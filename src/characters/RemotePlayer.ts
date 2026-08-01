import { Object3D, Vector3 } from 'three';
import { OperatorId, SoldierRig, buildSoldierMesh, disposeSoldierRig } from './SoldierMesh';
import { PlayerVisualState, SoldierAnimator } from './SoldierAnimations';
import { WEAPONS, WeaponDef } from '../weapons/WeaponDefs';
import { clamp, lerp, lerpAngle } from '../util/math';

/**
 * One other player, as seen from this machine.
 *
 * The class exists to answer a single question honestly: given a stream of
 * states that arrive late, out of order and at a lower rate than the frame
 * rate, what should this character be doing *right now*? Everything here is
 * about that gap.
 *
 *  - **Snapshots are buffered and rendered in the past.** The character is
 *    drawn at `now - INTERP_DELAY`, so there are almost always two real
 *    snapshots bracketing the moment being drawn and the motion between them is
 *    interpolated rather than guessed. The cost is a fixed, small latency; the
 *    alternative is extrapolating, which is smooth right up until the player
 *    changes direction and the character visibly snaps back.
 *  - **Velocity is measured from the interpolated positions**, not sent. It has
 *    to be: the legs must match the movement actually being *drawn*, and a
 *    velocity from the sender describes movement that has not been drawn yet.
 *    Feet that disagree with the ground they are crossing is the single most
 *    recognisable artefact in a third-person shooter.
 *  - **Events are counters, not flags.** A boolean `firing` sampled at 20 Hz
 *    misses shots from a 600 rpm weapon and misses every shot in a dropped
 *    packet. A cumulative `shots` count cannot: the difference between the last
 *    one seen and the newest is exactly how many rounds to play, however the
 *    packets arrived.
 */

/** Snapshot flags, packed for the wire. */
export const PF = {
  sprinting: 1 << 0,
  crouching: 1 << 1,
  grounded: 1 << 2,
  aiming: 1 << 3,
  reloading: 1 << 4,
  dead: 1 << 5,
} as const;

/**
 * The complete authored-once description of another player's state.
 *
 * Deliberately flat and scalar: no engine types, no nested objects, no
 * references. Whatever transport this ends up on — WebRTC data channel,
 * WebSocket, or a local loopback for splitscreen — this is a struct that
 * serialises to about forty bytes without anybody having to redesign it.
 */
export interface PlayerSnapshot {
  /** Sender's clock, in seconds. */
  t: number;
  /** Position of the point between the feet. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  weaponId: string;
  /** Cumulative round count. The delta is how many shots to play. */
  shots: number;
  /** Cumulative melee count. */
  melees: number;
  flags: number;
  /** 0..1 through the reload timeline, if reloading. */
  reloadProgress: number;
  health: number;
}

export function packFlags(f: {
  sprinting?: boolean;
  crouching?: boolean;
  grounded?: boolean;
  aiming?: boolean;
  reloading?: boolean;
  dead?: boolean;
}): number {
  return (
    (f.sprinting ? PF.sprinting : 0) |
    (f.crouching ? PF.crouching : 0) |
    (f.grounded ? PF.grounded : 0) |
    (f.aiming ? PF.aiming : 0) |
    (f.reloading ? PF.reloading : 0) |
    (f.dead ? PF.dead : 0)
  );
}

/**
 * How far behind the newest snapshot the character is drawn.
 *
 * Two send intervals at 20 Hz, which is enough to ride out a single dropped or
 * reordered packet without ever running out of future to interpolate into.
 */
const INTERP_DELAY = 0.1;
/** Snapshots older than this behind the render time are dropped. */
const BUFFER_KEEP = 1.0;

const _prev = new Vector3();
const _next = new Vector3();

export class RemotePlayer {
  readonly id: string;
  readonly operator: OperatorId;
  readonly rig: SoldierRig;
  readonly animator: SoldierAnimator;
  /** Interpolated position of the point between the feet. */
  readonly position = new Vector3();

  yaw = 0;
  pitch = 0;
  health = 100;
  /** Cleared by `leave`, so a pooled rig can be handed to the next joiner. */
  active = true;

  private readonly buffer: PlayerSnapshot[] = [];
  private readonly state: PlayerVisualState = {
    moveRight: 0,
    moveForward: 0,
    pitch: 0,
    sprinting: false,
    crouching: false,
    grounded: true,
    aiming: false,
    fired: false,
    reloading: false,
    reloadProgress: 0,
    melee: false,
    dead: false,
  };
  private lastShots = -1;
  private lastMelees = -1;
  private weaponId = '';
  /** Set once the first snapshot lands, so the character does not slide in. */
  private started = false;

  constructor(id: string, operator: OperatorId, rig: SoldierRig) {
    this.id = id;
    this.operator = operator;
    this.rig = rig;
    this.animator = new SoldierAnimator(rig);
  }

  get root(): Object3D {
    return this.rig.root;
  }

