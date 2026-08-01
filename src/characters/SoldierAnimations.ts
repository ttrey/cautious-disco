import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Euler,
  InterpolateLinear,
  LoopOnce,
  LoopRepeat,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { BoneName } from './CharacterGeometry';
import { SoldierRig } from './SoldierMesh';
import { GunModel } from '../weapons/GunSmith';
import { WeaponDef } from '../weapons/WeaponDefs';
import { solveTwoBoneIK } from '../util/ik';
import { TAU, clamp, damp, lerp, smoothstep } from '../util/math';

/**
 * Operator animation.
 *
 * The contract this has to meet is unusual: a remote player's body must agree
 * with what *that* player is doing on their own screen, and their screen shows
 * a first-person viewmodel driven by layered procedural motion, not by clips.
 * So this is built the same way round as `ViewModel`, and for the same reason.
 *
 *   - **The legs are clips.** Walk, run and crouch cycles go through an
 *     `AnimationMixer`, because a stride is a shape you cannot get to by
 *     springing toward a target.
 *   - **The weapon is a socket, not a prop in a hand.** `rig.weaponMount` hangs
 *     off the chest and is placed each frame by blending carry poses — ready,
 *     shouldered, sprint, reload, melee — plus a recoil spring. The muzzle
 *     therefore points where the player is actually aiming, which a hand
 *     animation can only ever approximate.
 *   - **The arms follow the weapon**, by two-bone IK onto the same
 *     `leftGrip`/`rightGrip` points the first-person arms are solved onto. One
 *     set of grip data drives both views, so a weapon added later is held
 *     correctly in third person for free.
 *
 * EIGHT-WAY MOVEMENT WITHOUT EIGHT CYCLES. The legs are yawed toward the
 * direction of travel and the spine counter-rotates back onto the aim, which is
 * what a person actually does when they strafe. Two cycles then cover every
 * direction, and the upper body stays locked to the weapon throughout — the
 * pose that reads, at a glance, as somebody covering an angle while moving
 * across it.
 *
 * SIDES. The rig faces -Z with +Y up, so by the right-hand rule its own right
 * is +X, which is where the `*L` bones sit (see `SKELETON`). The suffixes are
 * mirrored with respect to anatomy, and rather than rename bones the whole
 * horde is already skinned against, the two constants below say so once.
 */

/** The model's right hand — the one on the fire control. */
const TRIGGER = 'L';
/** The model's left hand — the one on the handguard. */
const SUPPORT = 'R';

type Pose = Partial<Record<BoneName, [number, number, number]>>;

interface Keyframe {
  t: number;
  pose: Pose;
  /** Hips translation relative to bind, in metres. */
  hips?: [number, number, number];
}

interface ClipSpec {
  name: string;
  duration: number;
  loop: boolean;
  /**
   * Ground speed in m/s the cycle was authored at. Playback is rate-scaled by
   * the real speed against this, which is what stops the feet skating.
   */
  nominalSpeed?: number;
  keys: Keyframe[];
}

/**
 * The stance every clip is built on top of: weight forward, knees unlocked,
 * shoulders squared. The arms are left near the body because they are
 * overwritten by IK every frame — these values only ever show if a weapon has
 * not been set yet.
 */
const POSTURE: Pose = {
  hips: [0, 0, 0],
  spine: [-0.05, 0, 0],
  chest: [-0.03, 0, 0],
  neck: [0.05, 0, 0],
  head: [0.03, 0, 0],
  clavicleL: [0, 0.05, -0.06],
  clavicleR: [0, -0.05, 0.06],
  upperArmL: [0.5, 0, 0.28],
  upperArmR: [0.5, 0, -0.28],
  lowerArmL: [1.1, 0, 0],
  lowerArmR: [1.1, 0, 0],
  handL: [0, 0, 0],
  handR: [0, 0, 0],
  // A soldier stands with the knees soft; locked legs read as a mannequin.
  upLegL: [0.05, 0, 0.03],
  upLegR: [0.05, 0, -0.03],
  lowLegL: [-0.12, 0, 0],
  lowLegR: [-0.12, 0, 0],
  footL: [0.07, 0, 0],
  footR: [0.07, 0, 0],
};

const ALL_BONES: BoneName[] = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'clavicleL', 'upperArmL', 'lowerArmL', 'handL',
  'clavicleR', 'upperArmR', 'lowerArmR', 'handR',
  'upLegL', 'lowLegL', 'footL',
  'upLegR', 'lowLegR', 'footR',
];

const _euler = new Euler(0, 0, 0, 'XYZ');
const _quat = new Quaternion();

function poseAt(spec: ClipSpec, bone: BoneName, index: number): [number, number, number] {
  return spec.keys[index].pose[bone] ?? POSTURE[bone] ?? [0, 0, 0];
}

/**
 * Compiles a spec into an `AnimationClip`. Every bone gets a track, falling
 * back to the posture, so a cross-fade never leaves a limb stuck wherever the
 * outgoing clip abandoned it.
 */
