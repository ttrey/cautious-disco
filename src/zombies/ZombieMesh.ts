import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three';
import { boxProjectUV, mergeAll } from '../util/geometry';
import { makeSurface } from '../assets/Materials';
import { Rng, TAU, clamp, lerp, makeFbm, smoothstep } from '../util/math';
import {
  BodySection,
  BoneName,
  BonePair,
  CAVITY,
  EYE_R,
  EYE_X,
  EYE_Y,
  EYE_Z,
  FRONT_ANGLE,
  HEAD_BOTTOM,
  HEAD_SCALE,
  MOUTH_Y,
  SKELETON,
  Tint,
  UV_SCALE,
  WHITE,
  autoSkin,
  bakeVertexOcclusion,
  box,
  displaceAlongNormals,
  dome,
  ellipsoid,
  ensureChainLock,
  ensureTints,
  frontness,
  gaussian,
  headWorld,
  lockToTorso,
  mixTint,
  raggedSurface,
  rigidSkinRegion,
  skullPoint,
  skullSideX,
  smoothCurve,
  sweep,
  tint,
  tube,
  verticalLoft,
  wrappedPanel,
} from '../characters/CharacterGeometry';

/**
 * Procedural zombie construction.
 *
 * Everything here is authored in metres against real anthropometry, because the
 * failure mode of a procedural character is not "low poly", it is "wrong size":
 * a 3 mm eye or a 28 mm mouth reads as a smudge no matter how much geometry it
 * is made of. Landmarks therefore use measured values — 62 mm interpupillary
 * distance, 148 mm head width, 8 mm incisors — and the code says so.
 *
 * The body is a genuinely skinned character:
 *
 *  - A 19-bone humanoid skeleton with real proportions (1.75 m, eight heads).
 *  - The head is a lofted skull with a superelliptical cross-section, carved
 *    orbits and a real mandible line, carrying separate eyes, lids, nose, lips,
 *    gums, teeth, ears and matted hair.
 *  - Limbs and torso are tapered elliptical tubes with hand-authored radius
 *    profiles; the torso loft additionally carries rib, sternum and spine
 *    relief so an exposed chest reads as a starved ribcage.
 *  - The uniform is torn *geometrically*: garment panels are grids whose cells
 *    are dropped by a noise field, so holes are actual holes with flesh behind
 *    them and frayed, blood-darkened edges.
 *  - Per-seed variation in stature, build, decay, wounds and which parts of the
 *    uniform have survived, so a horde is not one model repeated.
 *
 * Flesh, cloth and gear are three SkinnedMeshes sharing one skeleton. Feature
 * colour (sclera, gums, rot, blood, bone) is carried in vertex colours that
 * multiply the material tint, which keeps the whole character at three draw
 * calls.
 */

export type { BoneName };

export interface ZombieRig {
  root: Group;
  bones: Record<BoneName, Bone>;
  boneList: Bone[];
  skeleton: Skeleton;
  skin: SkinnedMesh;
  clothes: SkinnedMesh;
  /** Load-bearing kit, headgear and boots — one shared dark field material. */
  gear: SkinnedMesh;
  /** Bind-pose world positions, used for hitbox construction. */
  bindPositions: Record<BoneName, Vector3>;
  /** Overall scale applied to this variant. */
  height: number;
}

/* ------------------------------------------------------------------ */
/* Vertex tints                                                        */
/* ------------------------------------------------------------------ */

/**
 * A corpse's sclera is dull, dry and yellowing — barely brighter than the skin
 * around it. Anything approaching white turns the eye into a golf ball.
 */
const SCLERA: Tint = [0.98, 0.9, 0.66];
const IRIS: Tint = [0.3, 0.34, 0.32];
const PUPIL: Tint = [0.05, 0.05, 0.055];
const TOOTH: Tint = [1.34, 1.2, 0.86];
const GUM: Tint = [0.62, 0.26, 0.24];
const LIP: Tint = [0.5, 0.34, 0.34];
const BONE: Tint = [1.18, 1.12, 0.94];
/** Exposed wet tissue at the edge of a wound. */
const RAW: Tint = [0.62, 0.16, 0.14];
const ROT: Tint = [0.34, 0.3, 0.22];
const HAIR: Tint = [0.14, 0.115, 0.1];

/* ------------------------------------------------------------------ */
/* Head                                                                */
/* ------------------------------------------------------------------ */

interface Crater {
  centre: Vector3;
  radius: number;
  depth: number;
  /** Deep enough that the bone underneath is showing. */
  bone: boolean;
}

interface HeadSpec {
  /** 0 = a fresh corpse, 1 = weeks gone. Drives hollows, rot and wounds. */
  decay: number;
  jawDrop: number;
  noseRotted: boolean;
  hasHair: boolean;
  hairLoss: number;
  earTorn: number;
  craters: Crater[];
  /** Radians the upper lid hangs below the top of the globe, per side. */
  lidDroop: [number, number];
  gaze: [number, number];
  eyeMilky: number;
  seed: number;
}

/**
 * The skull shell: cranium, brow, temples, cheekbones, orbits, nasal aperture,
 * mouth hollow, jawline and rot craters, as one lofted surface.
 *
 * Feature relief is applied in metres against the landmarks above rather than as
 * fractions of a unit sphere, so "5 mm brow ridge" means 5 mm.
 */
