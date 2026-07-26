import { Color, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { BoneName, ZombieRig, buildZombieMesh } from './ZombieMesh';
import { ZombieAnimator } from './ZombieAnimations';
import { Rng, TAU, clamp, damp } from '../util/math';

/**
 * A single zombie: health, hitboxes, steering state and damage reactions.
 *
 * Hitboxes are capsules defined between pairs of bones and evaluated from the
 * live skeleton, so they follow the animation rather than approximating it with
 * a static box. That is what makes headshots feel earned — the head capsule is
 * where the head actually is mid-lunge, not where the model's origin says it is.
 */

export type ZombieState = 'idle' | 'chasing' | 'attacking' | 'vaulting' | 'dying' | 'dead';

export type ZombieKind = 'walker' | 'sprinter' | 'brute';

export interface ZombieKindDef {
  kind: ZombieKind;
  healthMultiplier: number;
  speedMultiplier: number;
  damage: number;
  bulk: number;
  height: number;
  /** Points awarded for a killing blow. */
  killPoints: number;
  tint: number;
}

export const ZOMBIE_KINDS: Record<ZombieKind, ZombieKindDef> = {
  walker: {
    kind: 'walker',
    healthMultiplier: 1,
    speedMultiplier: 1,
    damage: 26,
    bulk: 1,
    height: 1,
    killPoints: 60,
    tint: 0xffffff,
  },
  sprinter: {
    kind: 'sprinter',
    healthMultiplier: 0.68,
    speedMultiplier: 1.72,
    damage: 20,
    bulk: 0.86,
    height: 0.97,
    killPoints: 80,
    tint: 0xc8bda8,
  },
  brute: {
    kind: 'brute',
    healthMultiplier: 3.6,
    speedMultiplier: 0.72,
    damage: 52,
    bulk: 1.32,
    height: 1.12,
    killPoints: 140,
    tint: 0x9aa39a,
  },
};

interface Hitbox {
  from: BoneName;
  /** null means "extend past `from` along its parent axis" — used for the head. */
  to: BoneName | null;
  extend: Vector3 | null;
  radius: number;
  multiplier: number;
  label: 'head' | 'torso' | 'limb';
}

const HITBOXES: Hitbox[] = [
  { from: 'head', to: null, extend: new Vector3(0, 0.2, 0), radius: 0.115, multiplier: 1, label: 'head' },
  { from: 'hips', to: 'chest', extend: null, radius: 0.2, multiplier: 1, label: 'torso' },
  { from: 'chest', to: 'neck', extend: null, radius: 0.19, multiplier: 1, label: 'torso' },
  { from: 'upperArmL', to: 'lowerArmL', extend: null, radius: 0.085, multiplier: 0.65, label: 'limb' },
  { from: 'lowerArmL', to: 'handL', extend: null, radius: 0.07, multiplier: 0.6, label: 'limb' },
  { from: 'upperArmR', to: 'lowerArmR', extend: null, radius: 0.085, multiplier: 0.65, label: 'limb' },
  { from: 'lowerArmR', to: 'handR', extend: null, radius: 0.07, multiplier: 0.6, label: 'limb' },
  { from: 'upLegL', to: 'lowLegL', extend: null, radius: 0.11, multiplier: 0.7, label: 'limb' },
  { from: 'lowLegL', to: 'footL', extend: null, radius: 0.09, multiplier: 0.65, label: 'limb' },
  { from: 'upLegR', to: 'lowLegR', extend: null, radius: 0.11, multiplier: 0.7, label: 'limb' },
  { from: 'lowLegR', to: 'footR', extend: null, radius: 0.09, multiplier: 0.65, label: 'limb' },
];

export interface HitResult {
  distance: number;
  point: Vector3;
  label: 'head' | 'torso' | 'limb';
  multiplier: number;
}

const _a = new Vector3();
const _b = new Vector3();
const _ab = new Vector3();
const _ao = new Vector3();
const _tmp = new Vector3();
const _quat = new Quaternion();
const _tint = new Color();
const _white = new Color(0xffffff);

/** Ray vs capsule. Returns the entry distance, or -1 on a miss. */
function rayCapsule(
  origin: Vector3,
  dir: Vector3,
  a: Vector3,
  b: Vector3,
  radius: number,
  maxDist: number,
): number {
  _ab.subVectors(b, a);
  _ao.subVectors(origin, a);

  const abab = _ab.dot(_ab);
  const abd = _ab.dot(dir);
  const abao = _ab.dot(_ao);

  // Solve the infinite-cylinder quadratic in the ray parameter.
  const m = abab - abd * abd;
  const n = abab * _ao.dot(_ao) - abao * abao - radius * radius * abab;

  if (Math.abs(m) > 1e-8) {
    const k = abab * _ao.dot(dir) - abd * abao;
    const disc = k * k - m * n;
    if (disc >= 0) {
      const t = (-k - Math.sqrt(disc)) / m;
      if (t >= 0 && t <= maxDist) {
        const along = (abao + t * abd) / abab;
        if (along >= 0 && along <= 1) return t;
      }
    }
  }

  // Fall back to the hemispherical end caps.
  let best = -1;
  for (const centre of [a, b]) {
    _tmp.subVectors(origin, centre);
    const bq = _tmp.dot(dir);
    const cq = _tmp.dot(_tmp) - radius * radius;
    const disc = bq * bq - cq;
    if (disc < 0) continue;
    const t = -bq - Math.sqrt(disc);
    if (t >= 0 && t <= maxDist && (best < 0 || t < best)) best = t;
  }
  return best;
}

export class Zombie {
  readonly rig: ZombieRig;
  readonly animator: ZombieAnimator;
  readonly position = new Vector3();
  readonly velocity = new Vector3();

  def: ZombieKindDef = ZOMBIE_KINDS.walker;
  state: ZombieState = 'dead';
  health = 100;
  maxHealth = 100;
  yaw = 0;
  baseSpeed = 1.5;
  active = false;

  /** Seconds until the next melee swing can land. */
  attackCooldown = 0;
  /** Set while the attack animation is in its damage window. */
  private attackWindowUsed = false;
  private attackTimer = 0;
  private deathTimer = 0;
  private flashTimer = 0;

  /** Radius used for separation and player-collision. */
  readonly radius = 0.34;

  private readonly rng: Rng;
  private readonly baseSkinColor = new Color();
  private readonly skinMaterial: MeshStandardMaterial;

  constructor(seed: number) {
    this.rng = new Rng(seed * 2654435761);
    this.rig = buildZombieMesh(seed);
    this.animator = new ZombieAnimator(this.rig, this.rng);
    this.skinMaterial = this.rig.skin.material as MeshStandardMaterial;
    this.baseSkinColor.copy(this.skinMaterial.color);
    this.rig.root.visible = false;
  }

  spawn(at: Vector3, def: ZombieKindDef, health: number, speed: number) {
    this.def = def;
    this.maxHealth = health;
    this.health = health;
    this.baseSpeed = speed;
    this.position.copy(at);
    this.velocity.set(0, 0, 0);
    this.yaw = this.rng.range(0, TAU);
    this.state = 'chasing';
    this.active = true;
    this.attackCooldown = this.rng.range(0.2, 0.8);
    this.deathTimer = 0;
    this.flashTimer = 0;

    this.rig.root.visible = true;
    this.rig.root.position.copy(at);
    // Kind tints multiply the per-instance skin colour chosen at build time.
    this.skinMaterial.color.copy(this.baseSkinColor).multiply(_tint.setHex(def.tint));
    this.animator.reset();
    this.animator.play('walk', 0);
  }

  despawn() {
    this.active = false;
    this.state = 'dead';
    this.rig.root.visible = false;
  }

  get eyeHeight() {
    return this.rig.height * 0.9;
  }

  /** Centre of mass, used for audio and AI targeting. */
  centre(out = new Vector3()): Vector3 {
    return out.set(this.position.x, this.position.y + this.rig.height * 0.55, this.position.z);
  }

  /**
   * Tests a ray against every hitbox capsule and returns the nearest hit.
   * Bone matrices must be current — the manager updates them before firing.
   */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): HitResult | null {
    if (!this.active || this.state === 'dead') return null;

    // Cheap reject: sphere around the whole body.
    _tmp.copy(this.position).setY(this.position.y + this.rig.height * 0.5).sub(origin);
    const along = _tmp.dot(dir);
    if (along < -1.2 || along > maxDist + 1.2) return null;
    if (_tmp.lengthSq() - along * along > 1.6) return null;

    let best: HitResult | null = null;
    for (const box of HITBOXES) {
      const boneA = this.rig.bones[box.from];
      _a.setFromMatrixPosition(boneA.matrixWorld);
      if (box.to) {
        _b.setFromMatrixPosition(this.rig.bones[box.to].matrixWorld);
      } else {
        // Head: extend upward in the bone's own frame.
        boneA.getWorldQuaternion(_quat);
        _b.copy(box.extend!).applyQuaternion(_quat).add(_a);
      }
      const t = rayCapsule(origin, dir, _a, _b, box.radius * this.def.bulk, maxDist);
      if (t >= 0 && (!best || t < best.distance)) {
        best = {
          distance: t,
          point: new Vector3().copy(origin).addScaledVector(dir, t),
          label: box.label,
          multiplier: box.multiplier,
        };
      }
    }
    return best;
  }

  /** Applies damage. Returns true if this blow killed the zombie. */
  takeDamage(amount: number, hit: HitResult): boolean {
    if (this.state === 'dying' || this.state === 'dead') return false;
    this.health -= amount;
    this.flashTimer = 0.11;
    // Bigger hits stagger harder; a headshot always flinches.
    this.animator.flinch(clamp(amount / this.maxHealth, 0.25, 1) + (hit.label === 'head' ? 0.4 : 0));

    if (this.health <= 0) {
      this.state = 'dying';
      this.deathTimer = 0;
      this.animator.playOneShot('death');
      return true;
    }
    return false;
  }

  /** Advances state that does not depend on the world (called by the manager). */
  update(dt: number, playerPos: Vector3, playerRadius: number, onAttack: (damage: number) => void) {
    if (!this.active) return;

    this.animator.update(dt);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      // Brief white flash on the skin so hits register even in a dark corner.
      const k = clamp(this.flashTimer / 0.11, 0, 1);
      this.skinMaterial.color
        .copy(this.baseSkinColor)
        .multiply(_tint.setHex(this.def.tint))
        .lerp(_white, k * 0.75);
    }

    if (this.state === 'dying') {
      this.deathTimer += dt;
      // Bodies linger briefly, then despawn to keep the draw count in check.
      if (this.deathTimer > 4.5) this.despawn();
      this.rig.root.position.copy(this.position);
      this.rig.root.rotation.y = this.yaw;
      return;
    }

    _tmp.subVectors(playerPos, this.position);
    _tmp.y = 0;
    const distance = _tmp.length();
    const reach = this.radius * this.def.bulk + playerRadius + 0.55;

    if (this.state === 'attacking') {
      this.attackTimer += dt;
      // The damage window sits on the strike keyframe, not at the start.
      if (!this.attackWindowUsed && this.attackTimer > 0.5) {
        this.attackWindowUsed = true;
        if (distance < reach + 0.35) onAttack(this.def.damage);
      }
      if (this.attackTimer > 0.95) {
        this.state = 'chasing';
        this.attackCooldown = this.rng.range(0.35, 0.75);
      }
    } else if (distance < reach && this.attackCooldown <= 0) {
      this.state = 'attacking';
      this.attackTimer = 0;
      this.attackWindowUsed = false;
      this.animator.playOneShot('attack');
    } else {
      this.attackCooldown -= dt;
      this.state = 'chasing';
    }

    // Face the direction of travel, or the player when close enough to matter.
    if (distance > 0.01) {
      const desiredYaw =
        distance < 3 || this.velocity.lengthSq() < 0.04
          ? Math.atan2(_tmp.x, _tmp.z)
          : Math.atan2(this.velocity.x, this.velocity.z);
      // Shortest-arc turn.
      let delta = desiredYaw - this.yaw;
      while (delta > Math.PI) delta -= TAU;
      while (delta < -Math.PI) delta += TAU;
      this.yaw += delta * (1 - Math.exp(-6 * dt));
    }

    const speed = this.velocity.length();
    if (this.state !== 'attacking') {
      this.animator.play(speed > this.baseSpeed * 1.35 ? 'run' : 'walk', 0.3);
    }

    this.rig.root.position.copy(this.position);
    // Model faces -Z, so add PI to point it down +yaw.
    this.rig.root.rotation.y = this.yaw + Math.PI;
  }

  /** Smoothly settles the body onto the floor height under it. */
  setGroundHeight(y: number, dt: number) {
    this.position.y = damp(this.position.y, y, 12, dt);
  }
}
