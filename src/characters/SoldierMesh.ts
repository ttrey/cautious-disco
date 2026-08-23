import {
  Bone,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from 'three';
import { mergeAll } from '../util/geometry';
import { makeSurface } from '../assets/Materials';
import { SurfaceId, surface } from '../assets/TextureForge';
import { Rng, TAU, clamp, lerp, smoothstep } from '../util/math';
import {
  BodySection,
  BoneName,
  BonePair,
  CAVITY,
  Chain,
  EYE_R,
  EYE_X,
  EYE_Y,
  EYE_Z,
  HEAD_BOTTOM,
  HEAD_SCALE,
  MOUTH_Y,
  SKELETON,
  Tint,
  WHITE,
  autoSkin,
  box,
  displaceAlongNormals,
  dome,
  ellipsoid,
  ensureChainLock,
  ensureTints,
  gaussian,
  headWorld,
  lockChain,
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
} from './CharacterGeometry';

/**
 * The four player operators.
 *
 * These are the characters the other three players in a squad are seen as, and
 * they are held to a higher bar than the horde for a specific reason: a zombie
 * is looked at for a second and a half in bad light while you are shooting it,
 * whereas a teammate is in frame for the whole round, at conversational
 * distance, standing still while somebody buys a door. Anything approximated
 * gets found.
 *
 * So, relative to `ZombieMesh`:
 *
 *  - **Faces are alive.** The same measured skull is underneath, but the relief
 *    is built from what fills a face rather than what a face loses — orbital
 *    fat, zygomatic prominence, buccal mass, a real mentolabial sulcus — and it
 *    carries eyes with lids and lashes, brows, ears, lips and per-operator
 *    facial hair.
 *  - **Hands are hands.** Four three-segment fingers and a thumb, wrapped
 *    around a rod on a circular arc, so a weapon put in the fist is actually
 *    held rather than floating beside a mitten.
 *  - **The kit is layered the way real kit is**: uniform, then armour, then what
 *    is mounted on the armour, in four materials (skin, printed camouflage,
 *    nylon webbing, hard composite) so a helmet shell does not shade like a
 *    pouch and a pouch does not shade like a shirt.
 *  - **Four silhouettes, not four palettes.** Recognising a teammate across a
 *    dark train shed is a shape problem: helmet, bare head with a headset, a
 *    boonie brim and a patrol cap read at any distance and in any light, which
 *    is what makes them the primary difference between these four.
 *
 * Everything is authored in bind-pose *world* metres, like the zombie, because
 * `autoSkin` weights vertices by their distance to bone segments and both are
 * therefore in the same space. The bind pose has no bone rotations, so local
 * axes and world axes coincide: +X is the character's left, -Z is forward.
 */

/* ------------------------------------------------------------------ */
/* Operators                                                           */
/* ------------------------------------------------------------------ */

export type OperatorId = 'vance' | 'novak' | 'ito' | 'rook';

/** The four, in the order slots are handed out. */
export const OPERATOR_IDS: readonly OperatorId[] = ['vance', 'novak', 'ito', 'rook'];

export type Headgear = 'helmet' | 'headset' | 'boonie' | 'patrolCap';

export interface OperatorDef {
  id: OperatorId;
  /** Shown on a nameplate or a scoreboard. */
  name: string;
  callsign: string;

  /** Overall stature multiplier against the 1.75 m baseline. */
  height: number;
  /** Girth multiplier — shoulders, chest, limbs. */
  bulk: number;
  /** Extra shoulder width beyond `bulk`, which is what reads as "heavy set". */
  frame: number;

  skinTone: number;
  /** Printed uniform. */
  camo: SurfaceId;
  /** Nylon kit — carrier, pouches, slings, holsters. */
  kitTint: number;
  /** Hard composite — helmet shell, goggles, buckles, soles. */
  hardTint: number;
  /** Squad colour: patches, tape, the helmet band. Also the map/HUD colour. */
  accent: number;

  headgear: Headgear;
  face: FaceSpec;

  /** Full-coverage plate carrier, or a lightweight chest rig. */
  armour: 'carrier' | 'rig';
  sleeves: 'rolled' | 'full';
  /** Scarf worn round the neck and pulled up over the nose. */
  shemagh: boolean;
  /** Goggles pushed up onto the headgear rather than worn over the eyes. */
  goggles: boolean;
  /** Ear cups and a boom mic; helmets carry their own on the rails. */
  headsetRig: boolean;
  thighHolster: boolean;
  dumpPouch: boolean;
  kneePads: boolean;
  /** Antenna whip off the back of the carrier. */
  radio: boolean;
}

export interface FaceSpec {
  /** Supraorbital ridge heaviness, 0..1. */
  brow: number;
  /** Zygomatic (cheekbone) prominence, 0..1. */
  cheek: number;
  /** Mandible width at the gonial angle, 0..1. */
  jaw: number;
  /** Nose length and projection, 0..1 around a mid nose. */
  nose: number;
  /** Dorsal hump; negative is a straight or scooped bridge. */
  noseHook: number;
  lipFullness: number;
  /** Upper-lid fold depth. Higher values give a hooded, monolid eye. */
  eyeFold: number;
  /** Beard length in metres — 0 is clean shaven. */
  beard: number;
  /** Shadow of a shaved beard, 0..1. Independent of `beard`. */
  stubble: number;
  hair: 'crop' | 'buzz' | 'shaved' | 'tiedBack';
  hairTint: Tint;
  browTint: Tint;
  eyeTint: Tint;
  /** Scar across the left brow and cheek. */
  scar: boolean;
}

export const OPERATORS: Record<OperatorId, OperatorDef> = {
  /**
   * Squad lead. The full-kit silhouette everyone else is read against: helmet,
   * plate carrier, knee pads, antenna. Arid pattern, orange squad colour.
   */
  vance: {
    id: 'vance',
    name: 'Sgt. R. Vance',
    callsign: 'ACTUAL',
    height: 1.015,
    bulk: 1.0,
    frame: 1.02,
    skinTone: 0xc9a483,
    camo: 'camoArid',
    kitTint: 0x8a7d5e,
    hardTint: 0x6f6a58,
    accent: 0xd9822b,
    headgear: 'helmet',
    armour: 'carrier',
    sleeves: 'rolled',
    shemagh: false,
    goggles: false,
    headsetRig: false,
    thighHolster: true,
    dumpPouch: false,
    kneePads: true,
    radio: true,
    face: {
      brow: 0.62,
      cheek: 0.5,
      jaw: 0.58,
      nose: 0.54,
      noseHook: 0.3,
      lipFullness: 0.45,
      eyeFold: 0.3,
      beard: 0.008,
      stubble: 0.55,
      hair: 'crop',
      hairTint: [0.2, 0.16, 0.13],
      browTint: [0.24, 0.19, 0.15],
      eyeTint: [0.36, 0.42, 0.5],
      scar: false,
    },
  },

  /**
   * Breacher. No helmet at all — a shaved head and a big pair of ear cups,
   * which is the most legible negative silhouette of the four. Heaviest build,
   * woodland pattern, blue squad colour.
   */
  novak: {
    id: 'novak',
    name: 'Cpl. M. Novak',
    callsign: 'HAMMER',
    height: 1.045,
    bulk: 1.16,
    frame: 1.1,
    skinTone: 0xb08a6a,
    camo: 'camoWoodland',
    kitTint: 0x4d5245,
    hardTint: 0x35382f,
    accent: 0x3d8bd4,
    headgear: 'headset',
    armour: 'carrier',
    sleeves: 'rolled',
    shemagh: false,
    goggles: false,
    headsetRig: true,
    thighHolster: true,
    dumpPouch: true,
    kneePads: false,
    radio: false,
    face: {
      brow: 0.85,
      cheek: 0.42,
      jaw: 0.86,
      nose: 0.6,
      noseHook: -0.15,
      lipFullness: 0.4,
      eyeFold: 0.42,
      beard: 0,
      stubble: 0.8,
      hair: 'shaved',
      hairTint: [0.16, 0.14, 0.13],
      browTint: [0.18, 0.15, 0.13],
      eyeTint: [0.32, 0.34, 0.3],
      scar: true,
    },
  },

  /**
   * Recon. Lightest of the four — chest rig instead of a carrier, sleeves down,
   * a boonie brim and a scarf over the nose. Desert pattern, green squad colour.
   */
  ito: {
    id: 'ito',
    name: 'Spc. K. Ito',
    callsign: 'KESTREL',
    height: 0.975,
    bulk: 0.9,
    frame: 0.94,
    skinTone: 0xd0a887,
    camo: 'camoDesert',
    kitTint: 0x9c8a63,
    hardTint: 0x6a6252,
    accent: 0x54b06a,
    headgear: 'boonie',
    armour: 'rig',
    sleeves: 'full',
    shemagh: true,
    goggles: false,
    headsetRig: false,
    thighHolster: false,
    dumpPouch: false,
    kneePads: true,
    radio: false,
    face: {
      brow: 0.34,
      cheek: 0.68,
      jaw: 0.4,
      nose: 0.4,
      noseHook: -0.25,
      lipFullness: 0.5,
      eyeFold: 0.78,
      beard: 0,
      stubble: 0.18,
      hair: 'tiedBack',
      hairTint: [0.09, 0.075, 0.07],
      browTint: [0.11, 0.09, 0.08],
      eyeTint: [0.22, 0.18, 0.14],
      scar: false,
    },
  },

  /**
   * Engineer. Patrol cap with goggles pushed up on it, a single-ear headset, a
   * heavy tool belt and a dump pouch. Urban digital pattern, violet squad
   * colour — the only cool-grey uniform of the four, which is what keeps it
   * apart from Novak in a dark room.
   */
  rook: {
    id: 'rook',
    name: 'Pfc. D. Rook',
    callsign: 'TOOLBOX',
    height: 0.99,
    bulk: 1.06,
    frame: 1.0,
    skinTone: 0x8a6247,
    camo: 'camoUrban',
    kitTint: 0x6a6358,
    hardTint: 0x3c4048,
    accent: 0x9b6ee0,
    headgear: 'patrolCap',
    armour: 'rig',
    sleeves: 'rolled',
    shemagh: false,
    goggles: true,
    headsetRig: true,
    thighHolster: false,
    dumpPouch: true,
    kneePads: true,
    radio: true,
    face: {
      brow: 0.5,
      cheek: 0.55,
      jaw: 0.5,
      nose: 0.48,
      noseHook: 0.1,
      lipFullness: 0.66,
      eyeFold: 0.36,
      beard: 0.016,
      stubble: 0.6,
      hair: 'buzz',
      hairTint: [0.055, 0.05, 0.048],
      browTint: [0.07, 0.06, 0.055],
      eyeTint: [0.2, 0.16, 0.13],
      scar: false,
    },
  },
};

export interface SoldierRig {
  root: Group;
  bones: Record<BoneName, Bone>;
  boneList: Bone[];
  skeleton: Skeleton;
  /** Face, neck, and whatever the uniform leaves bare. */
  skin: SkinnedMesh;
  /** Printed combat uniform. */
  uniform: SkinnedMesh;
  /** Nylon load-bearing kit. */
  gear: SkinnedMesh;
  /** Hard composite — helmet shell, goggles, buckles, soles, pads. */
  hard: SkinnedMesh;
  /**
   * Where a held weapon is parented — a direct child of the rig root, so its
   * transform is in the character's own frame: x to their right, -z forward,
   * y from the ground between their feet.
   *
   * Deliberately *not* a child of a hand or of the chest. The animator places
   * this socket from the aim state and then solves both arms onto the weapon's
   * grips, which is the only ordering that puts the muzzle where the player is
   * actually looking; hanging the weapon off a hand instead means the muzzle
   * ends up wherever an arm animation happened to leave it, and hanging it off
   * the chest means every breath and footfall in the spine swings the aim.
   */
  weaponMount: Object3D;
  bindPositions: Record<BoneName, Vector3>;
  /** Bind-pose length of the upper and lower arm bones, for the IK solver. */
  armLengths: { upper: number; lower: number };
  def: OperatorDef;
  height: number;
}

/* ------------------------------------------------------------------ */
/* Feature tints                                                       */
/* ------------------------------------------------------------------ */

/**
 * Mean albedo of the skin bake. Feature tints have to divide by this as well as
 * by the material colour, because the final surface is the product of all
 * three — and a bake sitting near 0.29 is most of the reason a sclera authored
 * as "white" arrives on screen the same value as the cheek beside it.
 */
const SKIN_ALBEDO = 0.29;

/**
 * Feature tints are authored as the colour they should *end up*, then divided
 * by everything that will multiply them on the way there.
 *
 * Without this, every operator's sclera is their own complexion: the skin
 * material is tinted per operator, the bake darkens it again, and vertex
 * colours multiply both. An eye white has to be an eye white on all four.
 *
 * The divisor is *measured*, not assumed. It used to be a hard-coded mean
 * albedo for the whole bake, and the day the bake was retuned underneath it
 * every eye on every operator blew past 1.0 in vertex space and rendered as a
 * pair of glowing lamps — the compensation was dividing by an albedo the
 * texture no longer had. Sampling the actual pixels once per session keeps the
 * eyes correct through any future re-bake.
 */
let bakeMeanCache: Tint | null = null;

function skinBakeMean(): Tint {
  if (bakeMeanCache) return bakeMeanCache;
  let mean: Tint = [SKIN_ALBEDO, SKIN_ALBEDO, SKIN_ALBEDO];
  try {
    if (typeof document !== 'undefined') {
      // Cast to HTMLCanvasElement once: CanvasImageSource is a union that
      // includes VideoFrame, which has no width/height, and drawImage's
      // source-rect arguments need the concrete canvas shape.
      const src = surface('soldierSkin').map.image as HTMLCanvasElement;
      const w = src.width || 64;
      const h = src.height || 64;
      const c = document.createElement('canvas');
      c.width = 32;
      c.height = 32;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(src, 0, 0, Math.min(w, src.width), Math.min(h, src.height), 0, 0, 32, 32);
        const px = ctx.getImageData(0, 0, 32, 32).data;
        let r = 0;
        let g = 0;
        let b = 0;
        const n = 32 * 32;
        for (let i = 0; i < px.length; i += 4) {
          r += px[i];
          g += px[i + 1];
          b += px[i + 2];
        }
        // Canvas pixels are sRGB; the multiplication happens in linear space,
        // so the mean has to be decoded before it can divide anything.
        const toLin = (sum: number) => {
          const s = sum / n / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        mean = [toLin(r), toLin(g), toLin(b)];
      }
    }
  } catch {
    // Off the main thread or a tainted canvas: fall back to the historical
    // constant rather than skipping the compensation entirely.
  }
  bakeMeanCache = mean;
  return mean;
}

/** Hard ceiling on compensated feature tints. Above this, ACES turns skin into light. */
const TINT_CEILING = 1.12;

function against(target: Tint, materialTint: number): Tint {
  const mean = skinBakeMean();
  const r = ((materialTint >> 16) & 255) / 255;
  const g = ((materialTint >> 8) & 255) / 255;
  const b = (materialTint & 255) / 255;
  return [
    clamp(target[0] / Math.max(r * mean[0], 0.02), 0, TINT_CEILING),
    clamp(target[1] / Math.max(g * mean[1], 0.02), 0, TINT_CEILING),
    clamp(target[2] / Math.max(b * mean[2], 0.02), 0, TINT_CEILING),
  ];
}

/**
 * A living sclera is bright but never white: it carries the shadow of the lids
 * and a wash of surface vessels, and painting it at 1.0 turns the eye into a
 * headlight the moment a rim light catches it. This target is deliberately well
 * under cheek value — at gameplay distance what reads "human eye" is a dark wet
 * aperture between two lids, not two bright balls.
 */
const SCLERA_TARGET: Tint = [0.52, 0.5, 0.46];
const PUPIL: Tint = [0.04, 0.04, 0.045];
/** Limbal ring — the dark rim around a real iris. Without it the eye is glass. */
const LIMBUS: Tint = [0.16, 0.15, 0.15];
const LIP: Tint = [0.86, 0.6, 0.56];
const LASH: Tint = [0.09, 0.075, 0.07];
/**
 * What a contact shadow multiplies skin down to. Kept slightly cool and never
 * black — an occluded pocket of skin is still lit by bounce from the skin
 * around it, and a neutral-grey ambient term is what makes procedural faces
 * look like they were carved out of stone.
 */
const SOCKET_SHADE: Tint = [0.42, 0.4, 0.42];

/** Webbing, straps and anything sewn rather than moulded. */
const STRAP: Tint = [0.72, 0.72, 0.72];
const STRAP_DARK: Tint = [0.44, 0.44, 0.45];
const BUCKLE: Tint = [1.35, 1.34, 1.3];
const RUBBER: Tint = [0.3, 0.3, 0.32];
const GLASS: Tint = [0.14, 0.18, 0.2];
const LEATHER: Tint = [0.46, 0.38, 0.32];

/* ------------------------------------------------------------------ */
/* Head                                                                */
/* ------------------------------------------------------------------ */

/**
 * The face shell: cranium, brow, orbits, cheekbones, muzzle, jawline and chin
 * as one lofted surface, with the relief of a face that has muscle and fat on
 * it rather than one that has lost both.
 *
 * The relief terms are the same *kind* of construction the zombie uses —
 * gaussians in metres against measured landmarks — but almost all of them have
 * the opposite sign. A corpse's face is a set of hollows; a living one is a set
 * of masses, and the difference between the two is not a texture.
 */
function buildFaceShell(spec: FaceSpec): BufferGeometry {
  const rows = 44;
  const cols = 58;
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const stride = cols + 1;
  const p = new Vector3();

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
      let dyUniform = 0;
      let t: Tint = WHITE;

      // Supraorbital ridge and glabella. Heavier here than on the zombie
      // because there is a brow *and* the soft tissue over it. At 2-4 m this
      // ridge is the strongest individuality cue on the upper face, so it is
      // carried at full anatomical depth (7-13 mm proud).
      const brow = gaussian(Math.abs(p.x) - 0.026, 0.024) * gaussian(p.y - 0.014, 0.012) * front;
      const glabella = gaussian(p.x, 0.013) * gaussian(p.y - 0.016, 0.013) * front;
      dz -= (0.0075 + 0.0055 * spec.brow) * brow + 0.0038 * glabella;

      /*
       * Orbits.
       *
       * Two terms, and the second one is what makes an eye read as set into a
       * face. The bowl recesses the socket; the *rim* around it comes back
       * forward, because an orbit is a hole in a ridge — brow above, nasal
       * process inboard, zygomatic below — and without that ring the eyeball
       * and its lids sit on a smooth dome like a bead glued to an egg, which is
       * exactly how the first pass looked however carefully the lids were cut.
       *
       * The bowl is also deliberately shallow. The socket is full of eyeball
       * and orbital fat; the deep pit that makes a skull read as a skull is the
       * one thing that must not happen on a living face.
       */
      let socket = 0;
      for (const sx of [-1, 1]) {
        const d = Math.hypot((p.x - sx * EYE_X) / 0.021, (p.y - EYE_Y) / 0.017);
        const bowl = smoothstep(clamp(1 - d, 0, 1)) * front;
        const upper = clamp((p.y - EYE_Y) / 0.016, 0, 1);
        dz += 0.0034 * bowl * (0.45 + 0.55 * upper);
        // Ring of bone standing proud, peaking just outside the socket. This
        // has to out-reach the globe: an eyeball is 25 mm across and the lids
        // over it are a further 5, so unless the face comes forward around them
        // the whole assembly reads as a ball resting on a cheek.
        dz -= 0.0075 * gaussian(d - 1.3, 0.3) * front;
        // Occlusion, weighted toward the top of the socket where the brow hangs
        // over it. This is the term that actually makes the eye read as set
        // into the head — see the note on `SOCKET_SHADE`.
        socket = Math.max(socket, smoothstep(clamp(1.25 - d, 0, 1)) * front * (0.55 + 0.45 * upper));
      }
      t = mixTint(t, SOCKET_SHADE, clamp(socket * 0.72, 0, 0.8));
      // The shadow the supraorbital ridge throws onto the lid itself. Without
      // it the lid is as bright as the forehead and the eye reads as a sticker
      // applied to the face rather than as something recessed behind a brow.
      const underBrow =
        gaussian(Math.abs(p.x) - EYE_X, 0.02) * gaussian(p.y - (EYE_Y + 0.014), 0.009) * front;
      t = mixTint(t, SOCKET_SHADE, clamp(underBrow * 0.45, 0, 0.5));

      // Nasal root: the bridge of the nose is set *back* between the eyes, and
      // the depth of that notch is most of what reads as an individual profile.
      dz += 0.0042 * gaussian(p.x, 0.011) * gaussian(p.y - 0.006, 0.009) * front;

      // Zygomatic arch and the cheek mass hung off it. Two terms: a hard
      // prominence on the bone, and a broad soft fullness below and in front of
      // it. Only the first exists on the zombie. Both are carried stronger than
      // a neutral face would need, because at 2-4 m the light that models a
      // cheekbone comes from above and 4 mm of relief is what survives.
      const zygoBone =
        gaussian(Math.abs(p.x) - 0.052, 0.017) * gaussian(p.y + 0.026, 0.016);
      dz -= (0.0036 + 0.005 * spec.cheek) * zygoBone * clamp(face + 0.35, 0, 1);
      dx -= (0.0028 + 0.0038 * spec.cheek) * zygoBone * side;
      const buccal =
        gaussian(Math.abs(p.x) - 0.042, 0.02) * gaussian(p.y + 0.05, 0.019) * front;
      dz -= 0.0032 * buccal;
      // The crease the cheekbone throws — a shallow trough running from the
      // outer eye corner down toward the jaw. It is the line that separates
      // "face" from "egg" in three-quarter view.
      dz += 0.0021
        * gaussian(Math.abs(p.x) - 0.047, 0.009)
        * gaussian(p.y + 0.038, 0.02)
        * clamp(face + 0.2, 0, 1);

      // Muzzle: maxilla and mandible carry the mouth forward of the cheeks.
      const muzzle = gaussian(p.x, 0.03) * gaussian(p.y - MOUTH_Y - 0.004, 0.024) * front;
      dz -= 0.0042 * muzzle;
      // Philtrum — the groove under the nose. 6 mm wide, 2 mm deep.
      dz += 0.002 * gaussian(p.x, 0.0045) * gaussian(p.y + 0.058, 0.008) * front;
      // Mentolabial sulcus, the crease between lower lip and chin.
      dz += 0.0022 * gaussian(p.x, 0.022) * gaussian(p.y + 0.087, 0.007) * front;
      // Mental protuberance — the chin button.
      dz -= 0.0038 * gaussian(p.x, 0.019) * gaussian(p.y + 0.101, 0.013) * front;

      // Mandible. The gonial angle is what makes a jaw square, and it is a
      // width term, not a depth one. Carried heavier than neutral because the
      // silhouette from three-quarter view is decided by this flare.
      const gonial = gaussian(p.y + 0.078, 0.021) * gaussian(Math.abs(p.x) - 0.056, 0.02);
      dx -= (0.0015 + 0.0068 * spec.jaw) * gonial * side;
      dz -= 0.0022 * gonial * clamp(face, 0, 1);
      // Jaw underside. Keeps the throat from meeting the chin in a straight line.
      dy -= 0.0022 * gaussian(p.y + 0.098, 0.016) * gaussian(p.x, 0.03) * clamp(face, 0, 1);

      // Temporal fossa: a flat, very slightly hollow plate above the arch. On a
      // fit head this is nearly flat, not the sunken pit a wasted one has.
      const temple = gaussian(p.y - 0.028, 0.026) * gaussian(Math.abs(p.x) - 0.062, 0.018);
      dx += 0.0022 * temple * side;

      // Occipital bulge and the nuchal shelf at the back of the skull.
      const back = clamp(-face, 0, 1);
      dz -= 0.0026 * back * gaussian(p.y - 0.01, 0.04);
      dz -= 0.0018 * back * gaussian(p.y + 0.062, 0.018);

      // Sternocleidomastoid attachment behind the ear, so the head does not
      // meet the neck as a clean sphere-on-cylinder join.
      dyUniform -= 0.0012 * gaussian(p.y + 0.104, 0.012);

      /*
       * Contact shadows, baked into the vertex colour.
       *
       * This pass is not decoration, it is the load-bearing half of every
       * feature above it. The features are 3-8 mm of relief on a 210 mm head,
       * and the map that would shadow them is a 2048 map over a 14 m frustum —
       * seven millimetres a texel. Nothing at face scale can self-shadow, so a
       * brow ridge lights identically to the socket under it and the eye reads
       * as a bead sitting on a smooth mask however carefully it was modelled.
       * Painting the occlusion is what puts the geometry back.
       */
      const shade =
        // Under the nose and along the nasolabial folds.
        gaussian(p.y + 0.062, 0.01) * gaussian(Math.abs(p.x) - 0.008, 0.012) * front * 0.75 +
        gaussian(Math.abs(p.x) - 0.026, 0.012) * gaussian(p.y + 0.062, 0.018) * front * 0.4 +
        // The crease under the lower lip, and the shadow the chin throws.
        gaussian(p.y + 0.086, 0.008) * gaussian(p.x, 0.024) * front * 0.5 +
        // Under the jaw and back into the throat, which is in shadow always.
        smoothstep(clamp((-0.088 - p.y) / 0.022, 0, 1)) * 0.75 +
        // Temples, where the skull turns away.
        gaussian(Math.abs(p.x) - 0.062, 0.014) * gaussian(p.y - 0.02, 0.03) * 0.35;
      t = mixTint(t, SOCKET_SHADE, clamp(shade, 0, 0.62));

      // Stubble and beard shadow. Painted on the shell as well as grown as
      // geometry: the shadow is what reads at ten metres, the geometry is what
      // reads at one.
      const beardMask = beardCoverage(p.x, p.y, p.z, spec);
      if (beardMask > 0) {
        const shade = clamp(spec.stubble * 0.55 + (spec.beard > 0 ? 0.25 : 0), 0, 0.72);
        t = mixTint(t, [0.4, 0.36, 0.34], beardMask * shade);
      }
      // Lips are a separate part, but the vermilion border has to be painted on
      // the shell too or the lip geometry sits on the face like a sticker.
      const lipZone = gaussian(p.y - MOUTH_Y, 0.008) * gaussian(p.x, 0.021) * front;
      t = mixTint(t, LIP, clamp(lipZone * 0.5, 0, 0.5));
      // The scar crosses the left brow and cheek: paler, and a shallow trough.
      if (spec.scar) {
        const s = gaussian(
          Math.abs((p.x - 0.03) * 0.82 + (p.y - 0.006) * 0.58) - 0.0,
          0.0035,
        ) * gaussian(p.y - 0.0, 0.034) * front;
        t = mixTint(t, [1.22, 1.05, 0.98], clamp(s * 0.85, 0, 0.8));
        dz += 0.0012 * s;
      }

      // Poles carry every angle at once, so any relief that varies with angle
      // has to fade out before it gets there or the crown and the jaw underside
      // tear themselves apart.
      const poleFade = smoothstep(clamp((1 - Math.abs(h)) / 0.16, 0, 1));
      positions.push(
        p.x + dx * poleFade,
        p.y + dy * poleFade + dyUniform,
        p.z + dz * poleFade,
      );
      uvs.push(
        ((j / cols) * TAU * 0.075) * 3.2,
        (p.y + 0.115) * 3.2,
      );
      colors.push(t[0], t[1], t[2]);
    }
  }

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const p0 = i * stride + j;
      indices.push(p0, p0 + stride, p0 + 1, p0 + 1, p0 + stride, p0 + stride + 1);
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
 * How much beard covers a point on the face, 0..1. The mask is the classic
 * beard line: up the jaw to just below the cheekbone, across the chin, and a
 * separate moustache band under the nose, with the throat included and the lips
 * cut out.
 */
