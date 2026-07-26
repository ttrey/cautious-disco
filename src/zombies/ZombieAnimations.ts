import {
  AnimationClip,
  AnimationMixer,
  AnimationAction,
  Euler,
  InterpolateSmooth,
  LoopOnce,
  LoopRepeat,
  Object3D,
  Quaternion,
  QuaternionKeyframeTrack,
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
  hips: [0.06, 0, 0],
  spine: [0.14, 0, 0.02],
  chest: [0.12, 0, -0.03],
  neck: [-0.1, 0, 0.06],
  head: [0.18, 0.1, -0.12],
  clavicleL: [0, 0, -0.24],
  clavicleR: [0, 0, 0.24],
  upperArmL: [-0.6, 0, -0.34],
  upperArmR: [-0.55, 0, 0.3],
  lowerArmL: [-0.85, 0, 0],
  lowerArmR: [-0.95, 0, 0],
  handL: [-0.3, 0, 0.2],
  handR: [-0.3, 0, -0.2],
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
 */
function buildClip(spec: ClipSpec): AnimationClip {
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
      values.push(x, y, z);
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
        spine: [0.16, 0.06, 0.02], chest: [0.12, -0.07, -0.03],
        upperArmL: [-0.5, 0, -0.36], upperArmR: [-0.68, 0, 0.28],
        head: [0.2, 0.14, -0.14],
      },
    },
    {
      t: 0.38,
      hips: [0.012, -0.035, 0],
      pose: {
        upLegL: [0.06, 0, 0.03], lowLegL: [-0.5, 0, 0], footL: [0.16, 0, 0],
        upLegR: [0.06, 0, -0.03], lowLegR: [-0.16, 0, 0], footR: [0.1, 0, 0],
        spine: [0.2, 0, 0.05], chest: [0.14, 0, -0.02],
        upperArmL: [-0.58, 0, -0.34], upperArmR: [-0.6, 0, 0.3],
        head: [0.24, 0.04, -0.06],
      },
    },
    {
      t: 0.75,
      hips: [0, 0.01, 0],
      pose: {
        // The dragging leg: it never fully lifts.
        upLegL: [-0.26, 0, 0.03], lowLegL: [-0.1, 0, 0], footL: [0.26, 0, 0],
        upLegR: [0.36, 0, -0.03], lowLegR: [-0.34, 0, 0], footR: [0.04, 0, 0],
        spine: [0.16, -0.06, 0.02], chest: [0.12, 0.07, -0.04],
        upperArmL: [-0.66, 0, -0.3], upperArmR: [-0.48, 0, 0.34],
        head: [0.16, -0.08, -0.16],
      },
    },
    {
      t: 1.14,
      hips: [-0.012, -0.03, 0],
      pose: {
        upLegL: [0.04, 0, 0.03], lowLegL: [-0.2, 0, 0], footL: [0.12, 0, 0],
        upLegR: [0.04, 0, -0.03], lowLegR: [-0.42, 0, 0], footR: [0.14, 0, 0],
        spine: [0.2, 0, 0.03], chest: [0.14, 0, -0.03],
        upperArmL: [-0.56, 0, -0.34], upperArmR: [-0.58, 0, 0.3],
        head: [0.22, 0.02, -0.1],
      },
    },
    {
      t: 1.5,
      hips: [0, 0, 0],
      pose: {
        upLegL: [0.42, 0, 0.03], lowLegL: [-0.3, 0, 0], footL: [0.05, 0, 0],
        upLegR: [-0.3, 0, -0.03], lowLegR: [-0.12, 0, 0], footR: [0.24, 0, 0],
        spine: [0.16, 0.06, 0.02], chest: [0.12, -0.07, -0.03],
        upperArmL: [-0.5, 0, -0.36], upperArmR: [-0.68, 0, 0.28],
        head: [0.2, 0.14, -0.14],
      },
    },
  ],
};

