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
  { from: 'hips', to: 'chest', extend: null, radius: 0.27, multiplier: 1, label: 'torso' },
  { from: 'chest', to: 'neck', extend: null, radius: 0.225, multiplier: 1, label: 'torso' },
  { from: 'upperArmL', to: 'lowerArmL', extend: null, radius: 0.095, multiplier: 0.65, label: 'limb' },
  { from: 'lowerArmL', to: 'handL', extend: null, radius: 0.07, multiplier: 0.6, label: 'limb' },
  { from: 'upperArmR', to: 'lowerArmR', extend: null, radius: 0.095, multiplier: 0.65, label: 'limb' },
  { from: 'lowerArmR', to: 'handR', extend: null, radius: 0.07, multiplier: 0.6, label: 'limb' },
  { from: 'upLegL', to: 'lowLegL', extend: null, radius: 0.155, multiplier: 0.7, label: 'limb' },
  { from: 'lowLegL', to: 'footL', extend: null, radius: 0.1, multiplier: 0.65, label: 'limb' },
  { from: 'upLegR', to: 'lowLegR', extend: null, radius: 0.155, multiplier: 0.7, label: 'limb' },
  { from: 'lowLegR', to: 'footR', extend: null, radius: 0.1, multiplier: 0.65, label: 'limb' },
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

  /**
   * Which player in the lobby this body is going for. Meaningless in single
   * player, and set by the host in co-op — it is what stops a zombie mauling
   * one operator from also chewing on the teammate who happened to be standing
   * beside them.
   */
  targetIndex = 0;

  private readonly rng: Rng;
  private readonly baseSkinColor = new Color();
  private readonly baseClothColor = new Color();
  private readonly skinMaterial: MeshStandardMaterial;
  private readonly clothMaterial: MeshStandardMaterial;
  /** Root scale is the visual kind silhouette; hit capsules use the same scale. */
  private modelBulk = 1;
  private modelHeight = 1;
  /**
   * Visual-only animation scheduler. The mixer is the expensive part of a
   * zombie update; movement, steering, damage windows and hitboxes never use
   * this clock. Each pooled body gets a stable phase so nine mixers do not all
   * wake up on the same render frame and turn a small horde into a CPU spike.
   */
  private animationTimer = 0;
  private animationDeadline = 1 / 60;
  private animationCadence = 1 / 60;
  private readonly animationPhase: number;

  /** Last root transform sent to Three; static death poses need no rewrites. */
  private renderedX = Number.NaN;
  private renderedY = Number.NaN;
  private renderedZ = Number.NaN;
  private renderedYaw = Number.NaN;

  constructor(seed: number) {
    this.rng = new Rng(seed * 2654435761);
    this.rig = buildZombieMesh(seed);
    this.animator = new ZombieAnimator(this.rig, this.rng);
    // Derive a cosmetic phase without consuming the gameplay RNG sequence.
    // That keeps spawn yaw and attack timing identical before and after this
    // optimization while distributing mixer work across the frame.
    this.animationPhase = ((seed * 0.7548776662466927) % 1 + 1) % 1;
    this.skinMaterial = this.rig.skin.material as MeshStandardMaterial;
    this.clothMaterial = this.rig.clothes.material as MeshStandardMaterial;
    this.baseSkinColor.copy(this.skinMaterial.color);
    this.baseClothColor.copy(this.clothMaterial.color);
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
    this.animationTimer = 0;
    this.animationCadence = 1 / 60;
    this.animationDeadline = (0.45 + this.animationPhase * 0.55) * this.animationCadence;
    this.renderedX = Number.NaN;
    this.renderedY = Number.NaN;
    this.renderedZ = Number.NaN;
    this.renderedYaw = Number.NaN;
    this.modelBulk = def.bulk;
    this.modelHeight = def.height;

    this.rig.root.visible = true;
    // Kinds must read as different bodies before they move: a sprinter is
    // narrow and quick, while a brute owns more of the doorway. Scaling the
    // rig at its feet preserves the nav contract and lets raycast use the
    // exact same scale for the animated hit capsules below.
    this.rig.root.scale.set(this.modelBulk, this.modelHeight, this.modelBulk);
    this.syncVisualTransform(Math.PI);
    // Kind tints multiply the per-instance skin colour chosen at build time.
    this.skinMaterial.color.copy(this.baseSkinColor).multiply(_tint.setHex(def.tint));
    this.clothMaterial.color.copy(this.baseClothColor).multiplyScalar(def.kind === 'brute' ? 0.88 : 1);
    this.animator.reset();
    this.animator.play('walk', 0);
  }

  despawn() {
    this.active = false;
    this.state = 'dead';
    this.rig.root.visible = false;
  }

  private syncVisualTransform(yawOffset: number) {
    if (
      this.renderedX !== this.position.x ||
      this.renderedY !== this.position.y ||
      this.renderedZ !== this.position.z
    ) {
      this.rig.root.position.copy(this.position);
      this.renderedX = this.position.x;
      this.renderedY = this.position.y;
      this.renderedZ = this.position.z;
    }

    const rootYaw = this.yaw + yawOffset;
    if (this.renderedYaw !== rootYaw) {
      this.rig.root.rotation.y = rootYaw;
      this.renderedYaw = rootYaw;
    }
  }

  get eyeHeight() {
    return this.rig.height * this.modelHeight * 0.9;
  }

  /** Centre of mass, used for audio and AI targeting. */
  centre(out = new Vector3()): Vector3 {
    return out.set(
      this.position.x,
      this.position.y + this.rig.height * this.modelHeight * 0.55,
      this.position.z,
    );
  }

  /**
   * Tests a ray against every hitbox capsule and returns the nearest hit.
   * Bone matrices must be current — the manager updates them before firing.
   */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): HitResult | null {
    if (!this.active || this.state === 'dead') return null;

    // Cheap reject: sphere around the whole body.
    _tmp.copy(this.position)
      .setY(this.position.y + this.rig.height * this.modelHeight * 0.5)
      .sub(origin);
    const along = _tmp.dot(dir);
    if (along < -1.2 || along > maxDist + 1.2) return null;
    if (_tmp.lengthSq() - along * along > 1.6) return null;

    // Only a body that passed the coarse test needs current bone matrices.
    // Rendering updates every visible rig later; doing it here keeps accurate
    // same-frame hitboxes without forcing all active skeletons every frame.
    this.rig.root.updateMatrixWorld(true);

    let best: HitResult | null = null;
    for (const box of HITBOXES) {
      const boneA = this.rig.bones[box.from];
      _a.setFromMatrixPosition(boneA.matrixWorld);
      if (box.to) {
        _b.setFromMatrixPosition(this.rig.bones[box.to].matrixWorld);
      } else {
        // Head: extend upward in the bone's own frame.
        boneA.getWorldQuaternion(_quat);
        _b.copy(box.extend!).multiplyScalar(this.modelHeight).applyQuaternion(_quat).add(_a);
      }
      // Bone endpoints already include root scale. Scaling the radius by the
      // same horizontal factor keeps the capsule tight to the visible limb
      // instead of making the brute's hitbox twice as wide as its mesh.
      const t = rayCapsule(origin, dir, _a, _b, box.radius * this.modelBulk, maxDist);
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
    this.flashTimer = Math.max(this.flashTimer, 0.13);
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

  /**
   * The visible half of taking a hit, with none of the bookkeeping.
   *
   * A client in a co-op game raycasts against bodies it does not own. It should
   * still flash and flinch the moment the shot lands — waiting for the host to
   * confirm would put a round trip between pulling the trigger and seeing
   * anything happen, which is the difference between a gun that feels connected
   * and one that feels broken. What it must *not* do is subtract health or
   * decide the zombie is dead; only the host gets to say that.
   */
  reactToHit(hit: HitResult) {
    if (this.state === 'dying' || this.state === 'dead') return;
    this.flashTimer = Math.max(this.flashTimer, 0.13);
    this.animator.flinch(0.35 + (hit.label === 'head' ? 0.4 : 0));
  }

  /** 0..1 progress through the current melee swing, for authored lunges. */
  get attackProgress() {
    return this.state === 'attacking' ? clamp(this.attackTimer / 0.95, 0, 1) : 0;
  }

  private shouldRun(speed: number) {
    // Sprinters are intentionally locomotion-authored runners. The old
    // speed-only test compared against 1.35x their target speed, so they
    // visually shambled while moving at their fastest gameplay pace.
    return this.def.kind === 'sprinter' || speed > this.baseSpeed * 1.16;
  }

  private updateImpactFlash(dt: number) {
    if (this.flashTimer <= 0) return;
    this.flashTimer -= dt;
    const k = clamp(this.flashTimer / 0.13, 0, 1);
    const skin = this.skinMaterial.color
      .copy(this.baseSkinColor)
      .multiply(_tint.setHex(this.def.tint));
    skin.lerp(_white, k * 0.78);
    this.clothMaterial.color.copy(this.baseClothColor).multiplyScalar(this.def.kind === 'brute' ? 0.88 : 1);
    this.clothMaterial.color.lerp(_white, k * 0.34);
  }

  /**
   * Drives a body whose position and state arrive over the network.
   *
   * The local state machine is deliberately not run here. It would be fed
   * interpolated positions of players it cannot see the input of, reach its own
   * conclusions about when to swing, and disagree with the host within a second
   * or two — at which point the zombie you are looking at is attacking
   * something the host says it is not. So the host's `state` is taken as given
   * and this only does the things that are purely local: play the right
   * animation, run the damage window if the swing is aimed at *this* machine's
   * player, and put the rig where the interpolator says it goes.
   */
  updateReplicated(
    dt: number,
    state: ZombieState,
    distanceToLocalPlayer: number,
    targetsLocalPlayer: boolean,
    onAttack: (damage: number) => void,
  ) {
    if (!this.active) return;
    this.updateAnimation(dt, distanceToLocalPlayer);

    this.updateImpactFlash(dt);

    const previous = this.state;
    this.state = state;

    if (state === 'dying') {
      if (previous !== 'dying') {
        this.deathTimer = 0;
        this.animator.playOneShot('death');
      }
      this.deathTimer += dt;
      this.syncVisualTransform(Math.PI);
      return;
    }

    if (state === 'attacking') {
      if (previous !== 'attacking') {
        this.attackTimer = 0;
        this.attackWindowUsed = false;
        this.animator.playOneShot('attack');
      }
      this.attackTimer += dt;
      // Same 0.5 s strike keyframe the local sim uses, so the hit lands on the
      // frame the animation makes contact rather than when the packet arrived.
      if (!this.attackWindowUsed && this.attackTimer > 0.5) {
        this.attackWindowUsed = true;
        const reach = this.radius * this.def.bulk + 0.34 + 0.9;
        if (targetsLocalPlayer && distanceToLocalPlayer < reach) onAttack(this.def.damage);
      }
    } else {
      const speed = this.velocity.length();
      this.animator.play(this.shouldRun(speed) ? 'run' : 'walk', 0.22);
    }

    this.syncVisualTransform(Math.PI);
  }

  /** Advances state that does not depend on the world (called by the manager). */
  update(dt: number, playerPos: Vector3, playerRadius: number, onAttack: (damage: number) => void) {
    if (!this.active) return;

    // Brief flash on flesh and cloth so a hit reads in a dark corner without
    // touching the shared gear material used by every pooled zombie.
    this.updateImpactFlash(dt);

    if (this.state === 'dying') {
      // Death is gameplay-terminal, so distant corpses can use the same visual
      // cadence as the rest of the horde without changing the damage window or
      // the brief, close-up collapse beside the player.
      this.updateAnimation(dt, this.position.distanceTo(playerPos));
      this.deathTimer += dt;
      // Bodies linger briefly, then despawn to keep the draw count in check.
      if (this.deathTimer > 2.7) this.despawn();
      this.syncVisualTransform(0);
      return;
    }

    _tmp.subVectors(playerPos, this.position);
    _tmp.y = 0;
    const distance = _tmp.length();
    this.updateAnimation(dt, distance);
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
      this.animator.play(this.shouldRun(speed) ? 'run' : 'walk', 0.22);
    }

    // Model faces -Z, so add PI to point it down +yaw.
    this.syncVisualTransform(Math.PI);
  }

  /**
   * Keeps nearby silhouettes fluid while amortising expensive skinned-mesh
   * mixer work for the back of a wave. AI and collision still run every frame;
   * only visual pose sampling is decimated.
   */
  private updateAnimation(dt: number, distance: number) {
    // Keep the silhouette nearest the operator at the original 60 Hz. At the
    // size a body occupies on screen beyond 12 m, 30 Hz is visually stable;
    // beyond 24 m the horde reads as a moving mass and 15 Hz avoids paying for
    // nineteen-bone mixer work that cannot be perceived. This is deliberately
    // independent of AI and hit testing, which remain full-rate below.
    const cadence = distance > 24 ? 1 / 15 : distance > 12 ? 1 / 30 : 1 / 60;

    if (cadence !== this.animationCadence) {
      const phase = clamp(this.animationDeadline / this.animationCadence, 0, 1);
      this.animationCadence = cadence;
      this.animationDeadline = Math.max(0.001, cadence * phase);
    }

    this.animationTimer += dt;
    if (this.animationTimer < this.animationDeadline) return;

    const step = this.animationTimer;
    const overrun = this.animationTimer - this.animationDeadline;
    this.animationTimer = 0;
    // Carry the overrun into the next deadline so each body keeps its phase
    // instead of synchronising all mixers after the first update. `step` still
    // contains the complete elapsed time, so animation speed remains correct.
    this.animationDeadline = Math.max(0.001, cadence - Math.min(overrun, cadence * 0.9));
    this.animator.update(step);
  }

  /** Smoothly settles the body onto the floor height under it. */
  setGroundHeight(y: number, dt: number) {
    this.position.y = damp(this.position.y, y, 12, dt);
  }
}