function buildClip(spec: ClipSpec, hipsBind: Vector3): AnimationClip {
  const times = spec.keys.map((k) => k.t);
  const tracks: (QuaternionKeyframeTrack | VectorKeyframeTrack)[] = [];

  for (const bone of ALL_BONES) {
    const values: number[] = [];
    for (let i = 0; i < spec.keys.length; i++) {
      const [x, y, z] = poseAt(spec, bone, i);
      _euler.set(x, y, z);
      _quat.setFromEuler(_euler);
      // Keep the quaternion path short — a sign flip between adjacent keys
      // makes the mixer take the long way round and the limb spins.
      if (values.length >= 4) {
        const dot =
          _quat.x * values[values.length - 4] +
          _quat.y * values[values.length - 3] +
          _quat.z * values[values.length - 2] +
          _quat.w * values[values.length - 1];
        if (dot < 0) _quat.set(-_quat.x, -_quat.y, -_quat.z, -_quat.w);
      }
      values.push(_quat.x, _quat.y, _quat.z, _quat.w);
    }
    tracks.push(new QuaternionKeyframeTrack(`${bone}.quaternion`, times, values));
  }

  if (spec.keys.some((k) => k.hips)) {
    const values: number[] = [];
    for (const key of spec.keys) {
      const [x, y, z] = key.hips ?? [0, 0, 0];
      values.push(hipsBind.x + x, hipsBind.y + y, hipsBind.z + z);
    }
    const track = new VectorKeyframeTrack('hips.position', times, values);
    // Linear, not smooth. A cubic through these keys overshoots between them,
    // and every millimetre of overshoot on the pelvis is a millimetre of boot
    // through the floor — the run cycle sank 44 mm at its lowest before this.
    // Nine keys a cycle is dense enough that linear is not visible.
    track.setInterpolation(InterpolateLinear);
    tracks.push(track);
  }

  return new AnimationClip(spec.name, spec.duration, tracks as never[]);
}

/* ------------------------------------------------------------------ */
/* Gait generator                                                      */
/* ------------------------------------------------------------------ */

interface GaitOptions {
  duration: number;
  nominalSpeed: number;
  /** Peak hip swing, radians. */
  hipSwing: number;
  /** Peak knee flexion during swing phase, radians. */
  kneeSwing: number;
  /**
   * Extra pelvis rise at the top of the cycle, metres. Only a run needs it —
   * everything else gets its bounce for free from the leg geometry.
   */
  lift: number;
  /** Forward lean carried in the spine, radians. */
  lean: number;
  /** Constant hip flexion. With `kneeBase`, this is what makes a crouch. */
  hipBase: number;
  /** Constant knee flexion. */
  kneeBase: number;
  /** Transverse pelvis rotation, radians. */
  pelvisTwist: number;
}

/** Thigh and shin lengths, straight off the skeleton. */
const THIGH = 0.45;
const SHIN = 0.46;
/**
 * Vertical distance from hip joint to ankle in the bind stance. Every gait key
 * is offset so its deepest ankle lands here, which is what keeps the feet on
 * the floor — see `plantedDrop`.
 */
const BIND_REACH = THIGH * Math.cos(0.05) + SHIN * Math.cos(0.05 - 0.12);

/** Vertical distance from the hip joint to the ankle for a given leg pose. */
const legReach = (hip: number, knee: number) =>
  THIGH * Math.cos(hip) + SHIN * Math.cos(hip + knee);

/**
 * How far the pelvis has to drop for the *supporting* leg to reach the floor.
 *
 * Flexing a hip or a knee shortens the leg, so any pose that is not the bind
 * stance leaves the model hovering or buried unless the pelvis follows. Hand
 * authoring that number per clip is how a crouch cycle ends up with its boots
 * through the tiles — a 1.28 rad knee bend shortens the leg by 25 cm, and no
 * amount of eyeballing a `drop` value tracks it once the hip swing changes too.
 * Solving it from the pose costs two cosines and cannot drift.
 *
 * Taking the deeper of the two legs is also what produces the pelvic bob for
 * free: the body rides the stance leg and dips through double support, which is
 * exactly what walking is.
 */
const plantedDrop = (hipL: number, kneeL: number, hipR: number, kneeR: number) =>
  Math.max(legReach(hipL, kneeL), legReach(hipR, kneeR)) - BIND_REACH;

/**
 * One gait cycle, sampled at eight phases.
 *
 * Real walking is not a sine wave on the hip: the knee is nearly straight
 * through stance and folds hard through swing, and it is that asymmetry — the
 * long straight push followed by the quick tuck — that separates a walk from
 * a mannequin rocking on its legs. So the leg is authored at four canonical
 * phases of the step (contact, midstance, toe-off, midswing) and both legs
 * read the same table half a cycle apart.
 */
