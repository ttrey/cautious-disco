import {
  Bone,
  DoubleSide,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Material,
  Matrix4,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { mergeAll } from '../util/geometry';
import { makeSurface } from '../assets/Materials';
import { Rng, TAU, clamp, lerp, makeFbm, smoothstep } from '../util/math';

/**
 * Procedural zombie construction.
 *
 * The brief is explicit that zombies must read as decaying humans rather than
 * low-poly mannequins, so the body is built as a genuinely skinned character:
 *
 *  - A 19-bone humanoid skeleton with real proportions (1.75 m, eight heads).
 *  - Limbs and torso are *tapered elliptical tubes* with hand-authored radius
 *    profiles — a human forearm is not a cylinder, and a torso is not a box.
 *  - The skull is a displaced sphere: brow ridge, sunken eye sockets, hollow
 *    cheeks, receded jaw. Sunken sockets are the single strongest read for
 *    "corpse" at gameplay distance.
 *  - Automatic skin weighting by distance to bone segments, so joints deform
 *    smoothly instead of shearing.
 *  - Per-seed variation in height, build, posture and decay so a horde doesn't
 *    look like one model repeated.
 *
 * Skin, clothing and gear are three SkinnedMeshes sharing one skeleton, which
 * keeps the material split clean without needing geometry groups.
 */

export type BoneName =
  | 'hips' | 'spine' | 'chest' | 'neck' | 'head'
  | 'clavicleL' | 'upperArmL' | 'lowerArmL' | 'handL'
  | 'clavicleR' | 'upperArmR' | 'lowerArmR' | 'handR'
  | 'upLegL' | 'lowLegL' | 'footL'
  | 'upLegR' | 'lowLegR' | 'footR';

interface BoneSpec {
  name: BoneName;
  parent: BoneName | null;
  pos: [number, number, number];
}

/** Bind-pose skeleton. Y-up, facing -Z, arms hanging at the sides. */
const SKELETON: BoneSpec[] = [
  { name: 'hips', parent: null, pos: [0, 1.0, 0] },
  { name: 'spine', parent: 'hips', pos: [0, 0.17, 0] },
  { name: 'chest', parent: 'spine', pos: [0, 0.18, 0] },
  { name: 'neck', parent: 'chest', pos: [0, 0.17, 0] },
  { name: 'head', parent: 'neck', pos: [0, 0.08, 0] },

  { name: 'clavicleL', parent: 'chest', pos: [0.045, 0.1, 0] },
  { name: 'upperArmL', parent: 'clavicleL', pos: [0.135, -0.02, 0] },
  { name: 'lowerArmL', parent: 'upperArmL', pos: [0, -0.28, 0] },
  { name: 'handL', parent: 'lowerArmL', pos: [0, -0.26, 0] },

  { name: 'clavicleR', parent: 'chest', pos: [-0.045, 0.1, 0] },
  { name: 'upperArmR', parent: 'clavicleR', pos: [-0.135, -0.02, 0] },
  { name: 'lowerArmR', parent: 'upperArmR', pos: [0, -0.28, 0] },
  { name: 'handR', parent: 'lowerArmR', pos: [0, -0.26, 0] },

  { name: 'upLegL', parent: 'hips', pos: [0.095, -0.05, 0] },
  { name: 'lowLegL', parent: 'upLegL', pos: [0, -0.45, 0] },
  { name: 'footL', parent: 'lowLegL', pos: [0, -0.46, 0] },

  { name: 'upLegR', parent: 'hips', pos: [-0.095, -0.05, 0] },
  { name: 'lowLegR', parent: 'upLegR', pos: [0, -0.45, 0] },
  { name: 'footR', parent: 'lowLegR', pos: [0, -0.46, 0] },
];

export interface ZombieRig {
  root: Group;
  bones: Record<BoneName, Bone>;
  boneList: Bone[];
  skeleton: Skeleton;
  skin: SkinnedMesh;
  clothes: SkinnedMesh;
  /** Boots and belt — shared dark leather material. */
  gear: SkinnedMesh;
  /** Bind-pose world positions, used for hitbox construction. */
  bindPositions: Record<BoneName, Vector3>;
  /** Overall scale applied to this variant. */
  height: number;
}

/* ------------------------------------------------------------------ */
/* Geometry primitives                                                 */
/* ------------------------------------------------------------------ */

/** Texture tiles per metre of body surface. Keeps pores and weave consistent. */
const UV_SCALE = 3.2;

/**
 * Tapered elliptical tube between two points.
 *
 * `profile(t)` returns [radiusX, radiusZ] at parameter t along the segment,
 * which is what lets a forearm swell at the elbow and narrow at the wrist.
 */
function tube(
  a: Vector3,
  b: Vector3,
  profile: (t: number) => [number, number],
  radial = 14,
  rings = 8,
  capA = true,
  capB = true,
  twist = 0,
): BufferGeometry {
  // UVs are laid out in metres (circumference across, length along) and scaled
  // by UV_SCALE at the end. Box projection was tried first and produced visible
  // rectangular seams wherever the dominant normal axis flipped, which on a
  // curved body is everywhere.
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const axis = new Vector3().subVectors(b, a);
  const length = axis.length();
  axis.normalize();
  // Build an orthonormal frame around the segment.
  const up = Math.abs(axis.y) > 0.95 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(up, axis).normalize();
  const fwd = new Vector3().crossVectors(axis, right).normalize();

  const ringCount = rings + 1;
  for (let i = 0; i < ringCount; i++) {
    const t = i / rings;
    const [rx, rz] = profile(t);
    const centre = new Vector3().copy(a).addScaledVector(axis, length * t);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * TAU + twist * t;
      const x = Math.cos(ang) * rx;
      const z = Math.sin(ang) * rz;
      positions.push(
        centre.x + right.x * x + fwd.x * z,
        centre.y + right.y * x + fwd.y * z,
        centre.z + right.z * x + fwd.z * z,
      );
      uvs.push((j / radial) * TAU * ((rx + rz) * 0.5) * UV_SCALE, t * length * UV_SCALE);
    }
  }

  // Winding is chosen so face normals point outward: with the frame
  // (right, fwd, axis) right-handed, (p0,p1,p2) yields +right at theta=0.
  const stride = radial + 1;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const p0 = i * stride + j;
      const p1 = p0 + 1;
      const p2 = p0 + stride;
      const p3 = p2 + 1;
      indices.push(p0, p1, p2, p1, p3, p2);
    }
  }

  // Domed caps rather than flat discs — flat caps show as hard discs on the
  // shoulders and hips under any grazing light.
  const addCap = (atStart: boolean) => {
    const t = atStart ? 0 : 1;
    const [rx, rz] = profile(t);
    const centre = new Vector3().copy(a).addScaledVector(axis, length * t);
    const domeH = Math.max(rx, rz) * 0.85 * (atStart ? -1 : 1);
    const apex = new Vector3().copy(centre).addScaledVector(axis, domeH);
    const steps = 3;
    const baseIndex = positions.length / 3;
    for (let s = 1; s <= steps; s++) {
      const k = s / steps;
      const shrink = Math.cos((k * Math.PI) / 2);
      const lift = Math.sin((k * Math.PI) / 2);
      for (let j = 0; j <= radial; j++) {
        const ang = (j / radial) * TAU;
        const x = Math.cos(ang) * rx * shrink;
        const z = Math.sin(ang) * rz * shrink;
        const c = new Vector3().copy(centre).lerp(apex, lift);
        positions.push(
          c.x + right.x * x + fwd.x * z,
          c.y + right.y * x + fwd.y * z,
          c.z + right.z * x + fwd.z * z,
        );
        uvs.push(
          (j / radial) * TAU * ((rx + rz) * 0.5) * UV_SCALE,
          (t * length + (atStart ? -k * domeH : k * domeH)) * UV_SCALE,
        );
      }
    }
    const ringStart = atStart ? 0 : rings * stride;
    for (let s = 0; s < steps; s++) {
      const cur = s === 0 ? ringStart : baseIndex + (s - 1) * stride;
      const next = baseIndex + s * stride;
      for (let j = 0; j < radial; j++) {
        // The start cap's dome runs along -axis, so its winding is the mirror
        // of the end cap's.
        if (atStart) indices.push(cur + j, next + j, cur + j + 1, cur + j + 1, next + j, next + j + 1);
        else indices.push(cur + j, cur + j + 1, next + j, cur + j + 1, next + j + 1, next + j);
      }
    }
  };
  if (capA) addCap(true);
  if (capB) addCap(false);

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Skull: a sphere pushed around by anatomical features. Building the head this
 * way (rather than as a scaled ball) is what produces a silhouette that reads
 * as human at 30 m and as a corpse at 3 m.
 */
