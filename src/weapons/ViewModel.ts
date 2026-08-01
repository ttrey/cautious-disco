import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  Texture,
  Vector3,
} from 'three';
import { GunModel } from './GunSmith';
import { WeaponDef } from './WeaponDefs';
import { buildArms, HandRig } from './Arms';
import { solveTwoBoneIK } from '../util/ik';
import { muzzleFlashTexture, smokeTexture } from '../assets/SpriteTextures';
import { Presets } from '../assets/Materials';
import { Rng, TAU, clamp, damp, lerp, smoothstep } from '../util/math';
import { disposeModel } from '../util/dispose';

/**
 * Bone lengths, which must match the capsules and joint offsets in `Arms.ts`.
 *
 * These are the *reach budget* for both grips, and the budget has to cover the
 * longest weapon on the roster. At 0.26 + 0.24 from a shoulder set 140 mm
 * behind the eye, the envelope stopped 500 mm out — while a battle rifle's
 * handguard sits 620 mm away. `solveTwoBoneIK` clamps an unreachable target
 * into its annulus rather than failing, so the arm silently straightened and
 * parked the hand up to 120 mm short, holding air beside the weapon.
 */
const UPPER_ARM = 0.285;
const FOREARM = 0.265;
/** Full-ADS rotational viewmodel recoil relative to hip fire. */
const ADS_RECOIL_ROTATION_SCALE = 0.45;
/**
 * Full-ADS backward travel relative to hip fire.
 *
 * Translation needs heavier suppression than rotation: repeated automatic
 * shots should add a little weight, not pull the rear of the weapon into the
 * camera.
 */
const ADS_RECOIL_TRANSLATION_SCALE = 0.18;
/** Maximum visible rearward travel for the viewmodel before ADS scaling. */
const MAX_VIEWMODEL_RECOIL_TRANSLATION = 0.055;
/** Target decay and visible-offset follow rates are scaled by weapon recovery. */
const RECOIL_TRANSLATION_TARGET_DECAY_SCALE = 1.15;
const RECOIL_TRANSLATION_FOLLOW_SCALE = 6;

/**
 * Distance from the wrist joint to the middle of the palm in the active grip
 * frame. Grip points are authored where the *hand* closes; the IK solves for
 * the wrist, so each target is offset by this before being solved.
 */
const PALM_REACH = 0.045;
/** Outboard wrist offset for the support hand, so its palm clears the handguard. */
const SUPPORT_HAND_OUTBOARD = 0.035;

/**
 * How far to the side of a grip point the middle of the palm sits.
 *
 * A palm is 30 mm of meat that cannot occupy the same space as the grip it is
 * holding, so a hand solved straight onto a grip point ends up inside the
 * weapon with its fingers starting from within the frame — wrapping around
 * nothing. The palm belongs against the flank: right hand outboard on +X, left
 * hand on -X.
 *
 * Only a small nudge lives here. The wrist's own break (see `poseWrist`) already
 * carries the hand about 18 mm outboard, and how far out the palm really needs
 * to sit depends on how thick the thing being held is — a 24 mm carbine
 * handguard and a 58 mm shotgun forend are not the same. That part is per
 * weapon, in the grip points themselves.
 */
const PALM_STANDOFF = 0.012;

/**
 * Where the shoulders sit relative to the view camera.
 *
 * Forward of a real shoulder line on purpose. The viewmodel's job is to put
 * hands on a weapon held out in front of the player, and every centimetre the
 * anchor sits behind the eye is a centimetre of reach spent before the arm
 * reaches the receiver, let alone the handguard.
 */
const LEFT_SHOULDER = new Vector3(-0.2, -0.2, 0.055);
const RIGHT_SHOULDER = new Vector3(0.2, -0.2, 0.055);

interface Shell {
  mesh: Mesh;
  vel: Vector3;
  spin: Vector3;
  life: number;
}

/**
 * The weapon viewmodel: everything the player looks at while shooting.
 *
 * Renders in its own scene through a narrow-FOV camera so the gun never clips
 * into walls. Motion is entirely procedural and layered — sway, bob, breathing,
 * recoil spring, ADS blend, sprint pose and a reload timeline all contribute
 * offsets to one base transform. Layering rather than baking means every
 * weapon gets the same weighty feel for free, and adding a gun costs only data.
 */
export class ViewModel {
  readonly root = new Group();

  private gun: GunModel | null = null;
  private def: WeaponDef | null = null;
  private readonly gunPivot = new Group();
  private readonly arms: { left: HandRig; right: HandRig };

  /** 0 = hip, 1 = fully aimed. */
  adsBlend = 0;
  private adsTarget = 0;