function beardCoverage(x: number, y: number, z: number, spec: FaceSpec): number {
  if (spec.beard <= 0 && spec.stubble <= 0) return 0;
  const front = clamp(-z * 14 + 0.2, 0, 1);
  // Below the cheekbone, above the throat.
  const jawline = smoothstep(clamp((-0.026 - y) / 0.022, 0, 1));
  const notTooHigh = smoothstep(clamp((0.052 - Math.abs(x)) / 0.02, 0, 1));
  const chin = smoothstep(clamp((-0.04 - y) / 0.03, 0, 1));
  const moustache =
    gaussian(y + 0.0605, 0.009) * smoothstep(clamp((0.024 - Math.abs(x)) / 0.012, 0, 1));
  // The vermilion of the lips never grows hair.
  const lips = gaussian(y - MOUTH_Y, 0.0075) * smoothstep(clamp((0.019 - Math.abs(x)) / 0.008, 0, 1));
  const base = clamp(Math.max(jawline * notTooHigh * chin, moustache) * front, 0, 1);
  return clamp(base - lips * 1.4, 0, 1);
}

/**
 * One eye: globe, iris, pupil, both lids and a lash line.
 *
 * The lids are the load-bearing part. An eyeball set into an orbit with no lids
 * reads as a doll every time, because a real eye is mostly *covered* — the
 * upper lid crosses the top of the iris, and the gap between the two lid
 * margins is what the brain reads as a gaze direction.
 */