function buildSkull(centre: Vector3, scale: number, rng: Rng): BufferGeometry {
  const geo = new SphereGeometry(1, 30, 24);
  const pos = geo.attributes.position as BufferAttribute;
  const dir = new Vector3();

  // Random asymmetry so no two skulls match.
  const asymX = rng.range(-0.04, 0.04);
  const socketDepth = rng.range(0.2, 0.3);
  const jawDrop = rng.range(0.0, 0.055);

  const gaussian = (d: number, sigma: number) => Math.exp(-(d * d) / (2 * sigma * sigma));

  for (let i = 0; i < pos.count; i++) {
    dir.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    let r = 1;

    // Base cranium: taller than wide, longer front-to-back.
    const shapeX = 0.86;
    const shapeY = 1.02;
    const shapeZ = 1.0;

    // The face occupies -Z (the character faces -Z).
    const face = -dir.z;

    // Brow ridge above the eyes.
    r += 0.05 * gaussian(dir.y - 0.24, 0.16) * clamp(face, 0, 1);
    // Occipital bulge at the back of the skull.
    r += 0.045 * gaussian(dir.z - 0.72, 0.3);
    // Flatten the temples.
    r -= 0.05 * gaussian(Math.abs(dir.x) - 0.9, 0.22) * gaussian(dir.y - 0.12, 0.35);

    // Sunken eye sockets.
    for (const sx of [-1, 1]) {
      const dx = dir.x - sx * 0.36;
      const dy = dir.y - 0.06;
      const dz = dir.z + 0.82;
      const d = Math.hypot(dx * 1.1, dy * 1.35, dz * 0.7);
      r -= socketDepth * gaussian(d, 0.28);
    }

    // Nasal aperture — a small recess, no protruding nose left.
    r -= 0.1 * gaussian(Math.hypot(dir.x * 2.4, (dir.y + 0.06) * 1.6, dir.z + 0.95), 0.24);
    // Cheek hollows.
    for (const sx of [-1, 1]) {
      const d = Math.hypot((dir.x - sx * 0.52) * 1.1, (dir.y + 0.3) * 1.1, (dir.z + 0.68) * 0.9);
      r -= 0.09 * gaussian(d, 0.3);
    }
    // Cheekbones sit proud just above the hollows.
    for (const sx of [-1, 1]) {
      const d = Math.hypot((dir.x - sx * 0.56) * 1.2, (dir.y - 0.02) * 1.4, (dir.z + 0.62) * 1.0);
      r += 0.05 * gaussian(d, 0.24);
    }
    // Jaw: pulled back and slightly agape.
    const jaw = gaussian(dir.y + 0.62, 0.3) * clamp(face + 0.35, 0, 1);
    r += 0.035 * jaw;

    let x = dir.x * r * shapeX + asymX * gaussian(dir.y, 0.6);
    let y = dir.y * r * shapeY;
    let z = dir.z * r * shapeZ;
    // Drop the mandible open.
    if (y < -0.35) {
      y -= jawDrop * (-y - 0.35) * 3;
      z -= jawDrop * 0.4 * clamp(face, 0, 1);
    }

    pos.setXYZ(i, x * scale + centre.x, y * scale + centre.y, z * scale + centre.z);
  }
  pos.needsUpdate = true;

  // Rescale the sphere's 0..1 UVs into the same metres-based space the tubes
  // use, so facial pores match the density on the neck they join.
  const uv = geo.attributes.uv as BufferAttribute;
  const circumference = TAU * scale * UV_SCALE;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * circumference, uv.getY(i) * circumference * 0.5);
  }
  uv.needsUpdate = true;

  geo.computeVertexNormals();
  return geo;
}

