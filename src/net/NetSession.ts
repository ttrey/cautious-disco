import { Scene, Vector3 } from 'three';
import { NetClient } from './NetClient';
import {
  GameMessage,
  HORDE_RATE,
  RosterEntry,
  SLOW_RATE,
  SNAPSHOT_RATE,
  compactSnapshot,
  expandSnapshot,
} from './Protocol';
import { PlayerSnapshot } from '../characters/RemotePlayer';
import { RemotePlayerManager } from '../characters/RemotePlayerManager';
import { OPERATOR_IDS, OperatorId } from '../characters/SoldierMesh';
import { ZombieManager } from '../zombies/ZombieManager';

/**
 * The co-op session: everything that only exists when other people are playing.
 *
 * `Game` keeps a reference to one of these or to `null`, and the single-player
 * path is exactly the null path — no branches inside the frame loop beyond
 * "is there a session". That is deliberate. The alternative, threading an
 * `isMultiplayer` flag through the round logic, the horde, the economy and the
 * HUD, is how a game ends up with a single-player mode nobody tests.
 *
 * ## Who decides what
 *
 * Every player owns their own body and reports it. The host additionally owns
 * the horde and the round clock, and broadcasts both. Damage a client deals is
 * shown immediately and *settled* by the host. See `Protocol` for why.
 *
 * ## Player order
 *
 * Ordered by operator slot, never by join order. The server hands out operators
 * from a fixed list and never reassigns one while its holder is connected, so
 * sorting by it gives every machine the same sequence — which is what lets a
 * zombie's target be sent as a single small integer that means the same person
 * on all four screens.
 */

export interface NetSessionHooks {
  /** The local player's current state, sampled at the send rate. */
  sampleLocal: () => PlayerSnapshot;
  /** Host only: what the round packet should say. */
  sampleRound: () => { round: number; phase: 'intermission' | 'active'; remaining: number };
  /** Host only: the barrier plank counts, indexed as the level built them. */
  sampleBarriers: () => number[];

  /** Client only: the host says the round changed. */
  onRound: (round: number, phase: 'intermission' | 'active', remaining: number) => void;
  /** Somebody bought a door. Fired on every machine except the buyer's. */
  onDoorOpened: (id: string) => void;
  /** Client only: host-authoritative barrier state. */
  onBarriers: (planks: number[]) => void;
  /** The host settled a kill. Fired on every machine, including the killer's. */
  onKillConfirmed: (index: number, by: string, points: number, headshot: boolean) => void;
  /** Host only: a client reported a hit that needs applying. */
  onRemoteHit: (from: string, index: number, damage: number, headshot: boolean) => void;
  /** Roster changed — names, scores, membership. Drives the scoreboard. */
  onRoster: (roster: RosterEntry[]) => void;
  /** This machine gained or lost the host role. */
  onAuthorityChanged: (isHost: boolean) => void;
  /** The connection dropped for good. */
  onDisconnected: () => void;
}

const _tmp = new Vector3();

export class NetSession {
  readonly net: NetClient;
  readonly remotes: RemotePlayerManager;

  private readonly hooks: NetSessionHooks;
  private readonly zombies: ZombieManager;

  private snapshotTimer = 0;
  private hordeTimer = 0;
  private slowTimer = 0;
  private scoreTimer = 0;
  /** Highest round observed locally or on the wire; guards late horde packets. */
  private latestRound = 0;
  /** Reused so a 20 Hz send loop does not allocate an array a second. */
  private readonly hordeScratch: number[] = [];

  /**
   * Player order, by operator slot. Rebuilt whenever the roster changes rather
   * than every frame — it only moves when somebody joins or leaves.
   */
  private ordered: RosterEntry[] = [];
  private readonly positions: Vector3[] = [];
  localIndex = 0;

  /** Latest scores, for the HUD. Keyed by player id. */
  scores = new Map<string, RosterEntry>();