function buildEye(parts: BufferGeometry[], spec: FaceSpec, sx: number, gaze: number, skinTint: number) {
  // The globe sits on EYE_Z exactly, which puts the cornea ten millimetres
  // behind the brow ridge and two in front of the cheek — measured, not
  // guessed. It is also a shade under the anatomical 12.5 mm radius: a globe
  // that is technically correct but sits proud of its lids dominates the face,
  // and a slightly small eye always reads better than a bulging one.
  const radius = EYE_R * 0.87;
  const centre = new Vector3(sx * EYE_X, EYE_Y, EYE_Z);
  const sclera = against(SCLERA_TARGET, skinTint);

  // Globe.
  const globe = ellipsoid(centre, new Vector3(radius, radius, radius * 0.94), 18, 14);
  parts.push(tint(globe, (x, y) => {
    // Vessels and the shadow the lids cast, baked into the sclera so the
    // corners stay dark even where the lid geometry is edge-on to the camera.
    // Scaled rather than mixed toward an absolute colour: the sclera tint is
    // already compensating for the bake and the complexion, so mixing it toward
    // a literal value would undo both.
    const corner = clamp((Math.abs(x - centre.x) - 0.005) / 0.006, 0, 1);
    const low = clamp((centre.y - y) / 0.012, 0, 1);
    const shade = 1 - corner * 0.5 - low * 0.2;
    const warm = 1 - corner * 0.18;
    return [sclera[0] * shade, sclera[1] * shade * warm, sclera[2] * shade * warm];
  }));

  // Iris and pupil, on the front of the globe.
  const irisCentre = new Vector3(
    centre.x + gaze * 0.0012,
    centre.y - 0.0005,
    centre.z - radius * 0.9,
  );
  const irisColour = against(spec.eyeTint, skinTint);
  const pupil = against(PUPIL, skinTint);
  const limbus = against(LIMBUS, skinTint);
  // Half the globe's diameter, as a real iris is. Smaller than that and the
  // sclera shows above and below it, which reads as eyes rolled back.
  const irisR = radius * 0.52;
  const iris = ellipsoid(irisCentre, new Vector3(irisR, irisR, 0.0026), 16, 8);
  parts.push(tint(iris, (x, y) => {
    const r = Math.hypot(x - irisCentre.x, y - irisCentre.y);
    if (r < irisR * 0.42) return pupil;
    const rim = clamp((r - irisR * 0.76) / (irisR * 0.24), 0, 1);
    // Radial fibres. A uniform colour reads as a printed dot; the stroma is
    // stranded, and even at this scale the variation is what makes it wet.
    const radial = 0.82 + 0.32 * Math.abs(Math.sin(Math.atan2(y - irisCentre.y, x - irisCentre.x) * 11));
    const base: Tint = [irisColour[0] * radial, irisColour[1] * radial, irisColour[2] * radial];
    return mixTint(base, limbus, rim);
  }));

  /*
   * Lids.
   *
   * These are the whole eye. A globe set in an open socket is a doll every
   * time, because a real eye is mostly covered: the upper lid crosses the top
   * of the iris and the palpebral aperture between the two margins is only
   * about 10 mm on a 24 mm globe. The first pass put the upper lid at latitude
   * 1.09 — a cap on the crown of the eyeball, invisible from the front — which
   * left 25 mm of bare sclera staring out of the face.
   *
   * `dome`'s pitch is measured from straight ahead, so the lid margins are
   * small angles either side of zero, not angles near the pole.
   */
  const lidR = new Vector3(radius + 0.0019, radius + 0.0019, radius * 0.94 + 0.0019);
  // Yaw always increases, whichever side this is. `raggedSurface` takes its
  // winding from the parameter directions, so running u backwards on one eye
  // turns that eye's lids inside out and back-face culling deletes them.
  const yawFrom = -1.15;
  const yawTo = 1.15;
  // The lids stop well short of the poles. Carried all the way round they close
  // into a hemisphere and the eye becomes a ball sitting on the face; stopped
  // here, their outer edges tuck in behind the orbital rim and the face itself
  // covers the rest.
  const lidReach = 0.95;
  // A hooded eye carries its margin further down the globe. The aperture these
  // two leave is about 7 mm on a 25 mm globe, which is the ratio a real eye has
  // — open it to 20 mm and the character is permanently startled.
  const upperMargin = lerp(0.2, 0.03, spec.eyeFold);
  const lowerMargin = -0.3;

  const upper = dome(centre, lidR, yawFrom, yawTo, upperMargin, lidReach, 16, 6);
  if (upper) parts.push(tint(upper, (x, y) => {
    // Lid flesh starts just under cheek value — never white — and darkens into
    // the crease, so the fold reads without extra geometry. A lid that starts
    // at full cheek value reads as a continuation of the forehead and leaves
    // the whole orbit reading as one flat plane.
    const k = clamp((y - centre.y - 0.002) / 0.009, 0, 1);
    void x;
    return mixTint([1.02, 0.97, 0.95], [0.5, 0.45, 0.44], k * 0.55);
  }));
  const lower = dome(centre, lidR, yawFrom, yawTo, -lidReach, lowerMargin, 16, 5);
  if (lower) parts.push(tint(lower, (x, y) => {
    const k = clamp((centre.y - y - 0.004) / 0.008, 0, 1);
    void x;
    return mixTint([0.94, 0.9, 0.88], [0.58, 0.52, 0.51], k * 0.4);
  }));

  // Lid margins: the lash line above and the thicker wet rim below. Two
  // millimetres of geometry that does more for the read of an eye than the
  // globe does — it is the edge that the brain measures the aperture against.
  const margin = (pitch: number, radius: number, tone: Tint) => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 7; i++) {
      const yaw = lerp(yawFrom, yawTo, i / 7) * 0.96;
      pts.push(new Vector3(
        centre.x + Math.sin(yaw) * Math.cos(pitch) * (lidR.x + 0.0005),
        centre.y + Math.sin(pitch) * (lidR.y + 0.0005),
        centre.z - Math.cos(yaw) * Math.cos(pitch) * (lidR.z + 0.0005),
      ));
    }
    parts.push(tint(sweep(pts, (t) => {
      const taper = 0.45 + 0.55 * Math.sin(t * Math.PI);
      return [radius * taper, radius * 0.8 * taper];
    }, 12, 6), tone));
  };
  margin(upperMargin, 0.0016, LASH);
  margin(lowerMargin, 0.0011, mixTint(WHITE, [0.7, 0.6, 0.58], 0.5));
}

/**
 * Brow: a tapered hair strip following the orbital rim.
 *
 * Kept thin and tapered at both ends. A brow of constant thickness is a painted
 * black bar, and a black bar on a face is the single fastest way to make it
 * read as a mask rather than as a person.
 */
function buildBrow(parts: BufferGeometry[], spec: FaceSpec, sx: number) {
  const pts: Vector3[] = [];
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    // From the inner end near the nose, out and slightly up, then down at the
    // tail — the arch is what stops a brow reading as a bar.
    const x = sx * lerp(0.007, 0.055, u);
    const y = EYE_Y + 0.0175 + Math.sin(u * Math.PI * 0.8) * 0.005 - u * u * 0.005;
    // Follows the curve of the brow ridge back toward the temple.
    const z = EYE_Z - 0.012 + Math.abs(x) * Math.abs(x) * 5.2 - 0.0011 * spec.brow;
    pts.push(new Vector3(x, y, z));
  }
  const thick = 0.0022 + 0.0013 * spec.brow;
  parts.push(tint(
    sweep(pts, (t) => {
      // Heaviest a third of the way along, thinning to nothing at the tail.
      const taper = Math.pow(Math.sin(Math.pow(t, 0.7) * Math.PI), 0.6);
      return [thick * (0.25 + 0.75 * taper), (0.0016 + 0.0008 * spec.brow) * (0.3 + 0.7 * taper)];
    }, 14, 6),
    spec.browTint,
  ));
}

/**
 * Nose: dorsum, tip, alae and nostrils.
 *
 * Built as a swept dorsum with a separate ball for the tip rather than as one
 * lofted mass, because the tip and the bridge are different materials in every
 * sense that matters — the bridge is skin over bone and reflects hard, the tip
 * is cartilage under thick sebaceous skin and reflects soft.
 */
function buildNose(parts: BufferGeometry[], spec: FaceSpec) {
  const length = lerp(0.044, 0.054, spec.nose);
  const rootY = 0.006;
  const tipY = rootY - length;
  const project = lerp(0.02, 0.027, spec.nose);

  /*
   * One lofted mass, not a pile of spheres.
   *
   * The first pass assembled the nose from a swept dorsum plus a ball for the
   * tip plus a ball per ala, and at the scale a nose actually is — 50 mm long,
   * 34 mm across the wings — three overlapping spheres do not merge into a
   * nose. They read as three spheres, because nothing smooths the normals
   * across separate geometries. So the whole thing is one surface: a
   * cross-section swept down the dorsum, widening into the tip and flaring at
   * the alae, with the underside turned back under the nostrils.
   */
  const at = (v: number) => {
    // v: 0 at the root between the brows, 1 under the nostrils.
    const y = lerp(rootY, tipY - 0.007, v);
    // Projection off the face, with an optional dorsal hump a third of the way
    // down. The tip carries the most.
    const hump = spec.noseHook * 0.0034 * gaussian(v - 0.36, 0.15);
    const out = 0.007 + smoothstep(clamp(v * 1.05, 0, 1)) * project + hump
      // Turns back under at the very bottom — a nose has an underside.
      - clamp((v - 0.86) / 0.14, 0, 1) * 0.008;
    // Narrow at the bridge, broad at the wings.
    const halfWidth = smoothCurve(v, [
      [0, 0.0062],
      [0.35, 0.0072],
      [0.6, 0.0094],
      [0.82, 0.0158],
      [1, 0.0148],
    ]);
    const depth = smoothCurve(v, [
      [0, 0.006],
      [0.5, 0.0082],
      // Tip mass peaks below the nostril line — the ball of the tip is what
      // carries the profile in side view, so it is the most projected part.
      [0.8, 0.0128],
      [1, 0.0104],
    ]);
    return { y, z: EYE_Z - 0.004 - out, halfWidth, depth };
  };

  const nose = raggedSurface(
    (u, v) => {
      const s = at(v);
      // u sweeps from the left cheek, over the dorsum, to the right cheek.
      // Stopped short of a full turn: carried all the way round, the surface
      // meets itself at the sides in a hard vertical seam down the face, which
      // reads as a ridge glued on rather than as a nose growing out.
      const angle = (u - 0.5) * Math.PI * 1.28;
      /*
       * Planes, not a cylinder.
       *
       * A circular cross-section turns the dorsum into a round rod glued to the
       * face — the "cardboard cutout" look. A real nose is a flat bridge plane
       * with two harder side planes falling off it, and a tip that reads as a
       * faceted ball. Raising the falloff exponent flattens the top (the
       * surface holds its projection across the middle third) and steepens the
       * sides, which is what catches light as a plane edge instead of as a
       * continuous roll.
       */
      const sideFall = Math.pow(1 - Math.cos(angle), 1.42);
      return new Vector3(
        Math.sin(angle) * s.halfWidth,
        s.y,
        s.z + sideFall * s.depth,
      );
    },
    30,
    16,
    { edgeWidth: 0.003, edgeTint: WHITE },
  );
  if (nose) parts.push(nose);

  // Nostrils, sunk *up into* the underside rather than hung below it. Small and
  // dark: at 7 mm across they are two shadows, and anything larger turns the
  // nose into a socket. Placed even a millimetre proud and they are two beads
  // stuck under the tip.
  const base = at(0.99);
  for (const sx of [-1, 1]) {
    parts.push(tint(
      ellipsoid(
        // Sunk up into the underside and pulled inboard: proud of the surface
        // even slightly, they read as two beads stuck under the tip instead of
        // as the shadowed apertures they are meant to be.
        new Vector3(sx * 0.0064, base.y + 0.0036, base.z + 0.0046),
        new Vector3(0.0028, 0.0021, 0.0038),
        10,
        6,
      ),
      CAVITY,
    ));
  }
}

/**
 * Mouth: both lips, the line between them, and a dark interior so a mouth left
 * slightly open is a mouth rather than a hole in the head.
 */
function buildMouth(parts: BufferGeometry[], spec: FaceSpec) {
  const halfWidth = 0.0242;
  // The lips lie on the muzzle, which curves back sharply toward the corners —
  // a mouth laid on a flat plane floats off the face at both ends.
  const surfaceZ = (x: number) => EYE_Z + 0.0032 + (x / halfWidth) * (x / halfWidth) * 0.0062;

  const lipPath = (yOffset: number, bowAmount: number, back: number) => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      const x = lerp(-halfWidth, halfWidth, u);
      const k = Math.abs(x) / halfWidth;
      // Cupid's bow: two peaks either side of a central dip, fading out toward
      // the corners where the lip thins away to nothing.
      const bow = bowAmount * (0.0015 * Math.cos(u * TAU * 2) - 0.0026 * k * k);
      pts.push(new Vector3(x, MOUTH_Y + yOffset + bow, surfaceZ(x) + back));
    }
    return pts;
  };

  /*
   * Two lips with volume and a seam between them, in contact.
   *
   * The first pass swept four thin tubes across the face — upper, lower, the
   * oral fissure and a hint of teeth — spaced far enough apart that they read
   * as four parallel ridges rather than as a mouth. A mouth is two masses that
   * *touch*, with one dark line where they meet, so these are thicker, closer,
   * and the teeth are gone: a dental arch behind a closed mouth is invisible
   * when it is right and a grin when it is not.
   */
  const fullness = lerp(0.78, 1.3, spec.lipFullness);
  parts.push(tint(
    sweep(lipPath(0.0046, 1, 0), (t) => {
      const taper = Math.sin(t * Math.PI) * 0.8 + 0.2;
      return [0.0056 * fullness * taper, 0.0042 * fullness * taper];
    }, 16, 8),
    LIP,
  ));
  parts.push(tint(
    sweep(lipPath(-0.0054, -0.35, -0.0004), (t) => {
      const taper = Math.sin(t * Math.PI) * 0.76 + 0.24;
      return [0.0064 * fullness * taper, 0.005 * fullness * taper];
    }, 16, 8),
    mixTint(LIP, [1.0, 0.72, 0.68], 0.3),
  ));

  // The oral fissure — a thin dark seam, sunk back so it reads as a crease
  // between the two masses rather than as a third one laid on top.
  parts.push(tint(
    sweep(lipPath(-0.0004, 0.3, 0.0035), (t) => {
      const taper = Math.sin(t * Math.PI) * 0.7 + 0.3;
      return [0.0018 * taper, 0.0012 * taper];
    }, 16, 6),
    [0.24, 0.14, 0.13],
  ));
}

/**
 * Ear: one shell with a rolled helix, a concha bowl and a lobe.
 *
 * Built as a surface rather than as a stack of arcs and beads. An ear is 60 mm
 * tall and 30 mm across, and at that size a helix sweep, an antihelix sweep, a
 * lobe sphere and a tragus sphere do not merge into an ear — they read as four
 * small objects stuck to the side of the head, which is exactly what the first
 * pass produced. The plate is a single flattened dome lofted from an outline,
 * and only the rolled rim is swept on top of it.
 */