/**
 * Pushes vertices along their normals by a band-limited noise field, giving
 * garments creases and giving flesh an irregular, sagging surface.
 */
function displaceAlongNormals(geo: BufferGeometry, rng: Rng, amount: number, frequency: number) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const fbm = makeFbm(rng.int(1, 1e6), { octaves: 3, frequency: 1 });
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Sample a 2D slice of the field per axis pair so the result varies in 3D.
    const n =
      fbm(x * frequency, y * frequency) * 0.5 +
      fbm(z * frequency + 3.1, y * frequency + 7.7) * 0.5;
    const d = (n - 0.5) * 2 * amount;
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }
  pos.needsUpdate = true;
}

/** Assigns up to four bone influences per vertex by distance to bone segments. */
function autoSkin(
  geo: BufferGeometry,
  bonePairs: { index: number; a: Vector3; b: Vector3; radius: number }[],
) {
  const pos = geo.attributes.position;
  const count = pos.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);

  const v = new Vector3();
  const ab = new Vector3();
  const av = new Vector3();
  const candidates: { i: number; w: number }[] = [];

  for (let i = 0; i < count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    candidates.length = 0;

    for (const bone of bonePairs) {
      ab.subVectors(bone.b, bone.a);
      av.subVectors(v, bone.a);
      const lenSq = ab.lengthSq();
      const t = lenSq > 0 ? clamp(av.dot(ab) / lenSq, 0, 1) : 0;
      const dist = av.sub(ab.multiplyScalar(t)).length();
      // Smooth falloff: full weight inside the bone's radius, zero at 2.2x.
      const w = Math.pow(clamp(1 - dist / (bone.radius * 2.2), 0, 1), 3);
      if (w > 0.0001) candidates.push({ i: bone.index, w });
    }

    candidates.sort((a, b) => b.w - a.w);
    let total = 0;
    for (let k = 0; k < 4; k++) total += candidates[k]?.w ?? 0;
    if (total <= 0) {
      // Fall back to the nearest bone so no vertex is ever unweighted.
      skinIndex[i * 4] = bonePairs[0].index;
      skinWeight[i * 4] = 1;
      continue;
    }
    for (let k = 0; k < 4; k++) {
      const c = candidates[k];
      skinIndex[i * 4 + k] = c ? c.i : 0;
      skinWeight[i * 4 + k] = c ? c.w / total : 0;
    }
  }

  geo.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