function gaitClip(name: string, o: GaitOptions): ClipSpec {
  // Hip, knee and ankle at contact / midstance / toe-off / midswing.
  const HIP = [1.0, -0.18, -0.86, 0.42];
  const KNEE = [-0.12, -0.2, -0.42, -1.0];
  const ANKLE = [0.02, 0.06, 0.34, -0.04];

  const leg = (phase: number) => {
    // Sample the four-key table with wrap-around and smooth interpolation, so
    // the cycle closes on itself without a visible corner at the seam.
    const x = ((phase % 1) + 1) % 1;
    const i = Math.floor(x * 4);
    const f = smoothstep(x * 4 - i);
    const a = i % 4;
    const b = (i + 1) % 4;
    return {
      hip: lerp(HIP[a], HIP[b], f) * o.hipSwing + o.hipBase,
      knee: lerp(KNEE[a], KNEE[b], f) * o.kneeSwing - o.kneeBase,
      // The constant part of the fold is given back at the ankle, so a crouched
      // soldier still has his soles flat on the floor rather than on tiptoe.
      ankle: lerp(ANKLE[a], ANKLE[b], f) + 0.07 + (o.kneeBase - o.hipBase),
    };
  };

  const steps = 8;
  const keys: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const phase = i / steps;
    const l = leg(phase);
    // The trailing leg is half a cycle behind. `L` is the model's right.
    const r = leg(phase + 0.5);
    const rise = plantedDrop(l.hip, l.knee, r.hip, r.knee) + o.lift * Math.max(0, Math.sin(phase * TAU * 2));
    const twist = Math.sin(phase * TAU) * o.pelvisTwist;
    keys.push({
      t: phase * o.duration,
      hips: [0, rise, 0],
      pose: {
        hips: [0, twist, 0],
        // The shoulders counter-rotate against the pelvis. Without this the
        // whole torso swings as one block and the walk reads as a shuffle.
        spine: [-o.lean * 0.6, -twist * 0.7, 0],
        chest: [-o.lean * 0.4, -twist * 0.5, 0],
        neck: [o.lean * 0.5, 0, 0],
        head: [o.lean * 0.5, 0, 0],
        upLegL: [l.hip, 0, 0.03],
        lowLegL: [l.knee, 0, 0],
        footL: [l.ankle, 0, 0],
        upLegR: [r.hip, 0, -0.03],
        lowLegR: [r.knee, 0, 0],
        footR: [r.ankle, 0, 0],
      },
    });
  }
  return { name, duration: o.duration, loop: true, nominalSpeed: o.nominalSpeed, keys };
}

/** Standing at the ready: weight shifts, breathing, a slow scan. */
const IDLE: ClipSpec = {
  name: 'idle',
  duration: 5.2,
  loop: true,
  keys: [
    {
      t: 0,
      hips: [0, 0, 0],
      pose: { hips: [0, 0.03, 0], spine: [-0.05, -0.02, 0.01], chest: [-0.03, 0, -0.01] },
    },
    {
      // Weight rolls onto one leg, which drops that hip and cocks the other.
      t: 1.9,
      hips: [0.012, -0.008, 0],
      pose: {
        hips: [0, 0.06, 0.02],
        spine: [-0.04, -0.05, -0.02],
        chest: [-0.04, 0.02, 0.01],
        upLegL: [0.03, 0, 0.05],
        lowLegL: [-0.2, 0, 0],
        upLegR: [0.08, 0, -0.02],
        lowLegR: [-0.06, 0, 0],
      },
    },
    {
      t: 3.4,
      hips: [-0.004, -0.004, 0],
      pose: { hips: [0, -0.02, 0], spine: [-0.06, 0.03, 0.01], chest: [-0.02, -0.02, 0] },
    },
    {
      t: 5.2,
      hips: [0, 0, 0],
      pose: { hips: [0, 0.03, 0], spine: [-0.05, -0.02, 0.01], chest: [-0.03, 0, -0.01] },
    },
  ],
};

/**
 * Crouched and still. The pelvis heights come from `plantedDrop` rather than
 * from taste, for the same reason the gait cycles' do.
 */
const CROUCH_IDLE: ClipSpec = {
  name: 'crouchIdle',
  duration: 4.4,
  loop: true,
  keys: [
    {
      t: 0,
      hips: [0, plantedDrop(0.95, -1.5, 0.95, -1.5), 0.03],
      pose: {
        spine: [-0.16, 0, 0], chest: [-0.1, 0, 0], neck: [0.16, 0, 0], head: [0.1, 0, 0],
        upLegL: [0.95, 0, 0.14], lowLegL: [-1.5, 0, 0], footL: [0.62, 0, 0],
        upLegR: [0.95, 0, -0.14], lowLegR: [-1.5, 0, 0], footR: [0.62, 0, 0],
      },
    },
    {
      t: 2.2,
      hips: [0.006, plantedDrop(0.98, -1.54, 0.92, -1.46), 0.03],
      pose: {
        spine: [-0.18, -0.03, 0], chest: [-0.09, 0.02, 0], neck: [0.16, 0, 0], head: [0.1, 0, 0],
        upLegL: [0.98, 0, 0.15], lowLegL: [-1.54, 0, 0], footL: [0.64, 0, 0],
        upLegR: [0.92, 0, -0.13], lowLegR: [-1.46, 0, 0], footR: [0.6, 0, 0],
      },
    },
    {
      t: 4.4,
      hips: [0, plantedDrop(0.95, -1.5, 0.95, -1.5), 0.03],
      pose: {
        spine: [-0.16, 0, 0], chest: [-0.1, 0, 0], neck: [0.16, 0, 0], head: [0.1, 0, 0],
        upLegL: [0.95, 0, 0.14], lowLegL: [-1.5, 0, 0], footL: [0.62, 0, 0],
        upLegR: [0.95, 0, -0.14], lowLegR: [-1.5, 0, 0], footR: [0.62, 0, 0],
      },
    },
  ],
};

/** Airborne: legs tuck on the way up and reach on the way down. */
const JUMP: ClipSpec = {
  name: 'jump',
  duration: 0.9,
  loop: true,
  keys: [
    {
      t: 0,
      hips: [0, 0, 0],
      pose: {
        spine: [-0.12, 0, 0],
        upLegL: [0.62, 0, 0.08], lowLegL: [-0.9, 0, 0], footL: [0.3, 0, 0],
        upLegR: [0.2, 0, -0.06], lowLegR: [-0.45, 0, 0], footR: [0.2, 0, 0],
      },
    },
    {
      t: 0.9,
      hips: [0, 0, 0],
      pose: {
        spine: [-0.1, 0, 0],
        upLegL: [0.34, 0, 0.08], lowLegL: [-0.5, 0, 0], footL: [0.16, 0, 0],
        upLegR: [0.1, 0, -0.06], lowLegR: [-0.3, 0, 0], footR: [0.12, 0, 0],
      },
    },
  ],
};