function buildEar(parts: BufferGeometry[], sx: number) {
  const centreY = -0.032;
  const rootX = sx * (skullSideX(centreY) - 0.006);
  const centreZ = 0.016;

  // Outline, as a radius per angle: tall and narrow, wider at the top, drawn
  // in the plane of the side of the head (y up, z back).
  const outline = (a: number) => {
    const up = Math.cos(a);
    const back = Math.sin(a);
    const height = 0.0215 + 0.0025 * clamp(up, 0, 1);
    const depth = 0.0125 + 0.0022 * clamp(back, 0, 1);
    return { y: centreY + up * height, z: centreZ + back * depth };
  };

  const plate = raggedSurface(
    (u, v) => {
      const a = u * TAU - Math.PI;
      const o = outline(a);
      // v runs from the rim in to the centre; the shell stands off the skull at
      // the rim and sinks back to meet it at the middle, which is the shape
      // that makes an ear read as attached rather than as applied.
      const t = 1 - v;
      const stand = 0.004 + 0.008 * Math.pow(t, 1.4);
      return new Vector3(
        rootX + sx * stand,
        lerp(centreY, o.y, t),
        lerp(centreZ + 0.002, o.z, t),
      );
    },
    18,
    6,
    { edgeWidth: 0.002, edgeTint: WHITE },
  );
  if (plate) parts.push(plate);

  // Rolled helix along the outer rim, thinning as it runs down to the lobe.
  const helix: Vector3[] = [];
  for (let i = 0; i <= 9; i++) {
    const a = lerp(-2.5, 0.75, i / 9);
    const o = outline(a);
    helix.push(new Vector3(rootX + sx * 0.0125, o.y, o.z));
  }
  parts.push(sweep(helix, (t) => {
    const taper = 0.55 + 0.45 * Math.sin(Math.pow(t, 0.8) * Math.PI);
    return [0.0032 * taper, 0.0036 * taper];
  }, 16, 6, new Vector3(1, 0, 0)));

  // Concha: the bowl in front of the canal, and the canal itself.
  parts.push(tint(
    ellipsoid(
      new Vector3(rootX + sx * 0.005, centreY - 0.002, centreZ + 0.004),
      new Vector3(0.0045, 0.0088, 0.0058),
      12,
      8,
    ),
    [0.66, 0.58, 0.55],
  ));
  parts.push(tint(
    ellipsoid(
      new Vector3(rootX + sx * 0.002, centreY - 0.004, centreZ + 0.0035),
      new Vector3(0.0026, 0.004, 0.0028),
      8,
      6,
    ),
    CAVITY,
  ));
  // Tragus, the small flap over the canal.
  parts.push(ellipsoid(
    new Vector3(rootX + sx * 0.0062, centreY - 0.006, centreZ - 0.0042),
    new Vector3(0.003, 0.0046, 0.0032),
    8,
    6,
  ));
}

/**
 * Scalp hair. Military cuts only, which is a gift: everything here is within a
 * few millimetres of the skull, so it can be a shell offset along the skull
 * normal rather than anything that needs strands.
 */
function buildHair(parts: BufferGeometry[], spec: FaceSpec) {
  if (spec.hair === 'shaved') {
    // A shaved head is not a bald head: there is a shadow where the hair would
    // be, and it stops in a sharp line at the temples.
    const shadow = raggedSurface(
      (u, v) => {
        const angle = u * TAU - Math.PI;
        const h = lerp(0.16, 0.998, Math.pow(v, 0.75));
        return skullPoint(h, angle, 0.0012);
      },
      30,
      8,
      { edgeWidth: 0.004, edgeTint: WHITE, baseTint: () => mixTint(WHITE, spec.hairTint, 0.55) },
    );
    if (shadow) parts.push(shadow);
    return;
  }

  const thickness = spec.hair === 'buzz' ? 0.0032 : 0.0072;
  // Hairline: lower at the sides and back, with a slight widow's peak at the
  // front. `h` is the sphere latitude the hair starts at.
  const hairline = (angle: number) => {
    const front = Math.cos(angle);
    const peak = 0.045 * Math.pow(clamp(front, 0, 1), 6);
    return 0.3 - 0.34 * clamp(front, 0, 1) - 0.1 * clamp(-front, 0, 1) + peak;
  };
  const cap = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const start = hairline(angle);
      const h = lerp(start, 0.999, Math.pow(v, 0.7));
      // Thins toward the hairline, which is what makes it grow out of the head
      // rather than sit on it like a swimming cap.
      const grow = thickness * smoothstep(clamp(v * 3.2, 0, 1));
      return skullPoint(h, angle, grow);
    },
    36,
    10,
    { edgeWidth: 0.005, edgeTint: WHITE, baseTint: () => spec.hairTint },
  );
  if (cap) {
    displaceAlongNormals(cap, 0x51a3, thickness * 0.4, 90);
    cap.computeVertexNormals();
    parts.push(cap);
  }

  if (spec.hair === 'tiedBack') {
    // A short tail low on the back of the head, tucked under a hat brim.
    const base = skullPoint(-0.12, Math.PI, 0.004);
    parts.push(tint(
      sweep(
        [
          base,
          base.clone().add(new Vector3(0, -0.022, 0.012)),
          base.clone().add(new Vector3(0, -0.05, 0.018)),
        ],
        (t) => [lerp(0.016, 0.008, t), lerp(0.013, 0.007, t)],
        10,
        8,
      ),
      spec.hairTint,
    ));
  }
}

/** Beard geometry — a shell standing off the jaw wherever the mask says hair. */
function buildBeard(parts: BufferGeometry[], spec: FaceSpec) {
  if (spec.beard <= 0) return;
  const shell = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const h = lerp(-0.999, 0.1, v);
      return skullPoint(h, angle, spec.beard);
    },
    40,
    14,
    {
      alive: (u, v) => {
        const angle = u * TAU - Math.PI;
        const h = lerp(-0.999, 0.1, v);
        const p = skullPoint(h, angle);
        // The mask is a coverage fraction; turning it into a signed margin in
        // metres is what lets the shrink-wrap put the beard's edge on the real
        // hairline instead of on a grid cell.
        return (beardCoverage(p.x, p.y, p.z, spec) - 0.42) * 0.05;
      },
      edgeWidth: 0.006,
      edgeTint: mixTint(spec.hairTint, WHITE, 0.35),
      baseTint: () => spec.hairTint,
    },
  );
  if (!shell) return;
  displaceAlongNormals(shell, 0x9d21, spec.beard * 0.42, 70);
  shell.computeVertexNormals();
  parts.push(shell);
}