  /** Recoil state. Positional kick is bounded; angular kick remains spring-driven. */
  private recoilPos = 0;
  private recoilPosTarget = 0;
  private recoilPitch = 0;
  private recoilPitchVel = 0;
  private recoilYaw = 0;
  private recoilYawVel = 0;
  private recoilRoll = 0;

  /** Accumulated view punch handed back to the camera, in radians. */
  viewPunchPitch = 0;
  viewPunchYaw = 0;

  private swayX = 0;
  private swayY = 0;
  private sprintBlend = 0;
  private swapBlend = 1;
  private inspectTime = 0;

  /** Reload timeline, 0..1 while reloading, -1 when idle. */
  private reloadT = -1;
  private reloadDuration = 1;
  private reloadEmpty = false;
  private shellReloadStage = 0;

  private readonly flashGroup = new Group();
  private readonly flashPlanes: Mesh[] = [];
  private readonly flashLight: PointLight;
  private flashLife = 0;
  private readonly smokePuffs: { mesh: Mesh; life: number; vel: Vector3 }[] = [];
  private readonly smokeGeo = new PlaneGeometry(1, 1);

  private readonly shells: Shell[] = [];
  private readonly shellPool: Shell[] = [];
  private shellGeo!: BufferGeometry;

  /** Field of view of the camera this scene is drawn with; see `muzzleWorld`. */
  private viewFov = 58;

  private readonly rng = new Rng(0xbeef);
  private readonly tmpVec = new Vector3();
  private readonly tmpVec2 = new Vector3();
  private readonly tmpQuat = new Quaternion();
  private readonly gripBasis = new Matrix4();
  private readonly axisX = new Vector3();
  private readonly axisY = new Vector3();
  private readonly axisZ = new Vector3();

  constructor(private readonly viewScene: Scene) {
    this.root.add(this.gunPivot);
    viewScene.add(this.root);

    this.arms = buildArms();
    this.arms.left.root.position.copy(LEFT_SHOULDER);
    this.arms.right.root.position.copy(RIGHT_SHOULDER);
    this.root.add(this.arms.left.root, this.arms.right.root);

    // --- Muzzle flash: two crossed cards plus a bright transient light ---
    for (let i = 0; i < 3; i++) {
      const mat = new MeshBasicMaterial({
        map: muzzleFlashTexture(i),
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
        opacity: 0,
        color: new Color(0xffd9a0),
      });
      const plane = new Mesh(new PlaneGeometry(1, 1), mat);
      plane.rotation.z = (i / 3) * TAU;
      plane.visible = false;
      this.flashPlanes.push(plane);
      this.flashGroup.add(plane);
    }
    this.flashLight = new PointLight(0xffb861, 0, 6, 2);
    this.flashLight.castShadow = false;
    this.flashGroup.add(this.flashLight);
    this.gunPivot.add(this.flashGroup);

    this.buildShellGeometry();
  }

  /** Brass case: a tapered cylinder with a rim, small but readable in flight. */
  private buildShellGeometry() {
    const g = new CylinderGeometry(0.0045, 0.0052, 0.02, 10, 1, false);
    this.shellGeo = g;
  }

  equip(def: WeaponDef) {
    if (this.gun) {
      this.gunPivot.remove(this.gun.root);
      disposeModel(this.gun.root);
    }
    this.def = def;
    this.gun = def.build();
    this.gunPivot.add(this.gun.root);
    this.resetReloadParts();
    this.gunPivot.add(this.flashGroup);
    this.flashGroup.position.copy(this.gun.muzzle.position);
    this.swapBlend = 0;
    this.reloadT = -1;
    this.recoilPos = 0;
    this.recoilPosTarget = 0;
  }

  setAiming(aiming: boolean) {
    this.adsTarget = aiming ? 1 : 0;
  }

  /** True when the weapon in hand carries an optic with a sight picture. */
  get hasOptic() {
    return !!this.gun?.sightPicture;
  }

  /**
   * Binds the magnified world view to the optic's ocular, or `null` to leave
   * the tube simply open — which is the right look at the hip, where the eye is
   * nowhere near the sight and the scope should read as a hollow object.
   */
  setOpticView(texture: Texture | null) {
    const lens = this.gun?.sightPicture;
    if (!lens) return;
    const mat = lens.material as MeshBasicMaterial;
    if (mat.map !== texture) {
      mat.map = texture;
      mat.color.setHex(texture ? 0xffffff : 0x000000);
      mat.needsUpdate = true;
    }
    lens.visible = texture !== null;
  }

  startReload(duration: number, empty: boolean) {
    this.reloadT = 0;
    this.reloadDuration = duration;
    this.reloadEmpty = empty;
  }