/**
 * Going down. Backwards rather than forwards, and off one leg: a soldier who is
 * hit drops, and a symmetrical face-plant reads as a scripted animation.
 */
const DEATH: ClipSpec = {
  name: 'death',
  duration: 1.35,
  loop: false,
  keys: [
    { t: 0, hips: [0, 0, 0], pose: {} },
    {
      t: 0.28,
      hips: [0.02, -0.2, -0.04],
      pose: {
        hips: [0.2, 0.14, 0.06],
        spine: [0.16, 0.1, 0.04], chest: [0.1, 0.06, 0], neck: [-0.24, 0, 0], head: [-0.2, 0.2, 0],
        upLegL: [0.7, 0, 0.16], lowLegL: [-1.2, 0, 0],
        upLegR: [0.2, 0, -0.1], lowLegR: [-0.6, 0, 0],
        upperArmL: [-0.3, 0, 0.7], upperArmR: [0.1, 0, -0.5],
        lowerArmL: [0.5, 0, 0], lowerArmR: [0.9, 0, 0],
      },
    },
    {
      // On the back, one knee still up. Limb angles are chosen against the sum
      // of the chain above them: a pelvis rotated +1.3 already points the
      // shoulders at the floor.
      t: 0.78,
      hips: [0.04, -0.66, -0.16],
      pose: {
        hips: [1.15, 0.2, 0.1],
        spine: [0.1, 0.1, 0.04], chest: [0.04, 0.04, 0], neck: [-0.3, 0, 0.1], head: [-0.24, 0.3, 0.1],
        upLegL: [0.5, 0, 0.2], lowLegL: [-0.9, 0, 0],
        upLegR: [-0.05, 0, -0.12], lowLegR: [-0.2, 0, 0],
        upperArmL: [-0.5, 0, 0.9], upperArmR: [-0.2, 0, -0.8],
        lowerArmL: [0.4, 0, 0], lowerArmR: [0.6, 0, 0],
      },
    },
    {
      t: 1.35,
      hips: [0.04, -0.79, -0.22],
      pose: {
        hips: [1.42, 0.16, 0.06],
        spine: [0.06, 0.06, 0.03], chest: [0.02, 0.03, 0], neck: [-0.2, 0, 0.14], head: [-0.1, 0.34, 0.12],
        upLegL: [0.22, 0, 0.22], lowLegL: [-0.5, 0, 0],
        upLegR: [-0.08, 0, -0.14], lowLegR: [-0.1, 0, 0],
        upperArmL: [-0.35, 0, 1.05], upperArmR: [-0.1, 0, -0.95],
        lowerArmL: [0.2, 0, 0], lowerArmR: [0.3, 0, 0],
        handL: [0, 0, 0.3], handR: [0, 0, -0.3],
      },
    },
  ],
};

const WALK = gaitClip('walk', {
  duration: 0.86,
  nominalSpeed: 4.3,
  hipSwing: 0.44,
  kneeSwing: 0.72,
  lift: 0,
  lean: 0.1,
  hipBase: 0.04,
  kneeBase: 0.06,
  pelvisTwist: 0.1,
});

const RUN = gaitClip('run', {
  duration: 0.6,
  nominalSpeed: 7.1,
  hipSwing: 0.78,
  kneeSwing: 1.05,
  // The one gait with a flight phase, so the one gait that gets a real lift.
  lift: 0.045,
  lean: 0.26,
  hipBase: 0.06,
  kneeBase: 0.1,
  pelvisTwist: 0.16,
});

const CROUCH_WALK = gaitClip('crouchWalk', {
  duration: 1.05,
  nominalSpeed: 2.1,
  hipSwing: 0.3,
  kneeSwing: 0.35,
  lift: 0,
  lean: 0.18,
  // The whole crouch is these two. The hip flexes half of what the knee folds,
  // which keeps the shin under the body; `plantedDrop` then works out how far
  // the pelvis has to come down for the boots to stay on the floor.
  hipBase: 0.75,
  kneeBase: 1.66,
  pelvisTwist: 0.06,
});

const SPECS = [IDLE, WALK, RUN, CROUCH_IDLE, CROUCH_WALK, JUMP, DEATH];

export type SoldierAnimName = 'idle' | 'walk' | 'run' | 'crouchIdle' | 'crouchWalk' | 'jump' | 'death';

const cachedClips = new Map<string, Record<string, AnimationClip>>();

/**
 * Clips are pose data, not per-instance state, so one set serves every operator
 * of a given stature. Only the hips track depends on the rig, so the cache is
 * keyed on the bind hips position: four operators of four heights means four
 * sets, not one per remote player.
 */
export function soldierClips(hipsBind: Vector3): Record<string, AnimationClip> {
  const key = hipsBind.y.toFixed(4);
  let clips = cachedClips.get(key);
  if (!clips) {
    clips = {};
    for (const spec of SPECS) clips[spec.name] = buildClip(spec, hipsBind);
    cachedClips.set(key, clips);
  }
  return clips;
}

const NOMINAL_SPEED: Record<string, number> = {};
for (const spec of SPECS) if (spec.nominalSpeed) NOMINAL_SPEED[spec.name] = spec.nominalSpeed;