function buildSkullShell(spec: HeadSpec): BufferGeometry {
  const rows = 46;
  const cols = 60;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const stride = cols + 1;
  const p = new Vector3();

  const rot = makeFbm(spec.seed ^ 0x51ab, { octaves: 4, frequency: 6.5 });

  for (let i = 0; i <= rows; i++) {
    const h = Math.cos((i / rows) * Math.PI);
    for (let j = 0; j <= cols; j++) {
      // angle 0 faces -Z (the character's front) and increases to the left.
      const angle = (j / cols) * TAU - Math.PI;
      p.copy(skullPoint(h, angle));
      const face = Math.cos(angle); // 1 dead ahead, 0 at the ears, -1 behind.
      const front = clamp(face, 0, 1);
      const side = Math.abs(Math.sin(angle));
      let dz = 0; // forward relief, negative = proud of the face
      let dx = 0; // lateral relief, negative = pinched in
      let dy = 0;
      // Height offsets that do not vary with angle, so they are safe to apply
      // at the poles (see `poleFade` below).
      let dyUniform = 0;
      let t: Tint = WHITE;

      // Supraorbital ridge. Bone, so it stays proud even on a wasted face, and
      // it is what casts the shadow that makes the eyes read as recessed.
      const brow =
        gaussian(Math.abs(p.x) - 0.024, 0.026) * gaussian(p.y - 0.012, 0.011) * front;
      const glabella = gaussian(p.x, 0.012) * gaussian(p.y - 0.014, 0.012) * front;
      dz -= 0.0065 * brow + 0.0035 * glabella;

      // Orbits: a 40 x 34 mm bowl per side, 9-11 mm deep, darkened inside.
      for (const sx of [-1, 1]) {
        const d = Math.hypot((p.x - sx * EYE_X) / 0.0195, (p.y - EYE_Y) / 0.0165);
        const bowl = smoothstep(clamp(1 - d, 0, 1)) * front;
        dz += (0.0095 + 0.003 * spec.decay) * bowl;
        // Only a light shade: the bowl's own geometry casts the socket shadow,
        // and painting it dark as well leaves the eye reading as a pale egg
        // sitting in a black hole.
        if (bowl > 0.02) t = mixTint(t, [0.62, 0.56, 0.53], clamp(bowl * 1.3, 0, 1));
      }

      // Temporal hollow above the cheekbone, and the flat of the temple.
      const temple = gaussian(p.y - 0.022, 0.03) * side * clamp(face + 0.4, 0, 1);
      dx -= 0.005 * temple;

      // Zygomatic arch, then the hollow under it. The hollow is the single
      // strongest "starved corpse" cue on the whole model.
      for (const sx of [-1, 1]) {
        const cheekBone =
          gaussian(p.x - sx * 0.05, 0.019) * gaussian(p.y + 0.026, 0.014) * clamp(face + 0.25, 0, 1);
        const hollow =
          gaussian(p.x - sx * 0.043, 0.018) * gaussian(p.y + 0.055, 0.017) * front;
        dz -= 0.005 * cheekBone;
        dx += 0.0035 * cheekBone;
        dz += (0.006 + 0.005 * spec.decay) * hollow;
        dx -= (0.004 + 0.003 * spec.decay) * hollow;
        if (cheekBone > 0.55 && spec.decay > 0.55) {
          t = mixTint(t, BONE, clamp((cheekBone - 0.55) * 1.6 * spec.decay, 0, 0.75));
        }
      }

      // Nasal root and the pyriform aperture. On rotted noses the aperture is
      // the nose: a dark hole with the bony margin showing around it.
      const nasalRoot = gaussian(p.x, 0.011) * gaussian(p.y - 0.001, 0.014) * front;
      dz -= 0.004 * nasalRoot;
      const aperture =
        gaussian(p.x, 0.0085) * gaussian(p.y + 0.038, 0.0135) * front;
      dz += (spec.noseRotted ? 0.013 : 0.005) * aperture;
      if (spec.noseRotted && aperture > 0.25) {
        t = mixTint(t, CAVITY, clamp((aperture - 0.25) * 1.6, 0, 0.9));
      }

      // Mouth hollow. Deep and tight rather than a broad dish: the dental
      // arcades stand 8 mm proud of this floor, so the recess is what makes the
      // teeth read as being inside a mouth.
      const oral = gaussian(p.x, 0.019) * gaussian(p.y - MOUTH_Y, 0.0105) * front;
      dz += 0.016 * oral;

      // Philtrum, and the maxillary mass either side of it.
      dz -= 0.0022 * gaussian(p.x, 0.006) * gaussian(p.y + 0.058, 0.009) * front;

      // Mandible: a defined jawline from the angle forward to the chin, plus
      // the mental protuberance. The shell carries this rather than a separate
      // jaw part, which is what keeps it attached when the head deforms.
      const jawLine =
        gaussian(Math.abs(p.x) - 0.046, 0.019) * gaussian(p.y + 0.08, 0.015) * clamp(face + 0.3, 0, 1);
      dx += 0.004 * jawLine;
      // Submandibular hollow: the shadow under the jaw is what separates a head
      // from the neck it sits on, and it has to be cut, not shaded.
      //
      // Scaled by `side`, because `dx` is mirrored through `Math.sign(p.x)` on
      // the way out. A lateral pull that is still at full strength on the
      // midline therefore drags the left columns right and the right columns
      // left past each other: 8 mm of pull on rows whose columns are 3 mm apart
      // turned the underside of the chin inside out, and the fold rendered as a
      // bright vertical blade hanging into the throat. The hollow belongs beside
      // the mandible anyway, not under the chin.
      const underJaw = gaussian(p.y + 0.104, 0.018) * clamp(face + 0.55, 0, 1);
      dx -= 0.008 * underJaw * side;
      dz += 0.006 * underJaw * clamp(-face, 0, 1);
      const chin = gaussian(p.x, 0.016) * gaussian(p.y + 0.1, 0.015) * front;
      dz -= 0.011 * chin;
      dy -= 0.004 * chin;
      // Mentolabial sulcus — the crease between the lower lip and the chin.
      // Without it the whole lower face is one blank expanse and reads long.
      dz += 0.0035 * gaussian(p.x, 0.021) * gaussian(p.y + 0.087, 0.008) * front;
      // Nasolabial folds, which on a wasted face are deep.
      for (const sx of [-1, 1]) {
        dz += (0.0025 + 0.002 * spec.decay)
          * gaussian(p.x - sx * 0.0245, 0.007)
          * gaussian(p.y + 0.056, 0.014)
          * front;
      }
      // Agape. Ramped in below the cheekbones so the orbits never move. This is
      // a translation of the whole lower head, not angle-dependent relief, so it
      // must bypass the pole fade — fading it makes the rows above the bottom
      // pole drop further than the pole itself, folding the jaw back through
      // itself as a fan of splinters.
      dyUniform -= spec.jawDrop * smoothstep(clamp((-p.y - 0.045) / 0.045, 0, 1));

      // Occiput and the nuchal shelf at the back of the skull.
      dz += 0.004 * gaussian(p.y - 0.02, 0.05) * clamp(-face, 0, 1);

      // Desiccation: broad low-frequency shrinkage, strongest on the temples
      // and the back of the jaw where there is least tissue over the bone.
      const dryness = (rot(p.x * 4 + 0.5, p.y * 4 + 0.5) - 0.5) * 2;
      const boneClose = clamp(temple * 1.4 + jawLine * 0.9, 0, 1);
      dx -= 0.0035 * spec.decay * boneClose * clamp(dryness, 0, 1);
      t = mixTint(t, ROT, clamp(dryness * 0.5, 0, 1) * spec.decay * 0.55);

      // Rot craters: bites, gunshots and slipped skin. Each is a real
      // depression with wet tissue at the rim and, when deep, bone in the base.
      // A crater is 20-30 mm across on a shell whose vertices are 5-7 mm apart,
      // so its colour is carried by four or five samples in each direction.
      // That is not enough to render a hard edge as a curve: the `k * 1.4` this
      // used to saturate with turned every exposed patch of bone into a
      // flat-sided polygon sitting on the forehead, which read as a texturing
      // error rather than as an injury. Ramping the whole way to the rim
      // instead spends those few samples on the transition, which is the one
      // thing at this density that can look smooth.
      for (const crater of spec.craters) {
        const d = p.distanceTo(crater.centre) / crater.radius;
        if (d >= 1) continue;
        const k = smoothstep(1 - d);
        dz += crater.depth * k * front;
        dx -= crater.depth * k * side * 0.8;
        t = mixTint(t, crater.bone ? BONE : RAW, k * 0.78);
        // Wet tissue around the rim, blended over the outer half rather than
        // ringed on at a fixed radius.
        t = mixTint(t, RAW, smoothstep(clamp(1 - Math.abs(d - 0.75) / 0.3, 0, 1)) * 0.5);
      }

      // Every vertex in a pole row shares one position but has its own angle,
      // so any relief that varies with angle tears the pole into a fan of
      // spikes. Fading the relief out over the last few rows prevents that.
      const poleFade = smoothstep(clamp((1 - Math.abs(h)) / 0.07, 0, 1));
      positions.push(
        p.x + dx * poleFade * Math.sign(p.x || 1),
        p.y + dy * poleFade + dyUniform,
        p.z + dz * poleFade,
      );
      // Metre UVs, wrapped the long way round the skull.
      uvs.push((j / cols) * TAU * 0.075 * UV_SCALE, (p.y - HEAD_BOTTOM) * UV_SCALE);
      colors.push(t[0], t[1], t[2]);
    }
  }

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const p0 = i * stride + j;
      indices.push(p0, p0 + 1, p0 + stride, p0 + 1, p0 + stride + 1, p0 + stride);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * One eyelid, as a band of a sphere concentric with the globe.
 *
 * The lid margin is not a horizontal line: it rises toward both canthi so the
 * aperture is an almond that closes to a point at each corner. A constant-pitch
 * band instead leaves a rectangular slot, which is what makes procedural eyes
 * read as goggles.
 */
function eyelid(
  centre: Vector3,
  radius: number,
  upper: boolean,
  margin: number,
): BufferGeometry | null {
  const span = 1.18;
  const pole = upper ? 1.52 : -1.52;
  return raggedSurface(
    (u, v) => {
      // The lower lid runs the other way round so its winding still faces out.
      const yaw = upper ? lerp(-span, span, u) : lerp(span, -span, u);
      const corner = Math.pow(Math.abs(yaw) / span, 1.8) * 0.52;
      const from = upper ? margin - corner : margin + corner;
      const pitch = lerp(from, pole, v);
      return new Vector3(
        centre.x + Math.sin(yaw) * Math.cos(pitch) * radius,
        centre.y + Math.sin(pitch) * radius,
        centre.z - Math.cos(yaw) * Math.cos(pitch) * radius,
      );
    },
    14,
    upper ? 5 : 4,
    { edgeWidth: 0.004, edgeTint: WHITE },
  );
}

/** Eyeball, iris, pupil and both lids for one side. */
function buildEye(parts: BufferGeometry[], spec: HeadSpec, sx: number, side: number) {
  const centre = new Vector3(sx * EYE_X, EYE_Y, EYE_Z);
  const droop = spec.lidDroop[side];

  // The globe. Yellowed sclera with blood tracking through it — the veining is
  // vertex colour on the same sphere, so it costs nothing extra.
  const globe = ellipsoid(centre, new Vector3(EYE_R, EYE_R, EYE_R), 16, 10);
  const vein = makeFbm(spec.seed ^ (0x9e1 + side), { octaves: 3, frequency: 26 });
  tint(globe, (x, y, z) => {
    const v = vein(x * 40, y * 40 + z * 12);
    const bloodshot = clamp((v - 0.52) * 3.4, 0, 1);
    const yellowed = mixTint(SCLERA, [1.12, 0.92, 0.5], spec.decay * 0.6);
    return mixTint(yellowed, [1.0, 0.24, 0.2], bloodshot * 0.8);
  });
  parts.push(globe);

  // Iris and pupil sit just proud of the globe so they read as a disc rather
  // than as a stain under the surface. A dead eye's iris is clouded, not blue.
  const gazeX = spec.gaze[0];
  const gazeY = spec.gaze[1];
  const front = new Vector3(centre.x + gazeX, centre.y + gazeY, centre.z - EYE_R * 0.86);
  parts.push(
    tint(
      ellipsoid(front, new Vector3(0.0058, 0.0058, 0.0026), 14, 8),
      mixTint(IRIS, [0.82, 0.84, 0.8], spec.eyeMilky),
    ),
  );
  parts.push(
    tint(
      ellipsoid(
        new Vector3(front.x, front.y, front.z - 0.0018),
        new Vector3(0.0027, 0.0027, 0.0016),
        12,
        8,
      ),
      mixTint(PUPIL, [0.5, 0.5, 0.47], spec.eyeMilky * 0.7),
    ),
  );

  // Lids close over the globe from above and below. The 3 mm clearance matters:
  // at 1.5 mm the flesh displacement pass pushes the globe back out through the
  // lid in places.
  const lidR = EYE_R + 0.003;
  const upper = eyelid(centre, lidR, true, 0.26 - droop);
  if (upper) {
    // Lid skin is face-coloured; only the lid margin itself is dark.
    tint(upper, (_x, y) => {
      const margin = clamp((y - (centre.y + Math.sin(0.26 - droop) * lidR)) / 0.004, 0, 1);
      return mixTint([0.42, 0.34, 0.32], [0.97, 0.95, 0.92], margin);
    });
    parts.push(upper);
  }
  const lower = eyelid(centre, lidR, false, -0.42);
  if (lower) {
    tint(lower, (_x, y) => {
      const margin = clamp(((centre.y + Math.sin(-0.42) * lidR) - y) / 0.004, 0, 1);
      return mixTint([0.48, 0.38, 0.36], [1.0, 0.97, 0.93], margin);
    });
    parts.push(lower);
  }
}

/** Nose: bridge, tip, wings and nostrils — or the bare aperture if rotted. */
function buildNose(parts: BufferGeometry[], spec: HeadSpec) {
  const bridgeTop = new Vector3(0, 0.006, -0.0685);
  if (spec.noseRotted) {
    // Only the nasal bones survive: a short ridge above a dark hole, with a
    // ragged margin of exposed bone where the cartilage tore away.
    parts.push(
      tint(
        tube(bridgeTop, new Vector3(0, -0.022, -0.076), (t) => [
          lerp(0.0085, 0.006, t),
          lerp(0.007, 0.005, t),
        ], 10, 3),
        mixTint(WHITE, BONE, 0.7),
      ),
    );
    parts.push(
      tint(
        ellipsoid(new Vector3(0, -0.036, -0.0655), new Vector3(0.011, 0.014, 0.006), 14, 8),
        CAVITY,
      ),
    );
    return;
  }

  // Dorsum and lobule. 22 mm of projection past the maxilla, which is what
  // gives a face a profile at all. The tip and both wings are one 31 mm-wide
  // mass rather than three balls: separate alae read as a cluster of grapes.
  parts.push(
    tube(bridgeTop, new Vector3(0, -0.034, -0.0785), (t) => [
      lerp(0.0065, 0.0092, smoothstep(t)),
      lerp(0.006, 0.009, smoothstep(t)),
    ], 12, 4),
  );
  parts.push(
    ellipsoid(new Vector3(0, -0.0435, -0.0795), new Vector3(0.0155, 0.0105, 0.0115), 16, 10),
  );
  for (const sx of [-1, 1]) {
    parts.push(
      tint(
        ellipsoid(new Vector3(sx * 0.0066, -0.0522, -0.0735), new Vector3(0.003, 0.0026, 0.0036), 10, 8),
        CAVITY,
      ),
    );
  }
}

/** Oral cavity, gums, two dental arcades and retracted lips. */
function buildMouth(parts: BufferGeometry[], spec: HeadSpec, rng: Rng) {
  const drop = spec.jawDrop;
  const upperGumY = MOUTH_Y + 0.002;
  const lowerGumY = MOUTH_Y - 0.016 - drop;
  // Dental arcade: 24 mm across, 20 mm deep, centred behind the lip line.
  const arcCentre = new Vector3(0, 0, -0.0455);
  const arcRX = 0.0235;
  const arcRZ = 0.0205;
  const arcPoint = (y: number, a: number) => new Vector3(
    arcCentre.x + Math.sin(a) * arcRX,
    y,
    arcCentre.z - Math.cos(a) * arcRZ,
  );

  // The cavity is one dark ellipsoid, mostly buried in the head; only the part
  // framed by the lips and teeth is ever visible.
  parts.push(
    tint(
      ellipsoid(
        new Vector3(0, (upperGumY + lowerGumY) * 0.5, -0.036),
        new Vector3(0.026, 0.010 + drop * 0.55, 0.022),
        18,
        10,
      ),
      CAVITY,
    ),
  );

  for (const upper of [true, false]) {
    const gumY = upper ? upperGumY : lowerGumY;
    const sign = upper ? -1 : 1;
    const gumPts: Vector3[] = [];
    for (let k = -3; k <= 3; k++) gumPts.push(arcPoint(gumY, (k / 3) * 1.05));
    parts.push(tint(sweep(gumPts, () => [0.0042, 0.0038], 14, 6), GUM));

    // Ten front teeth per arcade. Incisors are 8-9 mm tall and 5.5 mm wide;
    // anything smaller vanishes at gameplay distance, which is why the old
    // 2 mm pips read as a zip fastener rather than as a mouth.
    for (let k = -4; k <= 4; k++) {
      const a = (k / 4.6) * 1.15;
      const missing = rng.chance(0.1 + spec.decay * 0.16);
      const broken = !missing && rng.chance(0.22);
      const height = missing ? 0.0022 : broken ? rng.range(0.004, 0.006) : (upper ? 0.0092 : 0.0078);
      const width = lerp(0.0029, 0.0022, Math.abs(k) / 4.6);
      const at = arcPoint(gumY + sign * height * 0.42, a);
      const t = new CylinderGeometry(width * 0.86, width, height, 5, 1, false);
      t.scale(1, 1, 0.62);
      t.rotateX(sign * 0.12);
      t.rotateY(-a);
      t.translate(at.x, at.y, at.z);
      boxProjectUV(t, UV_SCALE);
      const stain = rng.range(0, 1) * spec.decay;
      tint(t, mixTint(TOOTH, [0.5, 0.4, 0.24], clamp(stain, 0, 0.8)));
      parts.push(t);
    }
  }

  // Lips: dried and drawn back off the teeth, so they are thin cords rather
  // than full pads. Their line is what separates a snarl from a hole.
  const lipSpan = 0.023;
  const retract = 0.0018 * spec.decay;
  const upperLip: Vector3[] = [
    new Vector3(-lipSpan, MOUTH_Y + 0.001, -0.0555),
    new Vector3(-0.011, MOUTH_Y + 0.005 + retract, -0.0655),
    new Vector3(0, MOUTH_Y + 0.0045 + retract, -0.0685),
    new Vector3(0.011, MOUTH_Y + 0.005 + retract, -0.0655),
    new Vector3(lipSpan, MOUTH_Y + 0.001, -0.0555),
  ];
  const lowerLip: Vector3[] = [
    new Vector3(-lipSpan, MOUTH_Y - 0.014 - drop, -0.0555),
    new Vector3(-0.011, MOUTH_Y - 0.021 - drop - retract, -0.0645),
    new Vector3(0, MOUTH_Y - 0.023 - drop - retract, -0.0675),
    new Vector3(0.011, MOUTH_Y - 0.021 - drop - retract, -0.0645),
    new Vector3(lipSpan, MOUTH_Y - 0.014 - drop, -0.0555),
  ];
  const lipProfile = (t: number): [number, number] => {
    const mid = Math.sin(t * Math.PI);
    return [0.0032 + 0.0014 * mid, 0.0026 + 0.0016 * mid];
  };
  parts.push(tint(sweep(upperLip, lipProfile, 18, 7), LIP));
  parts.push(tint(sweep(lowerLip, (t) => {
    const [w, h] = lipProfile(t);
    return [w * 1.1, h * 1.25];
  }, 18, 7), LIP));
}

/**
 * Outer ear: a vertical bar swept along the side of the skull, with a helix rim
 * and a dark concha.
 *
 * It has to follow `skullSideX` down its whole length. A single ellipsoid at a
 * fixed x was tried first and the skull narrows by 7 mm from the top of the ear
 * to the lobe, so the bottom of the ear floated off the head.
 */
function buildEar(parts: BufferGeometry[], spec: HeadSpec, sx: number) {
  const earTop = 0.014;
  const earBottom = -0.036;
  if (spec.earTorn === sx) {
    const at = new Vector3(sx * (skullSideX(-0.008) - 0.002), -0.008, 0.014);
    parts.push(tint(ellipsoid(at, new Vector3(0.007, 0.014, 0.011), 10, 8), mixTint(RAW, ROT, 0.4)));
    return;
  }

  const along = (t: number, outward: number, back: number) => {
    const y = lerp(earTop, earBottom, t);
    // Ears stand furthest off the skull across the middle of the helix.
    const flare = Math.sin(Math.PI * clamp(t, 0.08, 0.92));
    return new Vector3(
      sx * (skullSideX(y) - 0.001 + outward * flare),
      y,
      0.012 + back - 0.003 * flare,
    );
  };
  const path: Vector3[] = [];
  for (let k = 0; k <= 5; k++) path.push(along(k / 5, 0.004, 0));
  parts.push(
    sweep(path, (t) => {
      const taper = Math.pow(Math.sin(Math.PI * clamp(t, 0.04, 0.96)), 0.5);
      return [0.0035 + 0.004 * taper, 0.004 + 0.014 * taper];
    }, 14, 8, new Vector3(0, 0, 1)),
  );
  // Helix: the rolled rim around the outer and rear edge of the ear.
  const rim: Vector3[] = [];
  for (let k = 0; k <= 5; k++) rim.push(along(k / 5, 0.0075, 0.012));
  parts.push(sweep(rim, () => [0.0028, 0.0032], 12, 6, new Vector3(0, 0, 1)));
  // Concha, sitting in the shadow of the rim.
  parts.push(
    tint(
      ellipsoid(along(0.42, 0.003, -0.004), new Vector3(0.0055, 0.011, 0.0075), 10, 8),
      mixTint(CAVITY, ROT, 0.45),
    ),
  );
}

/**
 * Matted hair over the back and top of the scalp, with the patches missing that
 * a body left outdoors would have lost. Bald egg-heads are the fastest way to
 * make a horde look like mannequins.
 */
function buildHair(parts: BufferGeometry[], spec: HeadSpec) {
  const patchy = makeFbm(spec.seed ^ 0x4a17, { octaves: 4, frequency: 3.4 });
  const cols = 40;
  const rows = 18;
  const point = (u: number, v: number) => {
    const angle = lerp(-Math.PI, Math.PI, u);
    const h = lerp(-0.24, 1, v);
    return skullPoint(h, angle, 0.004 + 0.003 * patchy(u * 3, v * 3));
  };
  const alive = (u: number, v: number) => {
    // Hairline: recedes at the temples, stops above the brow, and wanders.
    const angle = lerp(-Math.PI, Math.PI, u);
    const front = Math.max(0, 1 - Math.abs(angle) / 1.2);
    const hairline = 0.2 * front * front + (patchy(u * 6, 3.1) - 0.5) * 0.12;
    const patch = patchy(u * 2.2, v * 2.2) - 0.3 - spec.hairLoss * 0.3;
    let m = Math.min(patch * 0.06, (v - hairline) * 0.05);
    for (const crater of spec.craters) {
      const p = point(u, v);
      m = Math.min(m, (p.distanceTo(crater.centre) - crater.radius * 1.15) * 0.5);
    }
    return m;
  };
  const geo = raggedSurface(point, cols, rows, {
    alive,
    // A wide edge blend toward mid-tone hides the grid steps that a hard hair
    // boundary would otherwise show along the hairline.
    edgeWidth: 0.013,
    edgeTint: [0.5, 0.44, 0.38],
    baseTint: () => HAIR,
  });
  if (geo) parts.push(geo);
}

/** Everything above the neck, in head-local space. */
function buildHead(spec: HeadSpec, rng: Rng): BufferGeometry {
  const parts: BufferGeometry[] = [buildSkullShell(spec)];
  buildEye(parts, spec, -1, 0);
  buildEye(parts, spec, 1, 1);
  buildNose(parts, spec);
  buildMouth(parts, spec, rng);
  buildEar(parts, spec, -1);
  buildEar(parts, spec, 1);
  if (spec.hasHair) buildHair(parts, spec);

  // A dried tongue in the floor of an open mouth. One part, and it is the
  // difference between an open jaw and a hole. A matching exposed-tendon strand
  // on the cheek was tried and removed: at 1.6 mm across it reads as a splinter
  // stuck to the face rather than as anatomy.
  if (spec.jawDrop > 0.012) {
    parts.push(
      tint(
        ellipsoid(
          new Vector3(0, MOUTH_Y - 0.012 - spec.jawDrop * 0.55, -0.0455),
          new Vector3(0.011, 0.0042, 0.014),
          12,
          8,
        ),
        [0.44, 0.19, 0.18],
      ),
    );
  }

  ensureTints(parts);
  const merged = mergeAll(parts, ['color'])!;
  parts.forEach((part) => part.dispose());
  merged.computeVertexNormals();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Decay colouring                                                     */
/* ------------------------------------------------------------------ */

/**
 * Multiplies the authored feature colours by per-zombie decay: mottling, livor
 * mortis pooling on the back and underside, gangrenous extremities and dark
 * bruising. Vertices that already carry a feature colour (sclera, teeth, gums,
 * cavities) are left alone so the pass cannot mud them out.
 */
function colourFlesh(
  geo: BufferGeometry,
  seed: number,
  ctx: {
    hands: Vector3[];
    feet: Vector3[];
    decay: number;
    wounds: { centre: Vector3; radius: number }[];
  },
) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color as BufferAttribute;
  // Octave counts are deliberately low: this runs on every vertex of every rig
  // in the pool at load, and the difference between three octaves and four is
  // not visible on flesh at gameplay distance.
  const blotch = makeFbm(seed ^ 0x1122, { octaves: 3, frequency: 3.2 });
  const fine = makeFbm(seed ^ 0x3344, { octaves: 2, frequency: 11 });
  const livid = makeFbm(seed ^ 0x5566, { octaves: 2, frequency: 1.9 });
  const v = new Vector3();

  for (let i = 0; i < pos.count; i++) {
    const r = col.getX(i);
    const g = col.getY(i);
    const b = col.getZ(i);
    // Anything already authored away from white is a feature, not flesh.
    if (Math.abs(r - 1) > 0.02 || Math.abs(g - 1) > 0.02 || Math.abs(b - 1) > 0.02) continue;

    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let t: Tint = WHITE;

    // Uneven mottling. Two octave sets at different scales so the skin has both
    // large drained patches and fine discoloration.
    const m = (blotch(x * 3.4 + 5, y * 2.8) - 0.5) * 2;
    const f = (fine(z * 5 + 1.7, y * 5) - 0.5) * 2;
    const shade = 1 + m * 0.17 + f * 0.08;
    t = [t[0] * shade, t[1] * shade * (1 - m * 0.05), t[2] * shade * (1 - m * 0.1)];

    // Livor mortis: blood settles into whatever was lowest, so the back and the
    // undersides go purple while the front stays waxy.
    const pooling =
      clamp(livid(x * 1.6, y * 1.1) * 1.2 - 0.35, 0, 1) *
      clamp(0.35 + z * 3.5, 0, 1) *
      clamp(1.25 - (y - 0.6) * 0.55, 0, 1);
    t = mixTint(t, [0.58, 0.38, 0.49], pooling * (0.45 + 0.35 * ctx.decay));

    // Gangrene creeps up from the extremities.
    let extremity = 0;
    for (const hand of ctx.hands) {
      v.set(x - hand.x, y - hand.y, z - hand.z);
      extremity = Math.max(extremity, clamp(1 - v.length() / 0.16, 0, 1));
    }
    for (const foot of ctx.feet) {
      v.set(x - foot.x, y - foot.y, z - foot.z);
      extremity = Math.max(extremity, clamp(1 - v.length() / 0.14, 0, 1));
    }
    t = mixTint(t, [0.3, 0.32, 0.26], Math.pow(extremity, 1.6) * (0.55 + 0.3 * ctx.decay));

    // Wounds bruise outward from whatever tore the uniform open.
    for (const wound of ctx.wounds) {
      const d = Math.hypot(x - wound.centre.x, y - wound.centre.y, z - wound.centre.z) / wound.radius;
      if (d >= 1) continue;
      const k = smoothstep(1 - d);
      t = mixTint(t, [0.46, 0.17, 0.16], k * 0.85);
    }

    col.setXYZ(i, r * t[0], g * t[1], b * t[2]);
  }
  col.needsUpdate = true;
}

/**
 * Ground-in mud at the hem, sweat and rot salts, and blood soaking outward from
 * whatever tore the fabric. Multiplies the frayed-edge colours `raggedSurface`
 * already wrote, so a tear is dark and bloodied at its rim without a second
 * material or a decal.
 */
function stainUniform(
  geo: BufferGeometry,
  seed: number,
  decay: number,
  wounds: { centre: Vector3; radius: number }[],
) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color as BufferAttribute;
  const grime = makeFbm(seed ^ 0x2a2a, { octaves: 3, frequency: 2.4 });
  const fade = makeFbm(seed ^ 0x3b3b, { octaves: 2, frequency: 1.3 });

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let t: Tint = WHITE;

    // Sun-bleaching on the shoulders and upper back, grime everywhere else.
    const bleach = clamp((fade(x * 1.4, y * 1.2) - 0.4) * 1.6, 0, 1) * clamp((y - 1.15) / 0.3, 0, 1);
    t = mixTint(t, [1.22, 1.16, 1.02], bleach * 0.5);
    const dirt = clamp((grime(x * 2.2 + 3, y * 1.8) - 0.42) * 2.2, 0, 1);
    t = mixTint(t, [0.52, 0.46, 0.36], dirt * (0.35 + 0.25 * decay));
    // Mud wicks up from the ground.
    const splash = clamp(1 - (y - 0.55) / 0.45, 0, 1) * clamp((grime(x * 4, y * 4 + 9) - 0.3) * 2, 0, 1);
    t = mixTint(t, [0.44, 0.38, 0.29], splash * 0.7);

    for (const wound of wounds) {
      const d = Math.hypot(x - wound.centre.x, y - wound.centre.y, z - wound.centre.z) / (wound.radius * 2.4);
      if (d >= 1) continue;
      t = mixTint(t, [0.26, 0.11, 0.1], smoothstep(1 - d) * 0.85);
    }

    col.setXYZ(i, col.getX(i) * t[0], col.getY(i) * t[1], col.getZ(i) * t[2]);
  }
  col.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