  startShellInsert(duration: number) {
    this.reloadT = 0;
    this.reloadDuration = duration;
    this.reloadEmpty = false;
    this.shellReloadStage = (this.shellReloadStage + 1) % 2;
  }

  cancelReload() {
    this.reloadT = -1;
    this.resetReloadParts();
  }

  get reloading() {
    return this.reloadT >= 0;
  }

  /** Restores any weapon-specific reload props after a finish, cancel or swap. */
  private resetReloadParts() {
    if (!this.gun) return;
    if (this.gun.magazine) {
      this.gun.magazine.position.set(0, 0, 0);
      this.gun.magazine.rotation.set(0, 0, 0);
      this.gun.magazine.visible = true;
    }
    if (this.gun.charging) this.gun.charging.position.z = 0;
    if (this.gun.feedCover) this.gun.feedCover.rotation.set(0, 0, 0);
  }

  /** Kicks the whole weapon and returns the view punch for the camera. */
  fire(def: WeaponDef, shotIndex: number) {
    const r = def.recoil;
    const translationScale = lerp(1, ADS_RECOIL_TRANSLATION_SCALE, this.adsBlend);
    const rotationScale = lerp(1, ADS_RECOIL_ROTATION_SCALE, this.adsBlend);
    this.recoilPosTarget = clamp(
      this.recoilPosTarget + r.kick * translationScale,
      0,
      this.maxRecoilTranslation(r.kick, translationScale),
    );
    this.recoilPitchVel += (r.vertical * Math.PI) / 180 * 34 * rotationScale;

    // Alternating horizontal wander with a per-weapon directional bias makes
    // the pattern learnable instead of random.
    const wander = Math.sin(shotIndex * 2.399) * 0.6 + this.rng.range(-0.4, 0.4);
    this.recoilYawVel += ((r.horizontal * (wander + r.drift)) * Math.PI) / 180 * 30 * rotationScale;
    this.recoilRoll += (this.rng.range(-0.02, 0.02) - r.drift * 0.012) * rotationScale;

    // View punch is damped hard when aiming — a shouldered weapon moves less.
    const adsDamp = lerp(1, 0.55, this.adsBlend);
    this.viewPunchPitch += ((r.vertical * Math.PI) / 180) * adsDamp;
    this.viewPunchYaw += (((r.horizontal * wander) * Math.PI) / 180) * adsDamp;

    this.spawnFlash(def);
  }

  private spawnFlash(def: WeaponDef) {
    this.flashLife = 1;
    const baseScale = def.class === 'shotgun' ? 0.34 : def.class === 'lmg' ? 0.29 : def.class === 'rifle' ? 0.26 : 0.2;
    const scale = baseScale * (def.muzzleFlashScale ?? 1);
    const energyColor = def.wonder?.kind === 'plasma'
      ? 0x62f4ff
      : def.wonder?.kind === 'arc'
        ? 0xb29aff
        : 0xffd9a0;
    for (const p of this.flashPlanes) {
      p.visible = true;
      p.scale.setScalar(scale * this.rng.range(0.82, 1.22));
      p.rotation.z = this.rng.next() * TAU;
      const mat = p.material as MeshBasicMaterial;
      mat.color.setHex(energyColor);
      mat.opacity = this.rng.range(0.8, 1);
    }
    this.flashLight.color.setHex(energyColor);
    this.flashLight.intensity = (def.class === 'shotgun' ? 26 : def.class === 'lmg' ? 20 : 16) * (def.muzzleFlashScale ?? 1);

    // Muzzle smoke, in the viewmodel scene so it stays attached to the gun.
    if (!def.wonder && this.rng.chance(def.class === 'shotgun' ? 1 : def.class === 'lmg' ? 0.72 : 0.55)) {
      this.spawnSmoke();
    }
  }

  private spawnSmoke() {
    if (!this.gun) return;
    const mat = new MeshBasicMaterial({
      map: smokeTexture(),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      opacity: 0.34,
      color: new Color(0x9a938a),
      toneMapped: true,
    });
    const mesh = new Mesh(this.smokeGeo, mat);
    mesh.position.copy(this.gun.muzzle.position);
    mesh.scale.setScalar(0.06);
    this.gunPivot.add(mesh);
    this.smokePuffs.push({
      mesh,
      life: 1,
      vel: new Vector3(this.rng.range(-0.06, 0.06), this.rng.range(0.08, 0.2), -this.rng.range(0.2, 0.5)),
    });
  }

