import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { GunModel } from './GunSmith';
import { WeaponDef } from './WeaponDefs';
import { buildArms, HandRig } from './Arms';
import { solveTwoBoneIK } from '../util/ik';
import { muzzleFlashTexture, smokeTexture } from '../assets/SpriteTextures';
import { Presets } from '../assets/Materials';
import { Rng, TAU, clamp, damp, lerp, smoothstep } from '../util/math';

const UPPER_ARM = 0.26;
const FOREARM = 0.24;

/** Where the shoulders sit relative to the view camera. */
const LEFT_SHOULDER = new Vector3(-0.2, -0.2, 0.14);
const RIGHT_SHOULDER = new Vector3(0.2, -0.2, 0.14);

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

  /** Recoil spring state. */
  private recoilPos = 0;
  private recoilVel = 0;
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

  private readonly rng = new Rng(0xbeef);
  private readonly tmpVec = new Vector3();
  private readonly tmpVec2 = new Vector3();
  private readonly tmpQuat = new Quaternion();

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
      this.gun.root.traverse((o) => {
        const m = o as Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
    this.def = def;
    this.gun = def.build();
    this.gunPivot.add(this.gun.root);
    this.gunPivot.add(this.flashGroup);
    this.flashGroup.position.copy(this.gun.muzzle.position);
    this.swapBlend = 0;
    this.reloadT = -1;
  }

  setAiming(aiming: boolean) {
    this.adsTarget = aiming ? 1 : 0;
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
  }

  get reloading() {
    return this.reloadT >= 0;
  }

  /** Kicks the whole weapon and returns the view punch for the camera. */
  fire(def: WeaponDef, shotIndex: number) {
    const r = def.recoil;
    this.recoilVel += r.kick * 78;
    this.recoilPitchVel += (r.vertical * Math.PI) / 180 * 34;

    // Alternating horizontal wander with a per-weapon directional bias makes
    // the pattern learnable instead of random.
    const wander = Math.sin(shotIndex * 2.399) * 0.6 + this.rng.range(-0.4, 0.4);
    this.recoilYawVel += ((r.horizontal * (wander + r.drift)) * Math.PI) / 180 * 30;
    this.recoilRoll += this.rng.range(-0.02, 0.02) - r.drift * 0.012;

    // View punch is damped hard when aiming — a shouldered weapon moves less.
    const adsDamp = lerp(1, 0.55, this.adsBlend);
    this.viewPunchPitch += ((r.vertical * Math.PI) / 180) * adsDamp;
    this.viewPunchYaw += (((r.horizontal * wander) * Math.PI) / 180) * adsDamp;

    this.spawnFlash(def);
  }

  private spawnFlash(def: WeaponDef) {
    this.flashLife = 1;
    const scale = def.class === 'shotgun' ? 0.34 : def.class === 'rifle' ? 0.26 : 0.2;
    for (const p of this.flashPlanes) {
      p.visible = true;
      p.scale.setScalar(scale * this.rng.range(0.82, 1.22));
      p.rotation.z = this.rng.next() * TAU;
      (p.material as MeshBasicMaterial).opacity = this.rng.range(0.8, 1);
    }
    this.flashLight.intensity = def.class === 'shotgun' ? 26 : 16;

    // Muzzle smoke, in the viewmodel scene so it stays attached to the gun.
    if (this.rng.chance(def.class === 'shotgun' ? 1 : 0.55)) {
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
    if (!this.gun) return;
    let shell = this.shellPool.pop();
    if (!shell) {
      const mesh = new Mesh(this.shellGeo, Presets.brass());
      mesh.castShadow = false;
      shell = { mesh, vel: new Vector3(), spin: new Vector3(), life: 0 };
    }
    const s = shell;
    s.mesh.position.copy(this.gun.ejectPort.position);
    s.mesh.scale.setScalar(def.class === 'shotgun' ? 1.5 : def.class === 'rifle' ? 1.15 : 1);
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
    this.recoilPos = this.springStep(this.recoilPos, () => this.recoilVel, (v) => (this.recoilVel = v), rec.recovery * 4.2, rec.recovery * 0.9, dt);
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
    const adsX = 0;
    const adsY = -this.gun!.sightHeight;
    const adsZ = def.hipPosition[2] + this.gun!.sightForward;

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

    let rx = lerp(def.hipRotation[0], 0, this.adsBlend) - this.recoilPitch;
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
      // Reset animated parts to rest.
      if (this.gun?.magazine) {
        this.gun.magazine.position.y = 0;
        this.gun.magazine.rotation.z = 0;
        this.gun.magazine.visible = true;
      }
      if (this.gun?.charging) this.gun.charging.position.z = 0;
    }
    void def;
  }

  /** Slide/bolt travel driven by the recoil spring, plus trigger finger pull. */
  private animateAction(def: WeaponDef) {
    if (!this.gun) return;
    const travel = clamp(this.recoilPos / Math.max(def.recoil.kick, 0.001), 0, 1);
    if (this.gun.slide && this.gun.slide !== this.gun.charging) {
      this.gun.slide.position.z = travel * (def.class === 'shotgun' ? 0.06 : 0.028);
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
    this.tmpVec.set(def.rightGrip[0], def.rightGrip[1], def.rightGrip[2]);
    this.gunPivot.localToWorld(this.tmpVec);
    // Pole hint: elbow hangs down and out to the right.
    this.tmpVec2.set(0.55, -0.9, 0.5).add(this.tmpVec);
    solveTwoBoneIK(this.arms.right.root, this.arms.right.elbow, this.tmpVec, this.tmpVec2, UPPER_ARM, FOREARM);
    this.poseWrist(this.arms.right, 1);

    // Left hand: on the handguard, except mid-reload when it fetches a mag.
    this.tmpVec.set(def.leftGrip[0], def.leftGrip[1], def.leftGrip[2]);
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
    // Align the palm with the weapon's roll so the hand wraps the grip rather
    // than floating beside it.
    this.gunPivot.getWorldQuaternion(this.tmpQuat);
    arm.wrist.quaternion.copy(this.tmpQuat);
    arm.elbow.getWorldQuaternion(this.tmpQuat);
    arm.wrist.quaternion.premultiply(this.tmpQuat.invert());
    arm.wrist.rotateX(side > 0 ? -1.15 : -1.05);
    arm.wrist.rotateZ(side * 0.35);

    // Trigger finger tracks the trigger; the rest hold a firm grip.
    const pull = this.gun.trigger ? -this.gun.trigger.rotation.x / 0.35 : 0;
    if (side > 0) {
      arm.triggerFinger.rotation.x = -0.35 - pull * 0.5;
    }
  }

  dispose() {
    this.viewScene.remove(this.root);
  }
}