// Drained, desaturated flesh with a green-grey cast. Warm tints read as a
// living person with a tan, which is exactly the wrong note.
//
// These are brighter than the colours they produce: the material tint multiplies
// a baked albedo that is itself around 0.24 linear, so a mid-grey tint lands the
// final surface near 0.3 in sRGB — dead, but still legible in a dark level.
const SKIN_TINTS = [0xa9ae9c, 0x9ea693, 0xb2ae95, 0x99a596, 0xafab97, 0xa1a390];
// Sun-bleached field colours only. Pastel workwear makes the same silhouette
// read as a civilian, while these stay recognisably military under cool light.
const CLOTH_TINTS = [0x99a37d, 0xb0a077, 0x8d9490, 0xbcab7a, 0x76835f, 0xa6926b, 0x6f7a68, 0xc0b287];

let skinBase: MeshStandardMaterial | null = null;
let clothBase: MeshStandardMaterial | null = null;
let gearBase: MeshStandardMaterial | null = null;

/** Smoked-olive kit, helmet shells and dark combat boots. Shared by the horde. */
function gearMaterial(): MeshStandardMaterial {
  if (!gearBase) {
    gearBase = makeSurface('zombieCloth', {
      repeat: 1,
      tint: 0x6c7159,
      roughness: 0.86,
      metalness: 0,
      normalScale: 0.7,
    });
    gearBase.envMapIntensity = 0.5;
    gearBase.vertexColors = true;
  }
  return gearBase;
}