  /** Ejects a spinning brass case from the port. */
  ejectShell(def: WeaponDef) {
    // Both wonder weapons use sealed power cells rather than cartridge cases.
    if (!this.gun || def.wonder) return;
    let shell = this.shellPool.pop();
    if (!shell) {
      const mesh = new Mesh(this.shellGeo, Presets.brass());
      mesh.castShadow = false;
      shell = { mesh, vel: new Vector3(), spin: new Vector3(), life: 0 };
    }
    const s = shell;
    s.mesh.position.copy(this.gun.ejectPort.position);
    const baseShellScale = def.class === 'shotgun' ? 1.5 : def.class === 'lmg' ? 1.28 : def.class === 'rifle' ? 1.15 : 1;
    s.mesh.scale.setScalar(baseShellScale * (def.shellScale ?? 1));
    s.mesh.rotation.set(0, 0, Math.PI / 2);
    s.vel.set(this.rng.range(1.1, 1.9), this.rng.range(0.9, 1.6), this.rng.range(-0.3, 0.35));
    s.spin.set(this.rng.range(-24, 24), this.rng.range(-18, 18), this.rng.range(-30, 30));
    s.life = 1.5;
    this.gunPivot.add(s.mesh);
    this.shells.push(s);
  }

  /**
   * Full per-frame update. `look` is the accumulated mouse delta this frame,
   * used to drive sway; `moveIntensity` and `bob` come from the player.
   */
  update(
    dt: number,
    camera: PerspectiveCamera,
    ctx: {
      lookX: number;
      lookY: number;
      moveIntensity: number;
      bobPhase: number;
      bobAmount: number;
      sprinting: boolean;
      inspecting: boolean;
    },
  ) {
    if (!this.gun || !this.def) return;
    const def = this.def;

    // --- Blends -----------------------------------------------------------
    const canAds = !this.reloading && !ctx.sprinting;
    this.adsBlend = damp(this.adsBlend, canAds ? this.adsTarget : 0, 1 / Math.max(def.adsTime, 0.01) * 0.9, dt);
    this.sprintBlend = damp(this.sprintBlend, ctx.sprinting && !this.reloading ? 1 : 0, 9, dt);
    this.swapBlend = damp(this.swapBlend, 1, 1 / Math.max(def.swapTime, 0.05) * 1.4, dt);
    this.inspectTime = ctx.inspecting ? Math.min(this.inspectTime + dt, 2.2) : Math.max(this.inspectTime - dt * 2.5, 0);

    // --- Springs ----------------------------------------------------------
    const rec = def.recoil;
    const translationScale = lerp(1, ADS_RECOIL_TRANSLATION_SCALE, this.adsBlend);
    const maxTranslation = this.maxRecoilTranslation(rec.kick, translationScale);
    this.recoilPosTarget = clamp(
      damp(this.recoilPosTarget, 0, rec.recovery * RECOIL_TRANSLATION_TARGET_DECAY_SCALE, dt),
      0,
      maxTranslation,
    );
    this.recoilPos = clamp(
      damp(this.recoilPos, this.recoilPosTarget, rec.recovery * RECOIL_TRANSLATION_FOLLOW_SCALE, dt),
      0,
      maxTranslation,
    );
    this.recoilPitch = this.springStep(this.recoilPitch, () => this.recoilPitchVel, (v) => (this.recoilPitchVel = v), rec.recovery * 4.6, rec.recovery, dt);
    this.recoilYaw = this.springStep(this.recoilYaw, () => this.recoilYawVel, (v) => (this.recoilYawVel = v), rec.recovery * 3.6, rec.recovery * 0.85, dt);
    this.recoilRoll = damp(this.recoilRoll, 0, rec.recovery * 0.9, dt);

    // View punch decays back to centre; the camera consumes it each frame.
    this.viewPunchPitch = damp(this.viewPunchPitch, 0, rec.recovery * 0.55, dt);
    this.viewPunchYaw = damp(this.viewPunchYaw, 0, rec.recovery * 0.5, dt);

    // --- Sway: the gun lags the camera, more so at the hip ----------------
    const swayScale = lerp(1, 0.26, this.adsBlend);
    this.swayX = damp(this.swayX, clamp(-ctx.lookX * 3.4, -0.09, 0.09) * swayScale, 11, dt);
    this.swayY = damp(this.swayY, clamp(-ctx.lookY * 3.0, -0.07, 0.07) * swayScale, 11, dt);

    this.composeTransform(dt, def, ctx);
    this.updateFlash(dt);
    this.updateSmoke(dt);
    this.updateShells(dt);
    this.updateReload(dt, def);
    this.solveArms(def);

    // The viewmodel camera mirrors the world camera's orientation but sits at
    // the origin, so the weapon transform is purely local.
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    this.viewFov = camera.fov;
  }

  private maxRecoilTranslation(kick: number, translationScale: number) {
    return Math.min(MAX_VIEWMODEL_RECOIL_TRANSLATION, kick * 2 * translationScale);
  }