function buildHead(spec: FaceSpec, skinTint: number): BufferGeometry {
  const parts: BufferGeometry[] = [buildFaceShell(spec)];
  buildEye(parts, spec, -1, -1, skinTint);
  buildEye(parts, spec, 1, 1, skinTint);
  buildBrow(parts, spec, -1);
  buildBrow(parts, spec, 1);
  buildNose(parts, spec);
  buildMouth(parts, spec);
  buildEar(parts, -1);
  buildEar(parts, 1);
  buildHair(parts, spec);
  buildBeard(parts, spec);

  ensureTints(parts);
  const merged = mergeAll(parts, ['color'])!;
  parts.forEach((part) => part.dispose());
  merged.computeVertexNormals();
  return merged;
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

const TORSO_BOTTOM_Y = 0.86;
/** Where the shoulder line gives way to the neck. */
const TORSO_SHOULDER_Y = 1.455;

/**
 * Torso envelope for a fit adult, in bind-pose metres.
 *
 * The zombie's curve describes a body that has been starving; this one
 * describes one that trains. Concretely: the chest is wider and deeper, the
 * waist is narrower rather than merely smaller, and the trapezius carries the
 * shoulder line up and out instead of falling away to a thin neck. The
 * difference between the two curves is the whole difference between the two
 * silhouettes before a single piece of kit goes on.
 */
function soldierSectionAt(y: number, bulk: number, frame: number): BodySection {
  const shoulder = clamp((y - 1.24) / 0.16, 0, 1);
  return {
    halfWidth: smoothCurve(y, [
      [0.86, 0.136],
      [0.94, 0.155],
      [1.0, 0.158],
      [1.08, 0.146],
      [1.14, 0.139],
      [1.22, 0.15],
      [1.32, 0.171],
      [1.4, 0.168],
      [1.45, 0.148],
      [1.505, 0.082],
    ]) * bulk * lerp(1, frame, shoulder),
    halfDepth: smoothCurve(y, [
      [0.86, 0.101],
      [0.94, 0.112],
      [1.0, 0.113],
      [1.08, 0.103],
      [1.14, 0.098],
      [1.22, 0.107],
      [1.32, 0.121],
      [1.4, 0.111],
      [1.45, 0.094],
      [1.49, 0.064],
      [1.505, 0.051],
    ]) * bulk,
    centreZ: smoothCurve(y, [
      [0.86, 0.014],
      [1.0, 0.009],
      [1.1, -0.007],
      [1.2, -0.013],
      [1.32, -0.004],
      [1.42, 0.01],
      [1.505, 0.014],
    ]) * bulk,
  };
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

const baseCache = new Map<string, MeshStandardMaterial>();

function baseMaterial(key: string, make: () => MeshStandardMaterial): MeshStandardMaterial {
  let hit = baseCache.get(key);
  if (!hit) {
    hit = make();
    baseCache.set(key, hit);
  }
  return hit;
}

function skinMaterial(def: OperatorDef): MeshStandardMaterial {
  const m = baseMaterial('skin', () =>
    makeSurface('soldierSkin', {
      repeat: 1,
      roughness: 1,
      metalness: 0,
      normalScale: 0.95,
      aoIntensity: 0.8,
    })).clone();
  m.color.setHex(def.skinTone);
  m.vertexColors = true;
  // Low, on purpose. Skin is the only part of the model with any gloss, so it
  // picks up far more of the environment than the cloth around it and reads as
  // moulded orange rubber long before it reads as bright.
  m.envMapIntensity = 0.45;
  return m;
}

function uniformMaterial(def: OperatorDef): MeshStandardMaterial {
  const m = baseMaterial(`camo:${def.camo}`, () =>
    makeSurface(def.camo, {
      repeat: 1,
      roughness: 1,
      metalness: 0,
      normalScale: 1.05,
    })).clone();
  m.vertexColors = true;
  m.envMapIntensity = 0.45;
  // Collars, cuffs and cargo flaps are open shells.
  m.side = DoubleSide;
  return m;
}

function kitMaterial(def: OperatorDef): MeshStandardMaterial {
  const m = baseMaterial('cordura', () =>
    makeSurface('cordura', {
      repeat: 1,
      roughness: 1,
      metalness: 0,
      normalScale: 0.95,
    })).clone();
  m.color.setHex(def.kitTint);
  m.vertexColors = true;
  m.envMapIntensity = 0.6;
  m.side = DoubleSide;
  return m;
}

/**
 * Hard composite: helmet shells, goggle frames, buckles, boot soles, knee caps.
 *
 * Split out from the nylon because these are the only parts of a soldier with a
 * specular highlight that holds its shape, and running them through the webbing
 * bake is what makes procedural characters look like they were carved from one
 * block of felt.
 */
function hardMaterial(def: OperatorDef): MeshStandardMaterial {
  const m = baseMaterial('hard', () =>
    makeSurface('polymer', {
      repeat: 1,
      roughness: 0.62,
      metalness: 0.22,
      normalScale: 0.55,
    })).clone();
  m.color.setHex(def.hardTint);
  m.vertexColors = true;
  m.envMapIntensity = 1;
  m.side = DoubleSide;
  return m;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

const _handFrame = new Quaternion();

export function buildSoldierMesh(id: OperatorId): SoldierRig {
  const def = OPERATORS[id];
  const rng = new Rng((0x5a17c0de ^ Math.imul(OPERATOR_IDS.indexOf(id) + 1, 2654435761)) >>> 0);
  const root = new Group();
  root.name = `soldier:${id}`;

  const bulk = def.bulk;
  const frame = def.frame;
  const heightScale = def.height;

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
  // Shoulder joints follow the frame, since that is what a heavy build actually
  // widens — a broad man is broad across the acromions, not around the ribs.
  const shoulderJointX = 0.19 * bulk * frame;
  const upperArmLocalX = shoulderJointX - Math.abs(bones.clavicleL.position.x);
  bones.upperArmL.position.x = upperArmLocalX;
  bones.upperArmR.position.x = -upperArmLocalX;
  // The arms need the same A-stance the zombie has — an arm dropped straight
  // from a 0.19 shoulder puts the wrist inside the waistband, where no skin
  // weighting can separate hand from belt — but it has to be carried as a bind
  // *rotation*, not as an offset on the child joint.
  //
  // These arms are solved by two-bone IK onto a weapon's grips every frame, and
  // the solver's whole geometry assumes each bone extends along its own -Y: it
  // aims the upper bone's -Y down the shoulder-to-target chord and hinges the
  // elbow about local X. Displace the elbow sideways in its parent's frame and
  // that assumption quietly fails — the triangle still closes, so the arm looks
  // plausible, but the hand lands 70 mm off the grip and the elbow swings out
  // into a chicken wing to make up the difference. Rotating the joint keeps the
  // stance and keeps the chain straight.
  bones.lowerArmL.position.set(0, -0.28, 0);
  bones.lowerArmR.position.set(0, -0.28, 0);
  bones.handL.position.set(0, -0.26, 0);
  bones.handR.position.set(0, -0.26, 0);
  bones.upperArmL.rotation.set(0.06, 0, 0.2);
  bones.upperArmR.rotation.set(0.06, 0, -0.2);
  bones.lowerArmL.rotation.set(0.05, 0, 0.03);
  bones.lowerArmR.rotation.set(0.05, 0, -0.03);
  bones.upLegL.position.x = 0.098 * bulk;
  bones.upLegR.position.x = -0.098 * bulk;
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
  const handTipL = P.handL.clone().add(new Vector3(0, -0.088, 0));
  const handTipR = P.handR.clone().add(new Vector3(0, -0.088, 0));
  const toeL = P.footL.clone().add(new Vector3(0, -0.018, -0.155));
  const toeR = P.footR.clone().add(new Vector3(0, -0.018, -0.155));

  const bonePairs: BonePair[] = [
    { index: boneIndex.hips, a: P.hips.clone().add(new Vector3(0, -0.09, 0)), b: P.spine, radius: 0.15 * bulk, chain: 'torso' },
    { index: boneIndex.spine, a: P.spine, b: P.chest, radius: 0.15 * bulk, chain: 'torso' },
    { index: boneIndex.chest, a: P.chest, b: P.neck, radius: 0.18 * bulk, chain: 'torso' },
    { index: boneIndex.neck, a: P.neck, b: P.head, radius: 0.07, chain: 'torso' },
    { index: boneIndex.head, a: P.head, b: headTop, radius: 0.12, chain: 'torso' },
    { index: boneIndex.clavicleL, a: P.clavicleL, b: P.upperArmL, radius: 0.075, chain: 'torso' },
    { index: boneIndex.upperArmL, a: P.upperArmL, b: P.lowerArmL, radius: 0.06, chain: 'armL' },
    { index: boneIndex.lowerArmL, a: P.lowerArmL, b: P.handL, radius: 0.052, chain: 'armL' },
    { index: boneIndex.handL, a: P.handL, b: handTipL, radius: 0.05, chain: 'armL' },
    { index: boneIndex.clavicleR, a: P.clavicleR, b: P.upperArmR, radius: 0.075, chain: 'torso' },
    { index: boneIndex.upperArmR, a: P.upperArmR, b: P.lowerArmR, radius: 0.06, chain: 'armR' },
    { index: boneIndex.lowerArmR, a: P.lowerArmR, b: P.handR, radius: 0.052, chain: 'armR' },
    { index: boneIndex.handR, a: P.handR, b: handTipR, radius: 0.05, chain: 'armR' },
    { index: boneIndex.upLegL, a: P.upLegL, b: P.lowLegL, radius: 0.088, chain: 'legL' },
    { index: boneIndex.lowLegL, a: P.lowLegL, b: P.footL, radius: 0.07, chain: 'legL' },
    { index: boneIndex.footL, a: P.footL, b: toeL, radius: 0.058, chain: 'legL' },
    { index: boneIndex.upLegR, a: P.upLegR, b: P.lowLegR, radius: 0.088, chain: 'legR' },
    { index: boneIndex.lowLegR, a: P.lowLegR, b: P.footR, radius: 0.07, chain: 'legR' },
    { index: boneIndex.footR, a: P.footR, b: toeR, radius: 0.058, chain: 'legR' },
  ];

  const section = (y: number) => soldierSectionAt(y, bulk, frame);

  const skinParts: BufferGeometry[] = [];
  const uniformParts: BufferGeometry[] = [];
  const kitParts: BufferGeometry[] = [];
  const hardParts: BufferGeometry[] = [];

  /* --- Head and neck --------------------------------------------------- */
  const skullCentre = P.head.clone().add(new Vector3(0, 0.056, 0.004));
  const head = buildHead(def.face, def.skinTone);
  head.scale(HEAD_SCALE, HEAD_SCALE, HEAD_SCALE);
  head.translate(skullCentre.x, skullCentre.y, skullCentre.z);
  skinParts.push(head);

  // Neck: a tapered column with the sternocleidomastoids on the front of it.
  const neckBottom = P.chest.y + 0.1;
  const neckTop = skullCentre.y + HEAD_BOTTOM * HEAD_SCALE + 0.012;
  skinParts.push(verticalLoft(
    neckBottom,
    neckTop,
    (y) => {
      const t = clamp((y - neckBottom) / (neckTop - neckBottom), 0, 1);
      const r = lerp(0.062, 0.05, smoothstep(t)) * lerp(1, bulk, 0.6);
      return { halfWidth: r, halfDepth: r * 0.92, centreZ: 0.004 - t * 0.006 };
    },
    18,
    7,
    false,
    false,
  ));
  for (const sx of [-1, 1]) {
    skinParts.push(tube(
      new Vector3(sx * 0.03, neckTop - 0.012, -0.026),
      new Vector3(sx * 0.014, neckBottom + 0.004, -0.048),
      (t) => [lerp(0.009, 0.013, t), lerp(0.007, 0.011, t)],
      8,
      3,
      false,
      false,
    ));
  }
  // Trapezius slopes: the ridge every fit neck carries from behind the jaw out
  // and down to each acromion. Without it a head sits on a cylinder that ends
  // where the collar begins, which is exactly how the first pass read — the
  // uniform's mandarin collar was doing all of the blending on its own.
  for (const sx of [-1, 1]) {
    const outer = P[`upperArm${sx > 0 ? 'L' : 'R'}` as BoneName];
    skinParts.push(tint(sweep(
      [
        // Rises just under the skull base, behind the sternocleidomastoid.
        new Vector3(sx * 0.02, neckTop - 0.008, 0.024),
        new Vector3(sx * lerp(0.05, 0.11, bulk - 0.6), TORSO_SHOULDER_Y + 0.012, 0.012),
        // Lands on the shoulder line just inboard of the deltoid cap.
        new Vector3(outer.x * 0.82, outer.y + 0.032, outer.z + 0.004),
      ],
      (t) => {
        const w = lerp(0.014, 0.024, t);
        return [w, lerp(0.012, 0.02, t)];
      },
      10,
      7,
      new Vector3(0, 0, 1),
    ), [1.04, 1.0, 0.97]));
  }
  // Adam's apple, small: it is a silhouette cue on a raised chin, nothing more.
  skinParts.push(ellipsoid(
    new Vector3(0, lerp(neckBottom, neckTop, 0.6), -0.052),
    new Vector3(0.009, 0.013, 0.007),
    8,
    6,
  ));

  const inRigidHeadRegion = (x: number, y: number, z: number) =>
    y > skullCentre.y + HEAD_BOTTOM * HEAD_SCALE - 0.004 &&
    Math.hypot(x - skullCentre.x, z - skullCentre.z) < 0.19;

  /* --- Torso, arms and legs (skin) ------------------------------------- */
  // The uniform covers nearly all of this, so it is built at low density: what
  // it exists for is to close the gaps at the collar, the cuffs and the hem,
  // where a missing body reads as a hole straight through the character.
  //
  // It stops below the trapezius on purpose. Run it to the full torso height
  // and the bare shoulders stand proud of a shirt that ends at 1.487, which
  // paints a slab of skin across the top of the chest — and because skin is the
  // brightest material on the model, that slab is the first thing the eye finds.
  skinParts.push(verticalLoft(TORSO_BOTTOM_Y - 0.02, TORSO_SHOULDER_Y, section, 18, 12, true, true));

  const armProfile = (upper: boolean) => (t: number): [number, number] => {
    const r = upper
      // Deltoid into the belly of the biceps, then in to the elbow.
      ? lerp(0.052, 0.04, smoothstep(t)) + 0.005 * Math.sin(t * Math.PI)
      // Forearm: heavy at the flexor mass, narrow at the wrist.
      : lerp(0.044, 0.026, Math.pow(t, 0.75)) + 0.004 * Math.sin(t * Math.PI * 0.8);
    return [r * bulk, r * 0.93 * bulk];
  };

  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const upperArm = P[`upperArm${side}` as BoneName];
    const lowerArm = P[`lowerArm${side}` as BoneName];
    const hand = P[`hand${side}` as BoneName];

    const chain: Chain = side === 'L' ? 'armL' : 'armR';
    skinParts.push(lockChain(ellipsoid(
      upperArm.clone().add(new Vector3(0, -0.028, 0)),
      new Vector3(0.05 * bulk, 0.056, 0.048 * bulk),
      14,
      10,
    ), chain));
    skinParts.push(lockChain(tube(upperArm, lowerArm, armProfile(true), 14, 6, false, false), chain));
    skinParts.push(lockChain(tube(lowerArm, hand, armProfile(false), 14, 6, false, false), chain));

    const gloveKit: BufferGeometry[] = [];
    const gloveHard: BufferGeometry[] = [];
    bones[`hand${side}` as BoneName].getWorldQuaternion(_handFrame);
    buildGlovedHand(gloveKit, gloveHard, hand, _handFrame, sx, bulk);
    for (const g of gloveKit) kitParts.push(lockChain(g, chain));
    for (const g of gloveHard) hardParts.push(lockChain(g, chain));
  }

  const legProfile = (upper: boolean) => (t: number): [number, number] => {
    const r = upper
      ? lerp(0.098, 0.062, Math.pow(t, 0.85))
      // Calf belly at a third of the way down, then the ankle.
      : lerp(0.066, 0.036, Math.pow(t, 0.7)) + 0.012 * Math.sin(Math.pow(t, 0.7) * Math.PI);
    return [r * bulk, r * 0.94 * bulk];
  };
  for (const side of ['L', 'R'] as const) {
    const upLeg = P[`upLeg${side}` as BoneName];
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];
    skinParts.push(tube(upLeg.clone().add(new Vector3(0, 0.04, 0)), lowLeg, legProfile(true), 14, 6, false, false));
    skinParts.push(tube(lowLeg, foot.clone().add(new Vector3(0, 0.02, 0)), legProfile(false), 14, 6, false, false));
  }

  /* --- Uniform --------------------------------------------------------- */
  buildUniform(uniformParts, kitParts, P, section, def, bulk, rng);

  /* --- Load-bearing kit ------------------------------------------------ */
  buildArmour(kitParts, hardParts, section, def, bulk);
  buildBelt(kitParts, hardParts, P, section, def, bulk);
  buildBoots(kitParts, hardParts, P, toeL, toeR, bulk);
  if (def.kneePads) buildKneePads(kitParts, hardParts, P, bulk);

  /* --- Headgear -------------------------------------------------------- */
  buildHeadgear(kitParts, hardParts, skullCentre, def, P);
  if (def.shemagh) buildShemagh(kitParts, skullCentre, P, neckTop, bulk);

  /* --- Merge, skin, bind ----------------------------------------------- */
  const finish = (
    parts: BufferGeometry[],
    name: string,
    material: Material,
    opts: { fold?: number; rigidHead?: boolean } = {},
  ): SkinnedMesh => {
    ensureTints(parts);
    ensureChainLock(parts);
    const geo = mergeAll(parts, ['color', 'chainLock'])!;
    parts.forEach((g) => g.dispose());
    geo.computeVertexNormals();
    if (opts.fold) {
      // Drape and creases. Two octaves: one for the way a garment hangs, one
      // for the wrinkles in it.
      displaceAlongNormals(geo, 0x3d51, opts.fold, 9);
      displaceAlongNormals(geo, 0x7b12, opts.fold * 0.35, 38);
      geo.computeVertexNormals();
    }
    autoSkin(geo, bonePairs);
    if (opts.rigidHead) rigidSkinRegion(geo, boneIndex.head, inRigidHeadRegion);
    geo.deleteAttribute('chainLock');
    const mesh = new SkinnedMesh(geo, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Bind-pose bounding spheres do not survive an animated character reaching
    // out; the manager culls by position instead.
    mesh.frustumCulled = false;
    return mesh;
  };

  const skinMesh = finish(skinParts, 'soldierSkin', skinMaterial(def), { rigidHead: true });
  const uniformMesh = finish(uniformParts, 'soldierUniform', uniformMaterial(def), { fold: 0.0042 });
  const kitMesh = finish(kitParts, 'soldierGear', kitMaterial(def), { rigidHead: true });
  const hardMesh = finish(hardParts, 'soldierHard', hardMaterial(def), { rigidHead: true });

  /* --- Stature --------------------------------------------------------- */
  // Baked into the bones and the geometry rather than set on the root: a scaled
  // root is absorbed once by the bind inverses and again by the model matrix.
  // Must happen after every autoSkin call, because weighting reads
  // `bindPositions`, which is scaled in place here.
  if (heightScale !== 1) {
    for (const bone of boneList) bone.position.multiplyScalar(heightScale);
    for (const mesh of [skinMesh, uniformMesh, kitMesh, hardMesh]) {
      mesh.geometry.scale(heightScale, heightScale, heightScale);
    }
    for (const key of Object.keys(bindPositions) as BoneName[]) {
      bindPositions[key].multiplyScalar(heightScale);
    }
    root.updateMatrixWorld(true);
  }

  const skeleton = new Skeleton(boneList);
  for (const mesh of [skinMesh, uniformMesh, kitMesh, hardMesh]) {
    root.add(mesh);
    mesh.bind(skeleton, new Matrix4());
  }

  const weaponMount = new Object3D();
  weaponMount.name = 'weaponMount';
  root.add(weaponMount);

  return {
    root,
    bones,
    boneList,
    skeleton,
    skin: skinMesh,
    uniform: uniformMesh,
    gear: kitMesh,
    hard: hardMesh,
    weaponMount,
    bindPositions,
    armLengths: {
      upper: P.upperArmL.distanceTo(P.lowerArmL) * heightScale,
      lower: P.lowerArmL.distanceTo(P.handL) * heightScale,
    },
    def,
    height: 1.75 * heightScale,
  };
}

/* ------------------------------------------------------------------ */
/* Hands                                                               */
/* ------------------------------------------------------------------ */

/**
 * A gloved hand, closed around a rod.
 *
 * The fingers ride a circular arc about an axis through the fist along local Z,
 * which is what a hand holding anything cylindrical actually does, and it means
 * a weapon laid on that axis is gripped rather than intersected. Three segments
 * per finger: two cannot make 200 degrees of wrap without the knuckles reading
 * as hinges.
 *
 * Built at the origin in the hand bone's *own* frame and then transformed onto
 * the wrist, because the arms carry their A-stance as a bind rotation — a fist
 * laid out along world axes would be eleven degrees out of true with the bone
 * that drives it, and would twist off the grip the moment the arm moved.
 *
 * `sx` is +1 for the +X arm and -1 for the -X one; the palm faces the body, so
 * the palm direction is -sx on X.
 */
function buildGlovedHand(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  wrist: Vector3,
  wristFrame: Quaternion,
  sx: number,
  bulk: number,
) {
  const palmX = -sx; // unit direction from the back of the hand toward the palm
  const scale = lerp(1, bulk, 0.5);
  const knuckleY = -0.084 * scale;
  const local: { soft: BufferGeometry[]; hard: BufferGeometry[] } = { soft: [], hard: [] };

  // Palm block and the back of the hand.
  local.soft.push(box(
    new Vector3(palmX * 0.004 * scale, -0.046 * scale, -0.002),
    0.03 * scale,
    0.086 * scale,
    0.078 * scale,
  ));
  // Thenar eminence — the muscle at the base of the thumb, on the palm side.
  local.soft.push(ellipsoid(
    new Vector3(palmX * 0.015 * scale, -0.04 * scale, -0.024),
    new Vector3(0.011, 0.022, 0.014).multiplyScalar(scale),
    10,
    8,
  ));
  // Knuckle armour: the raised plate every tactical glove has on the back.
  local.hard.push(tint(box(
    new Vector3(-palmX * 0.013 * scale, knuckleY + 0.008 * scale, -0.004),
    0.011 * scale,
    0.03 * scale,
    0.062 * scale,
  ), RUBBER));
  // Cuff.
  local.soft.push(tint(tube(
    new Vector3(0, 0.016 * scale, 0),
    new Vector3(0, -0.008 * scale, 0),
    () => [0.035 * scale, 0.03 * scale],
    12,
    2,
    false,
    false,
  ), STRAP_DARK));

  // The rod the fist closes around, and the arc the joints ride on.
  const rod = new Vector3(palmX * 0.024 * scale, knuckleY - 0.014 * scale, 0);
  const wrapR = 0.03 * scale;
  const away = -palmX; // outward, away from the palm

  const at = (angle: number, radius: number, z: number) =>
    new Vector3(
      rod.x + away * Math.cos(angle) * radius,
      rod.y - Math.sin(angle) * radius,
      rod.z + z,
    );

  const fingerR = [0.0108, 0.0112, 0.0105, 0.0092];
  for (let f = 0; f < 4; f++) {
    // Index finger nearest the front of the weapon (-Z), pinky at the back.
    const z = (f - 1.5) * 0.0205 * scale * -sx;
    const r0 = fingerR[f] * scale;
    // The index finger rides forward on a trigger rather than fully closed, so
    // it wraps well short of the other three.
    const closure = f === 0 ? 0.62 : 1;
    const phi = [-0.42, 0.42 * closure + 0.02, 1.5 * closure, 2.35 * closure];
    const radii = [wrapR, wrapR * 0.96, wrapR * 0.9, wrapR * 0.84];
    for (let s = 0; s < 3; s++) {
      const a = at(phi[s], radii[s], z);
      const b = at(phi[s + 1], radii[s + 1], z);
      const rA = r0 * [1, 0.9, 0.8][s];
      const rB = r0 * [0.9, 0.8, 0.66][s];
      local.soft.push(tube(a, b, (t) => [lerp(rA, rB, t), lerp(rA, rB, t) * 0.92], 8, 2, s === 0, s === 2));
      /*
       * Armoured plate over the proximal and middle phalanx.
       *
       * The three tubes alone segment the finger, but at gameplay distance
       * three shaded bumps read as wrinkles. A hard plate riding the outside
       * of each segment is what turns them into *glove* segments: it catches a
       // hard-material highlight per phalanx, exactly where a tactical glove
       * carries its armour, and it makes the joint gaps read as gaps.
       */
      if (s < 2) {
        const phiMid = (phi[s] + phi[s + 1]) * 0.5;
        const segLen = b.distanceTo(a);
        // Local frame of the wrap arc: the outward normal and the tangent the
        // plate's long axis has to follow as the finger curls round the grip.
        const tx = -Math.sin(phiMid) * away;
        const ty = -Math.cos(phiMid);
        const plateAt = new Vector3(
          rod.x + away * Math.cos(phiMid) * (radii[s] + r0 * 0.52),
          rod.y - Math.sin(phiMid) * (radii[s] + r0 * 0.52),
          z,
        );
        local.hard.push(tint(box(
          plateAt,
          r0 * 0.78,
          segLen * 0.68,
          r0 * 2.15,
          Math.atan2(-tx, ty),
        ), RUBBER));
      }
    }
  }

  // Thumb: over the top of the fist from the front, meeting the middle finger.
  const thumbZ = -0.03 * scale * -sx;
  local.soft.push(sweep(
    [
      new Vector3(palmX * 0.02 * scale, -0.05 * scale, thumbZ * 0.4),
      at(-1.15, wrapR * 1.15, thumbZ * 0.9),
      at(-0.35, wrapR * 1.02, thumbZ * 1.05),
    ],
    (t) => {
      const r = lerp(0.014, 0.0098, t) * scale;
      return [r, r * 0.94];
    },
    10,
    8,
  ));

  const onto = new Matrix4().compose(wrist, wristFrame, UNIT_SCALE);
  for (const g of local.soft) {
    g.applyMatrix4(onto);
    kit.push(g);
  }
  for (const g of local.hard) {
    g.applyMatrix4(onto);
    hard.push(g);
  }
}

const UNIT_SCALE = new Vector3(1, 1, 1);

/* ------------------------------------------------------------------ */
/* Uniform                                                             */
/* ------------------------------------------------------------------ */

function buildUniform(
  uniform: BufferGeometry[],
  kit: BufferGeometry[],
  P: Record<BoneName, Vector3>,
  section: (y: number) => BodySection,
  def: OperatorDef,
  bulk: number,
  rng: Rng,
) {
  /* --- Combat shirt ---------------------------------------------------- */
  // Modern combat shirts have a stretch torso and hard-wearing sleeves, which
  // is why the torso sits closer to the body than the arms do.
  const shirtBottom = 0.9;
  const shirtTop = 1.5;
  const shirtSection = (y: number): BodySection => {
    const s = section(y);
    // Blouses out over the belt: a shirt tucked flat to the waist reads as a
    // wetsuit, and the hem is the only part of a uniform torso that is visible
    // under armour anyway.
    const hem = clamp((0.98 - y) / 0.08, 0, 1);
    const grow = 0.011 + 0.007 * hem * hem;
    return {
      halfWidth: s.halfWidth + grow,
      halfDepth: s.halfDepth + grow,
      centreZ: s.centreZ,
    };
  };
  uniform.push(lockToTorso(
    verticalLoft(shirtBottom, shirtTop, shirtSection, 22, 18, true, false, null, 'surface'),
  ));

  // Mandarin collar, standing up at the back and open at the front.
  const collarY = 1.44;
  const collar = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const y = lerp(collarY, collarY + 0.052, v);
      const s = shirtSection(collarY + 0.01);
      // Neck radius, not chest radius: the collar wraps the throat.
      const r = 0.068 * lerp(1, bulk, 0.6) + 0.008 + v * 0.004;
      return new Vector3(Math.sin(angle) * r, y, s.centreZ * 0.3 + -Math.cos(angle) * r);
    },
    26,
    3,
    {
      // Open at the front — the gap is where dog tags and the shirt zip show.
      alive: (u) => {
        const angle = u * TAU - Math.PI;
        return (Math.abs(angle) - 0.34) * 0.05;
      },
      edgeWidth: 0.004,
      edgeTint: WHITE,
    },
  );
  if (collar) uniform.push(lockToTorso(collar));

  // Shoulder yoke: a double layer over the traps, the seam of which is the most
  // recognisable line on a combat shirt.
  for (const sx of [-1, 1]) {
    const yoke = wrappedPanel(
      1.35,
      1.45,
      shirtSection,
      sx * 1.05,
      () => 0.5,
      () => 0.001,
      (t) => 0.004 * (0.4 + 0.6 * Math.sin(t * Math.PI)),
      6,
    );
    uniform.push(lockToTorso(yoke));
  }

  /* --- Sleeves --------------------------------------------------------- */
  for (const side of ['L', 'R'] as const) {
    const upperArm = P[`upperArm${side}` as BoneName];
    const lowerArm = P[`lowerArm${side}` as BoneName];
    const hand = P[`hand${side}` as BoneName];
    const sleeveEnd = lowerArm.clone().lerp(hand, def.sleeves === 'rolled' ? -0.05 : 0.92);
    // Everything on the arm is pinned to the arm, sleeve cap included — see
    // `lockChain`. Left to the distance test the cap belongs to the clavicle.
    const chain: Chain = side === 'L' ? 'armL' : 'armR';
    const onArm = (g: BufferGeometry) => lockChain(g, chain);

    // The deltoid gets its own cap in the *uniform* mesh, concentric with the
    // one in the skin mesh and a few millimetres larger, so the two shade as
    // one shoulder rather than as a ball inside a sleeve.
    uniform.push(onArm(ellipsoid(
      upperArm.clone().add(new Vector3(0, -0.03, 0)),
      new Vector3(0.058 * bulk, 0.058, 0.055 * bulk),
      14,
      10,
    )));
    // Starts at the joint and at the cap's own radius, so the two read as one
    // sleeve. Started narrower — or lower down — and the cap sits on top of it
    // as a separate ball, which is the puff-sleeve look of a costume rather
    // than the flat drape of a combat shirt.
    uniform.push(onArm(tube(
      upperArm.clone().add(new Vector3(0, -0.028, 0)),
      lowerArm,
      (t) => {
        const r = lerp(0.056, 0.047, Math.pow(t, 0.7)) * bulk;
        return [r, r * 0.95];
      },
      16,
      6,
      false,
      false,
    )));
    if (def.sleeves === 'full') {
      uniform.push(onArm(tube(
        lowerArm,
        sleeveEnd,
        (t) => {
          const r = lerp(0.05, 0.036, Math.pow(t, 0.8)) * bulk;
          return [r, r * 0.94];
        },
        14,
        5,
        false,
        false,
      )));
      // Buttoned cuff.
      kit.push(onArm(tint(tube(
        sleeveEnd.clone().add(new Vector3(0, 0.014, 0)),
        sleeveEnd,
        () => [0.038 * bulk, 0.036 * bulk],
        14,
        2,
        false,
        true,
      ), STRAP_DARK)));
    } else {
      // Rolled cuff: a thick band of doubled-over fabric just below the elbow,
      // started *above* where the sleeve tube ends so the two overlap. Butt
      // them together instead and the seam opens into a ring of bare arm the
      // moment the elbow bends.
      const rollAt = lowerArm.clone().lerp(hand, 0.1);
      uniform.push(onArm(tube(
        rollAt.clone().add(new Vector3(0, 0.06, 0)),
        rollAt.clone().add(new Vector3(0, -0.022, 0)),
        (t) => {
          const r = (0.05 + 0.008 * Math.sin(t * Math.PI)) * bulk;
          return [r, r * 0.95];
        },
        16,
        5,
        false,
        false,
      )));
    }

    // Elbow reinforcement patch.
    const elbowSign = side === 'L' ? 1 : -1;
    uniform.push(onArm(box(
      lowerArm.clone().add(new Vector3(elbowSign * 0.004, 0.012, 0.04 * bulk)),
      0.066 * bulk,
      0.086,
      0.018,
      0,
      0.2,
    )));

    // Shoulder patch — the squad colour, and the only saturated thing on the
    // uniform. Placed on the outside of the upper arm where it survives being
    // seen from behind.
    const sx = side === 'L' ? 1 : -1;
    kit.push(onArm(tint(box(
      upperArm.clone().add(new Vector3(sx * 0.056 * bulk, -0.05, -0.006)),
      0.008,
      0.05,
      0.038,
      0,
      0,
    ), accentTint(def))));
  }

  /* --- Trousers -------------------------------------------------------- */
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const upLeg = P[`upLeg${side}` as BoneName];
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];

    uniform.push(tube(
      upLeg.clone().add(new Vector3(0, 0.075, 0)),
      lowLeg,
      (t) => {
        const r = lerp(0.1, 0.072, Math.pow(t, 0.8)) * bulk;
        return [r, r * 0.96];
      },
      16,
      7,
      false,
      false,
    ));
    // Below the knee the trouser is bloused into the boot, so it widens again
    // and stops in a gathered cuff rather than tapering to the ankle.
    const bloused = foot.clone().add(new Vector3(0, 0.16, 0));
    uniform.push(tube(
      lowLeg,
      bloused,
      (t) => {
        const r = lerp(0.073, 0.079, smoothstep(t)) * bulk;
        return [r, r * 0.96];
      },
      16,
      6,
      false,
      true,
    ));

    // Cargo pocket on the outside of the thigh, with its flap.
    const thighSection = (y: number): BodySection => {
      const t = clamp((upLeg.y - y) / 0.42, 0, 1);
      const r = lerp(0.1, 0.078, Math.pow(t, 0.8)) * bulk;
      return { halfWidth: r, halfDepth: r * 0.96, centreZ: 0 };
    };
    const pocketTop = upLeg.y - 0.11;
    const pocketBottom = upLeg.y - 0.25;
    const pocket = wrappedPanel(
      pocketBottom,
      pocketTop,
      thighSection,
      sx * (Math.PI / 2) * 0.94,
      () => 0.5,
      () => 0.001,
      (t) => lerp(0.015, 0.009, Math.abs(t - 0.5) * 2),
      6,
    );
    // Placed by the panel's own angle about the leg's axis, so it has to be
    // translated onto the leg it belongs to.
    pocket.translate(upLeg.x, 0, upLeg.z);
    uniform.push(pocket);
    const flap = wrappedPanel(
      pocketTop - 0.03,
      pocketTop + 0.012,
      thighSection,
      sx * (Math.PI / 2) * 0.94,
      () => 0.54,
      () => 0.014,
      () => 0.005,
      4,
    );
    flap.translate(upLeg.x, 0, upLeg.z);
    uniform.push(flap);

    // Knee reinforcement — a doubled panel, which every field trouser has and
    // which reads even when knee pads are worn over it.
    uniform.push(box(
      lowLeg.clone().add(new Vector3(0, 0.03, -0.072 * bulk)),
      0.115 * bulk,
      0.13,
      0.024,
      0,
      -0.12,
    ));
  }

  // Seat and crotch: a short loft closing the top of the legs, so the two
  // trouser tubes are joined by a garment rather than by nothing.
  uniform.push(lockToTorso(verticalLoft(
    P.upLegL.y - 0.06,
    0.995,
    (y) => {
      const s = section(y);
      return { halfWidth: s.halfWidth + 0.014, halfDepth: s.halfDepth + 0.014, centreZ: s.centreZ };
    },
    20,
    5,
    true,
    false,
  )));

  void rng;
}