function skinMaterial(rng: Rng): MeshStandardMaterial {
  if (!skinBase) {
    skinBase = makeSurface('zombieSkin', {
      repeat: 1,
      roughness: 1,
      metalness: 0,
      normalScale: 1.1,
      aoIntensity: 0.85,
    });
  }
  const m = skinBase.clone();
  m.color.setHex(rng.pick(SKIN_TINTS));
  m.vertexColors = true;
  // Subsurface is out of budget, but a touch of sheen keeps flesh from reading
  // as dry clay under the rim lights.
  m.envMapIntensity = 0.7;
  return m;
}

function clothMaterial(rng: Rng): MeshStandardMaterial {
  if (!clothBase) {
    clothBase = makeSurface('zombieCloth', {
      repeat: 1,
      roughness: 1,
      metalness: 0,
      normalScale: 1.0,
    });
  }
  const m = clothBase.clone();
  m.color.setHex(rng.pick(CLOTH_TINTS));
  m.envMapIntensity = 0.4;
  m.vertexColors = true;
  // Garments are open shells with holes torn through them, so both sides of the
  // fabric are visible; without DoubleSide every tear renders as a black gap.
  m.side = DoubleSide;
  return m;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

const TORSO_BOTTOM_Y = 0.86;
const TORSO_TOP_Y = 1.505;

/**
 * Human torso envelope in bind-pose metres. Width gives the pelvis, waist,
 * ribcage and trapezius landmarks; depth and centre offset are separate so the
 * front and back silhouettes can differ — the pelvis carries the buttocks
 * rearward, the lumbar region hollows and the thoracic cage returns behind the
 * waist instead of forming a flat plank.
 */
function bodySectionAt(y: number, bulk: number, gauntMass: number): BodySection {
  return {
    halfWidth: smoothCurve(y, [
      [0.86, 0.128],
      [0.94, 0.148],
      [1.0, 0.152],
      [1.08, 0.141],
      [1.14, 0.135],
      [1.22, 0.142],
      [1.32, 0.156],
      [1.4, 0.152],
      [1.45, 0.138],
      [1.505, 0.078],
    ]) * bulk,
    // The depth has to fall away sharply above the clavicles or the base of the
    // neck ends up as far forward as the sternum, and everything hung there —
    // collar, dog tags — floats out in front of the chin.
    halfDepth: smoothCurve(y, [
      [0.86, 0.096],
      [0.94, 0.107],
      [1.0, 0.109],
      [1.08, 0.1],
      [1.14, 0.096],
      [1.22, 0.101],
      [1.32, 0.11],
      [1.4, 0.1],
      [1.45, 0.088],
      [1.49, 0.062],
      [1.505, 0.05],
    ]) * bulk * gauntMass,
    centreZ: smoothCurve(y, [
      [0.86, 0.014],
      [1.0, 0.01],
      [1.1, -0.006],
      [1.2, -0.011],
      [1.32, -0.002],
      [1.42, 0.01],
      [1.505, 0.014],
    ]) * bulk,
  };
}

export function buildZombieMesh(seed: number, opts: { bulk?: number; height?: number } = {}): ZombieRig {
  const rng = new Rng((0x2b1e5a3d ^ Math.imul(seed, 2654435761)) >>> 0);
  return assemble(rng, seed, opts);
}

function assemble(rng: Rng, seed: number, opts: { bulk?: number; height?: number }): ZombieRig {
  const root = new Group();
  root.name = 'zombie';

  /* --- Per-variant character ----------------------------------------- */
  const heightScale = opts.height ?? rng.range(0.94, 1.06);
  const bulk = opts.bulk ?? rng.range(0.88, 1.14);
  const decay = rng.range(0.25, 1);
  // Emaciation. Limbs keep 88% of baseline mass at the gaunt extreme so major
  // muscle landmarks do not collapse into sticks.
  const gauntMass = lerp(0.88, 1.0, 1 - decay * rng.range(0.5, 1));
  // Drawn here rather than with the rest of the head, because the throat has to
  // know how far the jaw has dropped before it can meet it.
  const jawDrop = rng.range(0.004, 0.022);
  const headgearRoll = rng.next();
  const hasHelmet = headgearRoll < 0.3;
  const hasCap = !hasHelmet && headgearRoll < 0.46;
  const bareHead = !hasHelmet && !hasCap;

  /* --- Bones ---------------------------------------------------------- */
  const bones = {} as Record<BoneName, Bone>;
  const boneList: Bone[] = [];
  const boneIndex = {} as Record<BoneName, number>;

  for (const spec of SKELETON) {
    const bone = new Bone();
    bone.name = spec.name;
    bone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    bones[spec.name] = bone;
    boneIndex[spec.name] = boneList.length;
    boneList.push(bone);
  }
  // Shoulder joints keep their anthropometric +/-0.19 baseline while following
  // bulk. The small A-stance begins below the joint so the proximal upper arm
  // is not pulled away from the ribcage.
  const shoulderJointX = 0.19 * bulk;
  const upperArmLocalX = shoulderJointX - Math.abs(bones.clavicleL.position.x);
  bones.upperArmL.position.x = upperArmLocalX;
  bones.upperArmR.position.x = -upperArmLocalX;
  // The A-stance carries on down the arm. It has to: the pelvis is 0.152 wide
  // and the forearm is 0.05 thick, so an arm that drops straight from a 0.19
  // shoulder puts the wrist inside the waistband — the flesh interpenetrates,
  // and the skinning cannot separate hand from belt. Elbow and wrist also come
  // forward, because a relaxed arm hangs ahead of the hip, not beside it.
  bones.lowerArmL.position.set(0.055 * bulk, -0.28, -0.018);
  bones.lowerArmR.position.set(-0.055 * bulk, -0.28, -0.018);
  bones.handL.position.set(0.022 * bulk, -0.26, -0.026);
  bones.handR.position.set(-0.022 * bulk, -0.26, -0.026);
  for (const spec of SKELETON) {
    if (spec.parent) bones[spec.parent].add(bones[spec.name]);
    else root.add(bones[spec.name]);
  }
  root.updateMatrixWorld(true);

  const bindPositions = {} as Record<BoneName, Vector3>;
  for (const spec of SKELETON) {
    bindPositions[spec.name] = new Vector3().setFromMatrixPosition(bones[spec.name].matrixWorld);
  }
  const P = bindPositions;

  const headTop = P.head.clone().add(new Vector3(0, 0.2, 0));
  const handTipL = P.handL.clone().add(new Vector3(0, -0.085, 0));
  const handTipR = P.handR.clone().add(new Vector3(0, -0.085, 0));
  const toeL = P.footL.clone().add(new Vector3(0, -0.02, -0.15));
  const toeR = P.footR.clone().add(new Vector3(0, -0.02, -0.15));

  const bonePairs: BonePair[] = [
    { index: boneIndex.hips, a: P.hips.clone().add(new Vector3(0, -0.09, 0)), b: P.spine, radius: 0.15 * bulk, chain: 'torso' },
    { index: boneIndex.spine, a: P.spine, b: P.chest, radius: 0.15 * bulk, chain: 'torso' },
    { index: boneIndex.chest, a: P.chest, b: P.neck, radius: 0.17 * bulk, chain: 'torso' },
    { index: boneIndex.neck, a: P.neck, b: P.head, radius: 0.07, chain: 'torso' },
    { index: boneIndex.head, a: P.head, b: headTop, radius: 0.115, chain: 'torso' },
    { index: boneIndex.clavicleL, a: P.clavicleL, b: P.upperArmL, radius: 0.075, chain: 'torso' },
    { index: boneIndex.upperArmL, a: P.upperArmL, b: P.lowerArmL, radius: 0.058, chain: 'armL' },
    { index: boneIndex.lowerArmL, a: P.lowerArmL, b: P.handL, radius: 0.05, chain: 'armL' },
    { index: boneIndex.handL, a: P.handL, b: handTipL, radius: 0.045, chain: 'armL' },
    { index: boneIndex.clavicleR, a: P.clavicleR, b: P.upperArmR, radius: 0.075, chain: 'torso' },
    { index: boneIndex.upperArmR, a: P.upperArmR, b: P.lowerArmR, radius: 0.058, chain: 'armR' },
    { index: boneIndex.lowerArmR, a: P.lowerArmR, b: P.handR, radius: 0.05, chain: 'armR' },
    { index: boneIndex.handR, a: P.handR, b: handTipR, radius: 0.045, chain: 'armR' },
    { index: boneIndex.upLegL, a: P.upLegL, b: P.lowLegL, radius: 0.085, chain: 'legL' },
    { index: boneIndex.lowLegL, a: P.lowLegL, b: P.footL, radius: 0.068, chain: 'legL' },
    { index: boneIndex.footL, a: P.footL, b: toeL, radius: 0.055, chain: 'legL' },
    { index: boneIndex.upLegR, a: P.upLegR, b: P.lowLegR, radius: 0.085, chain: 'legR' },
    { index: boneIndex.lowLegR, a: P.lowLegR, b: P.footR, radius: 0.068, chain: 'legR' },
    { index: boneIndex.footR, a: P.footR, b: toeR, radius: 0.055, chain: 'legR' },
  ];

  const bodySection = (y: number) => bodySectionAt(y, bulk, gauntMass);
  const frontSurfaceAt = (y: number) => {
    const s = bodySection(y);
    return s.centreZ - s.halfDepth;
  };

  /* --- Flesh ---------------------------------------------------------- */
  const skinParts: BufferGeometry[] = [];
  const wounds: { centre: Vector3; radius: number }[] = [];

  // Sternum, spine and pelvic relief on the torso loft itself. A starved
  // ribcage is the payoff for tearing the uniform open, so it has to be in the
  // flesh rather than painted on cloth that is no longer there.
  const torsoRelief = (y: number, angle: number) => {
    const f = frontness(angle);
    const back = clamp(-f, 0, 1);
    let r = 0;
    // Pectoral plate. Modelled as relief rather than as a pair of ellipsoids:
    // a round mound on the chest reads unmistakably as a breast, whereas the
    // defining feature of a male pec is a broad mass with a hard lower edge.
    const pec =
      smoothstep(clamp((y - 1.3) / 0.014, 0, 1)) *
      smoothstep(clamp((1.4 - y) / 0.05, 0, 1)) *
      clamp(f * 1.15, 0, 1);
    // Two lobes either side of the sternum, peaking about 65 mm off the midline.
    // Peaking *on* the midline instead gives one central dome, which is the
    // shape of a breast rather than of a pair of pectorals.
    const pecLobe = gaussian(Math.abs(Math.cos(angle)) - 0.42, 0.24);
    r += 0.011 * pec * pecLobe * (1.05 - 0.35 * decay);
    // Sternum groove and the xiphoid hollow below it.
    r -= 0.004 * gaussian(f - 1, 0.24) * gaussian(y - 1.33, 0.06);
    r -= 0.007 * gaussian(f - 1, 0.34) * gaussian(y - 1.2, 0.05) * (0.4 + 0.6 * decay);
    // Spinal furrow with vertebral bumps.
    r -= 0.006 * gaussian(f + 1, 0.16) * gaussian(y - 1.2, 0.18);
    r += 0.0035 * (0.5 + 0.5 * Math.cos((y - 1.2) * (TAU / 0.05)))
      * gaussian(f + 1, 0.1) * gaussian(y - 1.2, 0.2);
    // Scapular plates.
    r += 0.005 * back
      * (gaussian(Math.cos(angle) - 0.62, 0.22) + gaussian(Math.cos(angle) + 0.62, 0.22))
      * gaussian(y - 1.36, 0.05);
    // Iliac crest.
    r += 0.004 * gaussian(y - 1.0, 0.03) * Math.abs(Math.cos(angle));
    return r;
  };

  skinParts.push(
    verticalLoft(TORSO_BOTTOM_Y, TORSO_TOP_Y, bodySection, 28, 40, true, true, torsoRelief),
  );

  // Trapezius. The torso loft narrows to the base of the neck while the deltoid
  // tops out 70 mm further out, so without this ridge there is an open notch
  // between the neck and each shoulder.
  for (const side of [-1, 1]) {
    const upperArm = side > 0 ? P.upperArmL : P.upperArmR;
    const inner = bodySection(TORSO_TOP_Y - 0.02);
    skinParts.push(
      sweep(
        [
          new Vector3(side * 0.028, TORSO_TOP_Y - 0.012, inner.centreZ),
          new Vector3(side * 0.09 * bulk, TORSO_TOP_Y - 0.038, inner.centreZ - 0.004),
          new Vector3(side * (Math.abs(upperArm.x) - 0.012), upperArm.y + 0.042, upperArm.z + 0.002),
        ],
        (t) => [lerp(0.036, 0.03, t) * bulk, lerp(0.03, 0.026, t) * bulk],
        10,
        8,
        new Vector3(0, 0, 1),
      ),
    );
  }

  // Ribs, as arcs that follow the body's own cross-section and stand ~3 mm
  // proud of it. Corrugating the loft instead was tried first: at any vertex
  // density the game can afford, a 40 mm rib pitch lands on two rings and the
  // ridges wash out entirely.
  {
    const ribs = decay > 0.7 ? 5 : 4;
    for (let i = 0; i < ribs; i++) {
      // Starts below the pectoral plate: on a real chest the visible ribs are
      // the ones the pec does not cover.
      const topY = 1.295 - i * 0.042;
      const pts: Vector3[] = [];
      for (let k = -4; k <= 4; k++) {
        const a = FRONT_ANGLE + (k / 4) * 1.2;
        const y = topY - Math.pow(Math.abs(k) / 4, 1.5) * 0.028;
        const s = bodySection(y);
        pts.push(new Vector3(
          Math.cos(a) * (s.halfWidth - 0.003),
          y,
          s.centreZ + Math.sin(a) * (s.halfDepth - 0.003),
        ));
      }
      const prominence = 0.55 + 0.65 * decay;
      skinParts.push(
        sweep(pts, (t) => {
          const taper = 0.55 + 0.45 * Math.sin(t * Math.PI);
          return [0.006 * prominence * taper, 0.0095 * taper];
        }, 18, 6),
      );
    }
  }

  // Gluteal masses. Most of each ellipsoid is buried inside the loft; only the
  // anatomical mound remains visible.
  const gluteY = 0.965;
  const chestY = 1.335;
  for (let s = 0; s < 2; s++) {
    const sign = s === 0 ? -1 : 1;
    const asym = rng.range(0.9, 1.02);
    skinParts.push(
      ellipsoid(
        new Vector3(sign * 0.07 * bulk, gluteY, bodySection(gluteY).centreZ + bodySection(gluteY).halfDepth - 0.014 * bulk),
        new Vector3(0.072 * bulk * asym, 0.088 * asym, 0.03 * bulk * gauntMass),
        12,
        8,
      ),
    );
  }

  // Clavicles: shallow subcutaneous ridges from the sternum out to each deltoid.
  for (const side of [-1, 1]) {
    const upperArm = side > 0 ? P.upperArmL : P.upperArmR;
    const innerY = P.clavicleL.y + 0.012;
    skinParts.push(
      tube(
        new Vector3(side * 0.022 * bulk, innerY, frontSurfaceAt(innerY) - 0.002),
        new Vector3(
          side * (Math.abs(upperArm.x) - 0.03 * bulk),
          upperArm.y + 0.006,
          upperArm.z - 0.046 * bulk * gauntMass,
        ),
        () => [0.0068, 0.0068],
        7,
        3,
      ),
    );
  }

  // Neck, with sternocleidomastoids and a laryngeal prominence. The neck is
  // 105 mm across against a 148 mm head, and that difference is most of what
  // makes a head read as a head rather than as the top of a tube.
  //
  // Declared before the head so the throat can be shaped against the chin it has
  // to meet; `buildHead` uses the same centre further down.
  const skullCentre = P.head.clone().add(new Vector3(0, 0.056, 0.004));
  const neckBottom = P.neck.y - 0.045;
  const neckTop = P.head.y + 0.022;

  /*
   * The neck is described by where its front and back surfaces are, not by a
   * centre and a thickness.
   *
   * That is the whole fix. Written as centre-plus-depth, the throat needed a
   * local "submental shelf" — extra depth plus a forward shift over a 20 mm
   * band — to close the pocket under the jaw. But a swelling applied to a tube
   * is a swelling: it added 14 mm of depth and pushed the centre 16 mm forward
   * over a couple of rings, which put the front of the throat 7 mm *ahead* of
   * the chin and left a rounded pouch hanging under the head. Measured on the
   * built mesh it was 151 mm across at the jaw line, on a skull 111 mm wide.
   *
   * Stating the front surface directly makes the constraint that matters —
   * the jaw overhangs the throat, never the reverse — something the geometry
   * cannot violate, and the profile is monotonic so there is nothing to bulge.
   */
  /*
   * The chin, in bind space: where it reaches furthest forward and the height it
   * does it at.
   *
   * Sampled from the landmark `buildSkullShell` actually builds the mental
   * protuberance on — the ring at head-local y = -0.1, pulled 10 mm proud by the
   * chin relief and carried down with the jaw — then put through the same scale
   * and offset `buildHead` is placed with. Reading the bare `skullPoint` at some
   * nearby latitude instead, as this did, misses both the relief and the drop
   * and lands 5 mm behind and 20 mm above the real chin, which is enough to
   * invert the overhang the throat is built around.
   */
  const chinH = -0.1 / -HEAD_BOTTOM;
  const chinFrontZ = (skullPoint(chinH, 0).z - 0.010) * HEAD_SCALE + skullCentre.z;
  const chinY = (-0.1 - jawDrop) * HEAD_SCALE + skullCentre.y;
  /*
   * How far a section has climbed past the underside of the jaw. 0 on the open
   * throat, 1 once the mandible is what the eye sees.
   *
   * This is the fix for the neck standing in front of the face. The front
   * surface used to ramp forward in a single lerp from the sternal notch to
   * `chin + 12 mm` at the *top* ring — and the top ring is at nose height, not
   * chin height. So above the jaw the throat kept coming forward while the face
   * fell away into the oral hollow, and from y = 1.555 up it won the depth test:
   * a smooth column running up the outside of the head that swallowed the chin,
   * the mentolabial crease, the jawline and the lower lip, and left the mouth
   * sitting on the column's rim with the larynx below it reading as the chin.
   *
   * Above the jaw the neck is not a silhouette at all, so it has to get out of
   * the way rather than carry on up.
   */
  const neckTuck = (y: number) => smoothstep(clamp((y - (chinY - 0.014)) / 0.032, 0, 1));
  const chestFrontZ = bodySection(neckBottom).centreZ - bodySection(neckBottom).halfDepth * 0.98;
  const neckSection = (y: number): BodySection => {
    const t = clamp((y - neckBottom) / (neckTop - neckBottom), 0, 1);
    const tuck = neckTuck(y);
    // Front: out of the sternal notch, back to the throat plane 26 mm behind the
    // chin — that difference is the overhang — then in under the jaw, where the
    // remaining rings only exist to keep the tube's open top buried in the skull.
    const throat = lerp(chestFrontZ, chinFrontZ + 0.026, smoothstep(clamp(t / 0.42, 0, 1)));
    const front = lerp(throat, chinFrontZ + 0.062, tuck);
    const back = lerp(0.046, 0.03, t) * lerp(1, bulk, 0.5);
    return {
      // Narrowed through the tuck as well: at the jawline the untapered neck is
      // 12 mm wider per side than the mandible, and a neck wider than the jaw it
      // hangs from erases the jawline from the front view even when the depths
      // are right.
      halfWidth: lerp(0.058, 0.046, t) * lerp(1, bulk, 0.6) * gauntMass * lerp(1, 0.62, tuck),
      halfDepth: (back - front) * 0.5,
      centreZ: (back + front) * 0.5,
    };
  };
  /*
   * Sternocleidomastoids, as relief on the neck's own loft rather than as two
   * swept tubes laid over it.
   *
   * They were tubes, and tubes are the wrong tool for a muscle that is part of
   * the surface it sits on. Each one has to run from the sternal notch on the
   * midline up and round to the mastoid behind the ear, which means crossing
   * the whole flank — so wherever it is placed it is partly inside the neck and
   * partly outside, and what renders is the intersection curve: a thin, hard,
   * tapering blade down the side of the face. Three attempts at the placement
   * moved the blade without removing it, because the blade *is* an intersection
   * and the only fix is not to have one.
   *
   * As relief the muscle is the same surface as the neck, which is also what it
   * is anatomically. `verticalLoft` already takes a per-(height, angle) radial
   * offset for exactly this — it is how the torso carries its ribs.
   */
  const neckRelief = (y: number, angle: number): number => {
    // Both features belong to the open throat. Above the jaw the loft is inside
    // the skull with only a few millimetres to spare, and relief there is either
    // invisible or a lump pushed out through the cheek.
    const open = 1 - neckTuck(y);
    if (open <= 0) return 0;
    // The loft puts x on cos(angle) and z on sin(angle), so the throat is at
    // -PI/2 and the flanks at 0 and -PI.
    const fromThroat = (() => {
      let d = angle + Math.PI / 2;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      return d;
    })();

    // Sternocleidomastoids: swell above the collar, die away under the jaw, and
    // travel from the midline out to the flanks as they rise. Measured up the
    // *open* throat rather than up the whole loft, so both the swell and the
    // sweep still land on the part of the neck that is actually seen.
    const climb = clamp((y - neckBottom) / (chinY - 0.014 - neckBottom), 0, 1);
    const along = smoothstep(clamp(climb / 0.42, 0, 1)) * open;
    let r = 0;
    if (along > 0) {
      for (const side of [1, -1]) {
        const swing = lerp(0.3, Math.PI / 2 - 0.3, climb);
        r = Math.max(r, gaussian(fromThroat - side * swing, 0.3) * 0.0065 * along);
      }
    }

    // Laryngeal prominence, on the throat. Also relief rather than a separate
    // ellipsoid: a blob set into a curved surface meets it along a grazing
    // curve, and that curve renders as the same hard sliver the muscles did.
    // Sits mid-throat: hung off the neck bone it landed at the jawline instead,
    // where it was the only thing under the mouth and read as the chin.
    const larynxY = lerp(neckBottom, chinY - 0.014, 0.55);
    r += gaussian(fromThroat, 0.34) * gaussian(y - larynxY, 0.012) * 0.0055 * open;
    return r;
  };
  skinParts.push(
    verticalLoft(neckBottom, neckTop, neckSection, 24, 14, false, false, neckRelief),
  );
  /* --- Head ----------------------------------------------------------- */
  const craters: Crater[] = [];
  const craterCount = decay > 0.75 ? rng.int(2, 3) : decay > 0.45 ? rng.int(1, 2) : rng.int(0, 1);
  const woundSide = rng.chance(0.5) ? -1 : 1;
  for (let i = 0; i < craterCount; i++) {
    // Placed on the front hemisphere at brow height or below, where they are
    // actually seen, and never over an orbit.
    const yaw = woundSide * rng.range(0.35, 1.5) * (i === 0 ? 1 : rng.chance(0.5) ? 1 : -1);
    const h = rng.range(-0.55, 0.62);
    const c = skullPoint(h, yaw, -0.002);
    craters.push({
      centre: c,
      radius: rng.range(0.014, 0.026),
      depth: rng.range(0.005, 0.011),
      bone: rng.chance(0.45),
    });
  }
  const headSpec: HeadSpec = {
    decay,
    jawDrop,
    noseRotted: rng.chance(0.18 + decay * 0.3),
    hasHair: bareHead ? rng.chance(0.82) : rng.chance(0.35),
    hairLoss: rng.range(0.1, 0.85),
    earTorn: rng.chance(0.22) ? (rng.chance(0.5) ? -1 : 1) : 0,
    craters,
    lidDroop: [rng.range(-0.05, 0.5), rng.range(-0.05, 0.5)],
    gaze: [rng.range(-0.0018, 0.0018), rng.range(-0.0012, 0.0012)],
    eyeMilky: rng.range(0, 1) * decay,
    seed,
  };
  const head = buildHead(headSpec, rng);
  head.scale(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE);
  head.translate(skullCentre.x, skullCentre.y, skullCentre.z);
  skinParts.push(head);
  for (const crater of craters) {
    wounds.push({
      centre: crater.centre.clone().multiplyScalar(HEAD_SCALE).add(skullCentre),
      radius: crater.radius * HEAD_SCALE * 1.6,
    });
  }

  /* --- Arms ----------------------------------------------------------- */
  const armAsym = [rng.range(0.93, 1), rng.range(0.93, 1)];
  const armProfile = (upper: boolean, asym: number) => (t: number): [number, number] => {
    if (upper) {
      // Keep proximal mass so the axillary junction survives on gaunt variants.
      const proximal = lerp(0.98, gauntMass * asym, smoothstep(clamp(t / 0.45, 0, 1)));
      const r = (lerp(0.05, 0.037, t) + 0.006 * Math.pow(Math.sin(t * Math.PI), 1.25)) * bulk * proximal;
      return [r, r * 0.95];
    }
    const r = (lerp(0.042, 0.026, Math.pow(t, 0.8)) + 0.004 * Math.sin(t * Math.PI)) * bulk * gauntMass * asym;
    return [r, r * 0.92];
  };

  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R';
    const sign = side === 'L' ? 1 : -1;
    const upperArm = P[`upperArm${side}` as BoneName];
    const lowerArm = P[`lowerArm${side}` as BoneName];
    const hand = P[`hand${side}` as BoneName];
    const tip = side === 'L' ? handTipL : handTipR;

    // The deltoid intersects the ribcage: its medial volume sinks into the
    // trapezius while its lateral surface forms the shoulder. Centred *below*
    // the joint, because the acromion — the top of the shoulder — is only about
    // 20 mm above the glenohumeral joint, not 60.
    skinParts.push(
      ellipsoid(
        upperArm.clone().add(new Vector3(0, -0.024, 0)),
        new Vector3(0.052 * bulk, 0.055 * rng.range(0.95, 1.03), 0.05 * bulk * gauntMass),
        14,
        10,
      ),
    );
    skinParts.push(tube(upperArm, lowerArm, armProfile(true, armAsym[s]), 14, 8, false, false));
    // Olecranon — the elbow point, which is bone and shows on any thin arm.
    skinParts.push(
      ellipsoid(lowerArm.clone().add(new Vector3(0, 0.004, 0.022 * bulk)), new Vector3(0.026, 0.03, 0.02), 10, 8),
    );
    skinParts.push(tube(lowerArm, hand, armProfile(false, armAsym[s]), 14, 8, false, false));

    // Hand: a flattened palm with a thumb and four clawed fingers. Straight
    // finger stubs read as a mitten; the curl is what makes it a claw.
    skinParts.push(
      tube(
        hand,
        tip,
        (t) => [
          lerp(0.032, 0.026, t) * gauntMass * armAsym[s],
          lerp(0.02, 0.014, t) * gauntMass,
        ],
        12,
        4,
      ),
    );
    // Digits are two segments each, sharing one open joint: a domed cap costs
    // three extra rings, and ten fingers' worth of caps is more geometry than
    // the whole ribcage. The last segment tapers to a claw instead of carrying a
    // separate nail box, and the fingertips are darkened by the flesh pass.
    const knuckle = tip.clone().add(new Vector3(0, 0.006, 0));
    const digit = (base: Vector3, mid: Vector3, end: Vector3, r0: number, r1: number, r2: number) => {
      skinParts.push(tube(base, mid, (t) => [lerp(r0, r1, t), lerp(r0, r1, t)], 6, 1, true, false));
      skinParts.push(tube(mid, end, (t) => [lerp(r1, r2, t), lerp(r1, r2, t)], 6, 1, false, true));
    };
    for (let f = 0; f < 4; f++) {
      const off = (f - 1.5) * 0.0165;
      const spread = 1 + Math.abs(f - 1.5) * 0.08;
      const base = knuckle.clone().add(new Vector3(off, 0, -0.004));
      const mid = base.clone().add(new Vector3(off * 0.12, -0.031 * spread, -0.014));
      const end = mid.clone().add(new Vector3(off * 0.1, -0.021, -0.023));
      digit(base, mid, end, 0.0092, 0.0078, 0.0042);
    }
    const thumbBase = tip.clone().add(new Vector3(sign * 0.022, 0.026, -0.006));
    const thumbMid = thumbBase.clone().add(new Vector3(sign * 0.008, -0.019, -0.017));
    const thumbEnd = thumbMid.clone().add(new Vector3(sign * 0.002, -0.014, -0.018));
    digit(thumbBase, thumbMid, thumbEnd, 0.011, 0.009, 0.005);
  }

  /* --- Legs ----------------------------------------------------------- */
  const legAsym = [rng.range(0.94, 1), rng.range(0.94, 1)];
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R';
    const upLeg = P[`upLeg${side}` as BoneName];
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];
    const toe = side === 'L' ? toeL : toeR;
    const legMass = bulk * gauntMass * legAsym[s];

    skinParts.push(
      tube(upLeg.clone().add(new Vector3(0, 0.075, 0)), lowLeg, (t) => {
        const r = (lerp(0.088, 0.055, smoothstep(t)) + 0.009 * Math.pow(Math.sin(t * Math.PI), 1.4)) * legMass;
        return [r, r * (1.03 + 0.04 * Math.sin(t * Math.PI))];
      }, 16, 10, false, false),
    );
    // Patella, mostly buried — only the front of the kneecap should show. A
    // proud sphere here catches a specular highlight and reads as a golf ball
    // through a torn trouser leg.
    skinParts.push(
      ellipsoid(lowLeg.clone().add(new Vector3(0, 0.014, -0.018 * legMass)), new Vector3(0.031, 0.03, 0.011), 10, 8),
    );
    skinParts.push(
      tube(lowLeg, foot, (t) => {
        const r = smoothCurve(t, [
          [0, 0.052],
          [0.22, 0.057],
          [0.36, 0.064],
          [0.58, 0.052],
          [0.8, 0.039],
          [1, 0.032],
        ]) * legMass;
        return [r, r * 0.93];
      }, 16, 10, false, false),
    );
    // Gastrocnemius belly, high and behind the shin.
    skinParts.push(
      ellipsoid(lowLeg.clone().add(new Vector3(0, 0.004, -0.043 * legMass)), new Vector3(0.05 * legMass, 0.047, 0.022 * legMass), 12, 8),
    );
    skinParts.push(
      tube(foot.clone().add(new Vector3(0, 0.02, 0)), toe, (t) => [
        lerp(0.047, 0.036, t) * gauntMass,
        lerp(0.041, 0.026, t) * gauntMass,
      ], 12, 4),
    );
  }

  ensureTints(skinParts);
  const skinGeo = mergeAll(skinParts, ['color'])!;
  skinParts.forEach((g) => g.dispose());
  skinGeo.computeVertexNormals();
  // Sagging, irregular flesh. Kept off the face, whose millimetre-scale inserts
  // have to stay registered with the cavities they sit in.
  // Ramped rather than switched at the jaw line: a hard boundary in a
  // displacement field leaves a step in the surface across the throat.
  const bodyWeight = (y: number) => clamp((skullCentre.y - 0.115 - y) / 0.035, 0, 1);
  displaceAlongNormals(skinGeo, seed ^ 0x77, 0.0045, 13, (_x, y) => bodyWeight(y));
  displaceAlongNormals(skinGeo, seed ^ 0x91, 0.0008, 40, (_x, y) => 1 - bodyWeight(y));
  skinGeo.computeVertexNormals();

  const inRigidHeadRegion = (x: number, y: number, z: number) =>
    y > skullCentre.y + HEAD_BOTTOM * HEAD_SCALE - 0.004 &&
    Math.hypot(x - skullCentre.x, z - skullCentre.z) < 0.17;

  /* --- Uniform -------------------------------------------------------- */
  const clothParts: BufferGeometry[] = [];
  const jacketBottomY = P.hips.y - rng.range(0.03, 0.09);
  const jacketTopY = P.neck.y - 0.02;

  const uniformSectionAt = (y: number): BodySection => {
    const body = bodySectionAt(y, bulk, gauntMass);
    // Clearance over the pectoral and gluteal mounds, which sit diagonally
    // around the body's ellipse, so the jacket has to widen as well as deepen.
    const mound = Math.max(
      Math.exp(-Math.pow((y - chestY) / 0.09, 2)),
      Math.exp(-Math.pow((y - gluteY) / 0.09, 2)),
    );
    // The jacket is cut close at the yoke and loose over the chest and hips.
    const fit = 1 - 0.55 * clamp((y - 1.42) / 0.085, 0, 1);
    return {
      halfWidth: body.halfWidth + (0.018 + 0.03 * mound) * fit,
      halfDepth: body.halfDepth + (0.018 + 0.03 * mound) * fit,
      centreZ: body.centreZ,
    };
  };
  const uniformFrontAt = (y: number) => {
    const s = uniformSectionAt(y);
    return s.centreZ - s.halfDepth;
  };

  // What has survived of this uniform. A jacket with two intact sleeves and no
  // holes is a costume; one that has lost a sleeve, a shoulder and its hem to
  // whatever killed the wearer is a corpse's clothing.
  const holes = makeFbm(seed ^ 0xbeef, { octaves: 4, frequency: 2.2 });
  const hemNoise = makeFbm(seed ^ 0xfeed, { octaves: 3, frequency: 3.2 });
  // Measured distribution of this field: mean 0.497, sd 0.067, and it never
  // exceeds 0.68. So the useful thresholds are all just below 0.4 — 0.385
  // removes about 5% of the fabric as a handful of ragged holes, while 0.5
  // would take three quarters of the garment and leave confetti.
  const shred = 0.378 + decay * 0.03;

  // How much of each sleeve and trouser leg has survived. Drawn before the
  // chest tear is decided so that a uniform which happens to have kept both
  // sleeves and both legs is guaranteed to have lost its chest instead — a
  // corpse in an intact uniform reads as a soldier standing still.
  const sleeveCut: number[] = [];
  for (let s = 0; s < 2; s++) {
    const roll = rng.next();
    sleeveCut.push(roll < 0.3 ? 1 : roll < 0.62 ? rng.range(0.55, 0.8) : roll < 0.85 ? rng.range(0.24, 0.42) : 0.1);
  }
  // 1 is the knee, 2 the ankle.
  const trouserCut = [0, 1].map(() => (rng.chance(0.32) ? rng.range(0.8, 1.15) : rng.range(1.75, 2.02)));
  const limbsTorn = sleeveCut.some((c) => c < 0.8) || trouserCut.some((c) => c < 1.6);
  const chestTear = rng.chance(0.7) || !limbsTorn;
  const tearY = P.chest.y - rng.range(0.02, 0.11);
  const tearAngle = FRONT_ANGLE + rng.range(-0.55, 0.55);
  const tearSize = rng.range(0.06, 0.105);
  if (chestTear) {
    // Anchored on the body surface, not the jacket's: the bruising has to reach
    // the flesh that is now showing through.
    const s = bodySectionAt(tearY, bulk, gauntMass);
    wounds.push({
      centre: new Vector3(Math.cos(tearAngle) * s.halfWidth, tearY, s.centreZ + Math.sin(tearAngle) * s.halfDepth),
      radius: tearSize * 1.5,
    });
  }
  // A corpse whose uniform survived intact reads as a soldier standing still,
  // not as a zombie, so anything that escaped the chest tear loses a shoulder.
  const missingShoulder = rng.chance(chestTear ? 0.3 : 1) ? (rng.chance(0.5) ? -1 : 1) : 0;

  /**
   * Fabric margin for the jacket, in metres. Positive is cloth. Composed of a
   * ragged hem, a noise-driven hole field, an optional blown-out chest and an
   * optional missing shoulder.
   */
  // Every noise lookup below uses an integer multiple of `angleFrac`, because
  // `makeFbm` tiles with period 1: a fractional multiplier leaves the field
  // discontinuous at the seam and tears the fabric open along one flank.
  const jacketAlive = (angleFrac: number, y: number) => {
    const hem = jacketBottomY + hemNoise(angleFrac * 2, 0.3) * 0.045 + Math.sin(angleFrac * TAU * 3) * 0.006;
    let m = (y - hem) * 0.6;
    m = Math.min(m, (jacketTopY - 0.004 - y) * 2);
    const field = holes(angleFrac, (y - jacketBottomY) * 2);
    m = Math.min(m, (field - shred) * 0.5);
    if (chestTear) {
      const a = ((angleFrac * TAU - (tearAngle + Math.PI * 2)) % TAU + TAU + Math.PI) % TAU - Math.PI;
      const d = Math.hypot(a * 0.13, (y - tearY) * 0.9) / tearSize;
      // The outline needs jitter well above one grid cell or the tear is an
      // ellipse with sawtooth edges.
      m = Math.min(m, (d - 1) * 0.06 + (hemNoise(angleFrac * 4, y * 6) - 0.5) * 0.03);
    }
    if (missingShoulder !== 0) {
      const shoulderAngle = missingShoulder > 0 ? 0 : Math.PI;
      const a = ((angleFrac * TAU - shoulderAngle) % TAU + TAU + Math.PI) % TAU - Math.PI;
      const d = Math.hypot(a * 0.1, (y - (jacketTopY - 0.03)) * 0.7) / 0.075;
      m = Math.min(m, (d - 1) * 0.06);
    }
    return m;
  };

  const jacket = raggedSurface(
    (u, v) => {
      const y = lerp(jacketBottomY - 0.03, jacketTopY, v);
      const angle = u * TAU;
      const s = uniformSectionAt(y);
      return new Vector3(
        Math.cos(angle) * s.halfWidth,
        y,
        s.centreZ + Math.sin(angle) * s.halfDepth,
      );
    },
    52,
    34,
    {
      alive: (u, v) => jacketAlive(u, lerp(jacketBottomY - 0.03, jacketTopY, v)),
      edgeWidth: 0.02,
    },
  );
  if (jacket) clothParts.push(lockToTorso(jacket));

  // Collar: a stand band around the neck plus two folded points lying back on
  // the chest, leaving a V at the throat. Both are sized off the neck rather
  // than off the jacket's front, which is 30 mm further forward at this height.
  const collarY = jacketTopY - 0.008;
  // Sized and centred on the *neck*, with 12 mm of clearance all round. Taking
  // the depth from the jacket section instead leaves the band's front edge
  // grazing the throat, where it shows through as a pair of thin slivers.
  const collarSection = (y: number): BodySection => ({
    halfWidth: 0.067 * bulk,
    halfDepth: 0.071 * bulk,
    centreZ: bodySectionAt(y, bulk, gauntMass).centreZ,
  });
  clothParts.push(
    verticalLoft(collarY - 0.012, collarY + 0.036, collarSection, 18, 3, false, false),
  );
  for (const side of [-1, 1]) {
    // The points lie back on the chest. Standing them up leaves two thin blades
    // edge-on under the chin, which read as hooks rather than as a collar.
    const pointY = collarY - 0.032;
    clothParts.push(
      box(
        new Vector3(side * 0.043 * bulk, pointY, uniformFrontAt(pointY) - 0.007),
        0.046,
        0.06,
        0.01,
        side * 0.45,
        0.3,
      ),
    );
  }

  // Button placket down the front, with buttons, and bellows breast pockets.
  // Segmented so it can follow the curve of the chest, but the segments overlap:
  // leaving gaps between them turns the placket into a ladder of tabs.
  const placketPieces = Math.ceil((jacketTopY - jacketBottomY) / 0.075);
  for (let i = 0; i < placketPieces; i++) {
    const height = (jacketTopY - jacketBottomY) / placketPieces;
    const y = jacketBottomY + height * (i + 0.5);
    if (jacketAlive(0.75, y) <= 0.004) continue;
    clothParts.push(box(new Vector3(0, y, uniformFrontAt(y) - 0.005), 0.019, height * 1.12, 0.01));
    if (i % 2 === 0) {
      clothParts.push(
        tint(
          box(new Vector3(0, y, uniformFrontAt(y) - 0.011), 0.009, 0.009, 0.004),
          [0.55, 0.5, 0.42],
        ),
      );
    }
  }
  for (const side of [-1, 1]) {
    const y = P.chest.y + 0.01;
    // A pocket whose backing fabric has been torn away would hang in mid-air,
    // so it has to clear the tear by more than a point sample at its centre.
    const u = side > 0 ? 0.68 : 0.82;
    let backed = 1;
    for (let du = -1; du <= 1; du++) {
      for (let dy = -1; dy <= 1; dy++) {
        backed = Math.min(backed, jacketAlive(u + du * 0.055, y + dy * 0.05));
      }
    }
    if (backed <= 0.008) continue;
    const x = side * 0.078 * bulk;
    clothParts.push(
      box(new Vector3(x, y, uniformFrontAt(y) - 0.008), 0.062 * bulk, 0.064, 0.016),
      box(new Vector3(x, y + 0.036, uniformFrontAt(y + 0.036) - 0.006), 0.067 * bulk, 0.016, 0.012),
    );
  }

  // Shoulder yoke: the panel of the jacket that lies across each shoulder from
  // the neck out to the sleeve head. The torso loft is a body-shaped tube and
  // cannot reach out over a deltoid that sits 190 mm off the spine, so without
  // this the top of each shoulder is bare flesh with a dome of sleeve fabric
  // perched on it.
  for (const side of [-1, 1]) {
    if (missingShoulder === side) continue;
    const upperArm = side > 0 ? P.upperArmL : P.upperArmR;
    const yokeZ = uniformSectionAt(1.47).centreZ;
    clothParts.push(
      sweep(
        [
          new Vector3(side * 0.046, jacketTopY - 0.004, yokeZ),
          new Vector3(side * 0.12 * bulk, jacketTopY - 0.022, yokeZ - 0.002),
          new Vector3(side * Math.abs(upperArm.x), upperArm.y + 0.026, upperArm.z + 0.004),
        ],
        (t) => [0.013, lerp(0.05, 0.072, t) * bulk],
        12,
        9,
        new Vector3(0, 0, 1),
      ),
    );
  }

  // Sleeves. Independently one of: full, torn at the forearm, torn above the
  // elbow, or gone entirely bar a ragged shoulder cap (see `sleeveCut` above).
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R';
    const sign = side === 'L' ? 1 : -1;
    const upperArm = P[`upperArm${side}` as BoneName];
    const lowerArm = P[`lowerArm${side}` as BoneName];
    const hand = P[`hand${side}` as BoneName];
    const cut = sleeveCut[s];
    const armPoint = (t: number) => (t <= 0.5
      ? upperArm.clone().lerp(lowerArm, t * 2)
      : lowerArm.clone().lerp(hand, (t - 0.5) * 2));
    // The sleeve has to taper like the arm inside it, or it reads as a plank
    // hanging off the shoulder.
    const sleeveRadius = (t: number) => smoothCurve(t, [
      [0, 0.052],
      [0.45, 0.044],
      [0.5, 0.041],
      [0.8, 0.033],
      [1, 0.028],
    ]) * bulk + 0.008;

    if (missingShoulder !== sign) {
      // Shoulder cap: a dome of fabric over the deltoid. Without it the sleeve
      // is an open pipe and you see straight down the inside of it.
      // Radii chosen to match the sleeve's own radius at the joint so there is
      // no step where they meet, and to clear the deltoid underneath by 8 mm.
      const cap = dome(
        upperArm.clone().add(new Vector3(0, -0.014, 0)),
        new Vector3(sleeveRadius(0) - 0.002, 0.06, sleeveRadius(0) - 0.006),
        -Math.PI,
        Math.PI,
        -0.55,
        Math.PI / 2,
        18,
        6,
      );
      if (cap) clothParts.push(cap);
    }

    const sleeve = raggedSurface(
      (u, v) => {
        const t = v * cut;
        const centre = armPoint(t);
        const r = sleeveRadius(t);
        // Negated so that with v running down the arm the winding still faces
        // outward; a sleeve lit from the inside reads as a hole.
        const angle = -u * TAU;
        return new Vector3(centre.x + Math.cos(angle) * r, centre.y, centre.z + Math.sin(angle) * r * 0.98);
      },
      24,
      Math.max(5, Math.round(cut * 18)),
      {
        alive: (u, v) => {
          const cuff = 1 - v - hemNoise(u * 2 + s, 0.7) * 0.2 - 0.03;
          let m = cuff * 0.12;
          m = Math.min(m, (holes(u + s * 3, v * 2) - shred - 0.006) * 0.5);
          return m;
        },
        edgeWidth: 0.016,
      },
    );
    if (sleeve) clothParts.push(sleeve);

    // A subdued unit patch survives on a surviving upper sleeve often enough to
    // break up the silhouette.
    if (cut > 0.4 && rng.chance(0.6)) {
      const at = armPoint(0.22);
      clothParts.push(
        box(
          new Vector3(at.x + sign * (sleeveRadius(0.22) + 0.002), at.y, at.z - 0.006),
          0.009,
          0.046,
          0.038,
        ),
      );
    }
  }

  // Trousers: waistband, two legs with ragged cuffs and knee blowouts, and
  // bellows cargo pockets.
  // Trouser seat. Runs below the crotch and pinches in at the bottom so its
  // open rim finishes inside the leg tubes; ending it at the crotch instead
  // leaves a smooth pale panel between the thighs with a hard edge across it.
  const seatBottomY = P.hips.y - 0.15;
  clothParts.push(
    verticalLoft(
      seatBottomY,
      P.hips.y + 0.055,
      (y) => {
        const s = uniformSectionAt(y);
        const pinch = 1 - 0.28 * smoothstep(clamp((P.hips.y - 0.105 - y) / 0.045, 0, 1));
        return {
          halfWidth: (s.halfWidth + 0.005) * pinch,
          halfDepth: (s.halfDepth + 0.005) * pinch,
          centreZ: s.centreZ,
        };
      },
      22,
      7,
      false,
      false,
    ),
  );
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R';
    const sign = side === 'L' ? 1 : -1;
    const upLeg = P[`upLeg${side}` as BoneName];
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];
    const cut = trouserCut[s];
    const topY = upLeg.y + 0.05;
    /** `along` is 0 at the waist, 1 at the knee, 2 at the ankle. */
    const legPoint = (along: number) => (along <= 1
      ? new Vector3(upLeg.x, lerp(topY, lowLeg.y, along), lerp(upLeg.z, lowLeg.z, along))
      : new Vector3(upLeg.x, lerp(lowLeg.y, foot.y, along - 1), lerp(lowLeg.z, foot.z, along - 1)));
    const legRadius = (along: number) => smoothCurve(along, [
      [0, 0.104],
      [0.55, 0.088],
      [1, 0.073],
      [1.5, 0.068],
      [2, 0.058],
    ]) * bulk + 0.011;

    const trouser = raggedSurface(
      (u, v) => {
        const along = v * cut;
        const centre = legPoint(along);
        const r = legRadius(along);
        const angle = -u * TAU;
        return new Vector3(centre.x + Math.cos(angle) * r, centre.y, centre.z + Math.sin(angle) * r * 1.02);
      },
      26,
      Math.max(8, Math.round(cut * 13)),
      {
        alive: (u, v) => {
          const hem = 1 - v - hemNoise(u * 3 + s * 5, 1.4) * 0.22 - 0.01;
          let m = hem * 0.16;
          m = Math.min(m, (v + 0.02) * 0.4);
          m = Math.min(m, (holes(u + s * 7, v * 2) - shred - 0.004) * 0.5);
          return m;
        },
        edgeWidth: 0.018,
      },
    );
    if (trouser) clothParts.push(trouser);

    // Cargo pocket, lofted from the trouser's own taper so it curves with the
    // leg instead of floating beside it.
    const pocketCentreY = lerp(upLeg.y, lowLeg.y, 0.33);
    const pocketSection = (y: number): BodySection => {
      const r = legRadius(clamp((topY - y) / (topY - lowLeg.y), 0, 2));
      return { halfWidth: r, halfDepth: r * 1.02, centreZ: 0 };
    };
    const pocketBottomY = pocketCentreY - 0.05;
    const pocketTopY = pocketCentreY + 0.05;
    const pocket = wrappedPanel(
      pocketBottomY,
      pocketTopY,
      pocketSection,
      sign * Math.PI * 0.5,
      (t) => 0.038 / (pocketSection(lerp(pocketBottomY, pocketTopY, t)).halfDepth + 0.015),
      () => -0.003,
      () => 0.017,
      6,
    );
    pocket.translate(upLeg.x, 0, 0);
    boxProjectUV(pocket, UV_SCALE);
    clothParts.push(pocket);
  }

  /* --- Gear ----------------------------------------------------------- */
  const gearParts: BufferGeometry[] = [];

  // Combat boots: shaft over the trouser cuff, projecting toe, separate sole
  // and two lace straps.
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R';
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];
    const toe = side === 'L' ? toeL : toeR;
    // Leather, so darker than the webbing and helmet that share this material.
    const bootLeather: Tint = [0.44, 0.38, 0.33];
    gearParts.push(
      tint(
        tube(
          foot.clone().add(new Vector3(0, 0.025, 0.008)),
          foot.clone().lerp(lowLeg, 0.4),
          (t) => [lerp(0.055, 0.063, t) * bulk, lerp(0.053, 0.058, t) * bulk],
          12,
          4,
          false,
          false,
        ),
        bootLeather,
      ),
      tint(
        tube(
          foot.clone().add(new Vector3(0, 0.075, 0.01)),
          toe.clone().add(new Vector3(0, 0.004, -0.012)),
          (t) => [lerp(0.05, 0.038, t), lerp(0.048, 0.03, t)],
          14,
          5,
        ),
        bootLeather,
      ),
      tint(
        tube(
          foot.clone().add(new Vector3(0, -0.012, 0.012)),
          toe.clone().add(new Vector3(0, -0.012, -0.016)),
          (t) => [lerp(0.052, 0.04, t), 0.014],
          12,
          4,
        ),
        [0.3, 0.28, 0.26],
      ),
    );
    for (let l = 0; l < 2; l++) {
      const at = foot.clone().add(new Vector3(0, 0.055 + l * 0.028, -0.02 + l * 0.006));
      gearParts.push(
        tint(
          sweep(
            [
              new Vector3(at.x - 0.045, at.y, at.z),
              new Vector3(at.x, at.y + 0.004, at.z - 0.03),
              new Vector3(at.x + 0.045, at.y, at.z),
            ],
            () => [0.005, 0.004],
            8,
            5,
          ),
          [0.3, 0.26, 0.22],
        ),
      );
    }
  }

  // Pistol belt and square field buckle.
  const beltCentreY = P.hips.y - 0.004;
  const beltSection = uniformSectionAt(beltCentreY);
  gearParts.push(
    verticalLoft(
      beltCentreY - 0.017,
      beltCentreY + 0.017,
      (y) => {
        const s = uniformSectionAt(y);
        return { halfWidth: s.halfWidth + 0.008, halfDepth: s.halfDepth + 0.008, centreZ: s.centreZ };
      },
      20,
      2,
      false,
      false,
    ),
    tint(
      box(
        new Vector3(0, beltCentreY, beltSection.centreZ - beltSection.halfDepth - 0.014),
        0.044,
        0.034,
        0.012,
      ),
      [0.62, 0.58, 0.46],
    ),
  );

  // Suspenders over the shoulders, front to back. Segmenting the path keeps
  // them outside the torso instead of cutting the straight line through it.
  if (rng.chance(0.35)) {
    for (const side of [-1, 1]) {
      const frontY = P.chest.y - 0.03;
      const front = new Vector3(side * 0.06 * bulk, frontY, uniformFrontAt(frontY) - 0.006);
      const crownY = P.neck.y - 0.03;
      const crown = new Vector3(side * 0.085 * bulk, crownY, uniformSectionAt(crownY).centreZ);
      const backY = P.chest.y - 0.02;
      const backS = uniformSectionAt(backY);
      const back = new Vector3(side * 0.06 * bulk, backY, backS.centreZ + backS.halfDepth + 0.006);
      // Only the yoke over the shoulder. The vertical runs down to the belt were
      // 28 mm hexagonal prisms standing off a curved chest, and read as two
      // scaffolding poles bolted to the torso.
      gearParts.push(
        sweep([front, crown, back], () => [0.014, 0.005], 12, 7, new Vector3(0, 0, 1)),
      );
    }
  }

  // Dog tags on a chain, hanging where the chest is open.
  if (rng.chance(0.65)) {
    const tagY = P.chest.y + 0.02;
    const tagZ = uniformFrontAt(tagY) - 0.012;
    for (const side of [-1, 1]) {
      gearParts.push(
        tint(
          tube(
            new Vector3(side * 0.028, P.neck.y - 0.045, tagZ + 0.02),
            new Vector3(side * 0.006, tagY + 0.02, tagZ),
            () => [0.0022, 0.0022],
            5,
            2,
            false,
            false,
          ),
          [0.7, 0.68, 0.6],
        ),
      );
    }
    gearParts.push(
      tint(box(new Vector3(-0.008, tagY, tagZ), 0.02, 0.032, 0.004, -0.08), [0.85, 0.83, 0.72]),
      tint(box(new Vector3(0.009, tagY - 0.007, tagZ - 0.003), 0.02, 0.032, 0.004, 0.1), [0.8, 0.78, 0.68]),
    );
  }

  /* --- Headgear ------------------------------------------------------- */
  if (hasHelmet) {
    // Steel pot lofted off the skull's own profile with a 12 mm standoff, so it
    // sits on the head rather than intersecting it. The rim rides high across
    // the brow and dips at the sides and back, which is both what an M1 shell
    // does and what keeps the shell from covering the eyes.
    const rimH = (angle: number) => 0.135 + 0.175 * Math.cos(angle);
    const helmet = raggedSurface(
      (u, v) => {
        const angle = u * TAU - Math.PI;
        const h = lerp(rimH(angle), 0.995, Math.pow(v, 0.85));
        const flare = 0.012 + 0.012 * Math.pow(1 - v, 2.4);
        return headWorld(h, angle, flare, skullCentre);
      },
      28,
      7,
      { edgeWidth: 0.004, edgeTint: WHITE },
    );
    if (helmet) gearParts.push(helmet);
    // Rolled rim, following the same varying line.
    const rimPts: Vector3[] = [];
    for (let k = 0; k <= 26; k++) {
      const angle = (k / 26) * TAU - Math.PI;
      rimPts.push(headWorld(rimH(angle), angle, 0.0235, skullCentre));
    }
    gearParts.push(sweep(rimPts, () => [0.0055, 0.005], 28, 5));
    // Chin strap, hanging loose from one side as often as not.
    const jawSide = rng.chance(0.5) ? -1 : 1;
    for (const side of [-1, 1]) {
      const loose = side === jawSide && rng.chance(0.5);
      const pts = [
        headWorld(0.1, side * 1.5, 0.012, skullCentre),
        new Vector3(skullCentre.x + side * 0.066, skullCentre.y - 0.05, skullCentre.z + 0.002),
        loose
          ? new Vector3(skullCentre.x + side * 0.06, skullCentre.y - 0.115, skullCentre.z - 0.008)
          : new Vector3(skullCentre.x + side * 0.03, skullCentre.y - 0.126, skullCentre.z - 0.036),
      ];
      gearParts.push(sweep(pts, () => [0.008, 0.0022], 10, 5));
    }
  } else if (hasCap) {
    const rimH = (angle: number) => 0.26 + 0.06 * Math.cos(angle);
    const cap = raggedSurface(
      (u, v) => {
        const angle = u * TAU - Math.PI;
        const h = lerp(rimH(angle), 0.995, Math.pow(v, 0.8));
        return headWorld(h, angle, 0.008 + 0.004 * (1 - v), skullCentre);
      },
      24,
      6,
      { edgeWidth: 0.004, edgeTint: WHITE },
    );
    if (cap) gearParts.push(cap);
    const brim = headWorld(rimH(0), 0, 0.006, skullCentre);
    gearParts.push(box(new Vector3(brim.x, brim.y - 0.006, brim.z - 0.026), 0.112, 0.008, 0.054, 0, 0.14));
  }

  // Flesh colouring runs here rather than with the rest of the body, because
  // the bruising around a wound has to know where the uniform was torn open —
  // the tears are decided above.
  colourFlesh(skinGeo, seed, {
    hands: [handTipL, handTipR],
    feet: [P.footL, P.footR],
    decay,
    wounds,
  });

  ensureTints(clothParts);
  ensureChainLock(clothParts);
  const clothGeo = mergeAll(clothParts, ['color', 'chainLock'])!;
  clothParts.forEach((g) => g.dispose());
  clothGeo.computeVertexNormals();
  // Sag and folds. Perfectly smooth tubes read as a wetsuit; two octaves of
  // displacement along the normal — one for the drape of the garment, one for
  // creases — is what makes them cloth.
  displaceAlongNormals(clothGeo, seed ^ 0x1f, 0.006, 8);
  displaceAlongNormals(clothGeo, seed ^ 0x2e, 0.0022, 34);
  clothGeo.computeVertexNormals();
  stainUniform(clothGeo, seed, decay, wounds);

  ensureTints(gearParts);
  const gearGeo = mergeAll(gearParts, ['color'])!;
  gearParts.forEach((g) => g.dispose());
  gearGeo.computeVertexNormals();

  /* --- Contact occlusion ----------------------------------------------- */
  //
  // All three meshes exist and are final before any of them is shaded, because
  // each one has to be able to see the others. That ordering is the whole
  // point: flesh is dark because a uniform is over it, which is what makes a
  // tear read as a hole into a body rather than as a hole cut in a decal, and
  // the uniform is dark under the webbing that is strapped across it.
  //
  // Skinning comes after, since it only reads positions and these passes only
  // write colours.
  bakeVertexOcclusion(skinGeo, {
    occluders: [clothGeo, gearGeo],
    radius: 0.028,
    strength: 1,
    // Deep, because the darkest places on a corpse are the ones this finds:
    // the sockets, the open mouth, the throat, and everything still under
    // cloth. The floor is what keeps a torn-open ribcage legible rather than
    // black — the contrast of pale flesh against dark cloth is most of what
    // makes a zombie read at all, and drowning the flesh in shadow loses it.
    floor: 0.24,
    bias: 0.11,
    range: 0.3,
    shade: [0.32, 0.3, 0.31],
  });
  bakeVertexOcclusion(clothGeo, {
    occluders: [gearGeo],
    radius: 0.032,
    // Lighter than the flesh gets. The uniform is the largest area on the
    // model, so any darkening here is paid for over the whole silhouette, and
    // past about this much the horde stops reading as figures in the dark and
    // starts reading as one dark shape.
    strength: 0.6,
    floor: 0.44,
    bias: 0.14,
    range: 0.32,
    shade: [0.4, 0.39, 0.37],
  });
  bakeVertexOcclusion(gearGeo, {
    occluders: [clothGeo],
    radius: 0.026,
    strength: 0.7,
    floor: 0.36,
    bias: 0.14,
    range: 0.32,
    shade: [0.36, 0.35, 0.34],
  });

  autoSkin(skinGeo, bonePairs);
  rigidSkinRegion(skinGeo, boneIndex.head, inRigidHeadRegion);
  autoSkin(clothGeo, bonePairs);
  // Authoring data, not render data — it has done its job by now.
  clothGeo.deleteAttribute('chainLock');
  autoSkin(gearGeo, bonePairs);
  rigidSkinRegion(gearGeo, boneIndex.head, inRigidHeadRegion);

  /* --- Apply the variant's height ------------------------------------- */
  // Baked into the bone rest positions and the geometry rather than set on the
  // root: scaling the root would double-apply, since the bind inverses absorb
  // it once and the model matrix again. Must happen after every autoSkin call,
  // because the weighting reads `bindPositions`, which is scaled in place here.
  if (heightScale !== 1) {
    for (const bone of boneList) bone.position.multiplyScalar(heightScale);
    for (const geo of [skinGeo, clothGeo, gearGeo]) geo.scale(heightScale, heightScale, heightScale);
    for (const key of Object.keys(bindPositions) as BoneName[]) {
      bindPositions[key].multiplyScalar(heightScale);
    }
    root.updateMatrixWorld(true);
  }

  /* --- Skinned meshes ------------------------------------------------- */
  const skeleton = new Skeleton(boneList);

  const attach = (geo: BufferGeometry, material: Material, name: string): SkinnedMesh => {
    const mesh = new SkinnedMesh(geo, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Bounding spheres are computed in bind pose; an animated zombie reaching
    // out would pop out of it, so culling is handled by the manager instead.
    mesh.frustumCulled = false;
    root.add(mesh);
    mesh.bind(skeleton, new Matrix4());
    return mesh;
  };

  const skin = attach(skinGeo, skinMaterial(rng), 'zombieSkin');
  const clothes = attach(clothGeo, clothMaterial(rng), 'zombieClothes');
  const gear = attach(gearGeo, gearMaterial(), 'zombieGear');

  return {
    root,
    bones,
    boneList,
    skeleton,
    skin,
    clothes,
    gear,
    bindPositions,
    height: 1.75 * heightScale,
  };
}

/** Frees every GPU resource owned by a rig. Shared materials are left alone. */
export function disposeRig(rig: ZombieRig) {
  rig.skin.geometry.dispose();
  rig.clothes.geometry.dispose();
  rig.gear.geometry.dispose();
  // Skin and cloth materials are per-zombie clones; gear is shared.
  (rig.skin.material as Material).dispose();
  (rig.clothes.material as Material).dispose();
  rig.root.clear();
}