  constructor(net: NetClient, scene: Scene, zombies: ZombieManager, hooks: NetSessionHooks) {
    this.net = net;
    this.zombies = zombies;
    this.hooks = hooks;
    this.remotes = new RemotePlayerManager(scene);
    this.latestRound = hooks.sampleRound().round;

    // Take over the socket's game-facing callbacks. The menu owned them up to
    // this point; from here the session does.
    this.attach();
    // The roster that is already on the socket is applied straight away rather
    // than waited for. A session built the moment the host presses start would
    // otherwise have no teammates until the server's next broadcast, and would
    // spend that window with a player order — and therefore a set of zombie
    // targets — of exactly one.
    this.applyRoster(net.roster);
  }

  get isHost(): boolean {
    return this.net.isHost;
  }

  get localOperator(): OperatorId {
    return (this.net.self?.operator as OperatorId) ?? 'vance';
  }

  /** Every player's feet, ordered by operator slot. Fed to the horde AI. */
  playerPositions(localPosition: Vector3): readonly Vector3[] {
    this.positions.length = 0;
    for (let i = 0; i < this.ordered.length; i++) {
      const entry = this.ordered[i];
      if (entry.id === this.net.selfId) {
        this.positions.push(localPosition);
        continue;
      }
      const remote = this.remotes.get(entry.id);
      // A player who has joined but whose first snapshot has not landed yet has
      // no position. Standing them on the local player is wrong in an obvious,
      // harmless way — one frame of a zombie aiming at the wrong body — where
      // pushing a zero vector would drag the flow field to the map origin and
      // send the whole horde walking into a corner.
      this.positions.push(remote && remote.active ? remote.position : localPosition);
    }
    if (this.positions.length === 0) this.positions.push(localPosition);
    return this.positions;
  }

  /* --- Wiring ----------------------------------------------------------- */

  private attach() {
    this.net.setHandlers({
      onRoster: (roster) => this.applyRoster(roster),
      onPlayerLeft: (id) => {
        this.remotes.leave(id);
        this.scores.delete(id);
      },
      onGameMessage: (from, data) => this.receive(from, data),
      onStatus: (status) => {
        if (status === 'closed' || status === 'error') this.hooks.onDisconnected();
      },
    });
  }

  private applyRoster(roster: RosterEntry[]) {
    const wasHost = this.zombies.authority === 'local';

    this.ordered = [...roster].sort(
      (a, b) => OPERATOR_IDS.indexOf(a.operator) - OPERATOR_IDS.indexOf(b.operator),
    );
    this.localIndex = Math.max(
      0,
      this.ordered.findIndex((p) => p.id === this.net.selfId),
    );

    this.scores.clear();
    for (const entry of this.ordered) this.scores.set(entry.id, entry);

    // Admit anybody new to the operator pool, and give them the operator the
    // server assigned rather than letting the pool pick — otherwise two
    // machines can draw the same player as two different characters.
    for (const entry of this.ordered) {
      if (entry.id === this.net.selfId) continue;
      if (!this.remotes.get(entry.id)) this.remotes.join(entry.id, entry.operator as OperatorId);
    }
    for (const player of this.remotes.players) {
      if (!this.ordered.some((entry) => entry.id === player.id)) this.remotes.leave(player.id);
    }

    // Host migration. The server has already picked the successor; this is the
    // simulation catching up to it.
    const isHost = this.net.isHost;
    this.zombies.authority = isHost ? 'local' : 'remote';
    if (isHost !== wasHost) {
      this.zombies.resetReplication();
      this.hooks.onAuthorityChanged(isHost);
    }

    this.hooks.onRoster(this.ordered);
  }