const accentTint = (def: OperatorDef): Tint => {
  // Vertex tints multiply the kit material's own colour, so an accent has to be
  // divided by that colour to land on the value it was authored as.
  const kitR = ((def.kitTint >> 16) & 255) / 255;
  const kitG = ((def.kitTint >> 8) & 255) / 255;
  const kitB = (def.kitTint & 255) / 255;
  const r = ((def.accent >> 16) & 255) / 255;
  const g = ((def.accent >> 8) & 255) / 255;
  const b = (def.accent & 255) / 255;
  return [r / Math.max(kitR, 0.05), g / Math.max(kitG, 0.05), b / Math.max(kitB, 0.05)];
};

/* ------------------------------------------------------------------ */
/* Armour and load-bearing kit                                         */
/* ------------------------------------------------------------------ */

function buildArmour(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  section: (y: number) => BodySection,
  def: OperatorDef,
  bulk: number,
) {
  const carrier = def.armour === 'carrier';
  const outer = (y: number): BodySection => {
    const s = section(y);
    // Sits over the shirt, which is itself proud of the body.
    return { halfWidth: s.halfWidth + 0.016, halfDepth: s.halfDepth + 0.016, centreZ: s.centreZ };
  };

  const plateTop = 1.4;
  const plateBottom = carrier ? 1.06 : 1.15;

  // Front and rear plate bags. A plate carrier is two flat slabs joined at the
  // shoulders — the flatness is the point, and it is why these are panels
  // wrapped over a narrow angular sector rather than a full band.
  const front = wrappedPanel(
    plateBottom,
    plateTop,
    outer,
    0,
    (t) => lerp(0.62, 0.72, Math.sin(t * Math.PI)),
    () => 0.002,
    (t) => lerp(0.024, 0.03, Math.sin(t * Math.PI)),
    10,
  );
  kit.push(lockToTorso(front));
  if (carrier) {
    kit.push(lockToTorso(wrappedPanel(
      plateBottom,
      plateTop + 0.02,
      outer,
      Math.PI,
      (t) => lerp(0.6, 0.7, Math.sin(t * Math.PI)),
      () => 0.002,
      (t) => lerp(0.022, 0.028, Math.sin(t * Math.PI)),
      10,
    )));
    // Cummerbund: the band round the ribs joining the two plates, with side
    // pockets moulded into it.
    for (const sx of [-1, 1]) {
      kit.push(lockToTorso(tint(wrappedPanel(
        plateBottom + 0.01,
        plateBottom + 0.13,
        outer,
        sx * (Math.PI / 2),
        () => 0.62,
        () => 0.0,
        () => 0.016,
        6,
      ), STRAP)));
    }
  }

  // Shoulder straps, over the yoke from the front plate to the back.
  //
  // Swept with the default up vector, not with +Z. `sweep` builds its frame by
  // projecting `up` off the tangent, and this path's tangent *is* mostly Z — so
  // an up of +Z degenerates, the normal collapses to noise, and the strap
  // renders as a flat board standing off the shoulder like a rank board.
  for (const sx of [-1, 1]) {
    const chestS = outer(1.38);
    const strap = sweep(
      [
        new Vector3(sx * 0.072, plateTop - 0.03, chestS.centreZ - chestS.halfDepth - 0.014),
        new Vector3(sx * 0.094, plateTop + 0.042, chestS.centreZ - chestS.halfDepth * 0.5),
        new Vector3(sx * 0.098, plateTop + 0.048, chestS.centreZ + chestS.halfDepth * 0.5),
        new Vector3(sx * 0.072, plateTop - 0.02, chestS.centreZ + chestS.halfDepth + 0.014),
      ],
      (t) => [0.036 * (0.8 + 0.2 * Math.sin(t * Math.PI)), 0.011],
      16,
      8,
    );
    kit.push(lockToTorso(tint(strap, STRAP)));
  }

  /* --- What is mounted on the front ------------------------------------ */
  const frontS = outer(1.24);
  const frontZ = frontS.centreZ - frontS.halfDepth - 0.03;
  const magPouch = (x: number, y: number, w: number, h: number, d: number) => {
    kit.push(lockToTorso(box(new Vector3(x, y, frontZ - d / 2), w, h, d)));
    // Flap with a pull tab, the thing that actually reads as "magazine pouch".
    kit.push(lockToTorso(tint(box(new Vector3(x, y + h / 2 - 0.008, frontZ - d - 0.004), w * 1.02, 0.032, 0.01), STRAP)));
    kit.push(lockToTorso(tint(box(new Vector3(x, y + h / 2 - 0.03, frontZ - d - 0.008), w * 0.28, 0.02, 0.006), BUCKLE)));
  };

  // Three rifle magazines across the middle of the chest, which is the single
  // most recognisable feature of a modern soldier's front.
  const pouchY = 1.18;
  for (let i = 0; i < 3; i++) {
    magPouch((i - 1) * 0.078, pouchY, 0.06, 0.115, 0.038);
  }

  if (carrier) {
    // Admin pouch high on the left of the chest, radio on the right.
    kit.push(lockToTorso(box(new Vector3(0.086, 1.325, frontZ - 0.018), 0.09, 0.075, 0.03)));
    kit.push(lockToTorso(tint(box(new Vector3(0.086, 1.352, frontZ - 0.034), 0.088, 0.026, 0.008), STRAP)));
  }
  if (def.radio) {
    hard.push(lockToTorso(tint(box(new Vector3(-0.088, 1.322, frontZ - 0.022), 0.07, 0.11, 0.042), RUBBER)));
    // Antenna: a long whip with a slight bend, the best long-range silhouette
    // cue on the whole model.
    const base = new Vector3(-0.088, 1.382, frontZ - 0.022);
    hard.push(tint(sweep(
      [
        base,
        base.clone().add(new Vector3(-0.012, 0.12, 0.02)),
        base.clone().add(new Vector3(-0.028, 0.24, 0.055)),
        base.clone().add(new Vector3(-0.05, 0.33, 0.1)),
      ],
      (t) => [lerp(0.0042, 0.0018, t), lerp(0.0042, 0.0018, t)],
      12,
      5,
    ), RUBBER));
    // Coiled handset cable running back to the shoulder.
    hard.push(tint(sweep(
      [
        base.clone().add(new Vector3(0.006, -0.01, 0)),
        new Vector3(-0.06, 1.36, frontZ + 0.02),
        new Vector3(-0.09, 1.4, frontZ + 0.06),
      ],
      () => [0.0038, 0.0038],
      10,
      5,
    ), RUBBER));
  }

  // Name tape across the top of the front plate.
  kit.push(lockToTorso(tint(box(new Vector3(0, 1.372, frontZ - 0.008), 0.1, 0.018, 0.005), STRAP_DARK)));
  // Squad-colour identification panel — the in-game "which teammate is that".
  kit.push(lockToTorso(tint(box(new Vector3(0, 1.083, frontZ - 0.012), 0.052, 0.03, 0.006), accentTint(def))));

  /* --- What is mounted on the back ------------------------------------- */
  if (carrier) {
    const backS = outer(1.2);
    const backZ = backS.centreZ + backS.halfDepth + 0.03;
    // Hydration bladder: a big soft slab, which is what fills out the back of a
    // loaded carrier and stops the character reading as flat from behind.
    kit.push(lockToTorso(box(new Vector3(0, 1.24, backZ + 0.026), 0.2, 0.26, 0.05)));
    // Drink tube over the left shoulder.
    kit.push(lockToTorso(tint(sweep(
      [
        new Vector3(0.04, 1.36, backZ + 0.02),
        new Vector3(0.1, 1.44, backZ - 0.02),
        new Vector3(0.095, 1.4, backZ - 0.13),
        new Vector3(0.07, 1.32, backZ - 0.17),
      ],
      () => [0.0055, 0.0055],
      14,
      6,
    ), RUBBER)));
    if (def.accent) {
      // IR identification square, top centre of the back.
      kit.push(lockToTorso(tint(box(new Vector3(0, 1.352, backZ + 0.05), 0.05, 0.05, 0.006), accentTint(def))));
    }
  }
  if (def.dumpPouch) {
    const s = outer(1.02);
    kit.push(lockToTorso(tint(tube(
      new Vector3(-0.14 * bulk, 1.02, s.centreZ + 0.05),
      new Vector3(-0.15 * bulk, 0.9, s.centreZ + 0.06),
      (t) => [lerp(0.055, 0.062, Math.sin(t * Math.PI)), lerp(0.045, 0.05, Math.sin(t * Math.PI))],
      12,
      5,
    ), STRAP)));
  }

  // Sling: over the left shoulder, across the chest, terminating at a clip on
  // the carrier rather than reaching for a weapon that moves.
  const slingS = outer(1.3);
  kit.push(lockToTorso(tint(sweep(
    [
      new Vector3(0.08, 1.4, slingS.centreZ + slingS.halfDepth + 0.02),
      new Vector3(0.112, 1.44, slingS.centreZ),
      new Vector3(0.086, 1.39, slingS.centreZ - slingS.halfDepth - 0.02),
      new Vector3(0.0, 1.27, slingS.centreZ - slingS.halfDepth - 0.05),
      new Vector3(-0.07, 1.18, slingS.centreZ - slingS.halfDepth - 0.045),
    ],
    (t) => [lerp(0.014, 0.011, t), 0.004],
    18,
    6,
  ), STRAP_DARK)));
}

