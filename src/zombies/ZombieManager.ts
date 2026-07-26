import { Scene, Vector3 } from 'three';
import { NavGrid } from '../core/Nav';
import { Effects } from '../core/Effects';
import { HitResult, Zombie, ZOMBIE_KINDS, ZombieKind } from './Zombie';
import { Rng, clamp } from '../util/math';

/**
 * Owns the horde.
 *
 * Zombies are pooled: a fixed set of rigs is built once at load and recycled
 * for the rest of the session. Building a skinned character costs tens of
 * milliseconds, so spawning one mid-round would be a visible hitch.
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

const POOL_SIZE = 26;
/** Distinct rigs built at load; the pool cycles through them. */
const VARIANTS = 8;

const _dir = new Vector3();
const _sep = new Vector3();
const _avoid = new Vector3();
const _desired = new Vector3();
const _tmp = new Vector3();

export class ZombieManager {
  readonly pool: Zombie[] = [];
  /** Zombies still to be released this round. */
  pendingSpawns = 0;
  /** Set of zone ids the player has unlocked; gates which spawns are usable. */
  readonly openZones = new Set<string>(['start']);

  private spawnPoints: SpawnPoint[] = [];
  private spawnTimer = 0;
  private spawnInterval = 1.4;
  private readonly rng = new Rng(0xa11e5);
  private roundHealth = 100;
  private roundSpeed = 1.4;
  private sprinterChance = 0;
  private bruteChance = 0;

  onPlayerHit?: (damage: number) => void;
  onKill?: (zombie: Zombie) => void;