  /**
   * World position of the muzzle, for effects that live in the world scene.
   *
   * The viewmodel is drawn by its own narrower-FOV camera parked at the origin,
   * so a point in that scene has to be re-projected before it lines up with the
   * world camera: the same screen position needs a smaller lateral offset the
   * wider the FOV. Depth is unchanged.
   */
  muzzleWorld(worldCamera: PerspectiveCamera, out: Vector3): Vector3 {
    if (!this.gun) return out.setFromMatrixPosition(worldCamera.matrixWorld);
    this.gun.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.gun.muzzle.matrixWorld);

    const fovRatio =
      Math.tan((this.viewFov * Math.PI) / 360) / Math.tan((worldCamera.fov * Math.PI) / 360);
    out.x *= fovRatio;
    out.y *= fovRatio;

    return out.applyMatrix4(worldCamera.matrixWorld);
  }

  private springStep(
    value: number,
    getVel: () => number,
    setVel: (v: number) => void,
    stiffness: number,
    damping: number,
    dt: number,
  ): number {
    let v = getVel();
    v += (-stiffness * value - damping * v) * dt;
    setVel(v);
    return value + v * dt;
  }

  /** Builds the final gun transform from all the layered contributions. */
  private composeTransform(
    dt: number,
    def: WeaponDef,
    ctx: { moveIntensity: number; bobPhase: number; bobAmount: number; sprinting: boolean },
  ) {
    const hip = def.hipPosition;
    const t = performance.now() * 0.001;

    // Base: hip pose lerped toward the sight line for ADS. Bringing the weapon
    // to centre and lifting it by the sight height is what makes irons line up.
    // Eye relief is its own number rather than a function of the hip pose —
    // where the gun rests at the hip says nothing about how far from your eye
    // the sights should sit, and tying them together means restyling the hip
    // pose silently moves the sight picture (and pulls the grips out of arm's
    // reach).
    const adsX = 0;
    const adsY = -this.gun!.sightHeight;
    const adsZ = def.adsDistance + this.gun!.sightForward;

    let px = lerp(hip[0], adsX, this.adsBlend);
    let py = lerp(hip[1], adsY, this.adsBlend);
    let pz = lerp(hip[2], adsZ, this.adsBlend);

    // Idle breathing — slow, elliptical, and suppressed while aiming.
    const breathe = (1 - this.adsBlend * 0.72) * (1 - ctx.bobAmount * 0.6);
    px += Math.sin(t * 0.75) * 0.0032 * breathe;
    py += Math.sin(t * 1.13 + 0.9) * 0.0038 * breathe;

    // Walk bob, figure-of-eight, scaled down when aiming.
    const bobScale = ctx.bobAmount * lerp(1, 0.22, this.adsBlend);
    px += Math.cos(ctx.bobPhase) * 0.014 * bobScale;
    py += Math.sin(ctx.bobPhase * 2) * 0.011 * bobScale;

    // Sway from mouse movement.
    px += this.swayX;
    py += this.swayY;

    // Recoil pushes the weapon back and up into the shoulder.
    pz += this.recoilPos;
    py += this.recoilPos * 0.28;

    // Swap: the weapon rises into frame from below with a slight roll.
    const swapEase = smoothstep(clamp(this.swapBlend, 0, 1));
    py -= (1 - swapEase) * 0.34;
    pz += (1 - swapEase) * 0.1;

    // Sprint: canted low and away, muzzle down-left. Reads as "not ready".
    const sp = smoothstep(this.sprintBlend);
    px += sp * 0.055;
    py -= sp * 0.052;
    pz += sp * 0.03;

    // Inspect: rotate the weapon into view.
    const insp = smoothstep(clamp(this.inspectTime / 0.45, 0, 1)) * (this.inspectTime > 0 ? 1 : 0);

    this.gunPivot.position.set(px, py, pz);

    // The bore points along -Z, so positive X rotation raises the muzzle.
    let rx = lerp(def.hipRotation[0], 0, this.adsBlend) + this.recoilPitch;
    let ry = lerp(def.hipRotation[1], 0, this.adsBlend) + this.recoilYaw;
    let rz = lerp(def.hipRotation[2], 0, this.adsBlend) + this.recoilRoll;

    rx += Math.sin(t * 1.13 + 0.9) * 0.012 * breathe;
    ry += Math.sin(t * 0.75) * 0.014 * breathe;
    rx += Math.sin(ctx.bobPhase * 2 + 1.1) * 0.02 * bobScale;
    rz += Math.cos(ctx.bobPhase) * 0.03 * bobScale;
    rz -= (1 - swapEase) * 0.5;
    // Sprint cant.
    rx += sp * 0.16;
    ry -= sp * 0.42;
    rz += sp * 0.5;
    // Inspect rotation.
    ry += insp * 0.9;
    rz += insp * 0.5;
    rx += insp * 0.15;

    // Reload pose is applied on top.
    const reloadPose = this.reloadPose(def);
    this.gunPivot.position.x += reloadPose.x;
    this.gunPivot.position.y += reloadPose.y;
    this.gunPivot.position.z += reloadPose.z;
    rx += reloadPose.pitch;
    ry += reloadPose.yaw;
    rz += reloadPose.roll;

    this.gunPivot.rotation.set(rx, ry, rz);

    // Keep the flash anchored to the (possibly animated) muzzle.
    this.flashGroup.position.copy(this.gun!.muzzle.position);
    void dt;
  }

  /**
   * Reload choreography.
   *
   * Phase 1 (0–0.3): weapon tips inboard, magazine drops away.
   * Phase 2 (0.3–0.62): left hand travels off-screen to fetch a fresh mag.
   * Phase 3 (0.62–0.85): magazine seats with a firm push.
   * Phase 4 (0.85–1): bolt release / slide drop, weapon returns to rest.
   */
  private reloadPose(def: WeaponDef) {
    const out = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 };
    if (this.reloadT < 0 || !this.gun) return out;
    const p = clamp(this.reloadT, 0, 1);

    if (def.shellReload) {
      // Pump-action: the weapon dips while a shell is thumbed into the port.
      const dip = Math.sin(p * Math.PI);
      out.y = -0.05 * dip;
      out.x = 0.02 * dip;
      out.roll = 0.5 * dip;
      out.pitch = 0.12 * dip;
      return out;
    }

    if (def.reloadStyle === 'belt') {
      // Belt-fed reload: open the tray, remove the spent can, lay in a fresh
      // belt, then close the cover. This deliberately has a different beat to
      // a rifle's magazine drop, so the M240 feels like its own mechanism.
      const tip = Math.sin(clamp(p / 0.30, 0, 1) * Math.PI * 0.5) * (1 - smoothstep(clamp((p - 0.80) / 0.20, 0, 1)));
      out.roll = 0.46 * tip;
      out.yaw = 0.20 * tip;
      out.pitch = 0.11 * tip;
      out.y = -0.040 * tip;
      out.x = 0.020 * tip;

      const cover = this.gun.feedCover;
      if (cover) {
        const open = p < 0.18
          ? smoothstep(clamp(p / 0.18, 0, 1))
          : 1 - smoothstep(clamp((p - 0.77) / 0.23, 0, 1));
        // The lid's geometry extends forward (-Z) from its rear hinge. A
        // positive X rotation carries that forward edge upward; the opposite
        // sign drives it down through the receiver instead of opening it.
        cover.rotation.x = open * 0.96;
      }

      const can = this.gun.magazine;
      if (can) {
        if (p < 0.30) {
          const d = smoothstep(clamp(p / 0.30, 0, 1));
          can.position.y = -d * 0.19;
          can.position.x = d * 0.025;
          can.rotation.z = d * 0.22;
          can.visible = d < 0.96;
        } else if (p < 0.62) {
          can.visible = false;
        } else {
          const d = smoothstep(clamp((p - 0.62) / 0.22, 0, 1));
          can.visible = true;
          can.position.y = -(1 - d) * 0.15;
          can.position.x = (1 - d) * 0.018;
          can.rotation.z = (1 - d) * 0.16;
        }
      }

      if (this.gun.charging && this.reloadEmpty && p > 0.83) {
        const d = Math.sin(clamp((p - 0.83) / 0.17, 0, 1) * Math.PI);
        this.gun.charging.position.z = d * 0.062;
        out.pitch += d * 0.075;
      }
      return out;
    }

    const tip = Math.sin(clamp(p / 0.35, 0, 1) * Math.PI * 0.5) * (1 - smoothstep(clamp((p - 0.78) / 0.22, 0, 1)));
    out.roll = 0.62 * tip;
    out.yaw = 0.3 * tip;
    out.pitch = 0.18 * tip;
    out.y = -0.055 * tip;
    out.x = 0.028 * tip;

    // Magazine animation.
    const mag = this.gun.magazine;
    if (mag) {
      if (p < 0.34) {
        // Drop free.
        const d = smoothstep(clamp(p / 0.34, 0, 1));
        mag.position.y = -d * 0.4;
        mag.rotation.z = d * 0.5;
        (mag as Object3D).visible = d < 0.95;
      } else if (p < 0.62) {
        (mag as Object3D).visible = false;
      } else {
        // Insert.
        const d = smoothstep(clamp((p - 0.62) / 0.24, 0, 1));
        (mag as Object3D).visible = true;
        mag.position.y = -(1 - d) * 0.3;
        mag.rotation.z = (1 - d) * 0.28;
      }
    }

    // Charging handle / slide release on the tail of the animation.
    const charge = this.gun.charging ?? this.gun.slide;
    if (charge && this.reloadEmpty && p > 0.86) {
      const d = Math.sin(clamp((p - 0.86) / 0.14, 0, 1) * Math.PI);
      charge.position.z = d * 0.05;
      out.pitch += d * 0.09;
    }

    return out;
  }

  private updateReload(dt: number, def: WeaponDef) {
    if (this.reloadT < 0) return;
    this.reloadT += dt / this.reloadDuration;
    if (this.reloadT >= 1) {
      this.reloadT = -1;
      this.resetReloadParts();
    }
    void def;
  }

  /** Slide/bolt travel driven by the recoil spring, plus trigger finger pull. */
  private animateAction(def: WeaponDef) {
    if (!this.gun) return;
    const travel = clamp(this.recoilPos / Math.max(def.recoil.kick, 0.001), 0, 1);
    if (this.gun.slide && this.gun.slide !== this.gun.charging) {
      // The authored reciprocating part is either a pump forend or a visible
      // bolt carrier. Its per-class travel keeps the action inside the
      // receiver/forend envelope instead of clipping through the model.
      this.gun.slide.position.z = travel * (def.class === 'shotgun' ? 0.05 : def.class === 'lmg' ? 0.042 : 0.028);
    } else if (this.gun.slide) {
      this.gun.slide.position.z = travel * 0.02;
    }
    if (this.gun.trigger) {
      this.gun.trigger.rotation.x = -travel * 0.35;
    }
  }

  private updateFlash(dt: number) {
    if (this.flashLife <= 0) return;
    // Very short: a muzzle flash that lingers reads as a cartoon.
    this.flashLife -= dt * 22;
    const k = clamp(this.flashLife, 0, 1);
    this.flashLight.intensity *= Math.pow(0.0001, dt);
    for (const p of this.flashPlanes) {
      const m = p.material as MeshBasicMaterial;
      m.opacity = k * k;
      p.visible = k > 0.02;
      p.scale.multiplyScalar(1 + dt * 5);
    }
    if (this.flashLife <= 0) {
      this.flashLight.intensity = 0;
      for (const p of this.flashPlanes) p.visible = false;
    }
  }

  private updateSmoke(dt: number) {
    for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
      const s = this.smokePuffs[i];
      s.life -= dt * 0.85;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(1 - dt * 1.6);
      s.vel.y += dt * 0.14;
      s.mesh.scale.setScalar(0.06 + (1 - s.life) * 0.34);
      const m = s.mesh.material as MeshBasicMaterial;
      m.opacity = clamp(s.life, 0, 1) * 0.3;
      // Billboard toward the view camera (which sits at the origin looking -Z).
      s.mesh.quaternion.identity();
      if (s.life <= 0) {
        this.gunPivot.remove(s.mesh);
        m.dispose();
        this.smokePuffs.splice(i, 1);
      }
    }
  }

  private updateShells(dt: number) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= dt;
      s.vel.y -= 9.8 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.life <= 0) {
        this.gunPivot.remove(s.mesh);
        this.shells.splice(i, 1);
        if (this.shellPool.length < 24) this.shellPool.push(s);
      }
    }
  }

  /** Places both hands on the weapon's grips via IK. */
  private solveArms(def: WeaponDef) {
    if (!this.gun) return;
    this.animateAction(def);

    this.gunPivot.updateWorldMatrix(true, true);

    // Right hand: always on the fire control grip.
    //
    // The IK drives the *wrist joint*, which sits at the heel of the palm — but
    // a grip is held in the middle of the palm, PALM_REACH further down the
    // hand. Solving the wrist straight onto the grip point therefore parks the
    // whole hand a palm's length ahead of the grip, out over the trigger guard.
    this.tmpVec.set(def.rightGrip[0] + PALM_STANDOFF, def.rightGrip[1], def.rightGrip[2] + PALM_REACH);
    this.gunPivot.localToWorld(this.tmpVec);
    // Pole hint: elbow hangs down and out to the right.
    this.tmpVec2.set(0.55, -0.9, 0.5).add(this.tmpVec);
    solveTwoBoneIK(this.arms.right.root, this.arms.right.elbow, this.tmpVec, this.tmpVec2, UPPER_ARM, FOREARM);
    this.poseWrist(this.arms.right, 1);

    // Left hand: on the handguard, except mid-reload when it fetches a mag.
    // Its wrist sits below the support point; the palm rises onto the barrel
    // and the fingers curl inboard around it. The support grip is therefore a
    // vertical hand frame, not the firing hand's along-the-bore frame.
    this.tmpVec.set(def.leftGrip[0] - SUPPORT_HAND_OUTBOARD, def.leftGrip[1] - PALM_REACH * 1.5, def.leftGrip[2]);
    this.gunPivot.localToWorld(this.tmpVec);
    if (this.reloadT >= 0 && !def.shellReload) {
      const p = this.reloadT;
      // Travel down to the mag pouch and back — an arc, not a straight line.
      const away = Math.sin(clamp((p - 0.05) / 0.55, 0, 1) * Math.PI);
      this.tmpVec.x += away * 0.22;
      this.tmpVec.y -= away * 0.34;
      this.tmpVec.z += away * 0.16;
    } else if (this.reloadT >= 0 && def.shellReload) {
      const away = Math.sin(clamp(this.reloadT, 0, 1) * Math.PI);
      this.tmpVec.x += away * 0.16;
      this.tmpVec.y -= away * 0.2;
      this.tmpVec.z += away * 0.22;
    }
    this.tmpVec2.set(-0.5, -0.85, 0.35).add(this.tmpVec);
    solveTwoBoneIK(this.arms.left.root, this.arms.left.elbow, this.tmpVec, this.tmpVec2, UPPER_ARM, FOREARM);
    this.poseWrist(this.arms.left, -1);
  }

  /** Orients the hand onto the grip and curls the fingers around it. */
  private poseWrist(arm: HandRig, side: number) {
    if (!this.gun) return;

    // Build the hand's frame from the weapon's axes rather than by nudging
    // Eulers off the weapon's own orientation.
    //
    // The rig's hand is +X across the knuckles, -Y down the fingers, +Z out of
    // the palm. Closing that hand around a near-vertical grip means: palm
    // faces inboard at the grip, fingers start pointing down the barrel and
    // curl inboard around the front strap. That is a full permutation of the
    // weapon's axes, nowhere near the identity — starting from the weapon's
    // own orientation and tilting left both hands palm-up ahead of the muzzle
    // with the fingers splayed across the sight picture.
    this.gunPivot.updateWorldMatrix(true, false);
    this.gunPivot.matrixWorld.extractBasis(this.axisX, this.axisY, this.axisZ);
    if (side > 0) {
      // Right hand: palm faces -X (inboard), fingers along -Z (down range).
      this.gripBasis.makeBasis(this.axisY.negate(), this.axisZ, this.axisX.negate());
    } else {
      // Left support hand: palm faces +X, fingers rise from below the barrel
      // and curl inboard around its handguard/fore-end.
      this.gripBasis.makeBasis(this.axisZ, this.axisY.negate(), this.axisX);
    }
    this.tmpQuat.setFromRotationMatrix(this.gripBasis);
    arm.wrist.quaternion.copy(this.tmpQuat);
    arm.elbow.getWorldQuaternion(this.tmpQuat);
    arm.wrist.quaternion.premultiply(this.tmpQuat.invert());

    // Natural break at the wrist, outward on each side.
    arm.wrist.rotateX(-0.15);
    arm.wrist.rotateZ(side * 0.25);

    // The fingers close on the grip.
    //
    // Knuckle and second joint each take about half of the ~180 degrees needed
    // to bring a fingertip from the near flank, around the front strap, to the
    // far flank. Curling the knuckle alone — however far — only sweeps a
    // straight finger through an arc that misses the grip entirely, which is
    // what left both hands clawing at empty air beside the weapon.
    for (let i = 0; i < 4; i++) {
      arm.fingers[i].rotation.x = -1.5;
      arm.fingerTips[i].rotation.x = -1.4;
    }
    const pull = this.gun.trigger ? -this.gun.trigger.rotation.x / 0.35 : 0;
    if (side > 0) {
      // The trigger finger leaves the grip for the guard. Reaching the trigger
      // needs all three axes, not just the curl the other fingers use: the
      // trigger sits above the knuckle row (z: the lift off the grip), inboard
      // of it (y: the reach across to the centreline) and only 36 mm away, so
      // the finger has to fold hard (x) rather than extend. Curl alone sweeps
      // it straight out through the front of the trigger guard.
      arm.triggerFinger.rotation.set(-0.42 - pull * 0.28, -0.6, -1.1);
      arm.fingerTips[0].rotation.x = -1.98 - pull * 0.24;
    }
  }

  dispose() {
    if (this.gun) disposeModel(this.gun.root);
    this.viewScene.remove(this.root);
  }
}