function buildBelt(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  P: Record<BoneName, Vector3>,
  section: (y: number) => BodySection,
  def: OperatorDef,
  bulk: number,
) {
  const beltY = 0.985;
  const s = section(beltY);
  const beltR = (a: number) => new Vector3(
    Math.sin(a) * (s.halfWidth + 0.024),
    beltY,
    s.centreZ - Math.cos(a) * (s.halfDepth + 0.024),
  );
  const ring: Vector3[] = [];
  for (let i = 0; i <= 16; i++) ring.push(beltR((i / 16) * TAU - Math.PI));
  kit.push(lockToTorso(tint(sweep(ring, () => [0.011, 0.023], 30, 6), STRAP)));
  hard.push(lockToTorso(tint(box(beltR(0).add(new Vector3(0, 0, -0.006)), 0.052, 0.04, 0.014), BUCKLE)));

  // Utility pouches on the belt, behind the hips where a carrier's cummerbund
  // is not already in the way.
  for (const sx of [-1, 1]) {
    const at = beltR(sx * 2.3);
    kit.push(lockToTorso(box(at.clone().add(new Vector3(0, -0.03, 0)), 0.07, 0.075, 0.05)));
  }

  if (def.thighHolster) {
    // Drop-leg holster on the right thigh: platform, holster body, and the two
    // leg straps that stop it reading as a box glued to the trousers.
    const thigh = P.upLegR.clone().add(new Vector3(-0.075 * bulk, -0.15, 0.006));
    kit.push(box(thigh, 0.03, 0.15, 0.09));
    hard.push(tint(box(thigh.clone().add(new Vector3(-0.015, 0.01, -0.012)), 0.05, 0.13, 0.075), RUBBER));
    // The pistol butt, showing above the holster mouth.
    hard.push(tint(box(
      thigh.clone().add(new Vector3(-0.016, 0.086, -0.006)),
      0.028,
      0.05,
      0.05,
      0,
      0.25,
    ), [0.4, 0.4, 0.42]));
    for (let i = 0; i < 2; i++) {
      const y = thigh.y - 0.045 - i * 0.055;
      const strapPts: Vector3[] = [];
      for (let k = 0; k <= 10; k++) {
        const a = (k / 10) * TAU - Math.PI;
        const r = 0.098 * bulk;
        strapPts.push(new Vector3(P.upLegR.x + Math.sin(a) * r, y, Math.cos(a) * r));
      }
      kit.push(tint(sweep(strapPts, () => [0.006, 0.014], 20, 5), STRAP_DARK));
    }
  }
}

function buildKneePads(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  P: Record<BoneName, Vector3>,
  bulk: number,
) {
  for (const side of ['L', 'R'] as const) {
    const lowLeg = P[`lowLeg${side}` as BoneName];
    // Sits *on* the knee, not in front of it: the trouser at this height is
    // 0.073 across, so a pad centred much beyond that floats off the leg.
    const centre = lowLeg.clone().add(new Vector3(0, 0.026, -0.074 * bulk));
    hard.push(tint(ellipsoid(centre, new Vector3(0.05 * bulk, 0.062, 0.024), 14, 10), RUBBER));
    // Ribs across the cap.
    for (let i = -1; i <= 1; i++) {
      hard.push(tint(box(
        centre.clone().add(new Vector3(0, i * 0.022, -0.012)),
        0.062 * bulk,
        0.01,
        0.01,
      ), RUBBER));
    }
    // Elastic retention straps behind the knee.
    for (let i = 0; i < 2; i++) {
      const y = centre.y - 0.026 + i * 0.056;
      const pts: Vector3[] = [];
      for (let k = 0; k <= 10; k++) {
        const a = (k / 10) * TAU - Math.PI;
        const r = 0.075 * bulk;
        pts.push(new Vector3(lowLeg.x + Math.sin(a) * r, y, -Math.cos(a) * r * 0.9));
      }
      kit.push(tint(sweep(pts, () => [0.005, 0.012], 18, 5), STRAP_DARK));
    }
  }
}

function buildBoots(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  P: Record<BoneName, Vector3>,
  toeL: Vector3,
  toeR: Vector3,
  bulk: number,
) {
  for (const side of ['L', 'R'] as const) {
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];
    const toe = side === 'L' ? toeL : toeR;

    // Shaft, up over the ankle and over the bloused trouser cuff.
    kit.push(tint(tube(
      foot.clone().add(new Vector3(0, 0.03, 0.006)),
      foot.clone().lerp(lowLeg, 0.42),
      (t) => [lerp(0.062, 0.072, t) * bulk, lerp(0.058, 0.066, t) * bulk],
      14,
      5,
      false,
      false,
    ), LEATHER));
    // Vamp and toe box.
    kit.push(tint(tube(
      foot.clone().add(new Vector3(0, 0.072, 0.012)),
      toe.clone().add(new Vector3(0, 0.008, -0.012)),
      (t) => [lerp(0.055, 0.042, t), lerp(0.053, 0.033, t)],
      14,
      6,
    ), LEATHER));
    // Toe cap — a separate, harder panel, which is what a combat boot has.
    hard.push(tint(tube(
      toe.clone().add(new Vector3(0, 0.012, 0.03)),
      toe.clone().add(new Vector3(0, 0.006, -0.014)),
      (t) => [lerp(0.045, 0.036, t), lerp(0.04, 0.03, t)],
      12,
      3,
    ), [0.5, 0.46, 0.42]));
    // Sole: a slab with a heel block and a lugged edge. Kept just inside the
    // upper's own width — a sole wider than the boot it is on reads as a clown
    // shoe from every angle that matters.
    hard.push(tint(tube(
      foot.clone().add(new Vector3(0, -0.012, 0.022)),
      toe.clone().add(new Vector3(0, -0.012, -0.006)),
      (t) => [lerp(0.05, 0.036, t), 0.013],
      12,
      5,
    ), RUBBER));
    hard.push(tint(box(
      foot.clone().add(new Vector3(0, -0.018, 0.026)),
      0.086 * bulk,
      0.022,
      0.056,
    ), RUBBER));

    // Speed laces: three bands across the instep, with eyelet blocks.
    for (let l = 0; l < 3; l++) {
      const at = foot.clone().add(new Vector3(0, 0.052 + l * 0.03, -0.028 + l * 0.012));
      kit.push(tint(sweep(
        [
          new Vector3(at.x - 0.044, at.y, at.z + 0.006),
          new Vector3(at.x, at.y + 0.004, at.z - 0.03),
          new Vector3(at.x + 0.044, at.y, at.z + 0.006),
        ],
        () => [0.0045, 0.0035],
        10,
        5,
      ), STRAP_DARK));
      for (const sx of [-1, 1]) {
        hard.push(tint(box(
          new Vector3(at.x + sx * 0.042, at.y, at.z + 0.004),
          0.008,
          0.008,
          0.008,
        ), BUCKLE));
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Headgear                                                            */
/* ------------------------------------------------------------------ */

function buildHeadgear(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  centre: Vector3,
  def: OperatorDef,
  P: Record<BoneName, Vector3>,
) {
  switch (def.headgear) {
    case 'helmet':
      buildHelmet(kit, hard, centre, def);
      break;
    case 'boonie':
      buildBoonie(kit, centre);
      break;
    case 'patrolCap':
      buildPatrolCap(kit, hard, centre, def);
      break;
    case 'headset':
      break;
  }
  if (def.headsetRig) buildHeadset(kit, hard, centre, def.headgear === 'patrolCap');
  void P;
}

/**
 * Ballistic helmet.
 *
 * The shape that matters is the cut: a high cut leaves the ear exposed and the
 * shell's lower edge runs from the brow up over the ear and back down to the
 * nape. Getting that curve right is the difference between a helmet and a
 * bowl, so the edge is authored as a function of the angle round the head and
 * handed to the ragged-surface shrink-wrap.
 */
function buildHelmet(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  centre: Vector3,
  def: OperatorDef,
) {
  // Sphere latitude of the shell's lower edge, per angle round the head.
  //
  // The front edge has to clear the brow — the eyes are at latitude -0.12 and a
  // rim below that is a blindfold, which is exactly what the first pass drew.
  // From there it dips over the temple, sweeps *up* into the high-cut ear
  // scallop, and drops lowest at the nape.
  const rim = (angle: number) => {
    const front = clamp(Math.cos(angle), 0, 1);
    const back = clamp(-Math.cos(angle), 0, 1);
    const side = Math.abs(Math.sin(angle));
    const scallop = gaussian(side - 1, 0.34) * 0.34;
    return 0.16 * front - 0.14 * side * side - 0.34 * back * back + scallop;
  };
  const shell = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const h = lerp(rim(angle), 0.998, Math.pow(v, 0.72));
      // The shell stands off the skull by the pad thickness, and more at the
      // sides than the top, because that is where the pads actually are.
      const stand = 0.014 + 0.006 * Math.abs(Math.sin(angle)) * (1 - v);
      return headWorld(h, angle, stand, centre);
    },
    34,
    9,
    { edgeWidth: 0.005, edgeTint: WHITE },
  );
  if (shell) hard.push(shell);

  // Rolled edge: a bead round the rim, which is what gives the silhouette its
  // weight and catches the rim light that makes a helmet read as hard.
  const rimPts: Vector3[] = [];
  for (let i = 0; i <= 26; i++) {
    const angle = (i / 26) * TAU - Math.PI;
    rimPts.push(headWorld(rim(angle), angle, 0.0155, centre));
  }
  hard.push(sweep(rimPts, () => [0.005, 0.005], 40, 6));

  // Cover: a fabric skin over the shell, cut just short of the rim, with the
  // seam down the middle. Cloth over composite is the reason a real helmet is
  // matt in the middle and shiny at the edge.
  const cover = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const h = lerp(rim(angle) + 0.06, 0.998, Math.pow(v, 0.72));
      return headWorld(h, angle, 0.0205 + 0.004 * (1 - v), centre);
    },
    32,
    8,
    { edgeWidth: 0.005, edgeTint: WHITE },
  );
  if (cover) kit.push(cover);

  // Side rails.
  for (const sx of [-1, 1]) {
    const railPts: Vector3[] = [];
    for (let i = 0; i <= 5; i++) {
      const a = sx * lerp(0.75, 2.35, i / 5);
      railPts.push(headWorld(rim(a) + 0.14, a, 0.026, centre));
    }
    hard.push(tint(sweep(railPts, () => [0.006, 0.011], 12, 5), RUBBER));
  }

  // NVG shroud on the brow — the single most recognisable helmet feature.
  const brow = headWorld(0.26, 0, 0.03, centre);
  hard.push(tint(box(brow, 0.05, 0.03, 0.024, 0, 0.35), RUBBER));
  hard.push(tint(box(brow.clone().add(new Vector3(0, 0.016, -0.014)), 0.026, 0.026, 0.03, 0, 0.2), RUBBER));

  // Counterweight pouch at the back, and the bungee over the top that holds it.
  const backAt = headWorld(-0.1, Math.PI, 0.026, centre);
  kit.push(tint(box(backAt, 0.09, 0.06, 0.05), STRAP));
  const bungee: Vector3[] = [];
  for (let i = 0; i <= 5; i++) {
    const h = lerp(-0.05, 0.95, i / 5);
    bungee.push(headWorld(h, Math.PI, 0.028, centre));
  }
  kit.push(tint(sweep(bungee, () => [0.004, 0.004], 12, 5), STRAP_DARK));

  // Chin strap: down past the ear and under the jaw, with the cup on the chin.
  for (const sx of [-1, 1]) {
    const top = headWorld(rim(sx * 1.5) + 0.05, sx * 1.5, 0.02, centre);
    const jaw = centre.clone().add(new Vector3(sx * 0.03, -0.115, -0.03));
    kit.push(tint(sweep(
      [top, top.clone().lerp(jaw, 0.5).add(new Vector3(sx * 0.006, 0, 0.004)), jaw],
      () => [0.0035, 0.009],
      10,
      5,
    ), STRAP_DARK));
  }
  kit.push(tint(box(
    centre.clone().add(new Vector3(0, -0.118, -0.046)),
    0.05,
    0.03,
    0.026,
    0,
    -0.3,
  ), STRAP));

  // Squad-colour band round the back of the shell.
  const bandPts: Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + lerp(-0.9, 0.9, i / 10);
    bandPts.push(headWorld(rim(a) + 0.22, a, 0.024, centre));
  }
  kit.push(tint(sweep(bandPts, () => [0.005, 0.014], 16, 5), accentTint(def)));
}

