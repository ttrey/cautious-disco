import { PlayerSnapshot } from '../characters/RemotePlayer';
import { OperatorId } from '../characters/SoldierMesh';

/**
 * The wire.
 *
 * Two layers live here, and keeping them apart is the point of the file.
 *
 *  - **Lobby messages** are between a client and the Node server. The server
 *    understands these: who exists, who is host, what the code is.
 *  - **Game messages** are between clients. The server forwards them inside a
 *    `relay` envelope without looking inside, so gameplay rules stay in one
 *    place — here, in TypeScript, next to the code that already implements them
 *    for single player — instead of being written a second time in the server.
 *
 * The authority model the game messages assume:
 *
 *  - **Every player owns their own body.** Position, aim, health and death are
 *    reported, never requested. Nobody can be shoved or killed by a peer's
 *    assertion, and the local player never waits on the network to move — which
 *    is the single thing that would make the game feel broken over a tunnel.
 *  - **The host owns the horde and the round.** One machine runs the zombie AI
 *    and broadcasts the result. Otherwise four machines each simulate their own
 *    private horde from the same seed and drift apart within seconds, because
 *    the AI is driven by player positions that arrive late and interpolated.
 *  - **Damage is reported to the host and applied there.** A client raycasts
 *    against its own replicated bodies and shows blood and a hitmarker at once,
 *    then tells the host what it hit. Kills — and the points for them — come
 *    back from the host, so two players shooting the same zombie cannot both be
 *    paid for killing it.
 */

/* --- Lobby layer -------------------------------------------------------- */

export interface RosterEntry {
  id: string;
  name: string;
  operator: OperatorId;
  points: number;
  kills: number;
  downed: boolean;
  alive: boolean;
  host: boolean;
}

/** Client → server. */
export type LobbyOutbound =
  | { t: 'create'; name: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'name'; name: string }
  | { t: 'start' }
  | { t: 'score'; points: number; kills: number; downed: boolean; alive: boolean }
  | { t: 'relay'; to: 'all' | 'host' | string; data: GameMessage }
  | { t: 'leave' }
  | { t: 'ping'; at: number };

/** Server → client. */
export type LobbyInbound =
  | {
      t: 'joined';
      code: string;
      seed: number;
      started: boolean;
      hostId: string;
      maxPlayers: number;
      you: RosterEntry;
      players: RosterEntry[];
    }
  | {
      t: 'lobby';
      code: string;
      hostId: string;
      started: boolean;
      seed: number;
      maxPlayers: number;
      players: RosterEntry[];
    }
  | { t: 'joinedPlayer'; player: RosterEntry }
  | { t: 'left'; id: string; hostMigrated: string | null }
  | { t: 'started'; seed: number; players: RosterEntry[] }
  | { t: 'msg'; from: string; data: GameMessage }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; at: number };

/* --- Game layer --------------------------------------------------------- */

/** A `PlayerSnapshot` squeezed for the wire. See `compactSnapshot`. */
export type CompactSnapshot = (number | string)[];

export type GameMessage =
  /** A player's own body, 20 Hz, to everyone. */
  | { k: 'snap'; s: CompactSnapshot }
  /**
   * The horde, host → everyone. `z` is a flat packed array; see `packHorde`.
   * `r` is the round the horde belongs to, so a packet in flight across a round
   * change cannot resurrect bodies the new round already cleared.
   */
  | { k: 'horde'; r: number; z: number[] }
  /** Round flow, host → everyone. */
  | { k: 'round'; r: number; phase: 'intermission' | 'active'; remaining: number }
  /** A shot landing on a zombie, client → host. */
  | { k: 'hit'; i: number; d: number; head: boolean }
  /**
   * A confirmed kill, host → everyone. `by` is the player who gets paid; the
   * points value is computed on the host so the economy cannot be inflated by
   * a client claiming its own reward.
   */
  | { k: 'kill'; i: number; by: string; points: number; head: boolean }
  /** A door somebody bought, any → everyone. */
  | { k: 'door'; id: string }
  /**
   * Every barrier's plank count, host → everyone, in the order the level built
   * them. Whole-state rather than per-change: there are a dozen barriers and
   * the array costs a couple of dozen bytes, which is cheaper than the
   * bookkeeping needed to make sure a missed delta is ever noticed.
   */
  | { k: 'barrier'; planks: number[] }
  /**
   * Sent by a client that has just been handed the host role, asking the new
   * host for a full resync rather than waiting for state to drift back.
   */
  | { k: 'resync' };