/** Sprint: longer stride, deeper forward lean, arms thrown out ahead. */
const RUN: ClipSpec = {
  name: 'run',
  duration: 0.72,
  loop: true,
  keys: [
    {
      t: 0,
      hips: [0, 0.02, 0],
      pose: {
        hips: [0.16, 0, 0], spine: [0.24, 0.08, 0], chest: [0.16, -0.08, 0],
        upLegL: [0.78, 0, 0.04], lowLegL: [-0.6, 0, 0], footL: [0.1, 0, 0],
        upLegR: [-0.52, 0, -0.04], lowLegR: [-0.5, 0, 0], footR: [0.3, 0, 0],
        upperArmL: [-1.15, 0, -0.4], lowerArmL: [-1.0, 0, 0],
        upperArmR: [-0.85, 0, 0.34], lowerArmR: [-1.3, 0, 0],
        head: [0.1, 0.1, -0.08], neck: [-0.22, 0, 0.04],
      },
    },
    {
      t: 0.18,
      hips: [0, -0.06, 0],
      pose: {
        hips: [0.18, 0, 0], spine: [0.28, 0, 0], chest: [0.18, 0, 0],
        upLegL: [0.1, 0, 0.04], lowLegL: [-0.9, 0, 0], footL: [0.2, 0, 0],
        upLegR: [0.06, 0, -0.04], lowLegR: [-0.22, 0, 0], footR: [0.12, 0, 0],
        upperArmL: [-1.0, 0, -0.38], lowerArmL: [-1.1, 0, 0],
        upperArmR: [-1.0, 0, 0.36], lowerArmR: [-1.15, 0, 0],
        head: [0.14, 0, -0.04], neck: [-0.24, 0, 0],
      },
    },
    {
      t: 0.36,
      hips: [0, 0.02, 0],
      pose: {
        hips: [0.16, 0, 0], spine: [0.24, -0.08, 0], chest: [0.16, 0.08, 0],
        upLegL: [-0.52, 0, 0.04], lowLegL: [-0.5, 0, 0], footL: [0.3, 0, 0],
        upLegR: [0.78, 0, -0.04], lowLegR: [-0.6, 0, 0], footR: [0.1, 0, 0],
        upperArmL: [-0.85, 0, -0.34], lowerArmL: [-1.3, 0, 0],
        upperArmR: [-1.15, 0, 0.4], lowerArmR: [-1.0, 0, 0],
        head: [0.1, -0.1, -0.08], neck: [-0.22, 0, 0.04],
      },
    },
    {
      t: 0.54,
      hips: [0, -0.06, 0],
      pose: {
        hips: [0.18, 0, 0], spine: [0.28, 0, 0], chest: [0.18, 0, 0],
        upLegL: [0.06, 0, 0.04], lowLegL: [-0.22, 0, 0], footL: [0.12, 0, 0],
        upLegR: [0.1, 0, -0.04], lowLegR: [-0.9, 0, 0], footR: [0.2, 0, 0],
        upperArmL: [-1.0, 0, -0.38], lowerArmL: [-1.1, 0, 0],
        upperArmR: [-1.0, 0, 0.36], lowerArmR: [-1.15, 0, 0],
        head: [0.14, 0, -0.04], neck: [-0.24, 0, 0],
      },
    },
    {
      t: 0.72,
      hips: [0, 0.02, 0],
      pose: {
        hips: [0.16, 0, 0], spine: [0.24, 0.08, 0], chest: [0.16, -0.08, 0],
        upLegL: [0.78, 0, 0.04], lowLegL: [-0.6, 0, 0], footL: [0.1, 0, 0],
        upLegR: [-0.52, 0, -0.04], lowLegR: [-0.5, 0, 0], footR: [0.3, 0, 0],
        upperArmL: [-1.15, 0, -0.4], lowerArmL: [-1.0, 0, 0],
        upperArmR: [-0.85, 0, 0.34], lowerArmR: [-1.3, 0, 0],
        head: [0.1, 0.1, -0.08], neck: [-0.22, 0, 0.08],
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
    { t: 0, pose: { spine: [0.14, 0.04, 0.02], head: [0.2, 0.12, -0.14], upperArmL: [-0.56, 0, -0.32] } },
    { t: 1.7, pose: { spine: [0.17, -0.04, 0.04], head: [0.14, -0.1, -0.08], upperArmL: [-0.62, 0, -0.36] } },
    { t: 3.4, pose: { spine: [0.14, 0.04, 0.02], head: [0.2, 0.12, -0.14], upperArmL: [-0.56, 0, -0.32] } },
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
        spine: [0.14, 0, 0.02],
        upperArmL: [-0.6, 0, -0.34], upperArmR: [-0.55, 0, 0.3],
        lowerArmL: [-0.85, 0, 0], lowerArmR: [-0.95, 0, 0],
      },
    },
    {
      // Wind up: torso twists back, arms raise.
      t: 0.34,
      pose: {
        spine: [-0.1, -0.24, 0.02], chest: [-0.06, -0.2, 0], neck: [0.1, 0.2, 0],
        upperArmL: [-2.1, 0.2, -0.7], upperArmR: [-2.0, -0.2, 0.6],
        lowerArmL: [-0.5, 0, 0], lowerArmR: [-0.55, 0, 0],
        head: [-0.1, 0.16, -0.06],
      },
    },
    {
      // Strike.
      t: 0.5,
      pose: {
        spine: [0.34, 0.2, 0.02], chest: [0.22, 0.18, 0], neck: [-0.2, -0.14, 0],
        upperArmL: [-0.2, -0.3, -0.2], upperArmR: [-0.15, 0.3, 0.16],
        lowerArmL: [-0.3, 0, 0], lowerArmR: [-0.35, 0, 0],
        handL: [-0.7, 0, 0.3], handR: [-0.7, 0, -0.3],
        head: [0.3, -0.06, -0.1],
      },
    },
    {
      t: 0.95,
      pose: {
        spine: [0.14, 0, 0.02],
        upperArmL: [-0.6, 0, -0.34], upperArmR: [-0.55, 0, 0.3],
        lowerArmL: [-0.85, 0, 0], lowerArmR: [-0.95, 0, 0],
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
      t: 0.26,
      hips: [0, -0.16, 0.04],
      pose: {
        spine: [0.42, 0.1, 0], chest: [0.3, 0.08, 0], neck: [0.2, 0, 0], head: [0.4, 0.1, -0.1],
        upLegL: [0.6, 0, 0.1], lowLegL: [-1.1, 0, 0],
        upLegR: [0.5, 0, -0.1], lowLegR: [-1.3, 0, 0],
        upperArmL: [-0.2, 0, -0.5], upperArmR: [-0.15, 0, 0.45],
        lowerArmL: [-0.3, 0, 0], lowerArmR: [-0.3, 0, 0],
      },
    },
    {
      t: 0.66,
      hips: [0, -0.62, 0.16],
      pose: {
        hips: [1.0, 0.12, 0],
        spine: [0.5, 0.16, 0.1], chest: [0.34, 0.1, 0.08], neck: [0.3, 0, 0], head: [0.5, 0.2, -0.2],
        upLegL: [1.5, 0, 0.2], lowLegL: [-1.7, 0, 0],
        upLegR: [1.2, 0, -0.2], lowLegR: [-1.9, 0, 0],
        upperArmL: [0.4, 0, -0.7], upperArmR: [0.5, 0, 0.6],
        lowerArmL: [-0.2, 0, 0], lowerArmR: [-0.2, 0, 0],
      },
    },
    {
      t: 1.15,
      hips: [0, -0.86, 0.24],
      pose: {
        hips: [1.5, 0.16, 0.06],
        spine: [0.3, 0.2, 0.14], chest: [0.16, 0.12, 0.1], neck: [0.36, 0, 0], head: [0.2, 0.34, -0.3],
        upLegL: [1.7, 0, 0.34], lowLegL: [-1.5, 0, 0],
        upLegR: [1.4, 0, -0.3], lowLegR: [-1.8, 0, 0],
        upperArmL: [0.9, 0, -1.0], upperArmR: [1.0, 0, 0.9],
        lowerArmL: [-0.1, 0, 0], lowerArmR: [-0.1, 0, 0],
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
        spine: [-0.08, 0.1, 0.02], chest: [-0.12, 0.12, -0.03], neck: [-0.3, 0, 0.06],
        head: [-0.2, 0.16, -0.12],
        upperArmL: [-0.35, 0, -0.5], upperArmR: [-0.3, 0, 0.46],
      },
    },
    { t: 0.34, pose: {} },
  ],
};

const SPECS = [WALK, RUN, IDLE, ATTACK, DEATH, FLINCH];

let cachedClips: Record<string, AnimationClip> | null = null;

/** Clips are pose data, not per-instance state, so one set serves every zombie. */
export function zombieClips(): Record<string, AnimationClip> {
  if (!cachedClips) {
    cachedClips = {};
    for (const spec of SPECS) cachedClips[spec.name] = buildClip(spec);
  }
  return cachedClips;
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
    const clips = zombieClips();
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
    action.setEffectiveWeight(Math.min(intensity, 1) * 0.85);
    action.setEffectiveTimeScale(1.4);
    action.play();
  }

  /** True once the death clip has taken over. */
  get dead() {
    return this.locked;
  }

  reset() {
    this.locked = false;
    this.mixer.stopAllAction();
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
