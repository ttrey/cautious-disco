import { Scene, Vector3 } from 'three';
import { NavGrid } from '../core/Nav';
import { Effects } from '../core/Effects';
import { HitResult, Zombie, ZOMBIE_KINDS, ZombieKind, ZombieState } from './Zombie';
import {
  HORDE_INTERP_DELAY,
  HORDE_STRIDE,
  POS_SCALE,
  YAW_SCALE,
  Z_KIND_NAMES,
  Z_STATE,
  packZombieFlags,
  unpackZombieFlags,
} from '../net/Protocol';
import { Rng, clamp, lerp, lerpAngle } from '../util/math';

/**
 * Owns the horde.
 *
 * Zombies are pooled and recycled for the rest of the session. Enough rigs for
 * round one are built with the game; the remaining capacity is filled one idle
 * task at a time while the briefing is visible.
 *
 * Steering combines three forces — flow-field pursuit, separation from
 * neighbours, and wall avoidance. Flow alone marches everyone down the same
 * grid line; separation alone lets them walk through walls.
 */

export interface SpawnPoint {
  position: Vector3;
  /** Spawns only become active once the player has opened the area. */
  zone: string;
}

export interface ZombieDamageEvent {
  zombie: Zombie;
  damage: number;
  killed: boolean;
  headshot: boolean;
  point: Vector3;
}

/**
 * Maximum live-rig capacity.
 *
 * Sized against the map rather than against a player count: the expanded
 * terminal is roughly two and a half times the floor area of the original
 * four-room loop, so the same pool spread over it left whole wings empty. Each
 * rig is a skinned character costing real main-thread time, so the pool is
 * filled incrementally rather than making the first menu wait for all thirty.
 */
const POOL_SIZE = 30;
/** Enough for round one; the rest are built one per active frame during warm-up. */
const INITIAL_POOL_SIZE = 10;
/** Distinct rigs built at load; the pool cycles through them. */
const VARIANTS = 8;
const SEPARATION_CELL = 2;

const _dir = new Vector3();
const _sep = new Vector3();
const _avoid = new Vector3();
const _desired = new Vector3();
const _tmp = new Vector3();