/* --- Horde packing ------------------------------------------------------ */

/**
 * Six integers per zombie: index, x, y, z, yaw, flags.
 *
 * Quantised to integers before they go out. A `Vector3` serialised as JSON
 * floats runs to about sixty characters per zombie of pure noise digits; at
 * centimetre precision — well under what is visible on a body two metres tall —
 * the same zombie costs about twenty. Over a tunnel to a friend on hotel Wi-Fi
 * that difference is the whole packet budget.
 */
export const HORDE_STRIDE = 6;
/** Centimetres. A zombie is never mis-drawn by more than half of one. */
export const POS_SCALE = 100;
/** Milliradians. Well under the angle a shoulder turn covers in a frame. */
export const YAW_SCALE = 1000;

export const Z_STATE = { chasing: 0, attacking: 1, dying: 2 } as const;
export const Z_STATE_NAMES = ['chasing', 'attacking', 'dying'] as const;
export const Z_KIND_NAMES = ['walker', 'sprinter', 'brute'] as const;

/** flags = state | kind << 2 | targetPlayerIndex << 4 */
export const packZombieFlags = (state: number, kind: number, target: number) =>
  (state & 0b11) | ((kind & 0b11) << 2) | ((target & 0b111) << 4);

export const unpackZombieFlags = (flags: number) => ({
  state: Z_STATE_NAMES[flags & 0b11] ?? 'chasing',
  kind: Z_KIND_NAMES[(flags >> 2) & 0b11] ?? 'walker',
  target: (flags >> 4) & 0b111,
});

/* --- Snapshot compaction ------------------------------------------------ */

/**
 * `PlayerSnapshot` on the wire.
 *
 * Same reasoning as the horde: the struct is authored for clarity in
 * `RemotePlayer`, and squeezed here on the way out. Twelve fields of raw
 * floating point is roughly 240 bytes per player per send; at 20 Hz with three
 * teammates that is 14 kB/s of mostly meaningless precision.
 */
export function compactSnapshot(s: PlayerSnapshot): CompactSnapshot {
  return [
    Math.round(s.t * 1000),
    Math.round(s.x * POS_SCALE),
    Math.round(s.y * POS_SCALE),
    Math.round(s.z * POS_SCALE),
    Math.round(s.yaw * YAW_SCALE),
    Math.round(s.pitch * YAW_SCALE),
    s.shots,
    s.melees,
    s.flags,
    Math.round(s.reloadProgress * 100),
    Math.round(s.health),
    s.weaponId,
  ];
}

export function expandSnapshot(a: CompactSnapshot): PlayerSnapshot {
  return {
    t: (a[0] as number) / 1000,
    x: (a[1] as number) / POS_SCALE,
    y: (a[2] as number) / POS_SCALE,
    z: (a[3] as number) / POS_SCALE,
    yaw: (a[4] as number) / YAW_SCALE,
    pitch: (a[5] as number) / YAW_SCALE,
    shots: a[6] as number,
    melees: a[7] as number,
    flags: a[8] as number,
    reloadProgress: (a[9] as number) / 100,
    health: a[10] as number,
    weaponId: String(a[11] ?? 'pistol'),
  };
}

/* --- Rates -------------------------------------------------------------- */

/** Player snapshots per second. `RemotePlayer`'s interpolation delay assumes this. */
export const SNAPSHOT_RATE = 20;
/**
 * Horde updates per second. Lower than the player rate deliberately: there are
 * up to thirty bodies against four players, and a shambling zombie interpolates
 * over a longer window far more forgivingly than a strafing human does.
 */
export const HORDE_RATE = 12;
/** How much of the horde packet is buffered before it is drawn, in seconds. */
export const HORDE_INTERP_DELAY = 2 / HORDE_RATE;
/**
 * Round headers and barrier boards per second.
 *
 * These describe things that change a handful of times a minute, so they ride
 * their own slow clock instead of being restated inside every horde packet.
 * `NetSession.flushSlow` exists for the moments when one of them changes and
 * genuinely cannot wait for the next tick.
 */
export const SLOW_RATE = 4;