// Drained, desaturated flesh with a green-grey cast. Warm tints read as a
// living person with a tan, which is exactly the wrong note.
const SKIN_TINTS = [0x9aa094, 0x8e9184, 0xa3a294, 0x8b9489, 0x9c9a8e];
const CLOTH_TINTS = [0xb3bcc6, 0xc0b096, 0x9aa4ae, 0xbba69c, 0x96a196];

let skinBase: MeshStandardMaterial | null = null;
let clothBase: MeshStandardMaterial | null = null;
let gearBase: MeshStandardMaterial | null = null;

/** Boots and belt: dark, slightly glossy leather. Shared across all zombies. */
function gearMaterial(): MeshStandardMaterial {
  if (!gearBase) {
    gearBase = makeSurface('zombieCloth', {
      repeat: 1,
      tint: 0x3a332c,
      roughness: 0.78,
      metalness: 0,
      normalScale: 0.7,
    });
    gearBase.envMapIntensity = 0.55;
  }
  return gearBase;
}

function skinMaterial(rng: Rng): MeshStandardMaterial {
  if (!skinBase) {
    skinBase = makeSurface('zombieSkin', {
      repeat: 1,
      roughness: 1,
      metalness: 0,
      normalScale: 1.15,
      aoIntensity: 0.9,
    });
  }
  const m = skinBase.clone();
  m.color.setHex(rng.pick(SKIN_TINTS));
  // Subsurface is out of budget, but a touch of sheen keeps flesh from
  // reading as dry clay under the rim lights.
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
  // Garments are open tubes — a cut-off sleeve or torn hem shows its inside.
  // Without DoubleSide those openings render as black holes.
  m.side = DoubleSide;
  return m;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export function buildZombieMesh(seed: number, opts: { bulk?: number; height?: number } = {}): ZombieRig {
  const rng = new Rng((0x2b1e5a3d ^ Math.imul(seed, 2654435761)) >>> 0);
  return assemble(rng, opts);
}

function assemble(rng: Rng, opts: { bulk?: number; height?: number }): ZombieRig {
  const root = new Group();
  root.name = 'zombie';

  // --- Per-variant proportions ---
  const heightScale = opts.height ?? rng.range(0.94, 1.06);
  const bulk = opts.bulk ?? rng.range(0.86, 1.16);
  const gaunt = rng.range(0.82, 1.0); // emaciation factor

  // --- Bones ---
  const bones = {} as Record<BoneName, Bone>;
  const boneList: Bone[] = [];
  const boneIndex = {} as Record<BoneName, number>;

  for (const spec of SKELETON) {
    const bone = new Bone();
    bone.name = spec.name;
    bone.position.set(spec.pos[0], spec.pos[1] * (spec.parent ? 1 : 1), spec.pos[2]);
    bones[spec.name] = bone;
    boneIndex[spec.name] = boneList.length;
    boneList.push(bone);
  }
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

  // Virtual end effectors, so limb tips have something to weight against.
  const headTop = P.head.clone().add(new Vector3(0, 0.2, 0));
  const handTipL = P.handL.clone().add(new Vector3(0, -0.09, 0));
  const handTipR = P.handR.clone().add(new Vector3(0, -0.09, 0));
  const toeL = P.footL.clone().add(new Vector3(0, -0.02, -0.15));
  const toeR = P.footR.clone().add(new Vector3(0, -0.02, -0.15));

  const bonePairs = [
    { index: boneIndex.hips, a: P.hips.clone().add(new Vector3(0, -0.09, 0)), b: P.spine, radius: 0.15 * bulk },
    { index: boneIndex.spine, a: P.spine, b: P.chest, radius: 0.15 * bulk },
    { index: boneIndex.chest, a: P.chest, b: P.neck, radius: 0.17 * bulk },
    { index: boneIndex.neck, a: P.neck, b: P.head, radius: 0.07 },
    { index: boneIndex.head, a: P.head, b: headTop, radius: 0.115 },
    { index: boneIndex.clavicleL, a: P.clavicleL, b: P.upperArmL, radius: 0.075 },
    { index: boneIndex.upperArmL, a: P.upperArmL, b: P.lowerArmL, radius: 0.058 },
    { index: boneIndex.lowerArmL, a: P.lowerArmL, b: P.handL, radius: 0.05 },
    { index: boneIndex.handL, a: P.handL, b: handTipL, radius: 0.045 },
    { index: boneIndex.clavicleR, a: P.clavicleR, b: P.upperArmR, radius: 0.075 },
    { index: boneIndex.upperArmR, a: P.upperArmR, b: P.lowerArmR, radius: 0.058 },
    { index: boneIndex.lowerArmR, a: P.lowerArmR, b: P.handR, radius: 0.05 },
    { index: boneIndex.handR, a: P.handR, b: handTipR, radius: 0.045 },
    { index: boneIndex.upLegL, a: P.upLegL, b: P.lowLegL, radius: 0.085 },
    { index: boneIndex.lowLegL, a: P.lowLegL, b: P.footL, radius: 0.068 },
    { index: boneIndex.footL, a: P.footL, b: toeL, radius: 0.055 },
    { index: boneIndex.upLegR, a: P.upLegR, b: P.lowLegR, radius: 0.085 },
    { index: boneIndex.lowLegR, a: P.lowLegR, b: P.footR, radius: 0.068 },
    { index: boneIndex.footR, a: P.footR, b: toeR, radius: 0.055 },
  ];

  /* --- Body geometry ------------------------------------------------- */
  const skinParts: BufferGeometry[] = [];

  // Torso: hips through to the shoulder line, with a real ribcage taper.
  const hipBase = P.hips.clone().add(new Vector3(0, -0.1, 0));
  const shoulderLine = P.neck.clone().add(new Vector3(0, -0.02, 0));
  skinParts.push(
    tube(
      hipBase,
      shoulderLine,
      (t) => {
        // Anthropometry for a 1.75 m adult: hips ~0.34 m across, waist ~0.26,
        // chest ~0.30. Half-widths must stay clear of the arm bones at
        // +/-0.18 or the deltoids end up buried inside the ribcage.
        const wide = lerp(0.145, 0.112, smoothstep(clamp(t / 0.42, 0, 1))); // pelvis -> waist
        const chest = lerp(0.112, 0.152, smoothstep(clamp((t - 0.42) / 0.5, 0, 1)));
        const rx = (t < 0.42 ? wide : chest) * bulk;
        const depth = lerp(0.098, 0.112, Math.sin(t * Math.PI)) * bulk * gaunt;
        return [rx, depth];
      },
      20,
      12,
    ),
  );

  // Ribs showing through emaciated flesh — a shallow corrugation on the chest.
  if (rng.chance(0.55)) {
    for (let i = 0; i < 4; i++) {
      const y = P.chest.y + 0.02 - i * 0.045;
      const r = 0.006 + i * 0.0008;
      skinParts.push(
        tube(
          new Vector3(-0.115 * bulk, y, -0.07),
          new Vector3(0.115 * bulk, y - 0.015, -0.07),
          () => [r, r],
          6,
          4,
        ),
      );
    }
  }

  // Neck.
  skinParts.push(
    tube(P.neck.clone().add(new Vector3(0, -0.04, 0)), P.head, () => [0.047, 0.05], 12, 3, false, false),
  );

  // Head.
  skinParts.push(buildSkull(P.head.clone().add(new Vector3(0, 0.062, -0.006)), 0.089, rng));

  // Arms. Elbow and wrist swellings are what make a limb read as anatomy.
  const armProfile = (upper: boolean) => (t: number): [number, number] => {
    if (upper) {
      const r = lerp(0.049, 0.038, t) * bulk * gaunt + 0.005 * Math.sin(t * Math.PI);
      return [r, r * 0.95];
    }
    const r = lerp(0.042, 0.026, Math.pow(t, 0.8)) * bulk * gaunt + 0.004 * Math.sin(t * Math.PI);
    return [r, r * 0.92];
  };

  for (const side of ['L', 'R'] as const) {
    const shoulder = P[`clavicle${side}` as BoneName];
    const upperArm = P[`upperArm${side}` as BoneName];
    const lowerArm = P[`lowerArm${side}` as BoneName];
    const hand = P[`hand${side}` as BoneName];
    const tip = side === 'L' ? handTipL : handTipR;

    // Deltoid.
    skinParts.push(
      tube(shoulder, upperArm.clone().add(new Vector3(0, -0.03, 0)), (t) => {
        const r = lerp(0.05, 0.062, Math.sin(t * Math.PI * 0.7)) * bulk;
        return [r, r];
      }, 14, 5),
    );
    skinParts.push(tube(upperArm, lowerArm, armProfile(true), 14, 7, false, false));
    skinParts.push(tube(lowerArm, hand, armProfile(false), 14, 7, false, false));
    // Hand: a flattened paddle with splayed finger stubs.
    skinParts.push(
      tube(hand, tip, (t) => [lerp(0.031, 0.024, t) * gaunt, lerp(0.019, 0.013, t)], 12, 4),
    );
    for (let f = 0; f < 4; f++) {
      const off = (f - 1.5) * 0.017;
      const base = tip.clone().add(new Vector3(off, 0.008, 0));
      const end = base.clone().add(new Vector3(off * 0.5, -0.052, -0.012));
      skinParts.push(tube(base, end, (t) => [lerp(0.0085, 0.006, t), lerp(0.0085, 0.006, t)], 7, 3));
    }
  }

  // Legs.
  for (const side of ['L', 'R'] as const) {
    const upLeg = P[`upLeg${side}` as BoneName];
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const foot = P[`foot${side}` as BoneName];
    const toe = side === 'L' ? toeL : toeR;

    skinParts.push(
      tube(upLeg.clone().add(new Vector3(0, 0.05, 0)), lowLeg, (t) => {
        const r = lerp(0.081, 0.055, Math.pow(t, 0.9)) * bulk * gaunt;
        return [r, r * 1.02];
      }, 16, 8, false, false),
    );
    skinParts.push(
      tube(lowLeg, foot, (t) => {
        // Calf muscle belly high on the shin.
        const r = (lerp(0.055, 0.032, t) + 0.014 * Math.sin(Math.pow(1 - t, 0.6) * Math.PI)) * bulk * gaunt;
        return [r, r * 0.95];
      }, 16, 8, false, false),
    );
    // Foot, angled forward.
    skinParts.push(
      tube(foot.clone().add(new Vector3(0, 0.02, 0)), toe, (t) => [lerp(0.045, 0.036, t), lerp(0.04, 0.026, t)], 12, 4),
    );
  }

  const skinGeo = mergeAll(skinParts)!;
  skinParts.forEach((g) => g.dispose());
  skinGeo.computeVertexNormals();
  displaceAlongNormals(skinGeo, rng, 0.005, 14);
  skinGeo.computeVertexNormals();
  autoSkin(skinGeo, bonePairs);

  /* --- Clothing ------------------------------------------------------ */
  const clothParts: BufferGeometry[] = [];
  const shirtHemNoise = rng.range(0.02, 0.07);

  // Torn shirt over the torso. The hem is deliberately irregular and the
  // sleeves are cut at different lengths so the silhouette reads as ruined.
  const shirtBottom = P.hips.clone().add(new Vector3(0, -0.02 - shirtHemNoise, 0));
  clothParts.push(
    tube(shirtBottom, P.neck.clone().add(new Vector3(0, -0.03, 0)), (t) => {
      const base = t < 0.4 ? lerp(0.15, 0.116, t / 0.4) : lerp(0.116, 0.158, (t - 0.4) / 0.6);
      const r = base * bulk + 0.009;
      // Ragged hem: wobble the first ring outward.
      const ragged = t < 0.06 ? rng.range(-0.01, 0.01) : 0;
      return [r + ragged, lerp(0.104, 0.118, Math.sin(t * Math.PI)) * bulk + 0.009];
    }, 20, 12, false, false),
  );
  // Collar.
  clothParts.push(
    tube(
      P.neck.clone().add(new Vector3(0, -0.04, 0)),
      P.neck.clone().add(new Vector3(0, 0.03, 0)),
      (t) => [lerp(0.074, 0.062, t), lerp(0.077, 0.064, t)],
      16,
      3,
      false,
      false,
    ),
  );

  const sleeveLengths: [number, number] = rng.chance(0.4) ? [0.95, 0.35] : [rng.range(0.4, 0.75), rng.range(0.4, 0.9)];
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? 'L' : 'R';
    const shoulder = P[`clavicle${side}` as BoneName];
    const upperArm = P[`upperArm${side}` as BoneName];
    const lowerArm = P[`lowerArm${side}` as BoneName];
    const len = sleeveLengths[s];
    if (len < 0.08) continue;
    const end = len <= 0.5
      ? upperArm.clone().lerp(lowerArm, len * 2)
      : lowerArm.clone().lerp(P[`hand${side}` as BoneName], (len - 0.5) * 2);
    clothParts.push(
      tube(shoulder.clone().lerp(upperArm, 0.2), end, (t) => {
        const r = lerp(0.066, 0.044, t) * bulk + 0.007;
        return [r, r];
      }, 14, 6, false, false),
    );
  }

  // Trousers.
  for (const side of ['L', 'R'] as const) {
    const upLeg = P[`upLeg${side}` as BoneName];
    const lowLeg = P[`lowLeg${side}` as BoneName];
    const cut = rng.range(0.55, 1.0);
    const end = lowLeg.clone().lerp(P[`foot${side}` as BoneName], cut);
    clothParts.push(
      tube(upLeg.clone().add(new Vector3(0, 0.09, 0)), end, (t) => {
        const r = lerp(0.094, 0.063, Math.pow(t, 0.8)) * bulk + 0.009;
        return [r, r * 1.02];
      }, 16, 9, false, false),
    );
  }
  // Waistband.
  clothParts.push(
    tube(
      P.hips.clone().add(new Vector3(0, -0.06, 0)),
      P.hips.clone().add(new Vector3(0, 0.02, 0)),
      () => [0.149 * bulk + 0.011, 0.102 * bulk + 0.011],
      18,
      3,
      false,
      false,
    ),
  );

  // Boots get their own mesh: bright workwear tints look absurd on footwear,
  // and leather needs a different roughness from cotton.
  const gearParts: BufferGeometry[] = [];
  for (const side of ['L', 'R'] as const) {
    const foot = P[`foot${side}` as BoneName];
    const toe = side === 'L' ? toeL : toeR;
    gearParts.push(
      tube(
        foot.clone().add(new Vector3(0, 0.075, 0.01)),
        toe.clone().add(new Vector3(0, 0.004, -0.012)),
        (t) => [lerp(0.05, 0.038, t), lerp(0.048, 0.03, t)],
        14,
        5,
      ),
    );
    // Sole slab.
    gearParts.push(
      tube(
        foot.clone().add(new Vector3(0, -0.012, 0.012)),
        toe.clone().add(new Vector3(0, -0.012, -0.016)),
        (t) => [lerp(0.052, 0.04, t), 0.014],
        12,
        4,
      ),
    );
  }
  // Belt.
  gearParts.push(
    tube(
      P.hips.clone().add(new Vector3(0, -0.02, 0)),
      P.hips.clone().add(new Vector3(0, 0.012, 0)),
      () => [0.152 * bulk + 0.013, 0.105 * bulk + 0.013],
      18,
      2,
      false,
      false,
    ),
  );

  const clothGeo = mergeAll(clothParts)!;
  clothParts.forEach((g) => g.dispose());
  clothGeo.computeVertexNormals();
  // Folds and sag. Perfectly smooth tubes read as a wetsuit; a few millimetres
  // of low-frequency displacement along the normal is what makes them cloth.
  displaceAlongNormals(clothGeo, rng, 0.011, 9);
  clothGeo.computeVertexNormals();
  autoSkin(clothGeo, bonePairs);

  const gearGeo = mergeAll(gearParts)!;
  gearParts.forEach((g) => g.dispose());
  gearGeo.computeVertexNormals();
  autoSkin(gearGeo, bonePairs);

  /* --- Apply the variant's height ------------------------------------- */
  // The scale is baked into the bone rest positions and the geometry rather
  // than set on the root. Scaling the root would double-apply: the bind
  // inverses would absorb it once and the model matrix again.
  //
  // This has to happen after every autoSkin call: the weighting reads
  // `bindPositions`, which is scaled in place here.
  if (heightScale !== 1) {
    for (const bone of boneList) bone.position.multiplyScalar(heightScale);
    for (const geo of [skinGeo, clothGeo, gearGeo]) {
      geo.scale(heightScale, heightScale, heightScale);
    }
    for (const key of Object.keys(bindPositions) as BoneName[]) {
      bindPositions[key].multiplyScalar(heightScale);
    }
    root.updateMatrixWorld(true);
  }

  /* --- Skinned meshes ------------------------------------------------ */
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