  constructor(
    private readonly scene: Scene,
    private readonly nav: NavGrid,
    private readonly effects: Effects,
  ) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const z = new Zombie(i % VARIANTS);
      this.scene.add(z.rig.root);
      this.pool.push(z);
    }
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
    // Health ramps gently to round 10 then compounds, mirroring the classic
    // curve: early rounds are a warm-up, the twenties are a wall.
    this.roundHealth = round <= 9 ? 100 + (round - 1) * 32 : 388 * Math.pow(1.09, round - 9);
    this.roundSpeed = clamp(1.25 + round * 0.075, 1.25, 3.1);
    this.sprinterChance = round < 4 ? 0 : clamp((round - 3) * 0.06, 0, 0.45);
    this.bruteChance = round < 7 ? 0 : clamp((round - 6) * 0.035, 0, 0.22);
    this.spawnInterval = clamp(2.6 - round * 0.11, 0.55, 2.6);
    this.spawnTimer = 1.2;
  }

  /** Immediately clears the field — used on game over and restart. */
  clear() {
    this.pendingSpawns = 0;
    for (const z of this.pool) z.despawn();
  }

  private pickSpawn(playerPos: Vector3): SpawnPoint | null {
    const usable = this.spawnPoints.filter(
      (s) => this.openZones.has(s.zone) && s.position.distanceToSquared(playerPos) > 36,
    );
    if (usable.length === 0) {
      const fallback = this.spawnPoints.filter((s) => this.openZones.has(s.zone));
      return fallback.length ? this.rng.pick(fallback) : null;
    }
    // Weight toward spawns that are close (but not too close) so pressure comes
    // from the area the player is actually in.
    usable.sort(
      (a, b) => a.position.distanceToSquared(playerPos) - b.position.distanceToSquared(playerPos),
    );
    const window = Math.max(1, Math.ceil(usable.length * 0.6));
    return usable[this.rng.int(0, window - 1)];
  }

  private release(playerPos: Vector3) {
    const free = this.pool.find((z) => !z.active);
    if (!free) return;
    const spawn = this.pickSpawn(playerPos);
    if (!spawn) return;

    const roll = this.rng.next();
    let kind: ZombieKind = 'walker';
    if (roll < this.bruteChance) kind = 'brute';
    else if (roll < this.bruteChance + this.sprinterChance) kind = 'sprinter';
    const def = ZOMBIE_KINDS[kind];

    _tmp
      .copy(spawn.position)
      .add(new Vector3(this.rng.range(-0.7, 0.7), 0, this.rng.range(-0.7, 0.7)));
    free.spawn(
      _tmp,
      def,
      this.roundHealth * def.healthMultiplier,
      this.roundSpeed * def.speedMultiplier,
    );
    this.pendingSpawns--;
  }

  update(dt: number, playerPos: Vector3, playerRadius: number, groundY: number) {
    // Spawn pacing: never more than a handful of live bodies at once, so the
    // frame cost and the threat both stay bounded.
    if (this.pendingSpawns > 0) {
      this.spawnTimer -= dt;
      const liveCap = 24;
      if (this.spawnTimer <= 0 && this.aliveCount < liveCap) {
        this.release(playerPos);
        this.spawnTimer = this.spawnInterval * this.rng.range(0.65, 1.35);
      }
    }

    this.nav.rebuild(playerPos);

    for (const z of this.pool) {
      if (!z.active) continue;
      if (z.state !== 'dying') this.steer(z, dt, playerPos);
      z.setGroundHeight(groundY, dt);
      z.update(dt, playerPos, playerRadius, (damage) => this.onPlayerHit?.(damage));
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
    for (const other of this.pool) {
      if (other === z || !other.active || other.state === 'dying') continue;
      _tmp.subVectors(z.position, other.position);
      _tmp.y = 0;
      const distSq = _tmp.lengthSq();
      const minDist = (z.radius + other.radius) * 1.25;
      if (distSq > 1e-6 && distSq < minDist * minDist) {
        const dist = Math.sqrt(distSq);
        _sep.addScaledVector(_tmp.divideScalar(dist), (minDist - dist) / minDist);
      }
    }
    _desired.addScaledVector(_sep, speed * 1.7);

    // 3. Wall avoidance: probe ahead and to the sides on the nav grid.
    _avoid.set(0, 0, 0);
    const probe = 0.75;
    for (const angle of [-0.9, 0, 0.9]) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const px = z.position.x + (_dir.x * c - _dir.z * s) * probe;
      const pz = z.position.z + (_dir.x * s + _dir.z * c) * probe;
      if (this.nav.isBlockedWorld(px, pz)) {
        _avoid.x -= (px - z.position.x);
        _avoid.z -= (pz - z.position.z);
      }
    }
    _desired.addScaledVector(_avoid, speed * 1.1);

    // Attacking zombies plant their feet.
    if (z.state === 'attacking') _desired.multiplyScalar(0.12);

    // Accelerate toward the desired velocity rather than snapping to it.
    z.velocity.x += (_desired.x - z.velocity.x) * (1 - Math.exp(-7 * dt));
    z.velocity.z += (_desired.z - z.velocity.z) * (1 - Math.exp(-7 * dt));

    const nextX = z.position.x + z.velocity.x * dt;
    const nextZ = z.position.z + z.velocity.z * dt;

    // Hard constraint: never enter a blocked cell. Slide along the axis that is
    // still open so zombies scrape past doorframes instead of sticking.
    const openX = !this.nav.isBlockedWorld(nextX, z.position.z);
    const openZ = !this.nav.isBlockedWorld(z.position.x, nextZ);
    if (openX) z.position.x = nextX;
    else z.velocity.x *= -0.15;
    if (openZ) z.position.z = nextZ;
    else z.velocity.z *= -0.15;
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
      const killed = zombie.takeDamage(dealt, hit);

      this.effects.bloodBurst(hit.point, direction, headshot ? 1.5 : 1);
      if (killed) {
        this.effects.gib(hit.point, direction, zombie.position.y);
        this.onKill?.(zombie);
      }

      events.push({ zombie, damage: dealt, killed, headshot, point: hit.point });
      remaining--;
      // Each body a round passes through costs it a third of its energy.
      falloff *= 0.66;
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