/* ------------------------------------------------------------------ */
/* Player state                                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything the animator needs to know about a remote player, and nothing
 * else. This is deliberately the shape of a network snapshot: no object
 * references, no engine types, all of it either a scalar or a flag, so the
 * transport layer added later has something obvious to serialise.
 */
export interface PlayerVisualState {
  /** Velocity in the player's own frame: +x is their right, +z is forward. */
  moveRight: number;
  moveForward: number;
  /** Look pitch in radians; positive is up, matching `Player.pitch`. */
  pitch: number;
  sprinting: boolean;
  crouching: boolean;
  grounded: boolean;
  aiming: boolean;
  /** True on the frame a shot is fired. */
  fired: boolean;
  reloading: boolean;
  /** 0..1 through the reload timeline. */
  reloadProgress: number;
  /** True on the frame a melee swing starts. */
  melee: boolean;
  dead: boolean;
}

export const IDLE_STATE: PlayerVisualState = {
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

/* ------------------------------------------------------------------ */
/* Carry poses                                                         */
/* ------------------------------------------------------------------ */

/**
 * Where the weapon sits, in the character's own frame: metres from the point
 * between their feet, x to their right, -z forward, and radians of XYZ Euler.
 *
 * Root space rather than chest space, and the numbers are why. The M4 model
 * runs from z = -0.354 at the muzzle to +0.235 at the buttstock; the shoulder
 * joint is at (0.197, 1.432, -0.023) and the arm reaches 0.563 m. Put the butt
 * in the shoulder pocket and every one of those has to be checked against the
 * same origin, which is only true if the origin is the character. The first
 * pass measured the pose from the chest bone, put the butt 0.25 m *inside* the
 * ribcage, and left the firing hand 0.14 m from its own shoulder — well inside
 * the arm's minimum reach, so the IK folded the elbow out sideways and the whole
 * upper body read as a shrug.
 *
 * Rotations here describe the weapon at rest; aim pitch is applied separately,
 * about the shoulder, so that raising the muzzle swings the weapon up on the
 * arm instead of sliding it through the torso.
 */
interface CarryPose {
  pos: [number, number, number];
  rot: [number, number, number];
}

/**
 * Patrol carry: butt tucked under the arm, muzzle down and crossing the
 * centreline. This is the pose that has to look right, because it is what a
 * teammate is in for most of a round.
 */
const CARRY_READY: CarryPose = { pos: [0.115, 1.31, -0.3], rot: [-0.34, 0.16, 0.12] };

/**
 * Shouldered. The bore comes up under the dominant eye — 55 mm below it, which
 * is the sight height — and the butt stays in the shoulder pocket, so this is
 * mostly a rotation about the shoulder rather than a translation.
 */
const CARRY_AIM: CarryPose = { pos: [0.042, 1.545, -0.375], rot: [0, 0.01, 0.0] };

/** Sprint: weapon dropped and canted across the body, muzzle down and out. */
const CARRY_SPRINT: CarryPose = { pos: [0.145, 1.2, -0.31], rot: [-0.75, 0.4, 0.5] };

/** Reload: rolled inboard and up so the magwell faces the support hand. */
const CARRY_RELOAD: CarryPose = { pos: [0.1, 1.4, -0.34], rot: [-0.16, 0.36, 0.62] };

const blendCarry = (a: CarryPose, b: CarryPose, t: number, out: CarryPose): CarryPose => {
  for (let i = 0; i < 3; i++) {
    out.pos[i] = lerp(a.pos[i], b.pos[i], t);
    out.rot[i] = lerp(a.rot[i], b.rot[i], t);
  }
  return out;
};

/**
 * How much of the aim pitch each bone in the spine chain carries. The weapon
 * gets the whole angle on its own pivot; these only decide how the *body* bends
 * to follow it, and they under-sum on purpose — a soldier tracking something
 * high does not fold backwards by the full angle, they raise the weapon and
 * tilt the head.
 */
const PITCH_SHARE = { spine: 0.14, chest: 0.22, neck: 0.2, head: 0.2 };

/**
 * Wrist offsets from a grip point, in weapon space. A grip is held in the
 * middle of the palm, roughly 60 mm beyond the wrist, so an IK target placed on
 * the grip point itself parks the whole hand a palm's length past it.
 *
 * The support offset also slides *back* along the handguard. Solved onto the
 * forward grip the first-person arms use, the support arm has to span 0.65 m
 * from a shoulder that reaches 0.56, so it locks out dead straight and the hand
 * still falls short; a hand nearer the receiver is both reachable and what
 * somebody at the ready actually does.
 */
const TRIGGER_PALM = new Vector3(0.012, 0.062, 0.026);
const SUPPORT_PALM = new Vector3(-0.016, 0.052, 0.085);

/** Hand orientation relative to the weapon, tuned against the grip geometry. */
const TRIGGER_HAND_ROT = new Euler(-0.34, 0.12, 0.34, 'XYZ');
const SUPPORT_HAND_ROT = new Euler(-1.15, -0.1, -0.5, 'XYZ');

/**
 * The weapon pitches about the firing shoulder, so that looking up swings the
 * muzzle up on the arm rather than translating the rifle through the ribcage.
 */
const AIM_PIVOT = new Vector3(0.15, 1.43, -0.03);

const gunProtos = new Map<string, GunModel>();

/**
 * Weapons are built once and cloned per operator. A finished rifle is a few
 * milliseconds of geometry assembly, which is fine at load and a visible hitch
 * if it happens when somebody buys a wall buy across the map.
 */
function makeGun(def: WeaponDef): GunModel {
  let proto = gunProtos.get(def.id);
  if (!proto) {
    proto = def.build();
    gunProtos.set(def.id, proto);
  }
  const root = proto.root.clone(true);
  const find = (name: string): Object3D | null => root.getObjectByName(name) ?? null;
  return {
    root,
    muzzle: find('muzzle') ?? root,
    ejectPort: find('eject') ?? root,
    slide: find('slide'),
    magazine: find('magazine'),
    feedCover: find('feedCover'),
    charging: find('charging'),
    trigger: find('trigger'),
    sightHeight: proto.sightHeight,
    sightForward: proto.sightForward,
  };
}

/* ------------------------------------------------------------------ */
/* Animator                                                            */
/* ------------------------------------------------------------------ */

const _v = new Vector3();
const _grip = new Vector3();
const _pole = new Vector3();
const _q = new Quaternion();
const _qp = new Quaternion();
const _e = new Euler(0, 0, 0, 'XYZ');
const _carry: CarryPose = { pos: [0, 0, 0], rot: [0, 0, 0] };
const _carryB: CarryPose = { pos: [0, 0, 0], rot: [0, 0, 0] };

export class SoldierAnimator {
  readonly mixer: AnimationMixer;
  private readonly rig: SoldierRig;
  private readonly actions = {} as Record<SoldierAnimName, AnimationAction>;
  private current: SoldierAnimName = 'idle';
  private state: PlayerVisualState = { ...IDLE_STATE };

  private gun: GunModel | null = null;
  private weapon: WeaponDef | null = null;

  /** Smoothed drivers, so a jittery snapshot does not make the body twitch. */
  private legYaw = 0;
  private aimBlend = 0;
  private sprintBlend = 0;
  private reloadBlend = 0;
  private speed = 0;
  private pitch = 0;

  /** Recoil spring: metres back along the bore, and radians of muzzle rise. */
  private recoil = 0;
  private recoilVel = 0;
  private recoilPitch = 0;
  private meleeTimer = 0;
  private breathe = Math.random() * TAU;
  private dying = false;

  constructor(rig: SoldierRig) {
    this.rig = rig;
    this.mixer = new AnimationMixer(rig.root);
    const clips = soldierClips(rig.bindPositions.hips);
    for (const [name, clip] of Object.entries(clips)) {
      const action = this.mixer.clipAction(clip);
      const key = name as SoldierAnimName;
      if (key === 'death') {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
      } else {
        action.setLoop(LoopRepeat, Infinity);
      }
      this.actions[key] = action;
    }
    this.actions.idle.play();
  }

  /** Attaches a weapon to the chest socket, replacing whatever was there. */
  setWeapon(def: WeaponDef | null) {
    if (this.gun) {
      this.rig.weaponMount.remove(this.gun.root);
      this.gun = null;
    }
    this.weapon = def;
    if (!def) return;
    this.gun = makeGun(def);
    this.gun.root.traverse((o) => {
      o.castShadow = true;
      o.frustumCulled = false;
    });
    this.rig.weaponMount.add(this.gun.root);
  }

  get weaponId(): string | null {
    return this.weapon?.id ?? null;
  }

  /** World-space muzzle position, for tracers and flashes fired by this player. */
  muzzleWorld(out: Vector3): Vector3 {
    if (!this.gun) return out.copy(this.rig.root.position);
    this.gun.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.gun.muzzle.matrixWorld);
  }

  setState(next: Partial<PlayerVisualState>) {
    const s = this.state;
    Object.assign(s, next);
    if (s.fired) this.kick();
    if (s.melee && this.meleeTimer <= 0) this.meleeTimer = 0.55;
    if (s.dead && !this.dying) {
      this.dying = true;
      this.play('death', 0.12);
    } else if (!s.dead && this.dying) {
      this.dying = false;
      this.actions.death.stop();
      this.play('idle', 0.15);
    }
    // Edge flags are consumed by the animator, not left set for the next frame.
    s.fired = false;
    s.melee = false;
  }

  private kick() {
    const def = this.weapon;
    const strength = def ? clamp(def.recoil.kick * 26, 0.4, 1.6) : 0.8;
    this.recoilVel += 3.4 * strength;
    this.recoilPitch += 0.085 * strength;
    if (this.gun?.slide) this.gun.slide.userData.kick = 1;
  }

  /** Cross-fades the locomotion layer. */
  play(name: SoldierAnimName, fade = 0.18) {
    if (this.current === name) return;
    const from = this.actions[this.current];
    const to = this.actions[name];
    to.enabled = true;
    to.setEffectiveWeight(1);
    to.reset();
    to.play();
    from.crossFadeTo(to, fade, false);
    this.current = name;
  }

  update(dt: number) {
    const s = this.state;
    this.breathe += dt * 1.1;

    /* --- Pick and rate-scale the locomotion clip ---------------------- */
    const speed = Math.hypot(s.moveRight, s.moveForward);
    this.speed = damp(this.speed, speed, 14, dt);
    const moving = this.speed > 0.35;

    if (!this.dying) {
      if (!s.grounded) this.play('jump');
      else if (s.crouching) this.play(moving ? 'crouchWalk' : 'crouchIdle');
      else if (moving) this.play(s.sprinting && this.speed > 5 ? 'run' : 'walk');
      else this.play('idle');
    }

    // The legs turn toward the direction of travel; past about 120 degrees that
    // is no longer a thing a hip can do, so the cycle runs backwards instead
    // and the character backpedals.
    let moveAngle = moving ? Math.atan2(s.moveRight, s.moveForward) : 0;
    let reverse = 1;
    if (Math.abs(moveAngle) > 2.1) {
      moveAngle -= Math.sign(moveAngle) * Math.PI;
      reverse = -1;
    }
    this.legYaw = damp(this.legYaw, clamp(-moveAngle, -1.15, 1.15), 9, dt);

    const action = this.actions[this.current];
    const nominal = NOMINAL_SPEED[this.current];
    if (nominal) {
      // Rate-scaled by real speed, with a floor so a crawl does not freeze the
      // cycle mid-stride and a ceiling so a speed perk does not blur it.
      action.setEffectiveTimeScale(reverse * clamp(this.speed / nominal, 0.55, 1.7));
    } else {
      action.setEffectiveTimeScale(1);
    }

    this.mixer.update(dt);
    if (this.dying) return;

    /* --- Aim and strafe, layered over the clip ------------------------ */
    this.pitch = damp(this.pitch, clamp(s.pitch, -1.2, 1.2), 18, dt);
    this.aimBlend = damp(this.aimBlend, s.aiming ? 1 : 0, 11, dt);
    this.sprintBlend = damp(this.sprintBlend, s.sprinting && moving && !s.aiming ? 1 : 0, 9, dt);
    this.reloadBlend = damp(this.reloadBlend, s.reloading ? 1 : 0, 12, dt);
    if (this.meleeTimer > 0) this.meleeTimer = Math.max(0, this.meleeTimer - dt);

    const bones = this.rig.bones;
    // Legs yaw at the pelvis, spine gives it back, so the torso stays on aim.
    this.addRotation(bones.hips, 0, this.legYaw, 0);
    this.addRotation(bones.spine, this.pitch * PITCH_SHARE.spine, -this.legYaw * 0.55, 0);
    this.addRotation(bones.chest, this.pitch * PITCH_SHARE.chest, -this.legYaw * 0.45, 0);
    this.addRotation(bones.neck, this.pitch * PITCH_SHARE.neck, 0, 0);
    this.addRotation(bones.head, this.pitch * PITCH_SHARE.head, 0, 0);

    /* --- Weapon socket ------------------------------------------------ */
    this.placeWeapon(dt);

    this.rig.root.updateMatrixWorld(true);
    if (this.gun) this.solveArms();
  }

  /** Applies an extra XYZ rotation in the bone's parent frame. */
  private addRotation(bone: Object3D, x: number, y: number, z: number) {
    if (x === 0 && y === 0 && z === 0) return;
    _e.set(x, y, z);
    _q.setFromEuler(_e);
    bone.quaternion.premultiply(_q);
  }

  private placeWeapon(dt: number) {
    const mount = this.rig.weaponMount;
    const s = this.state;

    // Recoil spring. Critically damped rather than oscillating: a rifle that
    // rings after every shot reads as a toy.
    this.recoilVel += -this.recoil * 220 * dt;
    this.recoilVel *= Math.exp(-16 * dt);
    this.recoil = Math.max(0, this.recoil + this.recoilVel * dt);
    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);

    // Blend the carry poses. Reload wins over sprint, sprint over aim, which is
    // the priority the player's own viewmodel resolves them in.
    blendCarry(CARRY_READY, CARRY_AIM, this.aimBlend, _carry);
    blendCarry(_carry, CARRY_SPRINT, this.sprintBlend, _carryB);
    blendCarry(_carryB, CARRY_RELOAD, this.reloadBlend, _carry);

    // Breathing, and the sway of a weapon carried at speed. Both scale down
    // when aiming, exactly as the first-person viewmodel does.
    const calm = 1 - this.aimBlend * 0.7;
    const sway = Math.sin(this.breathe) * 0.006 * calm;
    const bob = this.speed * 0.0022 * calm;

    let meleePush = 0;
    let meleeRoll = 0;
    if (this.meleeTimer > 0) {
      // A short butt-stroke: quick out, slower back.
      const k = 1 - this.meleeTimer / 0.55;
      const swing = Math.sin(clamp(k * 2.1, 0, 1) * Math.PI);
      meleePush = swing * 0.24;
      meleeRoll = swing * 0.9;
    }

    mount.position.set(
      _carry.pos[0] + Math.sin(this.breathe * 0.7) * 0.004 * calm,
      _carry.pos[1] + sway + bob,
      _carry.pos[2] + this.recoil * 0.05 - meleePush,
    );
    _e.set(
      // The bore points along -Z, so positive X rotation raises the muzzle.
      _carry.rot[0] + this.recoilPitch + meleeRoll * 0.3,
      _carry.rot[1] - meleeRoll * 0.6,
      _carry.rot[2] + meleeRoll * 0.5,
    );
    mount.quaternion.setFromEuler(_e);

    // Aim: rotate the whole weapon about the firing shoulder. Done as a pivot
    // rather than a rotation in place because a rifle held against a shoulder
    // *is* on a pivot — rotating about its own origin would drive the butt
    // straight down through the collarbone on any upward shot.
    if (this.pitch !== 0) {
      _q.setFromAxisAngle(AXIS_X, this.pitch);
      mount.position.sub(AIM_PIVOT).applyQuaternion(_q).add(AIM_PIVOT);
      mount.quaternion.premultiply(_q);
    }

    this.animateGunParts(dt, s);
  }

  /** Slide, trigger, charging handle and magazine, driven by the same state. */
  private animateGunParts(dt: number, s: PlayerVisualState) {
    const gun = this.gun;
    if (!gun) return;

    if (gun.slide) {
      const kick = (gun.slide.userData.kick as number) ?? 0;
      gun.slide.userData.kick = Math.max(0, kick - dt * 14);
      // Reciprocates along the bore, which is the weapon's +Z (rearward).
      gun.slide.position.z = kick * 0.026;
    }
    if (gun.trigger) gun.trigger.rotation.x = (gun.slide?.userData.kick ?? 0) * 0.3;

    if (gun.magazine) {
      const p = s.reloading ? clamp(s.reloadProgress, 0, 1) : 1;
      // Out by a third, hand away by a half, new one seated by three quarters.
      const out = p < 0.34 ? smoothstep(p / 0.34) : p < 0.62 ? 1 : 1 - smoothstep((p - 0.62) / 0.28);
      gun.magazine.position.y = -out * 0.14;
      gun.magazine.position.z = out * 0.02;
      gun.magazine.rotation.x = out * 0.35;
    }
    if (gun.charging && s.reloading) {
      // Charging handle at the very end of the cycle.
      const p = clamp(s.reloadProgress, 0, 1);
      const pull = p > 0.86 ? Math.sin((p - 0.86) / 0.14 * Math.PI) : 0;
      gun.charging.position.z = pull * 0.05;
    } else if (gun.charging) {
      gun.charging.position.z = 0;
    }
  }

  /**
   * Both arms onto the weapon's grips.
   *
   * Runs after `updateMatrixWorld`, so the grip points it reads already carry
   * this frame's spine bend, weapon sway and recoil — the hands therefore ride
   * the recoil with the weapon instead of lagging a frame behind it.
   */
  private solveArms() {
    const gun = this.gun!;
    const def = this.weapon!;
    const rig = this.rig;
    const mount = rig.weaponMount;
    const { upper, lower } = rig.armLengths;

    const solve = (
      side: 'L' | 'R',
      grip: [number, number, number],
      palm: Vector3,
      handRot: Euler,
      poleLocal: Vector3,
      reachTarget: Vector3 | null,
    ) => {
      const upperArm = rig.bones[`upperArm${side}` as BoneName];
      const lowerArm = rig.bones[`lowerArm${side}` as BoneName];
      const hand = rig.bones[`hand${side}` as BoneName];

      if (reachTarget) {
        _grip.copy(reachTarget);
        mount.localToWorld(_grip);
      } else {
        _grip.set(grip[0] + palm.x, grip[1] + palm.y, grip[2] + palm.z);
        mount.localToWorld(_grip);
      }

      // Elbow hint, in the rig's own frame so it turns with the character.
      _pole.copy(poleLocal);
      rig.root.localToWorld(_pole);

      solveTwoBoneIK(upperArm, lowerArm, _grip, _pole, upper, lower);

      // The hand is oriented from the weapon, not from the forearm: a wrist
      // left to follow the IK chain rolls with the elbow and the grip slides
      // out of the palm.
      mount.getWorldQuaternion(_q);
      _q.multiply(_qp.setFromEuler(handRot));
      lowerArm.updateWorldMatrix(true, false);
      lowerArm.getWorldQuaternion(_qp);
      hand.quaternion.copy(_qp.invert().multiply(_q));
    };

    // Support hand leaves the handguard during a reload: down to the magwell,
    // across to the chest pouches, and back. This is the single most legible
    // "that player is reloading" cue there is.
    let supportReach: Vector3 | null = null;
    if (this.reloadBlend > 0.02) {
      const p = clamp(this.state.reloadProgress, 0, 1);
      const magwell = _v.set(def.rightGrip[0] - 0.01, def.rightGrip[1] + 0.02, def.rightGrip[2] - 0.09);
      const pouch = new Vector3(-0.16, -0.16, 0.16);
      const guard = new Vector3(
        def.leftGrip[0] + SUPPORT_PALM.x,
        def.leftGrip[1] + SUPPORT_PALM.y,
        def.leftGrip[2] + SUPPORT_PALM.z,
      );
      const stage =
        p < 0.3 ? magwell.clone().lerp(pouch, smoothstep(p / 0.3))
          : p < 0.55 ? pouch.clone()
            : p < 0.8 ? pouch.clone().lerp(magwell, smoothstep((p - 0.55) / 0.25))
              : magwell.clone().lerp(guard, smoothstep((p - 0.8) / 0.2));
      supportReach = guard.lerp(stage, this.reloadBlend);
    }

    solve(TRIGGER, def.rightGrip, TRIGGER_PALM, TRIGGER_HAND_ROT, POLE_TRIGGER, null);
    solve(SUPPORT, def.leftGrip, SUPPORT_PALM, SUPPORT_HAND_ROT, POLE_SUPPORT, supportReach);
    void gun;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig.root);
    if (this.gun) this.rig.weaponMount.remove(this.gun.root);
    this.gun = null;
  }
}

/**
 * Elbow hints, in the rig's own frame. Both elbows go down and out — a shooter
 * tucks the firing elbow in and drives the support elbow under the handguard,
 * and getting these backwards produces the chicken-wing pose that is the
 * classic tell of an unhinted IK arm.
 */
const POLE_TRIGGER = new Vector3(0.52, 0.62, 0.34);
const POLE_SUPPORT = new Vector3(-0.78, 0.5, -0.22);

const AXIS_X = new Vector3(1, 0, 0);