  /** Crouched right now, per the pose being drawn. Used to place the nametag. */
  get crouching(): boolean {
    return this.state.crouching;
  }

  /** Down, per the last snapshot. */
  get dead(): boolean {
    return this.state.dead;
  }

  push(snapshot: PlayerSnapshot) {
    // Out-of-order arrivals are inserted rather than appended; a snapshot older
    // than one already applied is simply late, not wrong.
    const at = this.buffer.findIndex((s) => s.t > snapshot.t);
    if (at < 0) this.buffer.push(snapshot);
    else this.buffer.splice(at, 0, snapshot);

    if (!this.started) {
      this.started = true;
      this.position.set(snapshot.x, snapshot.y, snapshot.z);
      this.yaw = snapshot.yaw;
      this.pitch = snapshot.pitch;
      this.lastShots = snapshot.shots;
      this.lastMelees = snapshot.melees;
      this.applyWeapon(snapshot.weaponId);
    }
  }

  private applyWeapon(id: string) {
    if (id === this.weaponId) return;
    this.weaponId = id;
    const def: WeaponDef | undefined = WEAPONS[id];
    this.animator.setWeapon(def ?? null);
  }

  /**
   * Advances the character. `now` is this machine's clock in the same units the
   * snapshots' `t` uses; the manager owns that mapping.
   */
  update(dt: number, now: number) {
    if (!this.started) return;
    const renderTime = now - INTERP_DELAY;

    // Find the pair of snapshots that bracket the render time.
    let a = this.buffer[0];
    let b = this.buffer[this.buffer.length - 1];
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].t <= renderTime && this.buffer[i + 1].t >= renderTime) {
        a = this.buffer[i];
        b = this.buffer[i + 1];
        break;
      }
    }
    // Before the first snapshot, or past the last: hold the nearest rather than
    // extrapolate. A held pose for one frame is invisible; an extrapolated one
    // that has to be corrected is a visible snap.
    const span = b.t - a.t;
    const k = span > 1e-5 ? clamp((renderTime - a.t) / span, 0, 1) : 1;

    _prev.set(a.x, a.y, a.z);
    _next.set(b.x, b.y, b.z);
    this.position.copy(_prev).lerp(_next, k);
    this.yaw = lerpAngle(a.yaw, b.yaw, k);
    this.pitch = lerp(a.pitch, b.pitch, k);
    this.health = lerp(a.health, b.health, k);

    // Velocity from the pair being drawn, rotated into the character's frame.
    let right = 0;
    let forward = 0;
    if (span > 1e-5) {
      const vx = (b.x - a.x) / span;
      const vz = (b.z - a.z) / span;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // The player's forward is (-sin yaw, 0, -cos yaw); see Player.forward.
      forward = -vx * sin - vz * cos;
      right = vx * cos - vz * sin;
    }

    const newest = this.buffer[this.buffer.length - 1];
    this.applyWeapon(newest.weaponId);

    const s = this.state;
    s.moveRight = right;
    s.moveForward = forward;
    s.pitch = this.pitch;
    s.sprinting = (b.flags & PF.sprinting) !== 0;
    s.crouching = (b.flags & PF.crouching) !== 0;
    s.grounded = (b.flags & PF.grounded) !== 0;
    s.aiming = (b.flags & PF.aiming) !== 0;
    s.reloading = (b.flags & PF.reloading) !== 0;
    s.reloadProgress = lerp(a.reloadProgress, b.reloadProgress, k);
    s.dead = (b.flags & PF.dead) !== 0;
    // Counters, so a burst that spanned a dropped packet still plays. Capped:
    // a long stall must not dump forty muzzle flashes into one frame.
    s.fired = newest.shots > this.lastShots;
    s.melee = newest.melees > this.lastMelees;
    this.lastShots = newest.shots;
    this.lastMelees = newest.melees;

    this.animator.setState(s);
    this.animator.update(dt);

    this.rig.root.position.copy(this.position);
    this.rig.root.rotation.y = this.yaw;

    // Trim the buffer, always keeping the pair currently being drawn.
    while (this.buffer.length > 2 && this.buffer[1].t < renderTime - BUFFER_KEEP) {
      this.buffer.shift();
    }
  }

  /** World-space muzzle, for tracers and flashes attributed to this player. */
  muzzleWorld(out: Vector3): Vector3 {
    return this.animator.muzzleWorld(out);
  }

  setVisible(visible: boolean) {
    this.rig.root.visible = visible;
  }

  /** Returns the rig to the pool: clears buffered state, keeps the geometry. */
  recycle() {
    this.buffer.length = 0;
    this.started = false;
    this.active = false;
    this.lastShots = -1;
    this.lastMelees = -1;
    this.animator.setWeapon(null);
    this.weaponId = '';
  }

  dispose() {
    this.animator.dispose();
    disposeSoldierRig(this.rig);
  }
}

/** Builds a rig for an operator. Separated so the manager can pool them. */
export function makeOperatorRig(operator: OperatorId): SoldierRig {
  return buildSoldierMesh(operator);
}