  private receive(from: string, message: GameMessage) {
    switch (message.k) {
      case 'snap': {
        this.remotes.push(from, expandSnapshot(message.s));
        return;
      }

      case 'horde': {
        // A host's own packet echoing back would fight its live simulation.
        if (this.isHost) return;
        const currentRound = Math.max(this.latestRound, this.hooks.sampleRound().round);
        if (message.r < currentRound) return;
        this.latestRound = message.r;
        this.zombies.applyHorde(message.z);
        return;
      }

      case 'round': {
        if (this.isHost) return;
        const currentRound = Math.max(this.latestRound, this.hooks.sampleRound().round);
        if (message.r < currentRound) return;
        this.latestRound = message.r;
        this.hooks.onRound(message.r, message.phase, message.remaining);
        return;
      }

      case 'barrier': {
        if (this.isHost) return;
        this.hooks.onBarriers(message.planks);
        return;
      }

      case 'hit': {
        if (!this.isHost) return;
        this.hooks.onRemoteHit(from, message.i, message.d, message.head);
        return;
      }

      case 'kill': {
        this.hooks.onKillConfirmed(message.i, message.by, message.points, message.head);
        return;
      }

      case 'door': {
        this.hooks.onDoorOpened(message.id);
        return;
      }

      case 'resync': {
        // A machine that just inherited the host role asking to be caught up.
        // Only the new host can answer, and it does so on its next tick anyway;
        // forcing the timers makes that the very next frame instead.
        if (this.isHost) {
          this.hordeTimer = 0;
          this.slowTimer = 0;
          this.scoreTimer = 0;
        }
        return;
      }

      default:
        return;
    }
  }

  /* --- Per-frame -------------------------------------------------------- */

  update(dt: number, localPosition: Vector3) {
    this.remotes.update(dt, localPosition);

    this.snapshotTimer -= dt;
    if (this.snapshotTimer <= 0) {
      this.snapshotTimer += 1 / SNAPSHOT_RATE;
      const snapshot = this.hooks.sampleLocal();
      snapshot.t = this.remotes.now;
      this.net.relay({ k: 'snap', s: compactSnapshot(snapshot) });
    }

    if (!this.isHost) return;

    this.hordeTimer -= dt;
    if (this.hordeTimer <= 0) {
      this.hordeTimer += 1 / HORDE_RATE;
      const round = this.hooks.sampleRound();
      this.net.relay({ k: 'horde', r: round.round, z: this.zombies.packHorde(this.hordeScratch) });
    }

    // Round and barrier state ride much slower clocks than the horde does, and
    // deliberately so. A full wave's horde packet is around 600 bytes and goes
    // out twelve times a second; sending a round header and a dozen plank
    // counts alongside every one of them was a third of the host's upstream
    // spent restating numbers that change a few times a minute.
    this.slowTimer -= dt;
    if (this.slowTimer <= 0) {
      this.slowTimer += 1 / SLOW_RATE;
      const round = this.hooks.sampleRound();
      this.net.relay({ k: 'round', r: round.round, phase: round.phase, remaining: round.remaining });
      this.net.relay({ k: 'barrier', planks: this.hooks.sampleBarriers() });
    }
  }

  /**
   * Forces the slow packets out on the next frame.
   *
   * Called when something the slow clock carries changes *now* and cannot wait
   * for its turn — a round starting, a barrier finally breached. Without this a
   * client can be up to a fifth of a second behind on a round transition, which
   * is long enough to see a banner land after the zombies it was warning about.
   */
  flushSlow() {
    this.slowTimer = 0;
  }

  /** Pushed to the server on a slow tick; it owns the copy the lobby UI reads. */
  reportScore(dt: number, points: number, kills: number, downed: boolean, alive: boolean) {
    this.scoreTimer -= dt;
    if (this.scoreTimer > 0) return;
    this.scoreTimer = 0.5;
    this.net.reportScore(points, kills, downed, alive);
  }

  /* --- Outbound events -------------------------------------------------- */

  reportHit(index: number, damage: number, headshot: boolean) {
    if (index < 0) return;
    this.net.relay({ k: 'hit', i: index, d: Math.round(damage), head: headshot }, 'host');
  }

  announceKill(index: number, by: string, points: number, headshot: boolean) {
    this.net.relay({ k: 'kill', i: index, by, points, head: headshot });
  }

  announceDoor(id: string) {
    this.net.relay({ k: 'door', id });
  }

  /** Nudges the horde and score packets out on the next frame. */
  requestResync() {
    this.net.relay({ k: 'resync' }, 'host');
  }

  /** World position of another player, for nametags. */
  positionOf(id: string, out = _tmp): Vector3 | null {
    const remote = this.remotes.get(id);
    return remote?.active ? out.copy(remote.position) : null;
  }

  dispose() {
    this.remotes.dispose();
    this.net.close();
  }
}