/**
 * Boonie hat. The brim is the whole point: a wide, soft, drooping annulus that
 * breaks up the head's outline, which is exactly what the hat is for and what
 * makes it legible at any range.
 */
function buildBoonie(kit: BufferGeometry[], centre: Vector3) {
  const brimStart = -0.22;

  const crown = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const h = lerp(brimStart, 0.995, Math.pow(v, 0.8));
      // A boonie crown is soft and slumps: it stands off the skull further at
      // the top than at the band, and it is not a hemisphere.
      const stand = 0.008 + 0.026 * Math.pow(v, 1.4);
      return headWorld(h, angle, stand, centre);
    },
    30,
    8,
    { edgeWidth: 0.005, edgeTint: WHITE },
  );
  if (crown) kit.push(crown);

  // Brim: sweeps out from the band and droops, more at the front and back than
  // at the sides — which is how a boonie is actually worn and shaped.
  const band = (angle: number) => headWorld(brimStart, angle, 0.01, centre);
  const brim = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const at = band(angle);
      const front = Math.abs(Math.cos(angle));
      const width = 0.062 + 0.026 * front;
      const droop = (0.03 + 0.03 * front) * v * v;
      const out = width * v;
      return new Vector3(
        at.x + Math.sin(angle) * out,
        at.y - droop + 0.004,
        at.z - Math.cos(angle) * out,
      );
    },
    34,
    5,
    { edgeWidth: 0.006, edgeTint: WHITE },
  );
  if (brim) {
    displaceAlongNormals(brim, 0x77a1, 0.004, 14);
    brim.computeVertexNormals();
    kit.push(brim);
  }

  // Band round the base of the crown, and the branch loops sewn into it.
  const bandPts: Vector3[] = [];
  for (let i = 0; i <= 20; i++) bandPts.push(band((i / 20) * TAU - Math.PI));
  kit.push(tint(sweep(bandPts, () => [0.006, 0.013], 30, 5), STRAP));

  // Chin cord, hanging slack under the jaw.
  const left = headWorld(brimStart + 0.05, 1.5, 0.008, centre);
  const right = headWorld(brimStart + 0.05, -1.5, 0.008, centre);
  kit.push(tint(sweep(
    [left, new Vector3(0, centre.y - 0.16, centre.z - 0.02), right],
    () => [0.0028, 0.0028],
    14,
    5,
  ), STRAP_DARK));
}

/** Patrol cap: a soft flat-topped crown and a short stiff bill. */
function buildPatrolCap(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  centre: Vector3,
  def: OperatorDef,
) {
  const bandH = -0.2;
  const crown = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const h = lerp(bandH, 0.99, Math.pow(v, 0.65));
      // Flat-topped: the stand-off grows quickly and then stops, so the crown
      // has a defined top edge rather than a dome.
      const stand = 0.008 + 0.02 * smoothstep(clamp(v * 1.5, 0, 1));
      return headWorld(h, angle, stand, centre);
    },
    28,
    7,
    { edgeWidth: 0.005, edgeTint: WHITE },
  );
  if (crown) kit.push(crown);

  const bandPts: Vector3[] = [];
  for (let i = 0; i <= 20; i++) bandPts.push(headWorld(bandH, (i / 20) * TAU - Math.PI, 0.01, centre));
  kit.push(tint(sweep(bandPts, () => [0.006, 0.012], 28, 5), STRAP));

  // Bill: short, curved down, and stiff — so it is on the hard material.
  const front = headWorld(bandH, 0, 0.012, centre);
  const bill = raggedSurface(
    (u, v) => {
      const angle = lerp(-0.95, 0.95, u);
      const at = headWorld(bandH, angle, 0.01, centre);
      const out = 0.062 * v * (1 - 0.35 * Math.abs(Math.sin(angle)));
      return new Vector3(
        at.x + Math.sin(angle) * out * 0.5,
        at.y - 0.006 - 0.022 * v * v,
        at.z - Math.cos(angle) * out,
      );
    },
    18,
    4,
    { edgeWidth: 0.005, edgeTint: WHITE },
  );
  if (bill) hard.push(bill);
  void front;

  // Squad colour on the front panel.
  kit.push(tint(box(
    headWorld(bandH + 0.4, 0, 0.028, centre),
    0.03,
    0.022,
    0.008,
    0,
    0.2,
  ), accentTint(def)));

  if (def.goggles) {
    // Goggles pushed up onto the crown — the classic engineer's tell, and a
    // second hard-edged band that stops a soft cap reading as a beanie.
    const strapPts: Vector3[] = [];
    for (let i = 0; i <= 20; i++) {
      const angle = (i / 20) * TAU - Math.PI;
      strapPts.push(headWorld(0.16, angle, 0.03, centre));
    }
    kit.push(tint(sweep(strapPts, () => [0.007, 0.013], 28, 5), STRAP_DARK));
    const lensAt = headWorld(0.1, 0, 0.036, centre);
    hard.push(tint(box(lensAt, 0.13, 0.042, 0.03, 0, 0.5), RUBBER));
    hard.push(tint(box(
      lensAt.clone().add(new Vector3(0, 0.004, -0.014)),
      0.115,
      0.028,
      0.012,
      0,
      0.5,
    ), GLASS));
  }
}

/** Comms headset: ear cups, headband and a boom mic. */
function buildHeadset(
  kit: BufferGeometry[],
  hard: BufferGeometry[],
  centre: Vector3,
  singleEar: boolean,
) {
  const earY = -0.03;
  const sides: number[] = singleEar ? [-1] : [-1, 1];
  for (const sx of sides) {
    const x = sx * (skullSideX(earY) * HEAD_SCALE + 0.024);
    const at = new Vector3(centre.x + x, centre.y + earY * HEAD_SCALE, centre.z + 0.014);
    hard.push(tint(ellipsoid(at, new Vector3(0.017, 0.042, 0.036), 14, 10), RUBBER));
    // Foam cushion against the head, softer and wider than the cup.
    kit.push(tint(ellipsoid(
      at.clone().add(new Vector3(-sx * 0.012, 0, 0)),
      new Vector3(0.009, 0.046, 0.04),
      12,
      8,
    ), STRAP_DARK));
    // Arm connecting the cup to the band.
    hard.push(tint(sweep(
      [
        at.clone().add(new Vector3(0, 0.04, 0)),
        at.clone().add(new Vector3(-sx * 0.008, 0.075, -0.002)),
      ],
      () => [0.006, 0.009],
      6,
      5,
    ), RUBBER));
  }

  if (!singleEar) {
    // Band over the crown, behind the vertex so it does not fight a hat.
    const bandPts: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const angle = lerp(1.55, -1.55, t);
      bandPts.push(headWorld(lerp(0.15, 0.94, Math.sin(t * Math.PI)), angle, 0.014, centre));
    }
    hard.push(tint(sweep(bandPts, (t) => {
      const w = 0.006 + 0.004 * Math.sin(t * Math.PI);
      return [w, 0.011];
    }, 16, 6), RUBBER));
  } else {
    // Single-ear rigs hook over the head on a thin wire.
    const wire: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      wire.push(headWorld(lerp(-0.05, 0.86, Math.sin(t * Math.PI * 0.5)), lerp(-1.5, -0.2, t), 0.012, centre));
    }
    hard.push(tint(sweep(wire, () => [0.0035, 0.0035], 12, 5), RUBBER));
  }

  // Boom mic, swinging round to the corner of the mouth.
  const from = new Vector3(
    centre.x - (skullSideX(earY) * HEAD_SCALE + 0.028),
    centre.y + earY * HEAD_SCALE - 0.012,
    centre.z + 0.006,
  );
  const to = centre.clone().add(new Vector3(-0.028, -0.072, -0.062));
  hard.push(tint(sweep(
    [from, from.clone().lerp(to, 0.5).add(new Vector3(-0.014, -0.006, 0)), to],
    () => [0.0032, 0.0032],
    12,
    5,
  ), RUBBER));
  hard.push(tint(ellipsoid(to, new Vector3(0.009, 0.008, 0.009), 10, 8), RUBBER));
}

/**
 * Shemagh: worn round the neck and pulled up over the nose, which changes the
 * head's outline more than any amount of face detail and is why the recon
 * operator reads differently at fifty metres.
 */
function buildShemagh(
  kit: BufferGeometry[],
  centre: Vector3,
  P: Record<BoneName, Vector3>,
  neckTop: number,
  bulk: number,
) {
  // The mask: a band round the lower face, from the bridge of the nose down.
  const mask = raggedSurface(
    (u, v) => {
      const angle = u * TAU - Math.PI;
      const h = lerp(-0.92, -0.18, v);
      return headWorld(h, angle, 0.009 + 0.004 * (1 - v), centre);
    },
    30,
    7,
    {
      // Cut away at the back — the mask covers the face, the rest is neck.
      alive: (u, v) => {
        const angle = u * TAU - Math.PI;
        const facing = Math.cos(angle);
        // Higher at the front (over the nose), lower at the sides.
        const top = -0.3 - 0.42 * clamp(-facing, 0, 1) + 0.16 * clamp(facing, 0, 1);
        const h = lerp(-0.92, -0.18, v);
        return (top - h) * 0.05 * (facing > -0.35 ? 1 : -1);
      },
      edgeWidth: 0.006,
      edgeTint: WHITE,
    },
  );
  if (mask) {
    displaceAlongNormals(mask, 0x1b5d, 0.003, 22);
    mask.computeVertexNormals();
    kit.push(mask);
  }

  // The bulk of the scarf, bunched around the neck and shoulders.
  const collarTop = neckTop - 0.02;
  const collarBottom = P.chest.y + 0.1;
  const wrap = verticalLoft(
    collarBottom,
    collarTop,
    (y) => {
      const t = clamp((y - collarBottom) / (collarTop - collarBottom), 0, 1);
      const r = lerp(0.098, 0.076, smoothstep(t)) * lerp(1, bulk, 0.5);
      return { halfWidth: r, halfDepth: r * 0.94, centreZ: 0.002 };
    },
    20,
    6,
    false,
    false,
  );
  displaceAlongNormals(wrap, 0x2c6e, 0.007, 16);
  wrap.computeVertexNormals();
  kit.push(lockToTorso(wrap));

  // A loose tail hanging down the back.
  const tail = raggedSurface(
    (u, v) => new Vector3(
      lerp(-0.06, 0.06, u) * (1 + v * 0.5),
      lerp(collarBottom + 0.02, collarBottom - 0.16, v),
      0.1 + v * 0.03 + Math.sin(u * Math.PI) * 0.012,
    ),
    8,
    6,
    { edgeWidth: 0.006, edgeTint: WHITE },
  );
  if (tail) {
    displaceAlongNormals(tail, 0x4f2a, 0.006, 18);
    tail.computeVertexNormals();
    kit.push(lockToTorso(tail));
  }
}

/** Frees every GPU resource owned by a rig. Shared base materials are left alone. */
export function disposeSoldierRig(rig: SoldierRig) {
  for (const mesh of [rig.skin, rig.uniform, rig.gear, rig.hard]) {
    mesh.geometry.dispose();
    (mesh.material as Material).dispose();
  }
  rig.root.clear();
}
