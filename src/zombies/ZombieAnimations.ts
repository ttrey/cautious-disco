import {
  AnimationClip,
  AdditiveAnimationBlendMode,
  AnimationMixer,
  AnimationAction,
  AnimationUtils,
  Euler,
  InterpolateSmooth,
  LoopOnce,
  LoopRepeat,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from 'three';
import { BoneName, ZombieRig } from './ZombieMesh';
import { Rng } from '../util/math';

/**
 * Zombie animation.
 *
 * Clips are authored here as keyframed pose data and compiled into real
 * `AnimationClip`s, then played through `AnimationMixer` with proper
 * cross-fades. Going through the mixer rather than writing bone rotations
 * directly every frame is what gives clean blending between shamble, sprint,
 * attack and death without any of the popping that ad-hoc pose lerping causes.
 *
 * All rotations are Euler XYZ in radians, relative to the bind pose. The bind
 * pose is a neutral A-stance, so every clip starts by applying POSTURE — the
 * hunched, head-lolled, arms-forward stance that reads as "not alive" even
 * before anything moves.
 *
 * SIGN CONVENTION. The model faces -Z, and the two bone families point in
 * opposite directions, so "forward" is a different sign for each. Getting this
 * backwards is what buries the arms in the ribcage, so it is spelled out:
 *
 *   Spine chain (hips, spine, chest, neck, head) rests pointing +Y:
 *     x < 0  tips the top forward (-Z)      — a hunch
 *     z > 0  leans the top to the model's left (+X)
 *
 *   Limb bones (upperArm, lowerArm, hand, upLeg, lowLeg) rest pointing -Y:
 *     x > 0  swings the far end forward (-Z) — a reach, or a leg's front step
 *     z > 0  swings a LEFT limb away from the body; a RIGHT limb needs z < 0
 *
 *   Clavicles rest pointing +X (left) / -X (right):
 *     clavicleL [_, +y, -z] and clavicleR [_, -y, +z] roll the shoulder
 *     forward and drop it — the slumped shoulder line of a corpse.
 *
 * Because a clavicle's z rotation also tilts the arm's frame, an upper arm has
 * to out-abduct its clavicle's droop before it clears the ribs at all.
 */

type Pose = Partial<Record<BoneName, [number, number, number]>>;

interface Keyframe {
  t: number;
  pose: Pose;
  /** Optional root offset — hips translation relative to bind, in metres. */
  hips?: [number, number, number];
}

interface ClipSpec {
  name: string;
  duration: number;
  loop: boolean;
  keys: Keyframe[];
}

/** The stance every clip is built on top of. */
const POSTURE: Pose = {
  hips: [0, 0, 0],
  spine: [-0.13, 0, 0.02],
  chest: [-0.14, 0, -0.03],
  // The neck and head give back a little of the thoracic hunch, or the chin
  // ends up buried in the sternum and the face never reads.
  neck: [0.06, 0, 0.06],
  head: [0.06, 0.1, -0.12],
  clavicleL: [0, 0.12, -0.1],
  clavicleR: [0, -0.12, 0.1],
  // Abduction has to beat the clavicle droop (0.1) with enough left over to
  // carry the upper arm clear of a ribcage that is 0.152 m wide at the chest.
  upperArmL: [0.52, 0, 0.22],
  upperArmR: [0.46, 0, -0.2],
  lowerArmL: [0.6, 0, 0],
  lowerArmR: [0.66, 0, 0],
  // Wrists extend, so the hands dangle off the ends of forward-held forearms
  // rather than continuing the reach like a mannequin's.
  handL: [-0.3, 0, 0.18],
  handR: [-0.3, 0, -0.18],
  upLegL: [0.04, 0, 0.03],
  upLegR: [0.04, 0, -0.03],
  lowLegL: [-0.14, 0, 0],
  lowLegR: [-0.14, 0, 0],
  footL: [0.1, 0, 0],
  footR: [0.1, 0, 0],
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
  const explicit = spec.keys[index].pose[bone];
  if (explicit) return explicit;
  return POSTURE[bone] ?? [0, 0, 0];
}

/**
 * Compiles a spec into an AnimationClip. Every bone gets a track (falling back
 * to the posture pose) so that cross-fading between two clips never leaves a
 * limb stuck at whatever the previous clip left it at.
 *
 * `hipsBind` is the rig's bind-pose hips position. Keyframed hips offsets are
 * authored relative to the bind pose, but a position track is absolute — the
 * bind position has to be added in here or the pelvis snaps to the rig origin
 * and the whole body sinks into the floor the moment a clip with a hips track
 * takes over.
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
        if (dot < 0) {
          _quat.set(-_quat.x, -_quat.y, -_quat.z, -_quat.w);
        }
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
    track.setInterpolation(InterpolateSmooth);
    tracks.push(track);
  }

  return new AnimationClip(spec.name, spec.duration, tracks as never[]);
}

/* ------------------------------------------------------------------ */
/* Clip library                                                        */
/* ------------------------------------------------------------------ */

/**
 * Shamble. Deliberately asymmetric: the left leg drags, the right shoulder
 * leads, and the head lags a beat behind the torso. Symmetric walk cycles
 * read as a person, not as something that has stopped caring.
 */
const WALK: ClipSpec = {
  name: 'walk',
  duration: 1.5,
  loop: true,
  keys: [
    {
      t: 0,
      hips: [0, 0, 0],
      pose: {
        upLegL: [0.42, 0, 0.03], lowLegL: [-0.3, 0, 0], footL: [0.05, 0, 0],
        upLegR: [-0.3, 0, -0.03], lowLegR: [-0.12, 0, 0], footR: [0.24, 0, 0],
        spine: [-0.16, 0.06, 0.02], chest: [-0.12, -0.07, -0.03],
        // Left leg leads, so the right arm leads with it.
        upperArmL: [0.36, 0, 0.24], upperArmR: [0.62, 0, -0.18],
        head: [0.04, 0.14, -0.14],
      },
    },
    {
      t: 0.38,
      hips: [0.012, -0.035, 0],
      pose: {
        upLegL: [0.06, 0, 0.03], lowLegL: [-0.5, 0, 0], footL: [0.16, 0, 0],
        upLegR: [0.06, 0, -0.03], lowLegR: [-0.16, 0, 0], footR: [0.1, 0, 0],
        spine: [-0.2, 0, 0.05], chest: [-0.14, 0, -0.02],
        upperArmL: [0.5, 0, 0.22], upperArmR: [0.5, 0, -0.2],
        head: [0.0, 0.04, -0.06],
      },
    },
    {
      t: 0.75,
      hips: [0, 0.01, 0],
      pose: {
        // The dragging leg: it never fully lifts.
        upLegL: [-0.26, 0, 0.03], lowLegL: [-0.1, 0, 0], footL: [0.26, 0, 0],
        upLegR: [0.36, 0, -0.03], lowLegR: [-0.34, 0, 0], footR: [0.04, 0, 0],
        spine: [-0.16, -0.06, 0.02], chest: [-0.12, 0.07, -0.04],
        upperArmL: [0.64, 0, 0.2], upperArmR: [0.38, 0, -0.24],
        head: [0.08, -0.08, -0.16],
      },
    },
    {
      t: 1.14,
      hips: [-0.012, -0.03, 0],
      pose: {
        upLegL: [0.04, 0, 0.03], lowLegL: [-0.2, 0, 0], footL: [0.12, 0, 0],
        upLegR: [0.04, 0, -0.03], lowLegR: [-0.42, 0, 0], footR: [0.14, 0, 0],
        spine: [-0.2, 0, 0.03], chest: [-0.14, 0, -0.03],
        upperArmL: [0.52, 0, 0.22], upperArmR: [0.48, 0, -0.2],
        head: [0.02, 0.02, -0.1],
      },
    },
    {
      t: 1.5,
      hips: [0, 0, 0],
      pose: {
        upLegL: [0.42, 0, 0.03], lowLegL: [-0.3, 0, 0], footL: [0.05, 0, 0],
        upLegR: [-0.3, 0, -0.03], lowLegR: [-0.12, 0, 0], footR: [0.24, 0, 0],
        spine: [-0.16, 0.06, 0.02], chest: [-0.12, -0.07, -0.03],
        upperArmL: [0.36, 0, 0.24], upperArmR: [0.62, 0, -0.18],
        head: [0.04, 0.14, -0.14],
      },
    },
  ],
};

/**
 * Sprint: longer stride, deeper forward lean, arms thrown out ahead.
 *
 * The pelvis stays level and the stride angles are absolute. Carrying the lean
 * on `hips` instead would rotate the legs with it, so every leg key would have
 * to be read as an offset from the torso — and the clip drifts out of step with
 * the walk, whose pelvis is level, the moment either one is retuned.
 */
const RUN: ClipSpec = {
  name: 'run',
  duration: 0.72,
  loop: true,
  keys: [
    {
      t: 0,
      hips: [0, 0.02, 0],
      pose: {
        spine: [-0.3, 0.08, 0], chest: [-0.24, -0.08, 0],
        upLegL: [0.94, 0, 0.04], lowLegL: [-0.6, 0, 0], footL: [0.1, 0, 0],
        upLegR: [-0.36, 0, -0.04], lowLegR: [-0.5, 0, 0], footR: [0.3, 0, 0],
        upperArmL: [1.2, 0, 0.26], lowerArmL: [0.3, 0, 0],
        upperArmR: [0.95, 0, -0.22], lowerArmR: [0.5, 0, 0],
        head: [0.2, 0.1, -0.08], neck: [0.22, 0, 0.04],
      },
    },
    {
      t: 0.18,
      hips: [0, -0.06, 0],
      pose: {
        spine: [-0.34, 0, 0], chest: [-0.26, 0, 0],
        upLegL: [0.28, 0, 0.04], lowLegL: [-0.9, 0, 0], footL: [0.2, 0, 0],
        upLegR: [0.24, 0, -0.04], lowLegR: [-0.22, 0, 0], footR: [0.12, 0, 0],
        upperArmL: [1.05, 0, 0.24], lowerArmL: [0.42, 0, 0],
        upperArmR: [1.05, 0, -0.24], lowerArmR: [0.42, 0, 0],
        head: [0.24, 0, -0.04], neck: [0.24, 0, 0],
      },
    },
    {
      t: 0.36,
      hips: [0, 0.02, 0],
      pose: {
        spine: [-0.3, -0.08, 0], chest: [-0.24, 0.08, 0],
        upLegL: [-0.36, 0, 0.04], lowLegL: [-0.5, 0, 0], footL: [0.3, 0, 0],
        upLegR: [0.94, 0, -0.04], lowLegR: [-0.6, 0, 0], footR: [0.1, 0, 0],
        upperArmL: [0.95, 0, 0.2], lowerArmL: [0.5, 0, 0],
        upperArmR: [1.2, 0, -0.28], lowerArmR: [0.3, 0, 0],
        head: [0.2, -0.1, -0.08], neck: [0.22, 0, 0.04],
      },
    },
    {
      t: 0.54,
      hips: [0, -0.06, 0],
      pose: {
        spine: [-0.34, 0, 0], chest: [-0.26, 0, 0],
        upLegL: [0.24, 0, 0.04], lowLegL: [-0.22, 0, 0], footL: [0.12, 0, 0],
        upLegR: [0.28, 0, -0.04], lowLegR: [-0.9, 0, 0], footR: [0.2, 0, 0],
        upperArmL: [1.05, 0, 0.24], lowerArmL: [0.42, 0, 0],
        upperArmR: [1.05, 0, -0.24], lowerArmR: [0.42, 0, 0],
        head: [0.24, 0, -0.04], neck: [0.24, 0, 0],
      },
    },
    {
      t: 0.72,
      hips: [0, 0.02, 0],
      pose: {
        spine: [-0.3, 0.08, 0], chest: [-0.24, -0.08, 0],
        upLegL: [0.94, 0, 0.04], lowLegL: [-0.6, 0, 0], footL: [0.1, 0, 0],
        upLegR: [-0.36, 0, -0.04], lowLegR: [-0.5, 0, 0], footR: [0.3, 0, 0],
        upperArmL: [1.2, 0, 0.26], lowerArmL: [0.3, 0, 0],
        upperArmR: [0.95, 0, -0.22], lowerArmR: [0.5, 0, 0],
        head: [0.2, 0.1, -0.08], neck: [0.22, 0, 0.08],
      },
    },
  ],
};

/** Idle sway for zombies that have lost their target. */
const IDLE: ClipSpec = {
  name: 'idle',
  duration: 3.4,
  loop: true,
  keys: [
    { t: 0, pose: { spine: [-0.13, 0.04, 0.02], head: [0.08, 0.12, -0.14], upperArmL: [0.48, 0, 0.23] } },
    { t: 1.7, pose: { spine: [-0.17, -0.04, 0.04], head: [0.02, -0.1, -0.08], upperArmL: [0.56, 0, 0.2] } },
    { t: 3.4, pose: { spine: [-0.13, 0.04, 0.02], head: [0.08, 0.12, -0.14], upperArmL: [0.48, 0, 0.23] } },
  ],
};

/** Two-handed overhead swipe. Wind-up is slow, the strike is fast. */
const ATTACK: ClipSpec = {
  name: 'attack',
  duration: 0.95,
  loop: false,
  keys: [
    {
      t: 0,
      pose: {
        spine: [-0.13, 0, 0.02],
        upperArmL: [0.52, 0, 0.22], upperArmR: [0.46, 0, -0.2],
        lowerArmL: [0.6, 0, 0], lowerArmR: [0.66, 0, 0],
      },
    },
    {
      // Wind up: torso twists and straightens, arms rise up and behind the
      // head. An upper arm past -PI/2 is above the shoulder and *behind* it,
      // which is what makes the strike slerp forward over the top rather than
      // taking the short way down through the hips.
      t: 0.34,
      pose: {
        spine: [0.06, -0.24, 0.02], chest: [0.04, -0.2, 0], neck: [-0.1, 0.2, 0],
        upperArmL: [-2.5, 0.2, 0.7], upperArmR: [-2.4, -0.2, -0.6],
        lowerArmL: [0.6, 0, 0], lowerArmR: [0.65, 0, 0],
        head: [-0.02, 0.16, -0.06],
      },
    },
    {
      // Strike: everything comes down and forward at once.
      t: 0.5,
      pose: {
        spine: [-0.34, 0.2, 0.02], chest: [-0.22, 0.18, 0], neck: [0.2, -0.14, 0],
        upperArmL: [1.05, -0.3, 0.24], upperArmR: [0.95, 0.3, -0.22],
        lowerArmL: [0.45, 0, 0], lowerArmR: [0.5, 0, 0],
        handL: [0.5, 0, 0.3], handR: [0.5, 0, -0.3],
        head: [0.14, -0.06, -0.1],
      },
    },
    {
      t: 0.95,
      pose: {
        spine: [-0.13, 0, 0.02],
        upperArmL: [0.52, 0, 0.22], upperArmR: [0.46, 0, -0.2],
        lowerArmL: [0.6, 0, 0], lowerArmR: [0.66, 0, 0],
      },
    },
  ],
};

/** Collapse. Legs buckle, torso folds, everything goes slack. */
const DEATH: ClipSpec = {
  name: 'death',
  duration: 1.15,
  loop: false,
  keys: [
    { t: 0, hips: [0, 0, 0], pose: {} },
    {
      // Knees buckle, torso folds over them.
      t: 0.26,
      hips: [0, -0.16, 0.04],
      pose: {
        spine: [-0.42, 0.1, 0], chest: [-0.3, 0.08, 0], neck: [-0.1, 0, 0], head: [-0.1, 0.1, -0.1],
        upLegL: [0.6, 0, 0.1], lowLegL: [-1.1, 0, 0],
        upLegR: [0.5, 0, -0.1], lowLegR: [-1.3, 0, 0],
        upperArmL: [0.25, 0, 0.55], upperArmR: [0.2, 0, -0.5],
        lowerArmL: [0.3, 0, 0], lowerArmR: [0.3, 0, 0],
      },
    },
    {
      // Pitching forward onto the face. Arm angles are chosen against the *sum*
      // of the chain above them — a pelvis rotated -1.0 and a spine rotated
      // -0.5 already point the shoulder at the ground, so an upper arm needs
      // roughly +1.6 just to hang vertically.
      t: 0.66,
      hips: [0, -0.62, 0.16],
      pose: {
        hips: [-1.0, 0.12, 0],
        spine: [-0.5, 0.12, 0.05], chest: [-0.24, 0.08, 0.04], neck: [-0.1, 0, 0], head: [0.3, 0.2, -0.2],
        upLegL: [-0.1, 0, 0.16], lowLegL: [-0.35, 0, 0],
        upLegR: [-0.16, 0, -0.14], lowLegR: [-0.3, 0, 0],
        upperArmL: [0.74, 0, 0.55], upperArmR: [0.7, 0, -0.5],
        lowerArmL: [0.3, 0, 0], lowerArmR: [0.3, 0, 0],
      },
    },
    {
      // Settled: flat on the front, legs trailing, arms splayed on the floor.
      t: 1.15,
      hips: [0, -0.86, 0.24],
      pose: {
        // Keep the twist and side-bend small. A prone body rolled by 0.3 puts
        // one shoulder in the air and drives the other hand through the floor.
        hips: [-1.35, 0.05, 0.02],
        spine: [-0.16, 0.06, 0.05], chest: [-0.06, 0.04, 0.04], neck: [-0.18, 0, 0], head: [0.24, 0.34, -0.3],
        // Limb angles here are absolute-ish: with the pelvis rotated -1.35, a
        // limb needs its own rotation near -1.5 total to lie flat, and anything
        // past that lifts it off the floor again.
        upLegL: [-0.08, 0, 0.18], lowLegL: [-0.12, 0, 0],
        upLegR: [-0.14, 0, -0.16], lowLegR: [-0.06, 0, 0],
        upperArmL: [-0.05, 0, 1.0], upperArmR: [-0.09, 0, -0.95],
        lowerArmL: [0.15, 0, 0], lowerArmR: [0.12, 0, 0],
        handL: [0, 0, 0.2], handR: [0, 0, -0.2],
      },
    },
  ],
};

/** Short flinch, played additively over locomotion when hit. */
const FLINCH: ClipSpec = {
  name: 'flinch',
  duration: 0.34,
  loop: false,
  keys: [
    { t: 0, pose: {} },
    {
      t: 0.1,
      pose: {
        // A hit knocks the hunch out of them: the spine straightens and the
        // head snaps back before the posture reasserts itself.
        spine: [0.08, 0.1, 0.02], chest: [0.12, 0.12, -0.03], neck: [0.3, 0, 0.06],
        head: [0.2, 0.16, -0.12],
        upperArmL: [0.3, 0, 0.42], upperArmR: [0.26, 0, -0.4],
      },
    },
    { t: 0.34, pose: {} },
  ],
};

const SPECS = [WALK, RUN, IDLE, ATTACK, DEATH, FLINCH];

const cachedClips = new Map<string, Record<string, AnimationClip>>();

/**
 * Clips are pose data, not per-instance state, so one set serves every zombie
 * of a given stature. Only the hips track depends on the rig — variants differ
 * by a height scale — so the cache is keyed on the bind hips position and there
 * is one set per distinct variant height, not one per zombie.
 */
export function zombieClips(hipsBind: Vector3): Record<string, AnimationClip> {
  const key = `${hipsBind.x.toFixed(4)},${hipsBind.y.toFixed(4)},${hipsBind.z.toFixed(4)}`;
  let clips = cachedClips.get(key);
  if (!clips) {
    clips = {};
    for (const spec of SPECS) {
      const clip = buildClip(spec, hipsBind);
      if (spec.name === 'flinch') AnimationUtils.makeClipAdditive(clip, 0);
      clips[spec.name] = clip;
    }
    cachedClips.set(key, clips);
  }
  return clips;
}

export type ZombieAnimName = 'walk' | 'run' | 'idle' | 'attack' | 'death' | 'flinch';

/**
 * Per-zombie animation controller. Owns a mixer and handles cross-fading,
 * playback-rate variation and one-shot layering.
 */
export class ZombieAnimator {
  readonly mixer: AnimationMixer;
  private readonly actions = {} as Record<ZombieAnimName, AnimationAction>;
  private current: ZombieAnimName = 'idle';
  private locked = false;
  /** Per-instance timing jitter so a horde never marches in lockstep. */
  private readonly rate: number;
  private readonly phase: number;

  constructor(rig: ZombieRig, rng: Rng) {
    this.mixer = new AnimationMixer(rig.root);
    const clips = zombieClips(rig.bindPositions.hips);
    this.rate = rng.range(0.86, 1.16);
    this.phase = rng.next();

    for (const [name, clip] of Object.entries(clips)) {
      const action = this.mixer.clipAction(clip);
      const key = name as ZombieAnimName;
      if (key === 'attack' || key === 'death' || key === 'flinch') {
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = key === 'death';
      } else {
        action.setLoop(LoopRepeat, Infinity);
      }
      if (key === 'flinch') {
        // FLINCH is authored from the same POSTURE baseline as locomotion.
        // Convert it to deltas so a hit can add a sharp recoil to a walk/run
        // pose instead of replacing the whole lower body for 340 ms.
        action.blendMode = AdditiveAnimationBlendMode;
        action.enabled = false;
      }
      this.actions[key] = action;
    }

    this.actions.idle.play();
    this.actions.idle.time = this.phase * this.actions.idle.getClip().duration;
  }

  /** Cross-fades the locomotion layer. Ignored while a one-shot has control. */
  play(name: ZombieAnimName, fade = 0.25) {
    if (this.locked || this.current === name) return;
    const from = this.actions[this.current];
    const to = this.actions[name];
    to.enabled = true;
    to.setEffectiveTimeScale(this.rate);
    to.setEffectiveWeight(1);
    to.reset();
    to.time = this.phase * to.getClip().duration;
    to.play();
    from.crossFadeTo(to, fade, false);
    this.current = name;
  }

  /** Plays attack/death, taking exclusive control until it finishes. */
  playOneShot(name: 'attack' | 'death', onFinish?: () => void) {
    const action = this.actions[name];
    const from = this.actions[this.current];
    action.reset();
    action.setEffectiveTimeScale(name === 'death' ? 1 : this.rate);
    action.setEffectiveWeight(1);
    action.enabled = true;
    action.play();
    from.crossFadeTo(action, 0.12, false);

    if (name === 'death') this.locked = true;

    const handler = (e: { action: AnimationAction }) => {
      if (e.action !== action) return;
      this.mixer.removeEventListener('finished', handler as never);
      if (name === 'attack') {
        // Hand control back to locomotion.
        const back = this.actions[this.current];
        back.enabled = true;
        back.setEffectiveWeight(1);
        back.play();
        action.crossFadeTo(back, 0.2, false);
      }
      onFinish?.();
    };
    this.mixer.addEventListener('finished', handler as never);
  }

  /** Layered hit reaction — does not interrupt whatever is playing. */
  flinch(intensity: number) {
    if (this.locked) return;
    const action = this.actions.flinch;
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(Math.min(intensity, 1) * 0.85);
    action.setEffectiveTimeScale(1.4);
    action.play();
    const handler = (e: { action: AnimationAction }) => {
      if (e.action !== action) return;
      this.mixer.removeEventListener('finished', handler as never);
      action.stop();
      action.enabled = false;
    };
    this.mixer.addEventListener('finished', handler as never);
  }

  /** True once the death clip has taken over. */
  get dead() {
    return this.locked;
  }

  reset() {
    this.locked = false;
    this.mixer.stopAllAction();
    this.actions.flinch.enabled = false;
    this.actions.idle.reset().play();
    this.current = 'idle';
  }

  update(dt: number) {
    this.mixer.update(dt);
  }

  dispose(root: Object3D) {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(root);
  }
}