function separationKey(cx: number, cz: number): number {
  return ((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff);
}

/**
 * Who decides what the horde does.
 *
 * `local` is single player and the co-op host: the AI runs, bodies spawn, and
 * damage lands here. `remote` is every other machine in a co-op game: the pool
 * is driven entirely by packets, and a shot fired locally is reported rather
 * than applied. There is no third mode, and nothing in between — a body is
 * either simulated here or it is not, and blurring that is how two machines end
 * up disagreeing about whether somebody is dead.
 */
export type HordeAuthority = 'local' | 'remote';

/**
 * One replicated body's interpolation state.
 *
 * Two samples, not a growing buffer: at 12 Hz the packets are the only thing
 * that ever moves a remote zombie, and the pair bracketing the render time is
 * all that gets read. `RemotePlayer` keeps a real buffer because a player can
 * change direction between packets in a way that has to be ridden out; a zombie
 * walking a flow field cannot.
 */
interface NetSample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

interface NetBody {
  prev: NetSample;
  next: NetSample;
  state: ZombieState;
  target: number;
  /** Set each time a packet mentions this slot, so absences can be detected. */
  seen: number;
}

const emptySample = (): NetSample => ({ t: 0, x: 0, y: 0, z: 0, yaw: 0 });

export class ZombieManager {
  readonly pool: Zombie[] = [];
  /** Zombies still to be released this round. */
  pendingSpawns = 0;
  /** Set of zone ids the player has unlocked; gates which spawns are usable. */
  readonly openZones = new Set<string>(['start']);

  /** See `HordeAuthority`. Flipped by the net layer on host migration. */
  authority: HordeAuthority = 'local';

  /**
   * Reports a shot that landed while somebody else owned the horde. The net
   * layer forwards it to the host, which is the only machine that subtracts
   * health.
   */
  onRemoteDamage?: (index: number, damage: number, headshot: boolean) => void;

  private readonly net: NetBody[] = [];
  private netClock = 0;
  /** Packet counter, used to spot slots that stopped being mentioned. */
  private netTick = 0;

  private spawnPoints: SpawnPoint[] = [];
  private spawnTimer = 0;
  private spawnInterval = 1.4;
  /** Rate limit on flow-field sweeps; see update(). */
  private fieldTimer = 0;
  private readonly rng = new Rng(0xa11e5);
  private roundHealth = 100;
  private roundSpeed = 1.4;
  private roundNumber = 0;
  private releasedThisRound = 0;
  private lastSpawn: SpawnPoint | null = null;
  private sprinterChance = 0;
  private bruteChance = 0;
  private readonly spatialBins = new Map<number, Zombie[]>();
  private readonly spatialKeys: number[] = [];

  /** Reused active count for the spawn gate; avoids a second pool reduction. */
  private activeForSpawn = 0;

  onPlayerHit?: (damage: number) => void;
  onKill?: (zombie: Zombie) => void;

  constructor(
    private readonly scene: Scene,
    private readonly nav: NavGrid,
    private readonly effects: Effects,
  ) {
    this.ensurePoolSize(INITIAL_POOL_SIZE);
    this.schedulePoolWarmup();
  }

  private ensurePoolSize(target: number) {
    const limit = Math.min(target, POOL_SIZE);
    while (this.pool.length < limit) {
      const i = this.pool.length;
      const z = new Zombie(i % VARIANTS);
      this.scene.add(z.rig.root);
      this.pool.push(z);
      this.net.push({
        prev: emptySample(),
        next: emptySample(),
        state: 'chasing',
        target: 0,
        seen: -1,
      });
    }
  }

  private warmPool() {
    if (this.pool.length < POOL_SIZE) this.ensurePoolSize(this.pool.length + 1);
  }

  private schedulePoolWarmup() {
    if (this.pool.length >= POOL_SIZE) return;
    const buildOne = () => {
      this.warmPool();
      this.schedulePoolWarmup();
    };
    if ('requestIdleCallback' in window) window.requestIdleCallback(buildOne, { timeout: 120 });
    else setTimeout(buildOne, 16);
  }

  setSpawnPoints(points: SpawnPoint[]) {
    this.spawnPoints = points;
  }

  openZone(zone: string) {
    this.openZones.add(zone);
  }

  get aliveCount() {
    return this.pool.reduce((n, z) => n + (z.active && z.state !== 'dying' ? 1 : 0), 0);
  }

  get remaining() {
    return this.pendingSpawns + this.aliveCount;
  }

  /** Configures the wave. Difficulty scaling lives entirely here. */
  beginRound(round: number, count: number) {
    this.pendingSpawns = count;
    this.roundNumber = round;
    this.releasedThisRound = 0;
    this.lastSpawn = null;
    // Health ramps gently to round 10 then compounds, mirroring the classic
    // curve: early rounds are a warm-up, the twenties are a wall.
    this.roundHealth = round <= 9 ? 100 + (round - 1) * 32 : 388 * Math.pow(1.09, round - 9);
    this.roundSpeed = clamp(1.25 + round * 0.075, 1.25, 3.1);
    this.sprinterChance = round < 4 ? 0 : clamp((round - 3) * 0.06, 0, 0.45);
    this.bruteChance = round < 7 ? 0 : clamp((round - 6) * 0.035, 0, 0.22);
    this.spawnInterval = clamp(2.6 - round * 0.11, 0.55, 2.6);
    // The first three arrivals have a deliberate beat: one readable threat,
    // then a pair that establishes the horde rhythm. Later rounds use the
    // normal pressure curve immediately.
    this.spawnTimer = round === 1 ? 1.45 : 1.2;
  }

  /** Immediately clears the field — used on game over and restart. */
  clear() {
    this.pendingSpawns = 0;
    for (const z of this.pool) z.despawn();
  }

  /**
   * Chooses where the next body comes from.
   *
   * With a squad, the anchor is one player picked at random rather than the
   * centroid of the group. The centroid is nobody's position: with two players
   * at opposite ends of the terminal it sits in a corridor between them, and
   * every zombie in the round then walks in from a door neither of them is
   * near. Picking a player spreads the pressure over the squad and keeps each
   * wave arriving from somewhere somebody can actually see.
   */
  private pickSpawn(players: readonly Vector3[]): SpawnPoint | null {
    const anchor = players.length === 1 ? players[0] : this.rng.pick(players as Vector3[]);
    const open = this.spawnPoints.filter((s) => this.openZones.has(s.zone));

    // Far enough from *everyone*, not just the anchor — a body appearing at a
    // teammate's elbow is the same bug whoever it spawned for.
    const usable = open.filter((s) =>
      players.every((p) => s.position.distanceToSquared(p) > 36),
    );
    if (usable.length === 0) return open.length ? this.rng.pick(open) : null;

    const withoutLast = usable.filter((s) => s !== this.lastSpawn);
    const candidates = withoutLast.length ? withoutLast : usable;

    // The opening wave is staged from the far side of the currently open area.
    // That buys the player a clean read of the first body and makes the first
    // contact feel like an authored entrance instead of a random teleport.
    if (this.roundNumber === 1 && this.releasedThisRound < 3) {
      const intro = candidates.find(
        (s) => s.zone === 'start' && s.position.z > -4 && s.position.z < 3,
      );
      if (this.releasedThisRound === 0 && intro) return intro;
      candidates.sort(
        (a, b) => b.position.distanceToSquared(anchor) - a.position.distanceToSquared(anchor),
      );
      const window = Math.max(1, Math.ceil(candidates.length * 0.45));
      return candidates[this.rng.int(0, window - 1)];
    }

    // Weight toward spawns that are close (but not too close) so pressure comes
    // from the area the anchor player is actually in.
    candidates.sort(
      (a, b) => a.position.distanceToSquared(anchor) - b.position.distanceToSquared(anchor),
    );
    const window = Math.max(1, Math.ceil(candidates.length * 0.6));
    return candidates[this.rng.int(0, window - 1)];
  }

  private release(players: readonly Vector3[]) {
    const free = this.pool.find((z) => !z.active);
    if (!free) return;
    const spawn = this.pickSpawn(players);
    if (!spawn) return;

    const roll = this.rng.next();
    let kind: ZombieKind = 'walker';
    if (roll < this.bruteChance) kind = 'brute';
    else if (roll < this.bruteChance + this.sprinterChance) kind = 'sprinter';
    const def = ZOMBIE_KINDS[kind];

    // Scatter arrivals so a queue at one window does not spawn bodies stacked on
    // a single point — but only onto cells that are actually walkable. Nine of
    // the eleven spawn pockets sit in the 1 m lane cut through a window, so a
    // flat ±0.7 m jitter drops about a third of arrivals into solid nav. A
    // zombie standing in a blocked cell has no flow field to read, falls back to
    // walking straight at the player through the wall, and is then pinned there
    // by the hard constraint in steer() — it never moves again for the rest of
    // the round. Those are the bodies that pile up outside a window.
    //
    // Every pocket centre is open, so giving up after a few tries and using it
    // unjittered is always a legal placement.
    _tmp.copy(spawn.position);
    for (let attempt = 0; attempt < 8; attempt++) {
      const jx = spawn.position.x + this.rng.range(-0.7, 0.7);
      const jz = spawn.position.z + this.rng.range(-0.7, 0.7);
      if (!this.nav.isBlockedWorld(jx, jz)) {
        _tmp.set(jx, spawn.position.y, jz);
        break;
      }
    }
    free.spawn(
      _tmp,
      def,
      this.roundHealth * def.healthMultiplier,
      this.roundSpeed * def.speedMultiplier,
    );
    this.lastSpawn = spawn;
    this.releasedThisRound++;
    this.pendingSpawns--;
  }

  /**
   * Advances the horde.
   *
   * `players` is every player's feet position, in the lobby's canonical order,
   * and `localIndex` says which of them is the one sitting at this keyboard.
   * Single player passes an array of one and an index of zero, which is why
   * there is no separate code path for it.
   */
  update(
    dt: number,
    players: readonly Vector3[],
    localIndex: number,
    playerRadius: number,
    groundY: number,
  ) {
    this.warmPool();
    if (this.authority === 'remote') {
      this.updateReplicated(dt, players, localIndex);
      return;
    }

    const localPos = players[localIndex] ?? players[0];

    // Spawn pacing: never more than a handful of live bodies at once, so the
    // frame cost and the threat both stay bounded.
    if (this.pendingSpawns > 0) {
      this.spawnTimer -= dt;
      const liveCap = 28;
      if (this.spawnTimer <= 0 && this.activeForSpawn < liveCap) {
        this.release(players);
        const openingBeat = this.roundNumber === 1 && this.releasedThisRound < 3
        ? [1.8, 1.35][this.releasedThisRound - 1] ?? 1.05
          : this.spawnInterval * this.rng.range(0.65, 1.35);
        this.spawnTimer = openingBeat;
      }
    }

    // The field is rebuilt when the player leaves a cell, which on a 0.5 m grid
    // is up to fourteen times a second at a sprint. That was free on the old
    // four-room map; the terminal's grid is 27k cells and a full sweep costs a
    // little over 2 ms, so paying it every crossing spikes an eighth of the
    // frame budget several times a second. Capping the rate leaves the field at
    // most an eighth of a second stale — under a metre of player movement,
    // which changes nothing about a route the horde is already walking, since
    // staleness moves the goal and not the topology.
    this.fieldTimer -= dt;
    if (this.fieldTimer <= 0) {
      // Multi-source: seeded from every player at once, so the field that comes
      // back is the distance to the nearest one. See NavGrid.rebuild.
      this.nav.rebuild(players);
      this.fieldTimer = 0.125;
    }

    this.rebuildSpatialBins();
    this.activeForSpawn = 0;
    for (const z of this.pool) {
      if (!z.active) continue;
      if (z.state !== 'dying') this.activeForSpawn++;
      // Each body chases whoever is nearest to it, which is also what the
      // multi-source flow field routes it toward.
      const targetIndex = this.nearestPlayerIndex(z.position, players);
      z.targetIndex = targetIndex;
      const target = players[targetIndex] ?? localPos;

      if (z.state !== 'dying') this.steer(z, dt, target);
      z.setGroundHeight(groundY, dt);
      // Only the player being attacked takes the hit. Without this a zombie
      // swinging at one operator damages every teammate standing within reach
      // of it, which in a doorway is the whole squad.
      const damages = targetIndex === localIndex;
      z.update(dt, target, playerRadius, (damage) => {
        if (damages) this.onPlayerHit?.(damage);
      });
    }
  }

  private nearestPlayerIndex(position: Vector3, players: readonly Vector3[]): number {
    if (players.length <= 1) return 0;
    let best = 0;
    let bestSq = Infinity;
    for (let i = 0; i < players.length; i++) {
      const d = position.distanceToSquared(players[i]);
      if (d < bestSq) {
        bestSq = d;
        best = i;
      }
    }
    return best;
  }

  private rebuildSpatialBins() {
    for (const key of this.spatialKeys) this.spatialBins.get(key)!.length = 0;
    this.spatialKeys.length = 0;

    for (const zombie of this.pool) {
      if (!zombie.active || zombie.state === 'dying' || zombie.state === 'dead') continue;
      const cx = Math.floor(zombie.position.x / SEPARATION_CELL);
      const cz = Math.floor(zombie.position.z / SEPARATION_CELL);
      const key = separationKey(cx, cz);
      let bin = this.spatialBins.get(key);
      if (!bin) {
        bin = [];
        this.spatialBins.set(key, bin);
      }
      if (bin.length === 0) this.spatialKeys.push(key);
      bin.push(zombie);
    }
  }

  /* --- Replication ------------------------------------------------------ */

  /**
   * Serialises every live body for the wire. Host only.
   *
   * Slots that are not active are simply absent; a receiver treats an absence
   * as "despawn that one", which means a body leaving costs zero bytes rather
   * than needing its own event. See `Protocol.HORDE_STRIDE`.
   */
  packHorde(out: number[] = []): number[] {
    out.length = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const z = this.pool[i];
      if (!z.active) continue;
      const state =
        z.state === 'dying' || z.state === 'dead'
          ? Z_STATE.dying
          : z.state === 'attacking'
            ? Z_STATE.attacking
            : Z_STATE.chasing;
      out.push(
        i,
        Math.round(z.position.x * POS_SCALE),
        Math.round(z.position.y * POS_SCALE),
        Math.round(z.position.z * POS_SCALE),
        Math.round(z.yaw * YAW_SCALE),
        packZombieFlags(state, Z_KIND_NAMES.indexOf(z.def.kind), z.targetIndex),
      );
    }
    return out;
  }

  /**
   * Takes a horde packet. Client only.
   *
   * Bodies the receiver has never heard of are spawned on the spot from the
   * kind in the packet rather than needing a separate spawn event. That makes
   * the stream self-healing: a client that connects mid-round, or drops the one
   * packet a spawn happened to be announced in, still ends up with the right
   * horde on the very next update instead of missing a zombie until it dies.
   */
  applyHorde(packed: number[]) {
    this.netTick++;
    const now = this.netClock;

    for (let at = 0; at + HORDE_STRIDE <= packed.length; at += HORDE_STRIDE) {
      const index = packed[at];
      if (index < 0 || index >= POOL_SIZE) continue;
      this.ensurePoolSize(index + 1);
      const x = packed[at + 1] / POS_SCALE;
      const y = packed[at + 2] / POS_SCALE;
      const z = packed[at + 3] / POS_SCALE;
      const yaw = packed[at + 4] / YAW_SCALE;
      const { state, kind, target } = unpackZombieFlags(packed[at + 5]);

      const zombie = this.pool[index];
      const body = this.net[index];
      body.state = state;
      body.target = target;
      body.seen = this.netTick;

      if (!zombie.active) {
        // First sighting: place it exactly and start both samples there, so it
        // does not slide in from wherever the slot was last used.
        // Health is never read on a client — the host owns it — but the speed
        // is, because it sets the threshold the walk/run animation switches at.
        // `beginRound` keeps both current on every machine.
        const def = ZOMBIE_KINDS[kind as ZombieKind];
        zombie.spawn(
          _tmp.set(x, y, z),
          def,
          this.roundHealth * def.healthMultiplier,
          this.roundSpeed * def.speedMultiplier,
        );
        zombie.yaw = yaw;
        body.prev = { t: now, x, y, z, yaw };
        body.next = { t: now, x, y, z, yaw };
        continue;
      }

      body.prev = body.next;
      body.next = { t: now, x, y, z, yaw };
    }

    // Anything the packet did not mention is gone on the host. A body already
    // playing its death animation is left alone to finish it — the host stops
    // sending it the moment it despawns, and cutting the animation there would
    // make every kill pop out of existence.
    for (let i = 0; i < this.pool.length; i++) {
      const zombie = this.pool[i];
      if (!zombie.active || this.net[i].seen === this.netTick) continue;
      if (zombie.state === 'dying') continue;
      zombie.despawn();
    }
  }

  private updateReplicated(dt: number, players: readonly Vector3[], localIndex: number) {
    this.netClock += dt;
    // Drawn a fixed step behind the newest packet, so there is nearly always a
    // real pair to interpolate between rather than a guess to correct later.
    const renderTime = this.netClock - HORDE_INTERP_DELAY;
    const localPos = players[localIndex] ?? players[0];

    for (let i = 0; i < this.pool.length; i++) {
      const zombie = this.pool[i];
      if (!zombie.active) continue;
      const body = this.net[i];

      const span = body.next.t - body.prev.t;
      const k = span > 1e-5 ? clamp((renderTime - body.prev.t) / span, 0, 1) : 1;
      const previousX = zombie.position.x;
      const previousZ = zombie.position.z;
      zombie.position.set(
        lerp(body.prev.x, body.next.x, k),
        lerp(body.prev.y, body.next.y, k),
        lerp(body.prev.z, body.next.z, k),
      );
      // Velocity is measured from what is being drawn rather than sent, for the
      // same reason `RemotePlayer` measures it: the walk cycle has to match the
      // ground the body is actually crossing on this screen.
      if (dt > 1e-5) {
        zombie.velocity.set(
          (zombie.position.x - previousX) / dt,
          0,
          (zombie.position.z - previousZ) / dt,
        );
      }
      zombie.yaw = lerpAngle(body.prev.yaw, body.next.yaw, k);
      zombie.targetIndex = body.target;

      const distance = zombie.position.distanceTo(localPos);
      zombie.updateReplicated(dt, body.state, distance, body.target === localIndex, (damage) =>
        this.onPlayerHit?.(damage),
      );
    }
  }

  /** Wipes replication bookkeeping — used when authority changes hands. */
  resetReplication() {
    this.netTick = 0;
    for (const body of this.net) body.seen = -1;
  }

  /**
   * Takes ownership of bodies that arrived over the network. Host migration.
   *
   * The zombies on screen were last placed by a host that has now gone. Their
   * positions are real and are kept — deleting them would make the whole horde
   * vanish and reappear, which is worse than any inconsistency this leaves —
   * but their health never crossed the wire, so it is restored from the round
   * curve. The practical effect is that a wave inherited mid-round is a little
   * tougher than it was a second earlier, which nobody notices, where the
   * alternative is a horde that dies to one bullet each.
   */
  adoptReplicatedHorde(round: number) {
    const health = round <= 9 ? 100 + (round - 1) * 32 : 388 * Math.pow(1.09, round - 9);
    const speed = clamp(1.25 + round * 0.075, 1.25, 3.1);
    this.roundHealth = health;
    this.roundSpeed = speed;

    for (const z of this.pool) {
      if (!z.active) continue;
      if (z.state === 'dying' || z.state === 'dead') continue;
      z.health = health * z.def.healthMultiplier;
      z.maxHealth = z.health;
      z.baseSpeed = speed * z.def.speedMultiplier;
      // Back into the local state machine from wherever the last packet left it.
      z.state = 'chasing';
    }
  }

  private steer(z: Zombie, dt: number, playerPos: Vector3) {
    const speed = z.baseSpeed;

    // 1. Pursuit along the flow field, falling back to a straight line when the
    //    field has no data (e.g. the zombie is briefly outside the grid).
    this.nav.flow(z.position.x, z.position.z, _dir);
    if (_dir.lengthSq() < 1e-6) {
      _dir.subVectors(playerPos, z.position).setY(0).normalize();
    }
    _desired.copy(_dir).multiplyScalar(speed);

    // 2. Separation. Without it the horde stacks into a single body and only
    //    the front zombie is ever hittable.
    _sep.set(0, 0, 0);
    const cellX = Math.floor(z.position.x / SEPARATION_CELL);
    const cellZ = Math.floor(z.position.z / SEPARATION_CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const neighbours = this.spatialBins.get(separationKey(cellX + dx, cellZ + dz));
        if (!neighbours) continue;
        for (const other of neighbours) {
          if (other === z) continue;
          _tmp.subVectors(z.position, other.position);
          _tmp.y = 0;
          const distSq = _tmp.lengthSq();
          const contact = z.state === 'attacking' || other.state === 'attacking';
          const minDist = (z.radius + other.radius) * (contact ? 1.08 : 1.24);
          if (distSq > 1e-6 && distSq < minDist * minDist) {
            const dist = Math.sqrt(distSq);
            _sep.addScaledVector(_tmp.divideScalar(dist), (minDist - dist) / minDist);
          }
        }
      }
    }
    _desired.addScaledVector(_sep, speed * 1.7);

    // 3. Wall avoidance: probe ahead and to the sides on the nav grid.
    //
    // The side probes may only push sideways. Subtracting a side probe's whole
    // offset also subtracts its forward component (cos 0.9 · 0.75 ≈ 0.47 each),
    // and a gap narrow enough to block both sides at once — every window apron
    // on this map is 1.0-1.5 m — makes those two forward components sum to
    // 1.03·speed against a pursuit force of exactly 1·speed. The lateral halves
    // cancel, the braking halves do not, and the zombie stops dead in the
    // approach lane with the rest of the horde piling up behind it outside the
    // building. Stripping the forward component leaves the intended behaviour:
    // one wall nearby steers away from it, walls on both sides cancel and the
    // zombie runs straight down the middle of the slot.
    //
    // The centre probe keeps its full offset — a wall genuinely dead ahead
    // should brake — but at 0.825·speed it can never out-pull pursuit on its
    // own, so avoidance can no longer reverse a zombie that has somewhere to go.
    _avoid.set(0, 0, 0);
    const probe = 0.75;
    for (const angle of [-0.9, 0, 0.9]) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const ox = (_dir.x * c - _dir.z * s) * probe;
      const oz = (_dir.x * s + _dir.z * c) * probe;
      if (!this.nav.isBlockedWorld(z.position.x + ox, z.position.z + oz)) continue;
      const forward = angle === 0 ? 0 : ox * _dir.x + oz * _dir.z;
      _avoid.x -= ox - _dir.x * forward;
      _avoid.z -= oz - _dir.z * forward;
    }
    _desired.addScaledVector(_avoid, speed * 1.1);

    // Attacks have a short authored lunge on the strike beat, then settle into
    // planted contact. Keeping it in steering (with the nav constraint below)
    // preserves collision and prevents visual root-motion drift.
    if (z.state === 'attacking') {
      const progress = z.attackProgress;
      const lunge = progress < 0.34 ? 0.08 : progress < 0.6 ? 0.44 : 0.12;
      _desired.multiplyScalar(lunge);
    }

    // Separation is allowed to ask for a little extra urgency, never an
    // unbounded speed spike. This keeps the front rank readable and prevents
    // a crowded doorway from slingshotting bodies through a corner.
    const maxDesired = speed * (z.state === 'attacking' ? 1.05 : 1.22);
    const desiredLength = Math.hypot(_desired.x, _desired.z);
    if (desiredLength > maxDesired) _desired.multiplyScalar(maxDesired / desiredLength);

    // Accelerate toward the desired velocity rather than snapping to it.
    z.velocity.x += (_desired.x - z.velocity.x) * (1 - Math.exp(-7 * dt));
    z.velocity.z += (_desired.z - z.velocity.z) * (1 - Math.exp(-7 * dt));

    const nextX = z.position.x + z.velocity.x * dt;
    const nextZ = z.position.z + z.velocity.z * dt;

    // Hard constraint: never enter a blocked cell. Slide along the axis that is
    // still open so zombies scrape past doorframes instead of sticking. The nav
    // grid is the *only* thing holding a zombie out of a wall — they carry no
    // physics collider — so this test has to be airtight.
    let openX = !this.nav.isBlockedWorld(nextX, z.position.z);
    let openZ = !this.nav.isBlockedWorld(z.position.x, nextZ);
    // Testing the axes independently is not enough: when both are individually
    // clear, the combined step can still land in a solid diagonal neighbour that
    // neither probe ever looked at. Beside a window that reads as a zombie
    // clipping the corner of the frame and walking on inside the masonry.
    // Nav.rebuild refuses the same diagonal when it builds the field, so
    // dropping the weaker axis here keeps the steering honest to the path the
    // flow field actually promised.
    if (openX && openZ && this.nav.isBlockedWorld(nextX, nextZ)) {
      if (Math.abs(z.velocity.x) >= Math.abs(z.velocity.z)) openZ = false;
      else openX = false;
    }
    if (openX) z.position.x = nextX;
    else z.velocity.x *= -0.15;
    if (openZ) z.position.z = nextZ;
    else z.velocity.z *= -0.15;
  }

  /**
   * The one place damage is applied, whoever fired and whoever owns the horde.
   *
   * On the authority this is the real thing: health comes off, a death is
   * declared, the kill callback fires. On a client it is the *appearance* of
   * the same thing — blood, a flinch, a white flash on the skin — with the
   * arithmetic sent to the host instead. Returning `false` for `killed` there
   * is not a fudge: this machine genuinely does not know yet, and the host's
   * `kill` message is what pays out.
   *
   * Every damage source in the class routes through here, so a wonder weapon's
   * splash and its chain lightning cannot quietly keep applying local damage in
   * a co-op game the way they would if each of them called `takeDamage`.
   */
  private applyDamage(
    zombie: Zombie,
    dealt: number,
    hit: HitResult,
    direction: Vector3,
    gibScale = 1,
  ): boolean {
    if (this.authority === 'remote') {
      zombie.reactToHit(hit);
      this.effects.bloodBurst(hit.point, direction, gibScale);
      this.onRemoteDamage?.(this.pool.indexOf(zombie), dealt, hit.label === 'head');
      return false;
    }

    const killed = zombie.takeDamage(dealt, hit);
    this.effects.bloodBurst(hit.point, direction, gibScale);
    if (killed) {
      this.effects.gib(hit.point, direction, zombie.position.y);
      this.onKill?.(zombie);
    }
    return killed;
  }

  /**
   * Plays the visual death confirmation for a body the host killed.
   *
   * A client never decides a zombie is dead, so without this the only sign of a
   * kill would be the body switching to its dying state in the next horde
   * packet — correct, but with no gore and no weight to it. This deliberately
   * does not fire `onKill`; local score accounting happens only after `by` is
   * checked by Game.
   */
  showRemoteKill(index: number, direction: Vector3) {
    const zombie = this.pool[index];
    if (!zombie?.active) return;
    zombie.centre(_tmp);
    this.effects.gib(_tmp, direction, zombie.position.y);
  }

  /**
   * Resolves a shot against the horde.
   *
   * `maxDist` should already be clipped to the nearest wall hit so bullets
   * cannot pass through geometry. Returns every zombie struck, nearest first,
   * up to the weapon's penetration count.
   */
  fireRay(
    origin: Vector3,
    direction: Vector3,
    maxDist: number,
    damage: number,
    headshotMultiplier: number,
    penetration: number,
  ): ZombieDamageEvent[] {
    const hits: { zombie: Zombie; hit: HitResult }[] = [];
    for (const z of this.pool) {
      const hit = z.raycast(origin, direction, maxDist);
      if (hit) hits.push({ zombie: z, hit });
    }
    hits.sort((a, b) => a.hit.distance - b.hit.distance);

    const events: ZombieDamageEvent[] = [];
    let remaining = Math.max(1, penetration);
    let falloff = 1;

    for (const { zombie, hit } of hits) {
      if (remaining <= 0) break;
      const headshot = hit.label === 'head';
      const dealt = damage * falloff * (headshot ? headshotMultiplier : hit.multiplier);
      const killed = this.applyDamage(zombie, dealt, hit, direction, headshot ? 1.5 : 1);

      events.push({ zombie, damage: dealt, killed, headshot, point: hit.point });
      remaining--;
      // Each body a round passes through costs it a third of its energy.
      falloff *= 0.66;
    }
    return events;
  }

  /**
   * Resolves a radial energy burst. This is deliberately owned by the horde
   * manager rather than WeaponSystem so it follows the same death handling,
   * kill callback and gore/effects path as a regular bullet hit.
   */
  blast(
    centre: Vector3,
    radius: number,
    damage: number,
    direction: Vector3,
    exclude?: Zombie,
  ): ZombieDamageEvent[] {
    const events: ZombieDamageEvent[] = [];
    const radiusSq = radius * radius;

    for (const zombie of this.pool) {
      if (zombie === exclude || !zombie.active || zombie.state === 'dying' || zombie.state === 'dead') continue;
      const point = zombie.centre(new Vector3());
      const distanceSq = point.distanceToSquared(centre);
      // A target's centre can sit just beyond the geometric edge while its body
      // is visibly inside it, so include a small torso-radius allowance.
      if (distanceSq > radiusSq + 0.3) continue;

      const distance = Math.sqrt(distanceSq);
      const falloff = 1 - Math.min(1, distance / radius) * 0.42;
      const hit: HitResult = {
        distance,
        point,
        label: 'torso',
        multiplier: 1,
      };
      const dealt = damage * falloff;
      const blastDirection = _tmp.subVectors(point, centre).setY(0);
      if (blastDirection.lengthSq() < 1e-5) blastDirection.copy(direction);
      else blastDirection.normalize();
      const killed = this.applyDamage(zombie, dealt, hit, blastDirection, 1.25);
      events.push({ zombie, damage: dealt, killed, headshot: false, point });
    }
    return events;
  }

  /**
   * Lets an electrical hit seek a nearest uncharged neighbour, then repeats
   * from that new point. It intentionally does not raycast geometry between
   * links: this is an arcing electrical field, not a bullet being allowed to
   * pass through walls, and each link remains constrained to a tight cluster.
   */
  chainLightning(
    source: Zombie,
    maxTargets: number,
    range: number,
    baseDamage: number,
  ): ZombieDamageEvent[] {
    const events: ZombieDamageEvent[] = [];
    const struck = new Set<Zombie>([source]);
    const previous = source.centre(new Vector3());
    let current = source;

    for (let link = 0; link < maxTargets; link++) {
      let next: Zombie | null = null;
      let nextPoint: Vector3 | null = null;
      let bestSq = range * range;
      const currentPoint = current === source ? previous : current.centre(new Vector3());

      for (const candidate of this.pool) {
        if (struck.has(candidate) || !candidate.active || candidate.state === 'dying' || candidate.state === 'dead') continue;
        const candidatePoint = candidate.centre(new Vector3());
        const distanceSq = candidatePoint.distanceToSquared(currentPoint);
        if (distanceSq < bestSq) {
          next = candidate;
          nextPoint = candidatePoint;
          bestSq = distanceSq;
        }
      }

      if (!next || !nextPoint) break;
      const direction = new Vector3().subVectors(nextPoint, currentPoint).normalize();
      this.effects.lightningArc(currentPoint, nextPoint);
      this.effects.electricBurst(nextPoint);

      const hit: HitResult = {
        distance: Math.sqrt(bestSq),
        point: nextPoint,
        label: 'torso',
        multiplier: 1,
      };
      // The first bounce is powerful; later links lose a little charge so a
      // crowded horde still rewards a well-placed opening hit.
      const dealt = baseDamage * Math.pow(0.86, link);
      const killed = this.applyDamage(next, dealt, hit, direction, 0.9);
      events.push({ zombie: next, damage: dealt, killed, headshot: false, point: nextPoint });
      struck.add(next);
      current = next;
    }
    return events;
  }

  /** Nearest live zombie within `range`, for audio and hit indicators. */
  nearest(position: Vector3, range: number): Zombie | null {
    let best: Zombie | null = null;
    let bestSq = range * range;
    for (const z of this.pool) {
      if (!z.active || z.state === 'dying') continue;
      const d = z.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = z;
      }
    }
    return best;
  }
}
