import {
  AdditiveBlending,
  Box3,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NormalBlending,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
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
import {
  contactShadowTexture,
  glowTexture,
  muzzleFlashTexture,
  smokeTexture,
} from '../assets/SpriteTextures';
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
 * The weapon keeps a visible kick without making the whole viewmodel jump out
 * of the sight picture. Camera/aim recoil is handled separately by
 * `WeaponSystem`, so this is deliberately a visual-only scale.
 */
const VIEWMODEL_RECOIL_SCALE = 0.55;
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
 * Hip carry bias, layered on top of each weapon's authored `hipPosition`.
 *
 * The def data places the weapon roughly at its firing grip; what it cannot
 * express (it is one pose for all states) is the *stance*: a carried weapon
 * parks low and to the right of the eye — CS:GO's presentation — rather than
 * floating level with the sight line. This bias is applied only while the
 * weapon is at rest at the hip; it fades out with ADS (where the sight picture
 * must land dead centre), sprint, inspect and the swap raise.
 */
const STANCE_X = 0.028;
/**
 * Vertical stance offset. Positive: the carry sits HIGHER than the firing grip
 * alone would place it, because a grip-height rest buries the whole weapon
 * below the bottom frame edge — grip, hands and all — exactly when the player
 * has the most time to look at it. CS:GO-style presentation keeps the weapon
 * in the lower-right *quadrant*, muzzle tip around 60–65% of frame height, and
 * that needs the receiver lifted clear of the bezel while staying well below
 * the sight line.
 */
const STANCE_Y = 0.025;
/** Slight inward cant: top of the receiver tips toward the sight line. */
const STANCE_ROLL = 0.05;
/** A touch of yaw convergence so the bore reads as pointed downrange. */
const STANCE_YAW = 0.026;

/**
 * Ease-out-back: a smoothstep-shaped rise that overshoots its target by a few
 * percent just before the end, then settles back onto it.
 *
 * Used for the equip raise — an arm catching a weapon at the top of the lift
 * does not stop dead, it carries through and settles. `s` scales the overshoot
 * (and the invisible starting wind-up, which happens off-screen).
 */
function easeOutBack(t: number, s: number): number {
  const u = t - 1;
  return 1 + u * u * ((s + 1) * u + s);
}

/**
 * How far the nearest weapon geometry is kept from the camera near plane.
 *
 * The viewmodel renders through a very narrow near plane so guns never clip
 * into walls, but extreme poses — a shotgun lowering into sprint, the bottom of
 * a swap raise — can still swing the stock across it. When the clearance check
 * below finds geometry inside this margin it slides the whole rig forward just
 * far enough to clear, which is exactly how shipped games handle it.
 */
const NEAR_CLEAR_MARGIN = 0.006;

/** Per-shot barrel-heat gain by class — sustained fire ramps toward glow. */
function heatPerShot(defClass: string): number {
  return defClass === 'lmg' ? 0.085 : defClass === 'shotgun' ? 0.09 : defClass === 'rifle' ? 0.07 : 0.05;
}

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
  /**
   * Soft contact shadow grounding the weapon assembly.
   *
   * The viewmodel renders in its own scene against whatever the world happens
   * to show behind it, so without an anchor the gun can appear to float —
   * most visibly during ADS, when the hands drop toward screen centre. A dim
   * radial-gradient card riding just below/behind the receiver reads as the
   * weapon's ambient occlusion onto the shooter's own chest/arms zone. It is
   * parented to `gunPivot` so recoil, sway and bob move it in lockstep; only
   * its opacity breathes (fade while swapping/reloading, when the pose stops
   * being "shouldered").
   */
  private contactShadow: Mesh | null = null;
  private contactShadowMat: MeshBasicMaterial | null = null;

  /** 0 = hip, 1 = fully aimed. */
  adsBlend = 0;
  private adsTarget = 0;

  /** Recoil state. Positional kick is bounded; angular kicks remain spring-driven. */
  private recoilPos = 0;
  private recoilPosTarget = 0;
  private recoilPitch = 0;
  private recoilPitchVel = 0;
  private recoilYaw = 0;
  private recoilYawVel = 0;
  /**
   * Roll about the bore axis, spring-driven like pitch/yaw.
   *
   * Real recoil torques the weapon around its barrel — the wrist rolls open a
   * degree or two and springs shut — which reads as power in a way pure
   * translation never does. A critically-damped decay (the old behaviour) had
   * no overshoot, so the torque felt like friction rather than mass.
   */
  private recoilRoll = 0;
  private recoilRollVel = 0;

  private swayX = 0;
  private swayY = 0;
  private swayPitch = 0;
  private swayYaw = 0;
  private swayRoll = 0;
  private sprintBlend = 0;
  private swapBlend = 1;
  private swapTarget = 1;
  private inspectBlend = 0;
  private inspectTarget = 0;
  /**
   * Seconds spent in (or easing out of) the inspect pose. Drives the slow
   * appraisal drift so the pose keeps living while held instead of freezing.
   */
  private inspectTime = 0;

  /** Reload timeline, 0..1 while reloading, -1 when idle. */
  private reloadT = -1;
  private reloadDuration = 1;
  private reloadEmpty = false;
  private shellReloadStage = 0;

  private readonly flashGroup = new Group();
  private readonly flashPlanes: Mesh[] = [];
  /** Per-plane phase offsets so each flash card flickers independently. */
  private readonly flashSeeds = [0.13, 0.71, 0.37];
  private readonly flashLight: PointLight;
  private flashLife = 0;
  /**
   * Barrel heat from sustained fire, 0..1. Ramps per shot, radiates off
   * between strings; drives the muzzle-area glow cards below.
   */
  private barrelHeat = 0;
  private readonly heatGlow: Mesh;
  private readonly heatLight: PointLight;
  private readonly smokePuffs: { mesh: Mesh; life: number; vel: Vector3; swirlPhase: number; spinRate: number }[] = [];
  private readonly smokeGeo = new PlaneGeometry(1, 1);

  /** Fake ambient occlusion blobs where each hand presses onto the weapon. */
  private readonly contactBlobs: Mesh[] = [];
  private readonly contactGeo = new PlaneGeometry(1, 1);
  private readonly contactMat: MeshBasicMaterial;

  /**
   * Weapon bounding-box corners in gunPivot space, captured once per equip for
   * the near-plane clearance check. Eight corner transforms per frame is far
   * cheaper than a true sweep and bounds every static part of the model.
   */
  private gunCorners: Vector3[] | null = null;
  private cameraNear = 0.008;

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
  private readonly tmpMat = new Matrix4();
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

    // --- Contact shadow: the card that stops the weapon reading as a cutout ---
    //
    // Multiplicative darkening (black with normal blending, low opacity) rather
    // than additive: this is occlusion, not light. The radial gradient keeps
    // the edge soft so it never reads as a decal. `depthTest: false` + a low
    // render order would fight the flash cards, so instead it renders after
    // everything at its own depth — parked behind/below the receiver where only
    // torso-zone pixels sit, it just quietly darkens whatever is there.
    const contactMat = new MeshBasicMaterial({
      map: contactShadowTexture(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.36,
    });
    // The texture's own alpha falloff does the shaping; normal blending keeps
    // the black RGB darkening whatever sits behind the card.
    contactMat.blending = NormalBlending;
    this.contactShadowMat = contactMat;
    this.contactShadow = new Mesh(new PlaneGeometry(1, 1), contactMat);
    // Below the bore line and slightly behind the receiver centre: the zone
    // the shooter's chest occupies from the camera's point of view.
    this.contactShadow.position.set(0, -0.16, 0.06);
    this.contactShadow.scale.setScalar(0.42);
    this.contactShadow.renderOrder = -1;
    this.contactShadow.visible = false;
    this.gunPivot.add(this.contactShadow);

    // --- Barrel heat: a soft ember card parked just behind the muzzle ---
    //
    // Sustained fire soaks the barrel and it glows — briefly visible between
    // shots as a dull orange halo that outlives each flash by seconds. The
    // shared radial glow texture does all the work; only opacity and scale
    // move with heat.
    const heatMat = new MeshBasicMaterial({
      map: glowTexture(),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 0,
      color: new Color(0xff6a26),
    });
    this.heatGlow = new Mesh(new PlaneGeometry(1, 1), heatMat);
    this.heatGlow.scale.setScalar(0.09);
    this.heatGlow.visible = false;
    this.heatGlow.renderOrder = 2;
    this.gunPivot.add(this.heatGlow);
    this.heatLight = new PointLight(0xff5a20, 0, 1.4, 2);
    this.heatLight.castShadow = false;
    this.gunPivot.add(this.heatLight);

    // Fake contact shadow where hands press onto the weapon: a dark radial
    // decal at each grip point. True hand shadows need a second shadow pass
    // the viewmodel budget cannot afford; a soft blob under the palms sells
    // the same "hands are holding this" weight for two quads.
    this.contactMat = new MeshBasicMaterial({
      map: glowTexture(),
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.26,
      color: new Color(0x000000),
    });

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
    this.applyWeaponMaterialBreakup(this.gun.root);
    this.gunPivot.add(this.gun.root);
    this.resetReloadParts();
    this.gunPivot.add(this.flashGroup);
    this.flashGroup.position.copy(this.gun.muzzle.position);
    // Heat card rides just behind the muzzle, hugging the barrel rather than
    // floating in the air past it.
    this.heatGlow.position.copy(this.gun.muzzle.position);
    this.heatGlow.position.z += 0.045;
    this.heatLight.position.copy(this.heatGlow.position);
    this.barrelHeat = 0;
    this.attachContactShadows(def);
    this.captureNearCorners();
    this.swapBlend = 0;
    this.swapTarget = 1;
    this.inspectBlend = 0;
    this.inspectTarget = 0;
    this.adsBlend = 0;
    this.adsTarget = 0;
    this.reloadT = -1;
    this.reloadEmpty = false;
    this.shellReloadStage = 0;
    this.recoilPos = 0;
    this.recoilPosTarget = 0;
    this.recoilPitch = 0;
    this.recoilPitchVel = 0;
    this.recoilYaw = 0;
    this.recoilYawVel = 0;
    this.recoilRoll = 0;
    this.recoilRollVel = 0;
  }

  /**
   * Dark decal under each hand's palm, in weapon space at the grip point.
   *
   * Rebuilt per equip because the grip points are per weapon. The blobs are
   * nudged a few millimetres outboard of the grip so they sit between the
   * receiver flank and the palm standoff — close enough to read as contact,
   * far enough to never z-fight the weapon's own surfaces.
   */
  private attachContactShadows(def: WeaponDef) {
    for (const blob of this.contactBlobs) {
      this.gunPivot.remove(blob);
    }
    this.contactBlobs.length = 0;
    // Blobs sit where the *palms* hover, using the same standoffs the IK
    // targets use (PALM_STANDOFF / SUPPORT_HAND_OUTBOARD) plus a hair — that
    // gap is guaranteed clear of geometry, whereas the grip points themselves
    // can be buried inside a thick fore-end. Radial falloff means the quad
    // vanishes edge-on, so the extra height never reads as a card.
    const grips: [readonly number[], number][] = [
      [def.rightGrip, 1],
      [def.leftGrip, -1],
    ];
    for (const [grip, outboard] of grips) {
      const blob = new Mesh(this.contactGeo, this.contactMat);
      const lift = outboard > 0 ? PALM_STANDOFF + 0.003 : SUPPORT_HAND_OUTBOARD + 0.004;
      blob.position.set(grip[0] + outboard * lift, grip[1] - (outboard < 0 ? PALM_REACH : 0), grip[2]);
      // The plane's +Z normal is swung to face outboard, and its local X —
      // which becomes the weapon's length axis after the swing — is scaled
      // longer than its height so the shadow smears along the grip like a
      // real occlusion patch instead of a round sticker.
      blob.rotation.y = (outboard * Math.PI) / 2;
      blob.scale.set(0.085, 0.055, 1);
      blob.renderOrder = 3;
      this.gunPivot.add(blob);
      this.contactBlobs.push(blob);
    }
  }

  /**
   * Records the weapon's bounding box (in gunPivot space) for the per-frame
   * near-plane clearance check in `composeTransform`.
   */
  private captureNearCorners() {
    this.gunPivot.updateWorldMatrix(true, false);
    this.tmpMat.copy(this.gunPivot.matrixWorld).invert();
    const bbox = new Box3().setFromObject(this.gun!.root);
    this.gunCorners = [];
    for (const x of [bbox.min.x, bbox.max.x]) {
      for (const y of [bbox.min.y, bbox.max.y]) {
        for (const z of [bbox.min.z, bbox.max.z]) {
          this.gunCorners.push(new Vector3(x, y, z).applyMatrix4(this.tmpMat));
        }
      }
    }
  }

  /**
   * Adds a restrained viewmodel-only material grade after the weapon is built.
   *
   * GunSmith deliberately batches by material role (`steel`, `bright`, `poly`,
   * `dark`, and so on). Keeping the pass here means every current and future
   * weapon gets a consistent first-person finish without changing weapon data,
   * stats, or the shared world materials. It is intentionally scalar-only:
   * the baked PBR maps remain authoritative for surface breakup and normals.
   */
  private applyWeaponMaterialBreakup(root: Object3D) {
    const tuned = new Set<MeshStandardMaterial>();
    // Polished-role clearcoat pass (below) needs every mesh that shares a
    // material: MeshKit batches by role, so one `bright` instance typically
    // backs several merged meshes across a build's sub-assemblies.
    const users = new Map<MeshStandardMaterial, { role: string; meshes: Mesh[] }>();
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const source of materials) {
        const material = source as MeshStandardMaterial;
        if (!material.isMeshStandardMaterial || material.transparent || tuned.has(material)) continue;
        tuned.add(material);

        const role = mesh.name.toLowerCase();
        // The optic pass owns its glass/reticle contrast; leave those materials
        // untouched so the sight picture never gets hazy from the grade.
        if (/glass|dot|liner/.test(role)) continue;

        // Stable, very small tonal drift keeps a merged bucket from reading as
        // a single CG colour while remaining below the threshold of painted
        // camo or a gameplay-affecting tint.
        const seed = Array.from(role).reduce((sum, char) => sum + char.charCodeAt(0), 0);
        const tonalDrift = ((seed % 7) - 3) * 0.008;
        material.color.offsetHSL(0, 0, tonalDrift);

        if (/bright|scopeRing|sightFrame/.test(role)) {
          // Machined edges should catch a clean, narrow highlight beside the
          // matte receiver without turning into chrome. The envMapIntensity
          // floor doubles as a rim-highlight term: the viewmodel scene carries
          // an IBL probe with hard bright strips in it, so pushing polished
          // metal's response to those strips puts a moving specular edge along
          // receivers and bolts no matter where the key light sits.
          material.roughness = clamp(material.roughness * 0.8, 0.26, 0.7);
          material.envMapIntensity = Math.max(material.envMapIntensity, 1.55);
        } else if (/steel|scopeBody/.test(role)) {
          // Same rim term, one step down: blued/parkerised steel keeps more of
          // its roughness but still picks up the strips along bevels and seam
          // lines — this is what separates "dark metal" from "black plastic".
          // Roughness comes down harder than a polish: at 0.9 the IBL strips
          // smear into nothing, while ~0.7 stretches them into the long
          // anisotropic-looking sheen a blued receiver actually shows.
          material.roughness = clamp(material.roughness * 0.86, 0.36, 0.84);
          material.envMapIntensity = Math.max(material.envMapIntensity, 1.48);
        } else if (/dark|rubber|vent/.test(role)) {
          // Recesses and rubber absorb the fill, giving the hand and receiver
          // highlights a readable edge to sit against. Deepened slightly: the
          // shadow side of the weapon is what gives the lit flank its punch,
          // and the fill light was flattening it.
          material.roughness = Math.max(material.roughness, 0.95);
          material.metalness = Math.min(material.metalness, 0.06);
          material.envMapIntensity = Math.min(material.envMapIntensity, 0.38);
        } else if (/poly|panel|stock|grip/.test(role)) {
          material.roughness = clamp(material.roughness * 1.04, 0.72, 1);
          material.metalness = Math.min(material.metalness, 0.06);
          material.envMapIntensity = Math.min(material.envMapIntensity, 0.72);
        }

        let entry = users.get(material);
        if (!entry) users.set(material, (entry = { role, meshes: [] }));
        entry.meshes.push(mesh);
      }
    });

    // Slight clearcoat on polished roles.
    //
    // MeshStandardMaterial cannot express a coating layer, so polished parts
    // (`bright` fasteners/bolts, `bsteel`, witness marks) are upgraded to
    // MeshPhysicalMaterial with a thin coat. The coat is what turns the IBL
    // strips into a crisp secondary highlight riding OVER the brushed base —
    // the same trick as the gloved hands' leather sheen in Arms.ts — while the
    // scalar grade above keeps the base itself honest. Swapping the class is
    // confined to the viewmodel copy of each build: weapon models are built
    // per equip and disposed with it, so nothing world-side shares these.
    for (const [material, { role, meshes }] of users) {
      if (!/bright|bsteel|witness|polish|chrome|nickel/.test(role)) continue;
      // Field-by-field copy rather than `physical.copy(standard)`: the
      // PhysicalMaterial copy routine reads clearcoat-only fields
      // (`clearcoatNormalScale` &c.) that do not exist on a plain standard
      // material and throws. These maps are exactly what `makeSurface` sets.
      const coated = new MeshPhysicalMaterial();
      coated.color.copy(material.color);
      coated.roughness = material.roughness;
      coated.metalness = material.metalness;
      coated.envMapIntensity = material.envMapIntensity;
      coated.map = material.map;
      coated.normalMap = material.normalMap;
      if (material.normalMap) coated.normalScale.copy(material.normalScale);
      coated.roughnessMap = material.roughnessMap;
      coated.metalnessMap = material.metalnessMap;
      coated.aoMap = material.aoMap;
      coated.aoMapIntensity = material.aoMapIntensity;
      coated.emissive.copy(material.emissive);
      coated.emissiveIntensity = material.emissiveIntensity;
      coated.clearcoat = 0.24;
      coated.clearcoatRoughness = 0.32;
      for (const mesh of meshes) mesh.material = coated;
      material.dispose();
    }
  }

  setAiming(aiming: boolean) {
    this.adsTarget = aiming ? 1 : 0;
  }

  /** Starts the lower half of a weapon swap before the new weapon is built. */
  startLower() {
    this.swapTarget = 0;
    this.inspectTarget = 0;
    this.cancelReload();
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
    this.reloadDuration = Math.max(duration, 0.05);
    this.reloadEmpty = empty;
    this.inspectTarget = 0;
  }

  startShellInsert(duration: number) {
    this.reloadT = 0;
    this.reloadDuration = Math.max(duration, 0.05);
    this.reloadEmpty = false;
    this.shellReloadStage = (this.shellReloadStage + 1) % 2;
    this.inspectTarget = 0;
  }

  cancelReload() {
    this.reloadT = -1;
    this.reloadEmpty = false;
    this.shellReloadStage = 0;
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
    if (this.gun.slide && this.gun.slide !== this.gun.charging) this.gun.slide.position.z = 0;
    if (this.gun.feedCover) this.gun.feedCover.rotation.set(0, 0, 0);
  }

  /** Kicks the viewmodel without changing the player's world camera. */
  fire(def: WeaponDef, shotIndex: number) {
    const r = def.recoil;
    const translationScale = lerp(1, ADS_RECOIL_TRANSLATION_SCALE, this.adsBlend);
    const rotationScale = lerp(1, ADS_RECOIL_ROTATION_SCALE, this.adsBlend);
    this.recoilPosTarget = clamp(
      this.recoilPosTarget + r.kick * translationScale * VIEWMODEL_RECOIL_SCALE,
      0,
      this.maxRecoilTranslation(r.kick, translationScale),
    );
    this.recoilPitchVel += (r.vertical * Math.PI) / 180 * 34 * rotationScale * VIEWMODEL_RECOIL_SCALE;

    // Alternating horizontal wander with a per-weapon directional bias makes
    // the pattern learnable instead of random.
    const wander = Math.sin(shotIndex * 2.399) * 0.6 + this.rng.range(-0.4, 0.4);
    this.recoilYawVel += ((r.horizontal * (wander + r.drift)) * Math.PI) / 180 * 30 * rotationScale * VIEWMODEL_RECOIL_SCALE;
    // Barrel torque: an impulse into a roll *spring*, not a direct offset.
    // The wrist rolls open about the bore and springs back with a touch of
    // overshoot, which is where the shot's "power" is felt. Drift biases the
    // torque consistently to one side so automatic fire visibly screws in,
    // while the random component keeps single shots from looking scripted.
    this.recoilRollVel += ((this.rng.range(-1, 1) * 0.17) - r.drift * 0.085) * rotationScale * VIEWMODEL_RECOIL_SCALE;

    // Sustained fire soaks the barrel toward glow. Wonder weapons have no
    // conventional barrel to heat — their muzzle cards already carry colour.
    if (!def.wonder) {
      this.barrelHeat = Math.min(1, this.barrelHeat + heatPerShot(def.class));
    }

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
      // Wide per-shot variance in size and roll: powder gas burns unevenly
      // every time, and three independently rolled, independently scaled
      // cards read as volume rather than as a spinning decal.
      p.scale.setScalar(scale * this.rng.range(0.72, 1.34));
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
      opacity: 0,
      color: new Color(0x9a938a),
      toneMapped: true,
    });
    const mesh = new Mesh(this.smokeGeo, mat);
    mesh.position.copy(this.gun.muzzle.position);
    mesh.scale.setScalar(0.05);
    this.gunPivot.add(mesh);
    // Each wisp gets its own curl phase and roll rate, so a string of shots
    // leaves several independently wandering columns of smoke rather than one
    // cloned puff marching in lockstep.
    this.smokePuffs.push({
      mesh,
      life: 1,
      vel: new Vector3(this.rng.range(-0.05, 0.05), this.rng.range(0.06, 0.16), -this.rng.range(0.25, 0.55)),
      swirlPhase: this.rng.next() * TAU,
      spinRate: this.rng.range(-0.9, 0.9),
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
    this.cameraNear = camera.near;

    // --- Blends -----------------------------------------------------------
    const canRaise = this.swapTarget > 0.5;
    const canAds = canRaise && !this.reloading && !ctx.sprinting && !ctx.inspecting;
    this.adsBlend = damp(this.adsBlend, canAds ? this.adsTarget : 0, 1 / Math.max(def.adsTime, 0.01) * 0.9, dt);
    const sprintTarget = ctx.sprinting && !this.reloading ? 1 : 0;
    // Asymmetric ease: settling INTO the carry is heavy (slow attack — the
    // arms lower the weapon), snapping back to ready is urgent (fast release).
    // One rate for both directions made the lower feel weightless on the way
    // down and sluggish on the way up.
    this.sprintBlend = damp(this.sprintBlend, sprintTarget, sprintTarget > this.sprintBlend ? 6.5 : 12, dt);
    this.swapBlend = damp(this.swapBlend, this.swapTarget, 1 / Math.max(def.swapTime, 0.05) * 1.4, dt);
    this.inspectTarget = ctx.inspecting && canRaise && !this.reloading && !ctx.sprinting ? 1 : 0;
    this.inspectBlend = damp(this.inspectBlend, this.inspectTarget, 8, dt);
    // The appraisal clock runs while the pose is alive at all (including its
    // ease-out) so the drift below never snaps phase when the key releases.
    if (this.inspectBlend > 0.001) this.inspectTime += dt;

    // --- Contact shadow ---------------------------------------------------
    //
    // The card is only meaningful while the weapon is shouldered in a stable
    // pose. ADS lifts the muzzle toward screen centre where the card would
    // smear across the sight picture, so its weight fades out with the aim
    // blend; swaps and reloads drop the pose entirely. Damped like every other
    // blend so the shadow eases rather than pops.
    if (this.contactShadow && this.contactShadowMat) {
      const grounded = (1 - this.adsBlend) * this.swapBlend * (this.reloading ? 0.35 : 1);
      const targetOpacity = 0.36 * grounded * (1 - this.sprintBlend * 0.55);
      this.contactShadowMat.opacity = damp(this.contactShadowMat.opacity, targetOpacity, 10, dt);
      this.contactShadow.visible = this.contactShadowMat.opacity > 0.01;
    }

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
    // Slightly softer than yaw: roll is the last motion to settle, which is
    // what makes the weapon feel like it rocks on its bore axis.
    this.recoilRoll = this.springStep(this.recoilRoll, () => this.recoilRollVel, (v) => (this.recoilRollVel = v), rec.recovery * 3.2, rec.recovery * 0.72, dt);

    // --- Sway: the gun lags the camera, more so at the hip ----------------
    const swayScale = lerp(1, 0.26, this.adsBlend);
    this.swayX = damp(this.swayX, clamp(-ctx.lookX * 3.4, -0.09, 0.09) * swayScale, 11, dt);
    this.swayY = damp(this.swayY, clamp(-ctx.lookY * 3.0, -0.07, 0.07) * swayScale, 11, dt);
    this.swayPitch = damp(this.swayPitch, clamp(ctx.lookY * 0.9, -0.06, 0.06) * swayScale, 10, dt);
    this.swayYaw = damp(this.swayYaw, clamp(-ctx.lookX * 1.05, -0.075, 0.075) * swayScale, 10, dt);
    this.swayRoll = damp(this.swayRoll, clamp(-ctx.lookX * 0.42, -0.035, 0.035) * swayScale, 10, dt);

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
    return Math.min(MAX_VIEWMODEL_RECOIL_TRANSLATION, kick * 2 * translationScale * VIEWMODEL_RECOIL_SCALE);
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

    // Idle breathing — slow, elliptical, suppressed while aiming or presenting
    // an inspection pose.
    //
    // The amplitude itself wanders on an eight-second cycle with a faster
    // incommensurate detail wave on top. A fixed-amplitude sine is the single
    // loudest "procedural viewmodel" tell there is — real breathing comes in
    // shallower and deeper swells, and a player who never fires still watches
    // the weapon breathe for minutes.
    const inspectWeight = smoothstep(this.inspectBlend);
    const breathe = (1 - this.adsBlend * 0.72) * (1 - inspectWeight * 0.55) * (1 - ctx.bobAmount * 0.6);
    const breathAmp = breathe * (0.72 + Math.sin(t * TAU / 8 + 1.3) * 0.24 + Math.sin(t * TAU / 8 * 2.71 + 4.2) * 0.1);
    px += Math.sin(t * 0.75) * 0.0032 * breathAmp;
    py += Math.sin(t * 1.13 + 0.9) * 0.0038 * breathAmp;

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

    // Swap: the weapon rises into frame from below with a slight roll, then
    // settles with a bounce. The rise itself is an ease-out-back: it carries
    // ~4% of its travel past rest before settling onto it — an arm catching
    // weight, not a winch. (Its starting wind-up dips deeper off-screen, which
    // costs nothing.) Translation depth and roll stay on plain smoothstep so
    // only the vertical read bounces.
    const swapEase = smoothstep(clamp(this.swapBlend, 0, 1));
    const backEase = easeOutBack(clamp(this.swapBlend, 0, 1), 1.1);
    const settleCatch = Math.max(0, backEase - swapEase);
    py -= (1 - backEase) * 0.34;
    pz += (1 - swapEase) * 0.1;

    // Sprint: canted low and away, muzzle down-left. Reads as "not ready".
    const sp = smoothstep(this.sprintBlend);
    px += sp * 0.055;
    py -= sp * 0.052;
    pz += sp * 0.03;

    // Stance bias: low-right carry, applied only while actually resting at the
    // hip. Every other state (ADS, sprint, inspect, reload tip, mid-swap)
    // owns the pose then, so this fades out under all of them.
    const stanceWeight =
      (1 - smoothstep(clamp(this.adsBlend, 0, 1))) *
      (1 - sp) *
      swapEase *
      (1 - inspectWeight * 0.85);
    px += stanceWeight * STANCE_X;
    py += stanceWeight * STANCE_Y;

    // The bore points along -Z, so positive X rotation raises the muzzle.
    let rx = lerp(def.hipRotation[0], 0, this.adsBlend) + this.recoilPitch;
    let ry = lerp(def.hipRotation[1], 0, this.adsBlend) + this.recoilYaw;
    let rz = lerp(def.hipRotation[2], 0, this.adsBlend) + this.recoilRoll;

    rx += Math.sin(t * 1.13 + 0.9) * 0.012 * breathAmp;
    ry += Math.sin(t * 0.75) * 0.014 * breathAmp;
    rx += Math.sin(ctx.bobPhase * 2 + 1.1) * 0.02 * bobScale;
    rz += Math.cos(ctx.bobPhase) * 0.03 * bobScale;
    // The hands lag the camera by a few degrees as well as a few centimetres.
    // These targets are bounded by the current look delta and always decay to
    // zero, so a held automatic trigger can never turn sway into drift.
    rx += this.swayPitch;
    ry += this.swayYaw;
    rz += this.swayRoll;
    rz -= (1 - swapEase) * 0.5;
    // Settle-bounce pitch/roll catch (see the translation ease above): the
    // muzzle dips as the weight lands, rolling a touch with it.
    rx -= settleCatch * 0.5;
    rz += settleCatch * 0.35;
    // Sprint cant.
    rx += sp * 0.16;
    ry -= sp * 0.42;
    rz += sp * 0.5;
    // Stance cant — the inward tip that makes the carry read as "held", not
    // "glued level".
    rz += stanceWeight * STANCE_ROLL;
    ry += stanceWeight * STANCE_YAW;
    // Inspect is a deliberate presentation pose, not an additive spin. It
    // takes priority over ADS and unwinds cleanly when the key is released.
    const insp = inspectWeight;
    px += insp * 0.065;
    py += insp * 0.018;
    pz += insp * 0.015;
    ry += insp * 0.82;
    rz += insp * 0.46;
    rx += insp * 0.12;
    // Appraisal drift: once fully raised, the pose keeps living — slow sweeps
    // as if the eye is travelling the weapon, plus a faint float. Quadratic
    // weight keeps it out of the way during the ease-in and ease-out.
    const admire = insp * insp;
    ry += Math.sin(this.inspectTime * 1.7) * 0.085 * admire;
    rz += Math.sin(this.inspectTime * 1.7 + 0.9) * 0.05 * admire;
    rx += Math.sin(this.inspectTime * 2.4 + 2.1) * 0.03 * admire;
    py += Math.sin(this.inspectTime * 2.1 + 0.5) * 0.004 * admire;

    // Reload pose is applied on top.
    const reloadPose = this.reloadPose(def);
    px += reloadPose.x;
    py += reloadPose.y;
    pz += reloadPose.z;
    rx += reloadPose.pitch;
    ry += reloadPose.yaw;
    rz += reloadPose.roll;

    // Commit translation after every layer has contributed. This is
    // intentionally late: inspect and reload are pose layers, not metadata
    // that should be silently ignored by an earlier transform write.
    this.gunPivot.position.set(px, py, pz);

    this.gunPivot.rotation.set(rx, ry, rz);

    // Near-plane clearance: slide the whole rig forward if any bounding corner
    // of the weapon has swung inside the safety margin (extreme sprint/swap/
    // reload poses can). The correction is computed fresh each frame from the
    // composed pose, so it releases smoothly as the pose returns to rest —
    // and it never engages in normal ADS, where the stock sits well clear.
    this.gunPivot.updateWorldMatrix(true, false);
    if (this.gunCorners) {
      const limit = -(this.cameraNear + NEAR_CLEAR_MARGIN);
      const m = this.gunPivot.matrixWorld.elements;
      let closest = -Infinity;
      for (const c of this.gunCorners) {
        const z = m[2] * c.x + m[6] * c.y + m[10] * c.z + m[14];
        if (z > closest) closest = z;
      }
      if (closest > limit) {
        this.gunPivot.position.z -= closest - limit;
        this.gunPivot.updateWorldMatrix(true, false);
      }
    }

    // Keep the flash anchored to the (possibly animated) muzzle.
    this.flashGroup.position.copy(this.gun!.muzzle.position);
    this.heatGlow.position.copy(this.gun!.muzzle.position);
    this.heatGlow.position.z += 0.045;
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
    //
    // Deliberately late relative to the support hand: the hand is already
    // travelling to the pouch while the thumb is still slapping the release,
    // so the magazine only starts falling once the grip has visibly opened
    // (see solveArms — the hand departs from p=0). Dropping both together read
    // as one mechanical event; staggering them reads as a person doing two
    // things in order.
    const mag = this.gun.magazine;
    if (mag) {
      if (p < 0.40) {
        // Drop free, after the release slap has landed.
        const d = smoothstep(clamp((p - 0.10) / 0.30, 0, 1));
        mag.position.y = -d * 0.4;
        mag.rotation.z = d * 0.5;
        (mag as Object3D).visible = d < 0.95;
      } else if (p < 0.58) {
        (mag as Object3D).visible = false;
      } else {
        // Insert.
        const d = smoothstep(clamp((p - 0.58) / 0.26, 0, 1));
        (mag as Object3D).visible = true;
        mag.position.y = -(1 - d) * 0.3;
        mag.rotation.z = (1 - d) * 0.28;
      }
    }

    // Grip re-seat: a tiny final press as the firing hand re-tightens after
    // the bolt release. One short sine on the tail of the timeline — barely
    // visible, but it stops the weapon from gliding to rest like it's on rails.
    const reseat = Math.sin(clamp((p - 0.88) / 0.12, 0, 1) * Math.PI);
    out.pitch += reseat * 0.032;
    out.y -= reseat * 0.004;

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
      this.reloadEmpty = false;
      this.shellReloadStage = 0;
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
    const now = performance.now() * 0.001;
    if (this.flashLife > 0) {
      // Very short: a muzzle flash that lingers reads as a cartoon.
      this.flashLife -= dt * 22;
      const k = clamp(this.flashLife, 0, 1);
      this.flashLight.intensity *= Math.pow(0.0001, dt);
      for (let i = 0; i < this.flashPlanes.length; i++) {
        const p = this.flashPlanes[i];
        const m = p.material as MeshBasicMaterial;
        // Per-card flicker: each plane strobes on its own high-frequency
        // phase, so the burst crackles like burning gas instead of fading
        // like a lamp on a dimmer.
        const flicker = 0.78 + 0.22 * Math.sin(now * 90 + this.flashSeeds[i] * 37.1);
        m.opacity = k * k * flicker;
        p.visible = k > 0.02;
        // Decelerating expansion — violent in the first centimetre, holding
        // shape by the end of its life.
        p.scale.multiplyScalar(1 + dt * 6 * k);
      }
      if (this.flashLife <= 0) {
        this.flashLight.intensity = 0;
        for (const p of this.flashPlanes) p.visible = false;
      }
    }

    // Barrel heat: glows while hot, radiates away between strings. The slow
    // exponential tail is what makes it readable at all — a fast decay would
    // be swallowed by the flash that preceded it.
    if (this.barrelHeat > 0) {
      this.barrelHeat = Math.max(0, this.barrelHeat - dt * (this.barrelHeat * 0.32 + 0.02));
      const heat = this.barrelHeat;
      const shimmer = 0.9 + 0.1 * Math.sin(now * 11.3);
      this.heatGlow.visible = heat > 0.015;
      (this.heatGlow.material as MeshBasicMaterial).opacity = Math.pow(heat, 1.7) * 0.5 * shimmer;
      this.heatGlow.scale.setScalar(0.075 + heat * 0.06);
      this.heatLight.intensity = heat * heat * 2.4 * shimmer;
    } else if (this.heatGlow.visible) {
      this.heatGlow.visible = false;
      this.heatLight.intensity = 0;
    }
  }

  private updateSmoke(dt: number) {
    const now = performance.now() * 0.001;
    for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
      const s = this.smokePuffs[i];
      s.life -= dt * 0.8;
      const age = 1 - s.life;
      s.vel.multiplyScalar(1 - dt * 1.7);
      s.vel.y += dt * 0.16;
      // Curl: each wisp wanders laterally on its own phase, so several puffs
      // separate into distinct drifting columns instead of one blob.
      s.vel.x += Math.sin(now * 2.6 + s.swirlPhase) * dt * 0.11;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.z += s.spinRate * dt;
      // Sub-linear growth — smoke billows hard off the muzzle then slows.
      s.mesh.scale.setScalar(0.05 + Math.pow(clamp(age, 0, 1), 0.75) * 0.33);
      const m = s.mesh.material as MeshBasicMaterial;
      // Fade-in over the first sixth of its life so the puff condenses rather
      // than popping into full opacity in front of the still-visible flash.
      m.opacity =
        0.3 * smoothstep(clamp(age * 6, 0, 1)) * clamp(s.life * 1.7, 0, 1);
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

    // How far the support hand has left its grip (0 = planted, 1 = away).
    // Computed before either arm is solved because the thumb-forward grip
    // blend needs it for both hands.
    let handAway = 0;
    if (this.reloadT >= 0 && !def.shellReload) {
      const p = this.reloadT;
      // Travel down to the mag pouch and back — an arc, not a straight line.
      // The departure starts immediately (p≈0), BEFORE the magazine is
      // released in reloadPose: anticipation is the hand leaving first.
      handAway = Math.sin(clamp((p - 0.02) / 0.60, 0, 1) * Math.PI);
    } else if (this.reloadT >= 0 && def.shellReload) {
      handAway = Math.sin(clamp(this.reloadT, 0, 1) * Math.PI);
    }
    // Thumb-forward grip on long guns: thumbs lay along the frame/handguard
    // instead of wrapping them — the firing thumb rides the receiver, the
    // support thumb rides the handguard (the C-clamp every modern manual
    // teaches). Both relax back to a wrapped pose while the support hand is
    // away fetching a magazine. Pistols keep both thumbs wrapped high.
    const thumbForward = (def.class === 'pistol' ? 0 : 1) * (1 - clamp(handAway, 0, 1));

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
    this.poseWrist(this.arms.right, 1, thumbForward);

    // Left hand: on the handguard, except mid-reload when it fetches a mag.
    // Its wrist sits below the support point; the palm rises onto the barrel
    // and the fingers curl inboard around it. The support grip is therefore a
    // vertical hand frame, not the firing hand's along-the-bore frame.
    this.tmpVec.set(def.leftGrip[0] - SUPPORT_HAND_OUTBOARD, def.leftGrip[1] - PALM_REACH * 1.5, def.leftGrip[2]);
    this.gunPivot.localToWorld(this.tmpVec);
    if (this.reloadT >= 0 && !def.shellReload) {
      this.tmpVec.x += handAway * 0.22;
      this.tmpVec.y -= handAway * 0.34;
      this.tmpVec.z += handAway * 0.16;
    } else if (this.reloadT >= 0 && def.shellReload) {
      this.tmpVec.x += handAway * 0.16;
      this.tmpVec.y -= handAway * 0.2;
      this.tmpVec.z += handAway * 0.22;
    }
    this.tmpVec2.set(-0.5, -0.85, 0.35).add(this.tmpVec);
    solveTwoBoneIK(this.arms.left.root, this.arms.left.elbow, this.tmpVec, this.tmpVec2, UPPER_ARM, FOREARM);
    this.poseWrist(this.arms.left, -1, thumbForward);
  }

  /** Orients the hand onto the grip and curls the fingers around it. */
  private poseWrist(arm: HandRig, side: number, thumbForward = 0) {
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

    // Support-hand thumb: wrapped by default (the Arms.ts authored pose),
    // blended toward laid-forward along the handguard as `thumbForward` rises.
    //
    // In the support hand's frame, rotating the thumb's rest pose further
    // about local Z swings its long axis onto the bore direction — from
    // "wrapped over the top" to "riding the rail", the C-clamp stance. (The
    // firing thumb keeps its authored high wrap: against a receiver it already
    // reads correctly, and the same rotation does not map cleanly onto the
    // firing hand's mirrored frame.)
    const thumb = side < 0 ? arm.fingers[4] : null;
    if (thumb) {
      thumb.rotation.x = lerp(-0.45, -0.23, thumbForward);
      thumb.rotation.z = lerp(side * -0.95, side * -0.95 * -1.26, thumbForward);
    }
  }

  dispose() {
    if (this.gun) disposeModel(this.gun.root);
    // ViewModel-owned effect resources: the contact decals and the heat card
    // use the shared cached glow texture (never disposed here), but their
    // materials and geometries belong to this instance.
    this.contactMat.dispose();
    this.contactGeo.dispose();
    (this.heatGlow.material as MeshBasicMaterial).dispose();
    this.heatGlow.geometry.dispose();
    this.viewScene.remove(this.root);
  }
}
