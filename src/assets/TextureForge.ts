import {
  CanvasTexture,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  NoColorSpace,
} from 'three';
import { clamp, lerp, makeFbm, smoothstep } from '../util/math';

/**
 * Procedural PBR texture generation.
 *
 * Every surface in the game is authored here as a per-texel `Sample` function
 * that returns albedo, roughness, metalness, ambient occlusion and a height
 * value. One pass fills albedo, a packed AO/roughness/metalness map and height;
 * the normal map is then derived from height with a wrapped Sobel filter so it
 * tiles seamlessly.
 *
 * This exists because the build has no access to a licensed texture library.
 * Generating real map sets — rather than assigning flat colours — is what keeps
 * materials reading as concrete, steel and skin instead of as untextured
 * plastic. These are final assets, not placeholders.
 */

export interface Sample {
  /** Linear-space albedo, 0..1 */
  r: number;
  g: number;
  b: number;
  /** 0 = mirror, 1 = fully diffuse */
  rough: number;
  /** 0 = dielectric, 1 = raw metal */
  metal: number;
  /** Baked cavity/contact occlusion, 0..1 (1 = fully open) */
  ao: number;
  /** Drives the derived normal map, 0..1 */
  height: number;
}

export interface MapSet {
  map: Texture;
  normalMap: Texture;
  roughnessMap: Texture;
  metalnessMap: Texture;
  aoMap: Texture;
}

const scratch: Sample = { r: 0, g: 0, b: 0, rough: 1, metal: 0, ao: 1, height: 0.5 };

let textureScale = 1;
let maxAnisotropy = 8;

/** Applies the selected quality tier before any surfaces are requested. */
export function configureTextureQuality(scale: number, anisotropy: number) {
  textureScale = clamp(scale, 0.25, 1);
  maxAnisotropy = Math.max(1, Math.floor(anisotropy));
}

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

function toTexture(data: ImageData, size: number, srgb: boolean, aniso: number): Texture {
  const canvas = makeCanvas(size);
  canvas.getContext('2d')!.putImageData(data, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.anisotropy = aniso;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** sRGB encode for the albedo channel (the other maps stay linear). */
function encodeSrgb(v: number): number {
  const c = clamp(v, 0, 1);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Derives a tangent-space normal map from a height field using a wrapped Sobel
 * kernel, so edges match across the seam when the texture repeats.
 */
function normalFromHeight(height: Float32Array, size: number, strength: number): ImageData {
  const out = new ImageData(size, size);
  const px = out.data;
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1);
      const t = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const l = at(x - 1, y);
      const r = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const b = at(x, y + 1);
      const br = at(x + 1, y + 1);

      const dx = tl + 2 * l + bl - (tr + 2 * r + br);
      const dy = tl + 2 * t + tr - (bl + 2 * b + br);

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;

      const i = (y * size + x) * 4;
      px[i] = (nx * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * 0.5 + 0.5) * 255;
      px[i + 2] = nz * inv * 255;
      px[i + 3] = 255;
    }
  }
  return out;
}

export interface BakeOptions {
  size?: number;
  normalStrength?: number;
  anisotropy?: number;
}

/**
 * Runs `sample` once per texel and produces a complete PBR map set.
 * `sample` writes into the shared scratch object to avoid 260k allocations.
 */
export function bake(
  sample: (u: number, v: number, out: Sample) => void,
  opts: BakeOptions = {},
): MapSet {
  const requestedSize = opts.size ?? 512;
  // A 128 px floor keeps compact weapon surfaces readable on the low tier.
  const size = Math.max(128, Math.round(requestedSize * textureScale));
  const strength = opts.normalStrength ?? 2.2;
  const aniso = Math.min(opts.anisotropy ?? 8, maxAnisotropy);

  const albedo = new ImageData(size, size);
  // Three reads AO from red, roughness from green and metalness from blue, so
  // all three scalar maps can share one GPU texture and one canvas upload.
  const orm = new ImageData(size, size);
  const height = new Float32Array(size * size);

  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      scratch.r = scratch.g = scratch.b = 0.5;
      scratch.rough = 1;
      scratch.metal = 0;
      scratch.ao = 1;
      scratch.height = 0.5;
      sample((x + 0.5) * inv, (y + 0.5) * inv, scratch);

      const i = (y * size + x) * 4;
      albedo.data[i] = encodeSrgb(scratch.r) * 255;
      albedo.data[i + 1] = encodeSrgb(scratch.g) * 255;
      albedo.data[i + 2] = encodeSrgb(scratch.b) * 255;
      albedo.data[i + 3] = 255;

      const rv = clamp(scratch.rough, 0, 1) * 255;
      const mv = clamp(scratch.metal, 0, 1) * 255;
      const av = clamp(scratch.ao, 0, 1) * 255;
      orm.data[i] = av;
      orm.data[i + 1] = rv;
      orm.data[i + 2] = mv;
      orm.data[i + 3] = 255;

      height[y * size + x] = scratch.height;
    }
  }

  const ormMap = toTexture(orm, size, false, aniso);
  return {
    map: toTexture(albedo, size, true, aniso),
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    aoMap: ormMap,
    normalMap: toTexture(normalFromHeight(height, size, strength), size, false, aniso),
  };
}

/* ------------------------------------------------------------------ */
/* Shared field helpers used by the surface definitions below.         */
/* ------------------------------------------------------------------ */

/** Distance to the nearest cell edge of a rectangular lattice, in UV units. */
export function gridEdge(u: number, v: number, cols: number, rows: number, stagger = 0) {
  const row = Math.floor(v * rows);
  const offset = stagger && row % 2 === 1 ? 0.5 / cols : 0;
  const cx = (u + offset) * cols;
  const cy = v * rows;
  const fx = cx - Math.floor(cx);
  const fy = cy - Math.floor(cy);
  return {
    edge: Math.min(fx, 1 - fx, fy, 1 - fy),
    cell: (Math.floor(cx) * 73856093) ^ (Math.floor(cy) * 19349663),
    fx,
    fy,
  };
}

/** Hash a cell id to a stable 0..1 value — per-brick / per-plank variation. */
export function cellHash(cell: number, salt = 0): number {
  let h = (cell ^ (salt * 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Thin anisotropic scratches, used to break up metal highlights. */
export function scratchField(u: number, v: number, fbm: (a: number, b: number) => number) {
  const a = fbm(u * 0.4 + v * 3.7, v * 0.4 - u * 2.9);
  const lines = Math.pow(Math.abs(Math.sin((a + u * 2 - v) * 40)), 24);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Surface library                                                     */
/* ------------------------------------------------------------------ */

export type SurfaceId =
  | 'concrete'
  | 'plaster'
  | 'brick'
  | 'woodPlank'
  | 'gunWood'
  | 'rustedMetal'
  | 'gunmetal'
  | 'polymer'
  | 'asphalt'
  | 'tile'
  | 'paintedMetal'
  | 'zombieSkin'
  | 'zombieCloth'
  | 'camoWoodland'
  | 'camoArid'
  | 'camoDesert'
  | 'camoUrban'
  | 'cordura'
  | 'soldierSkin';

const cache = new Map<string, MapSet>();

export function surface(id: SurfaceId, opts: BakeOptions = {}): MapSet {
  // Every option that changes pixels or sampling belongs in the key. Omitting
  // normal strength or anisotropy returned a previously baked but incompatible
  // map set when callers requested the same surface at the same size.
  const key = [
    id,
    opts.size ?? 'default',
    opts.normalStrength ?? 'default',
    opts.anisotropy ?? 'default',
    textureScale,
    maxAnisotropy,
  ].join(':');
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(id, opts);
  cache.set(key, built);
  return built;
}

/** Bakes expensive startup surfaces one at a time so the loader can repaint. */
export async function prewarmSurfaces(
  ids: readonly SurfaceId[],
  onProgress?: (completed: number, total: number) => void,
) {
  for (let i = 0; i < ids.length; i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    surface(ids[i]);
    onProgress?.(i + 1, ids.length);
  }
}

function build(id: SurfaceId, opts: BakeOptions): MapSet {
  switch (id) {
    case 'concrete':
      return bakeConcrete(opts);
    case 'plaster':
      return bakePlaster(opts);
    case 'brick':
      return bakeBrick(opts);
    case 'woodPlank':
      return bakeWood(opts, false);
    case 'gunWood':
      return bakeWood(opts, true);
    case 'rustedMetal':
      return bakeRustedMetal(opts);
    case 'gunmetal':
      return bakeGunmetal(opts);
    case 'polymer':
      return bakePolymer(opts);
    case 'asphalt':
      return bakeAsphalt(opts);
    case 'tile':
      return bakeTile(opts);
    case 'paintedMetal':
      return bakePaintedMetal(opts);
    case 'zombieSkin':
      return bakeZombieSkin(opts);
    case 'zombieCloth':
      return bakeZombieCloth(opts);
    case 'camoWoodland':
      return bakeCamo(opts, CAMO.woodland);
    case 'camoArid':
      return bakeCamo(opts, CAMO.arid);
    case 'camoDesert':
      return bakeCamo(opts, CAMO.desert);
    case 'camoUrban':
      return bakeCamo(opts, CAMO.urban);
    case 'cordura':
      return bakeCordura(opts);
    case 'soldierSkin':
      return bakeSoldierSkin(opts);
  }
}

function bakeConcrete(o: BakeOptions): MapSet {
  const grain = makeFbm(1201, { octaves: 6, frequency: 8 });
  const blotch = makeFbm(1202, { octaves: 4, frequency: 2.5 });
  const cracks = makeFbm(1203, { octaves: 5, frequency: 14, ridged: true });
  const pit = makeFbm(1204, { octaves: 3, frequency: 34 });
  // Very-low-frequency pour zoning: cast walls shift value from lift to lift,
  // so a broad field beyond `blotch` splits the slab into large tonal plates.
  const pour = makeFbm(1205, { octaves: 3, frequency: 1.4 });

  return bake((u, v, s) => {
    const g = grain(u, v);
    const bl = blotch(u, v);
    // Hairline cracks only. A wide, high-contrast crack network at this scale
    // reads as dried mud or an oil slick rather than as a poured slab.
    const crack = smoothstep(clamp((cracks(u, v) - 0.87) * 26, 0, 1));
    const pits = smoothstep(clamp((pit(u, v) - 0.78) * 4, 0, 1));

    // Board-formed slab furniture: form-panel joints every half tile and a
    // snap-tie plug dimple at each quarter-cell centre. Both come from the
    // wrapping lattice helpers, so they repeat seamlessly like the noise does.
    const seam = gridEdge(u, v, 2, 2);
    const tie = gridEdge(u, v, 4, 4);
    // Joint profile: a dark grouted core inside a soft chamfered shoulder —
    // how a real form joint catches raking light, not a hard vector line.
    const seamUv = seam.edge * 0.5;
    const seamCore = 1 - smoothstep(clamp(seamUv / 0.004, 0, 1));
    const seamShoulder = 1 - smoothstep(clamp(seamUv / 0.02, 0, 1));
    // Snap-tie holes: shallow conical recesses with a faint proud ring where
    // the snapped-off plug displaced the cement paste around it.
    const tieR = Math.hypot(tie.fx - 0.5, tie.fy - 0.5);
    const holeCore = 1 - smoothstep(clamp(tieR / 0.085, 0, 1));
    const holeRim = smoothstep(clamp((tieR - 0.09) / 0.05, 0, 1)) *
      (1 - smoothstep(clamp((tieR - 0.17) / 0.05, 0, 1)));

    // Tonal zones: pour-lift bands plus blotch drift give real plate-to-plate
    // value separation (~0.12..0.30 linear) instead of one flat grey.
    const zone = clamp((pour(u, v) - 0.34) / 0.32, 0, 1);
    const base = 0.175 + g * 0.05 + bl * 0.045 + (zone - 0.5) * 0.17;
    s.r = base * 1.02;
    s.g = base;
    s.b = base * 0.96;

    // Water staining pulls the low blotch areas toward a dirty umber.
    const stain = smoothstep(clamp((bl - 0.55) * 3, 0, 1)) * 0.5;
    s.r = lerp(s.r, 0.14, stain);
    s.g = lerp(s.g, 0.12, stain);
    s.b = lerp(s.b, 0.1, stain);

    // Efflorescence whisper: alkaline salt blooms hug the joints where
    // moisture migrated through the form seam. Capped near 35% mix so it
    // reads as a mineral deposit, never as a coat of paint.
    const effNoise = smoothstep(clamp((bl - 0.45) * 2.4, 0, 1));
    const eff = seamShoulder * effNoise * 0.35;
    s.r = lerp(s.r, 0.52, eff);
    s.g = lerp(s.g, 0.54, eff);
    s.b = lerp(s.b, 0.5, eff);

    // Recessed geometry darkens albedo and opens cavities in the AO channel.
    const dark = crack * 0.4 + pits * 0.12 + seamCore * 0.5 + holeCore * 0.42;
    s.r *= 1 - dark;
    s.g *= 1 - dark;
    s.b *= 1 - dark;

    // Grout dust in the joint and loose salts both roughen the finish.
    s.rough = clamp(0.88 + g * 0.08 + seamShoulder * 0.1 + eff * 0.12, 0, 1);
    s.metal = 0;
    s.ao = clamp(
      1 - crack * 0.35 - pits * 0.22 - seamCore * 0.3 - holeCore * 0.34, 0, 1);
    // Height carries the story: joints and tie holes recess, rims sit proud.
    s.height = clamp(
      0.55 + g * 0.26 - crack * 0.35 - pits * 0.25 -
        seamCore * 0.13 - seamShoulder * 0.045 -
        holeCore * 0.15 + holeRim * 0.05,
      0, 1);
  }, { normalStrength: 1.7, ...o });
}

function bakePlaster(o: BakeOptions): MapSet {
  const grain = makeFbm(2101, { octaves: 5, frequency: 12 });
  const patch = makeFbm(2102, { octaves: 4, frequency: 3 });
  const damp = makeFbm(2103, { octaves: 3, frequency: 1.7 });
  const brickUnder = makeFbm(2104, { octaves: 2, frequency: 6 });
  // Ridged web for hairline crazing, a slow field that warps the trowel arc
  // phase so the sweep reads as hand strokes rather than machined ribbing,
  // and a drift field that varies repair-patch sheen patch to patch.
  const craze = makeFbm(2105, { octaves: 4, frequency: 30, ridged: true });
  const sweepWarp = makeFbm(2106, { octaves: 3, frequency: 2 });
  const sheenDrift = makeFbm(2107, { octaves: 3, frequency: 1.9 });

  return bake((u, v, s) => {
    const g = grain(u, v);
    const p = patch(u, v);
    const wet = smoothstep(clamp((damp(u, v) - 0.5) * 2.6, 0, 1));

    // Cold, nicotine-stained terminal plaster. Keep the midtone restrained so
    // practical lamps create the contrast instead of bleaching the whole room.
    let r = 0.34 + g * 0.08;
    let gg = 0.31 + g * 0.075;
    let b = 0.27 + g * 0.065;

    // Trowel sweep: two families of shallow arcs whose phase drifts with the
    // periodic warp. Both sines advance by whole multiples of 2π across the
    // tile, so the sweep stays seamless. It lives mostly in height/sheen and
    // only whispers in albedo.
    const warp = sweepWarp(u, v);
    const arcV = Math.pow(
      Math.abs(Math.sin(Math.PI * 4 * v + (warp - 0.5) * 4)), 14) * 0.6;
    const arcU = Math.pow(
      Math.abs(Math.sin(Math.PI * 6 * u + (warp - 0.5) * 4)), 16) * 0.4;
    const sweep = arcV + arcU;

    // Sections where the plaster has fallen away, exposing dark masonry.
    const fallen = smoothstep(clamp((p - 0.62) * 7, 0, 1));
    const under = brickUnder(u * 2, v * 2);
    r = lerp(r, 0.16 + under * 0.08, fallen);
    gg = lerp(gg, 0.12 + under * 0.06, fallen);
    b = lerp(b, 0.11 + under * 0.05, fallen);

    // Repair patches: the band just below total failure is newer skim plaster
    // sitting slightly proud — brighter, denser, and with a sheen offset that
    // itself drifts, because no two mixes dry identically.
    const skim = smoothstep(clamp((p - 0.55) * 6, 0, 1)) * (1 - fallen);
    const sheen = (sheenDrift(u, v) - 0.5) * 2;
    r = lerp(r, 0.4 + g * 0.05, skim * 0.55);
    gg = lerp(gg, 0.38 + g * 0.05, skim * 0.55);
    b = lerp(b, 0.34 + g * 0.05, skim * 0.55);

    // Hairline crazing web: the shrinkage crack network every old lime coat
    // grows. Thin and low-contrast so it reads as surface texture, not damage.
    const crazeLine = smoothstep(clamp((craze(u, v) - 0.88) * 24, 0, 1));
    const crazeDark = crazeLine * 0.22;
    r *= 1 - crazeDark;
    gg *= 1 - crazeDark;
    b *= 1 - crazeDark;

    // Damp bleeding down from the ceiling line.
    const bleed = wet * (1 - v) * 0.55;
    r = lerp(r, 0.17, bleed);
    gg = lerp(gg, 0.16, bleed);
    b = lerp(b, 0.13, bleed);

    s.r = r;
    s.g = gg;
    s.b = b;
    // Burnished trowel arcs and fresh skim both gloss the surface; damp goes
    // matte. The skim's glossiness is scaled by the sheen drift.
    s.rough = clamp(
      0.82 + g * 0.12 - wet * 0.12 - sweep * 0.05 -
        skim * (0.1 + sheen * 0.08),
      0, 1);
    s.metal = 0;
    s.ao = clamp(1 - fallen * 0.5 - crazeLine * 0.08, 0, 1);
    s.height = clamp(
      0.7 + g * 0.12 + sweep * 0.05 + skim * 0.06 - fallen * 0.5 -
        crazeLine * 0.06,
      0, 1);
  }, { normalStrength: 2.0, ...o });
}

function bakeBrick(o: BakeOptions): MapSet {
  const grain = makeFbm(3101, { octaves: 5, frequency: 20 });
  const wear = makeFbm(3102, { octaves: 4, frequency: 3 });
  // High-frequency grit reads as sand grains only inside the soft mortar, and
  // a mid-frequency spall field drives the chipped arrises along brick edges.
  const crumbs = makeFbm(3103, { octaves: 3, frequency: 55 });
  const spall = makeFbm(3104, { octaves: 4, frequency: 26 });
  const COLS = 6;
  const ROWS = 16;

  return bake((u, v, s) => {
    const { edge, cell, fx, fy } = gridEdge(u, v, COLS, ROWS, 1);
    const mortarW = 0.09;
    const mortar = 1 - smoothstep(clamp(edge / mortarW, 0, 1));
    const g = grain(u, v);
    const w = wear(u, v);

    // Per-brick colour variation across a fired-clay range. The value span is
    // widened and a warm/cool kiln tilt added so neighbouring bricks clearly
    // disagree — real walls never come out of the kiln matching.
    const h = cellHash(cell);
    const h2 = cellHash(cell, 7);
    const h3 = cellHash(cell, 13);
    const val = lerp(0.11, 0.32, h);
    const tilt = (h2 - 0.5) * 0.22;
    let r = val * (1.02 + tilt) * (0.85 + g * 0.3);
    let gg = val * (0.6 - tilt * 0.45 + (h3 - 0.5) * 0.12) * (0.85 + g * 0.3);
    let b = val * (0.46 - tilt * 0.7) * (0.85 + g * 0.3);

    // Chipped arrises: impact spalls bite the brick edges — weighted hardest
    // at the corners — wherever the spall field spikes and the brick drew a
    // chipping lot. Exposed clay is paler and dustier than the fired face.
    const ex = Math.min(fx, 1 - fx);
    const ey = Math.min(fy, 1 - fy);
    const bandX = 1 - smoothstep(clamp(ex / 0.045, 0, 1));
    const bandY = 1 - smoothstep(clamp(ey / 0.045, 0, 1));
    const chipLot = cellHash(cell, 23) > 0.4 ? 1 : 0.25;
    const chipSrc = smoothstep(clamp((spall(u, v) - 0.6) * 7, 0, 1));
    const chip = clamp(
      Math.max(bandX, bandY) * (0.55 + bandX * bandY * 0.6) *
        chipLot * chipSrc * 1.2,
      0, 1);
    r *= 1 + chip * 0.5;
    gg *= 1 + chip * 0.55;
    b *= 1 + chip * 0.6;

    // Soot and general weathering.
    const soot = smoothstep(clamp((w - 0.55) * 3, 0, 1)) * 0.6;
    r = lerp(r, 0.07, soot);
    gg = lerp(gg, 0.065, soot);
    b = lerp(b, 0.06, soot);

    // Rain-streak grime: runoff from the joint above each brick drags dirt
    // down the face in a pair of hashed drip lines that fade with depth.
    // Everything keys off per-cell hashes, so repeats stay seamless.
    const runLen = 0.3 + cellHash(cell, 29) * 0.55;
    const dripA = cellHash(cell, 31);
    const dripB = (dripA * 3.7 + 0.31) % 1;
    const fall = 1 - smoothstep(clamp(fy / runLen, 0, 1));
    const lineA = Math.exp(-((fx - dripA) ** 2) / 0.004);
    const lineB = Math.exp(-((fx - dripB) ** 2) / 0.003);
    const streak = clamp(
      (lineA + lineB) * fall * smoothstep(clamp((w - 0.4) * 2.5, 0, 1)),
      0, 1) * 0.65;
    r = lerp(r, 0.075, streak);
    gg = lerp(gg, 0.07, streak);
    b = lerp(b, 0.062, streak);

    // Pale, crumbling mortar joints. The crumb field granulates the joint so
    // it reads as compacted sand rather than a bead of smooth caulk.
    const crumb = crumbs(u, v);
    const mr = 0.34 + g * 0.08 + (crumb - 0.5) * 0.17;
    r = lerp(r, mr, mortar);
    gg = lerp(gg, mr * 0.98, mortar);
    b = lerp(b, mr * 0.9, mortar);

    s.r = r;
    s.g = gg;
    s.b = b;
    // Chips leave a dusty broken face; damp streaks stay slightly tackier.
    s.rough = clamp(
      lerp(
        0.85 + g * 0.12 + chip * 0.06 + streak * 0.05,
        0.94 + (crumb - 0.5) * 0.08,
        mortar),
      0, 1);
    s.metal = 0;
    s.ao = clamp(1 - mortar * 0.55 - chip * 0.12, 0, 1);
    // Joints recess, chips bite the arris back, and the mortar surface gets
    // physical tooth from the same crumb field that granulates its albedo.
    s.height = clamp(
      0.75 + g * 0.12 - mortar * 0.6 - chip * 0.14 +
        (crumb - 0.5) * 0.12 * mortar,
      0, 1);
  }, { normalStrength: 3.2, ...o });
}

/**
 * Shared wood generator. `fine` switches from weathered structural planking to
 * the tighter, oiled figure used on weapon stocks and grips.
 */
function bakeWood(o: BakeOptions, fine: boolean): MapSet {
  const seed = fine ? 4201 : 4101;
  const warp = makeFbm(seed, { octaves: 4, frequency: fine ? 3 : 2 });
  const fibre = makeFbm(seed + 1, { octaves: 4, frequency: fine ? 40 : 26 });
  const knot = makeFbm(seed + 2, { octaves: 3, frequency: fine ? 3 : 4 });
  const rows = fine ? 1 : 5;

  return bake((u, v, s) => {
    const { edge, cell, fy } = gridEdge(u, v, 1, rows);
    const plankSeam = fine ? 0 : 1 - smoothstep(clamp(edge / 0.035, 0, 1));
    const h = fine ? 0.5 : cellHash(cell);

    // Growth rings: warp the coordinate then band it.
    const w = warp(u, v) * (fine ? 0.35 : 0.6);
    const rings = Math.abs(Math.sin((u * (fine ? 26 : 16) + w * 9 + h * 4) * Math.PI));
    const ring = Math.pow(rings, fine ? 1.6 : 1.1);
    const fib = fibre(u * 0.25, v * 4);

    // Knots read as dark elliptical cores.
    const k = smoothstep(clamp((knot(u, v) - 0.7) * 7, 0, 1));

    const warmA = fine ? [0.19, 0.098, 0.048] : [0.2, 0.145, 0.095];
    const warmB = fine ? [0.075, 0.036, 0.018] : [0.1, 0.07, 0.045];
    const t = ring * 0.75 + fib * 0.25;
    let r = lerp(warmA[0], warmB[0], t);
    let g = lerp(warmA[1], warmB[1], t);
    let b = lerp(warmA[2], warmB[2], t);

    // Weathered planks silver out; finished stocks stay saturated.
    if (!fine) {
      const grey = smoothstep(clamp((h - 0.45) * 2.4, 0, 1)) * 0.45;
      r = lerp(r, 0.19, grey);
      g = lerp(g, 0.175, grey);
      b = lerp(b, 0.155, grey);
    }

    r *= 1 - k * 0.7;
    g *= 1 - k * 0.72;
    b *= 1 - k * 0.72;

    r = lerp(r, 0.06, plankSeam);
    g = lerp(g, 0.05, plankSeam);
    b = lerp(b, 0.042, plankSeam);

    s.r = r;
    s.g = g;
    s.b = b;
    // Oiled furniture has a directional sheen; site timber is dry and matte.
    s.rough = fine
      ? clamp(0.44 + ring * 0.16 + fib * 0.06, 0, 1)
      : clamp(0.78 + fib * 0.16 - plankSeam * 0.1, 0, 1);
    s.metal = 0;
    s.ao = 1 - plankSeam * 0.6 - k * 0.3;
    s.height = clamp(
      (fine ? 0.72 : 0.7) - ring * (fine ? 0.08 : 0.2) - plankSeam * 0.55 - k * 0.2 + fy * 0.02,
      0,
      1,
    );
  }, { normalStrength: fine ? 1.4 : 2.8, ...o });
}

function bakeRustedMetal(o: BakeOptions): MapSet {
  const rustField = makeFbm(5101, { octaves: 6, frequency: 5 });
  const pit = makeFbm(5102, { octaves: 4, frequency: 22 });
  const grain = makeFbm(5103, { octaves: 3, frequency: 60 });
  const scr = makeFbm(5104, { octaves: 3, frequency: 8 });
  // Narrow-column field for gravity rust runs — u scaled by an integer so the
  // drip columns stay seamless — plus a slow field that varies pitting
  // pressure region to region instead of speckling uniformly everywhere.
  const runs = makeFbm(5105, { octaves: 4, frequency: 9 });
  const pitZone = makeFbm(5106, { octaves: 2, frequency: 2 });

  return bake((u, v, s) => {
    const rf = rustField(u, v);
    // Paint survives only as islands: past this threshold the oxide has won.
    const rustCore = smoothstep(clamp((rf - 0.42) * 3.6, 0, 1));
    // Chipped border: a thin band right at the paint/rust frontier where the
    // coating has lifted and bare steel still flashes through before the
    // oxidation swallows it.
    const rim = smoothstep(clamp((rf - 0.33) * 9, 0, 1)) *
      (1 - smoothstep(clamp((rf - 0.43) * 12, 0, 1)));
    const paint = 1 - Math.max(rustCore, rim);

    // Pitting variance: corrosion concentrates where moisture sat, so the raw
    // pit field is scaled by a broad regional pressure map and grows mainly
    // inside established rust.
    const pits = smoothstep(clamp((pit(u, v) - 0.55) * 5, 0, 1)) *
      (0.35 + pitZone(u, v) * 1.3) * (rustCore * 0.85 + 0.15);
    const g = grain(u, v);
    const scratches = scratchField(u, v, scr);

    // Gravity runs: bleed lines descending from the rust islands. The column
    // field is compressed horizontally only, so each drip wanders slowly down
    // the tile; strength keys off how established the rust above is.
    const drip = smoothstep(clamp((runs(u * 6, v) - 0.5) * 3.2, 0, 1)) *
      (0.3 + rustCore * 0.7);

    // Painted steel islands — a desaturated industrial green-grey.
    let r = 0.085 + g * 0.05;
    let gg = 0.095 + g * 0.05;
    let b = 0.09 + g * 0.05;

    // Rust runs from bright orange at the frontier to dark brown in the core.
    const rustHue = rustField(u * 2, v * 2);
    const rr = lerp(0.36, 0.16, rustHue);
    const rg = lerp(0.14, 0.07, rustHue);
    const rb = lerp(0.05, 0.035, rustHue);
    r = lerp(r, rr, rustCore);
    gg = lerp(gg, rg, rustCore);
    b = lerp(b, rb, rustCore);

    // Bright bare-steel flash along the chipped border, then stain everything
    // beneath the gravity runs with a dirty oxide wash.
    r = lerp(r, 0.38, rim * 0.85);
    gg = lerp(gg, 0.37, rim * 0.85);
    b = lerp(b, 0.36, rim * 0.85);
    r = lerp(r, 0.1, drip * 0.55);
    gg = lerp(gg, 0.065, drip * 0.55);
    b = lerp(b, 0.04, drip * 0.55);

    s.r = r;
    s.g = gg;
    s.b = b;
    // Chemistry per zone: paint is a dielectric coat, the chipped rim is
    // naked steel, and rust is fully oxidised. Runs stain without converting.
    s.metal = clamp(paint * 0.2 + rim * 0.75, 0, 1);
    s.rough = clamp(
      lerp(lerp(0.48 - scratches * 0.18, 0.3, rim), 0.94, rustCore) +
        pits * 0.05 + drip * 0.04,
      0.05, 1);
    s.ao = clamp(1 - pits * 0.45 - rustCore * 0.18 - drip * 0.12, 0, 1);
    // Rust blooms slightly proud of the coating, chips step down where the
    // paint has broken away, and pits bore into the steel.
    s.height = clamp(
      0.62 + g * 0.08 + rustCore * 0.1 - pits * 0.5 - rim * 0.12,
      0, 1);
  }, { normalStrength: 2.4, ...o });
}

function bakeGunmetal(o: BakeOptions): MapSet {
  // Slow tonal drift stands in for heat tint and forge mottle. The old
  // frequency-90 grain swung height and roughness every couple of texels,
  // which aliased into glitter under viewmodel lights — so it is gone.
  const tone = makeFbm(6101, { octaves: 3, frequency: 5 });
  const wearField = makeFbm(6103, { octaves: 4, frequency: 4 });
  // Lathe-feed wander: warps the machining-mark phase so the tool lines
  // drift like a real turned part instead of ruling straight across.
  const feedWarp = makeFbm(6105, { octaves: 2, frequency: 3 });

  return bake((u, v, s) => {
    const t = tone(u, v);
    // Finish wears through on high points, exposing bright bare steel.
    const wear = smoothstep(clamp((wearField(u, v) - 0.66) * 6, 0, 1));

    // Fine anisotropic machining sheen: dense parallel tool marks running
    // with the part axis, plus a faint slow cross-hatch from handling. Both
    // sines advance whole multiples of 2π across the tile, so they stay
    // seamless. The old scratchField was dropped here: its 1-2px lines hit a
    // 0.08 rough floor and fireflies as glitter under the viewmodel lights.
    const wander = (feedWarp(u, v) - 0.5) * 1.6;
    const marks = Math.pow(Math.abs(Math.sin(Math.PI * 96 * u + wander)), 32) *
      (0.55 + t * 0.45);
    const hatch = Math.pow(
      Math.abs(Math.sin(Math.PI * 48 * v - wander * 0.7)), 40) * 0.35;

    const base = 0.03 + t * 0.018;
    const bare = 0.24 + t * 0.05;
    const c = lerp(base, bare, Math.max(wear, hatch * 0.5));

    // Cold blue-grey cast typical of phosphate/parkerised finishes.
    s.r = c * 0.96;
    s.g = c * 0.99;
    s.b = c * 1.06;
    s.metal = 1;
    // Roughness varies smoothly and only dips coherently inside the tool
    // marks — directional sheen. The 0.16 floor keeps any residual gloss
    // from collapsing into sub-pixel specular dots.
    s.rough = clamp(
      0.52 + t * 0.12 - marks * 0.12 - hatch * 0.06 - wear * 0.26,
      0.16, 1);
    s.ao = clamp(1 - wear * 0.05, 0, 1);
    // Grooves cut shallow coherent lines into the height field; no broad
    // speckle bump to fight the normal map or alias at distance.
    s.height = clamp(
      0.62 + t * 0.06 - marks * 0.045 - hatch * 0.02,
      0, 1);
  }, { normalStrength: 0.9, size: 256, ...o });
}

function bakePolymer(o: BakeOptions): MapSet {
  // Pebble dropped from 110 to 70 cycles: below ~3px per bump the stipple
  // aliased into glitter under bright lights; 70 keeps the moulded texture.
  const pebble = makeFbm(7101, { octaves: 3, frequency: 70 });
  const macro = makeFbm(7102, { octaves: 3, frequency: 6 });
  const scuff = makeFbm(7103, { octaves: 4, frequency: 9 });

  return bake((u, v, s) => {
    // Fine moulded pebble grain — the defining look of modern gun furniture.
    const p = pebble(u, v);
    // Dome shaping instead of a raw power curve: wide rounded crowns with
    // narrow valleys, so normals describe bumps rather than per-texel spikes.
    const cells = smoothstep(clamp((p - 0.34) / 0.34, 0, 1));
    const m = macro(u, v);
    const sc = smoothstep(clamp((scuff(u, v) - 0.68) * 6, 0, 1));

    const base = 0.017 + cells * 0.02 + m * 0.008;
    s.r = base;
    s.g = base * 1.02;
    s.b = base * 1.05;

    // Scuffs polish the polymer to a lighter, shinier grey.
    s.r = lerp(s.r, 0.075, sc);
    s.g = lerp(s.g, 0.077, sc);
    s.b = lerp(s.b, 0.08, sc);

    s.metal = 0;
    // Roughness couples gently to the grain — valleys matte, crowns faintly
    // burnished — never swinging fast enough to read as sparkle.
    s.rough = clamp(0.74 - cells * 0.07 - sc * 0.22, 0.15, 1);
    s.ao = clamp(1 - (1 - cells) * 0.1, 0, 1);
    s.height = clamp(0.56 + cells * 0.28, 0, 1);
  }, { normalStrength: 0.9, size: 256, ...o });
}

function bakeAsphalt(o: BakeOptions): MapSet {
  const aggregate = makeFbm(8101, { octaves: 4, frequency: 46 });
  const macro = makeFbm(8102, { octaves: 4, frequency: 3.5 });
  const cracks = makeFbm(8103, { octaves: 4, frequency: 4, ridged: true });

  return bake((u, v, s) => {
    const agg = aggregate(u, v);
    const m = macro(u, v);
    const crack = smoothstep(clamp((cracks(u, v) - 0.76) * 10, 0, 1));

    // Loose gravel sits proud and catches light.
    const stone = smoothstep(clamp((agg - 0.62) * 7, 0, 1));
    let base = 0.035 + m * 0.03;
    base = lerp(base, 0.14 + agg * 0.08, stone * 0.8);

    s.r = base * 1.02;
    s.g = base;
    s.b = base * 0.99;
    s.metal = 0;
    s.rough = clamp(0.93 - stone * 0.15, 0, 1);
    s.ao = 1 - crack * 0.6 - (1 - stone) * 0.08;
    s.height = clamp(0.5 + stone * 0.4 + agg * 0.1 - crack * 0.6, 0, 1);
  }, { normalStrength: 2.4, ...o });
}

function bakeTile(o: BakeOptions): MapSet {
  const grime = makeFbm(9101, { octaves: 5, frequency: 5 });
  const craze = makeFbm(9102, { octaves: 4, frequency: 18, ridged: true });
  // Slow wander field: foot traffic polishes a meandering lane across the
  // floor rather than wearing every tile identically.
  const traffic = makeFbm(9104, { octaves: 3, frequency: 2 });
  const N = 8;

  return bake((u, v, s) => {
    const { cell, fx, fy } = gridEdge(u, v, N, N);
    // Grout width varies per JOINT, not per tile — each vertical/horizontal
    // line hashes its own troweled width (wrapped modulo N so the seam joint
    // agrees with itself) and neighbouring tiles inherit the shared gap.
    const col = Math.floor(u * N);
    const row = Math.floor(v * N);
    const nx = (((fx < 0.5 ? col : col + 1) % N) + N) % N;
    const ny = (((fy < 0.5 ? row : row + 1) % N) + N) % N;
    const wx = 0.028 + cellHash(nx, 41) * 0.026;
    const wy = 0.028 + cellHash(ny, 43) * 0.026;
    const ex = Math.min(fx, 1 - fx);
    const ey = Math.min(fy, 1 - fy);
    const grout = Math.max(
      1 - smoothstep(clamp(ex / wx, 0, 1)),
      1 - smoothstep(clamp(ey / wy, 0, 1)));
    const g = grime(u, v);
    const cracks = smoothstep(clamp((craze(u, v) - 0.82) * 12, 0, 1));
    const h = cellHash(cell);
    const h2 = cellHash(cell, 11);

    // Gritty institutional tile kept readable in the terminal's darker
    // lighting, but with a widened per-tile value span and a faint kiln-glaze
    // tint so the field doesn't read as one repeated swatch.
    let base = 0.235 + h * 0.09;
    const tint = (h2 - 0.5) * 0.05;
    base *= 1 - smoothstep(clamp((g - 0.45) * 2.5, 0, 1)) * 0.55;

    let r = base * (1 + tint * 0.35);
    let gg = base * (1.01 + tint);
    let b = base * (0.95 + tint * 0.5);

    // A few tiles are missing entirely.
    const missing = h > 0.93 ? 1 : 0;
    r = lerp(r, 0.09, missing);
    gg = lerp(gg, 0.085, missing);
    b = lerp(b, 0.08, missing);

    const groutC = 0.24 + g * 0.035;
    r = lerp(r, groutC, grout);
    gg = lerp(gg, groutC * 0.98, grout);
    b = lerp(b, groutC * 0.94, grout);

    // Traffic-path polish: the glazed skin burnishes wherever feet funnel,
    // dropping well below the surrounding matte tile — but only on intact
    // tile faces, never in the grout or the missing holes.
    const lane = smoothstep(clamp((traffic(u, v) - 0.5) * 3, 0, 1)) *
      (1 - grout) * (1 - missing);

    s.r = r;
    s.g = gg;
    s.b = b;
    s.metal = 0;
    s.rough = clamp(
      lerp(
        lerp(0.46 + cracks * 0.18 + g * 0.1, 0.26, lane),
        0.86,
        Math.max(grout, missing)),
      0.2, 1);
    s.ao = clamp(1 - grout * 0.28 - missing * 0.25, 0, 1);
    s.height = clamp(0.8 - grout * 0.35 - missing * 0.32 - cracks * 0.1, 0, 1);
  }, { normalStrength: 1.8, ...o });
}

function bakePaintedMetal(o: BakeOptions): MapSet {
  const chip = makeFbm(10101, { octaves: 4, frequency: 7 });
  const orange = makeFbm(10102, { octaves: 4, frequency: 30 });
  const dust = makeFbm(10103, { octaves: 4, frequency: 3 });
  // Fine dimple layer for true orange-peel micro-texture, and a
  // narrow-column field (integer u scale, so seamless) for enamel drips
  // running down the panel.
  const peelFine = makeFbm(10105, { octaves: 2, frequency: 90 });
  const drips = makeFbm(10106, { octaves: 3, frequency: 8 });

  return bake((u, v, s) => {
    // Neutral white base — perk machines tint this per-machine so one bake
    // serves all of them.
    const cv = chip(u, v);
    // Chipping reads in two stages: a wide primer halo where the topcoat has
    // lifted, then a bare-steel core where the damage reached the metal.
    const primer = smoothstep(clamp((cv - 0.62) * 9, 0, 1)) *
      (1 - smoothstep(clamp((cv - 0.72) * 12, 0, 1)));
    const steel = smoothstep(clamp((cv - 0.72) * 12, 0, 1));
    const exposed = Math.max(primer, steel);
    const peel = orange(u, v);
    const peel2 = peelFine(u, v);
    const d = dust(u, v);

    // Gravity drips: enamel runs bleed down in thin lines wherever the coat
    // went on too thick, skipping the already-chipped areas.
    const drip = smoothstep(clamp((drips(u * 5, v) - 0.52) * 3.4, 0, 1)) *
      (1 - exposed);

    let base = 0.82 - d * 0.12;
    let r = lerp(base, 0.16, primer);
    let g = lerp(base, 0.155, primer);
    let b = lerp(base, 0.145, primer);
    r = lerp(r, 0.13, steel);
    g = lerp(g, 0.125, steel);
    b = lerp(b, 0.12, steel);
    // Runs carry marginally denser pigment than the sprayed field.
    r *= 1 - drip * 0.04;
    g *= 1 - drip * 0.04;
    b *= 1 - drip * 0.04;

    s.r = r;
    s.g = g;
    s.b = b;
    // Only the steel core is metallic; the primer halo is a dielectric coat.
    s.metal = steel * 0.85;
    // Orange-peel lives in two scales: the broad spray mottle plus the fine
    // dimpled skin, with the drips burnishing the coat locally.
    s.rough = clamp(
      lerp(
        0.18 + peel * 0.12 + d * 0.1 + peel2 * 0.08 - drip * 0.07,
        0.7,
        exposed),
      0.04, 1);
    s.ao = clamp(1 - exposed * 0.25, 0, 1);
    // Height: spray dimples, proud drip beads, chips stepped down to steel.
    s.height = clamp(
      0.7 + peel * 0.1 + peel2 * 0.05 + drip * 0.03 - exposed * 0.35,
      0, 1);
  }, { normalStrength: 1.5, ...o });
}

/**
 * Decaying flesh.
 *
 * The hard constraint here is *low* albedo contrast. This map is applied at
 * 3.2 tiles per metre, so one tile covers a 310 mm patch of body: any strong
 * high-frequency detail lands at a few millimetres on screen and turns the whole
 * character into static, which destroys the shading that makes a face readable.
 * All the fine scale therefore lives in the height/normal and roughness
 * channels, and the albedo carries only large, soft discoloration.
 *
 * Sample albedo is LINEAR — `bake` sRGB-encodes it — so these values are darker
 * than the colours they produce on screen.
 */
function bakeZombieSkin(o: BakeOptions): MapSet {
  const macro = makeFbm(11101, { octaves: 3, frequency: 2.1 });
  const mid = makeFbm(11102, { octaves: 4, frequency: 5.5 });
  const livor = makeFbm(11106, { octaves: 3, frequency: 3.1 });
  const bruise = makeFbm(11107, { octaves: 3, frequency: 4.4 });
  // Subcutaneous veining. Ridged noise gives the branching filament network
  // that a starved, translucent corpse shows through the skin.
  const veins = makeFbm(11105, { octaves: 3, frequency: 4.5, ridged: true });
  const dry = makeFbm(11109, { octaves: 4, frequency: 13 });
  const pores = makeFbm(11104, { octaves: 3, frequency: 62 });
  const wet = makeFbm(11111, { octaves: 3, frequency: 2.6 });

  return bake((u, v, s) => {
    const M = macro(u, v);
    const m = mid(u, v);
    const p = pores(u, v);
    const dr = dry(u, v);

    // Base: drained grey with a faint olive cast.
    let r = 0.238;
    let g = 0.236;
    let b = 0.208;

    // Broad putrefactive discoloration — greenish over the belly and flanks.
    const green = clamp((M - 0.46) * 2.1, 0, 1);
    r = lerp(r, 0.196, green * 0.6);
    g = lerp(g, 0.236, green * 0.6);
    b = lerp(b, 0.158, green * 0.6);

    // Livor mortis: dull purple-brown pooling.
    const pool = clamp((livor(u, v) - 0.53) * 2.5, 0, 1);
    r = lerp(r, 0.252, pool * 0.6);
    g = lerp(g, 0.168, pool * 0.6);
    b = lerp(b, 0.192, pool * 0.6);

    // Old bruising: cooler and darker, sitting under the surface.
    const deep = clamp((bruise(u, v) - 0.62) * 2.8, 0, 1);
    r = lerp(r, 0.13, deep * 0.55);
    g = lerp(g, 0.125, deep * 0.55);
    b = lerp(b, 0.145, deep * 0.55);

    // Gentle value mottling. Deliberately small: +/-5% is the difference
    // between skin and camouflage.
    const tone = (m - 0.5) * 0.055 + (M - 0.5) * 0.035;
    r += tone;
    g += tone * 0.96;
    b += tone * 0.88;

    // Veins read mostly as height; only a whisper of them is in the albedo.
    const vein = clamp((veins(u, v) - 0.7) * 3.4, 0, 1);
    r = lerp(r, 0.176, vein * 0.3);
    g = lerp(g, 0.186, vein * 0.3);
    b = lerp(b, 0.196, vein * 0.3);

    // Dried, cracked patches: slightly darker, much rougher.
    const cracked = clamp((dr - 0.58) * 2.4, 0, 1);
    r = lerp(r, 0.168, cracked * 0.45);
    g = lerp(g, 0.158, cracked * 0.45);
    b = lerp(b, 0.132, cracked * 0.45);

    const poreShift = (p - 0.5) * 0.014;
    s.r = clamp(r + poreShift, 0, 1);
    s.g = clamp(g + poreShift, 0, 1);
    s.b = clamp(b + poreShift * 0.9, 0, 1);
    s.metal = 0;

    // Corpses are matte where they have dried and slick where fluid has wept
    // out; that split is most of what stops flesh reading as clay.
    const slick = clamp((wet(u, v) - 0.55) * 2.6, 0, 1);
    s.rough = clamp(0.86 - slick * 0.34 + cracked * 0.1, 0.3, 1);
    s.ao = clamp(1 - vein * 0.16 - cracked * 0.1 - deep * 0.1, 0.62, 1);
    s.height = clamp(
      0.55 + (p - 0.5) * 0.3 + (m - 0.5) * 0.22 - vein * 0.32 - cracked * 0.18,
      0,
      1,
    );
  }, { normalStrength: 0.95, ...o });
}

/**
 * Field uniform twill: faded, filthy and worn thin.
 *
 * The tears themselves are geometry (see `raggedSurface` in ZombieMesh), so this
 * map only has to supply weave, grime and staining. Contrast is kept low for the
 * same reason as the skin — at 3.2 tiles per metre, a busy albedo reads as
 * camouflage print rather than as dirt.
 */
function bakeZombieCloth(o: BakeOptions): MapSet {
  const weave = makeFbm(12101, { octaves: 3, frequency: 90 });
  const dirt = makeFbm(12102, { octaves: 4, frequency: 3.2 });
  const wear = makeFbm(12103, { octaves: 3, frequency: 6 });
  const blood = makeFbm(12104, { octaves: 4, frequency: 2.6 });

  return bake((u, v, s) => {
    // 2/1 twill. The diagonal rib is what distinguishes a uniform's cloth from
    // a bedsheet, and a plain cross-hatch cannot produce it. 88 cycles over a
    // 512 px bake keeps a thread near 6 texels; much tighter and it aliases
    // into hard black cracks under mipmapping.
    const threads = 88;
    const rib = Math.abs(Math.sin((u + v * 0.5) * threads * Math.PI));
    const weft = Math.abs(Math.sin(v * threads * Math.PI));
    const cloth = rib * 0.5 + weft * 0.2 + weave(u, v) * 0.3;

    const d = dirt(u, v);
    const abrasion = clamp((wear(u, v) - 0.56) * 2.6, 0, 1);
    const bl = smoothstep(clamp((blood(u, v) - 0.7) * 3.2, 0, 1));

    // Faded workwear. Kept mid-value so the per-zombie tints in ZombieMesh read
    // as different garments rather than all as black.
    let r = 0.216 + cloth * 0.055;
    let g = 0.222 + cloth * 0.057;
    let b = 0.228 + cloth * 0.058;

    const grime = clamp((d - 0.44) * 2.2, 0, 1) * 0.75;
    r = lerp(r, 0.098, grime);
    g = lerp(g, 0.09, grime);
    b = lerp(b, 0.074, grime);

    // Rubbed-through areas go pale and shiny where the nap has worn away.
    r = lerp(r, 0.26, abrasion * 0.4);
    g = lerp(g, 0.258, abrasion * 0.4);
    b = lerp(b, 0.24, abrasion * 0.4);

    // Dried arterial staining — dark, desaturated, not comic-book red.
    r = lerp(r, 0.082, bl);
    g = lerp(g, 0.019, bl);
    b = lerp(b, 0.016, bl);

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = 0;
    s.rough = clamp(0.95 - bl * 0.2 - abrasion * 0.12, 0, 1);
    s.ao = 1 - grime * 0.12;
    s.height = clamp(0.62 + cloth * 0.2 - abrasion * 0.1, 0, 1);
  }, { normalStrength: 1.15, ...o });
}

/* ------------------------------------------------------------------ */
/* Player operators                                                    */
/* ------------------------------------------------------------------ */

/**
 * `makeFbm` returns roughly 0.31..0.68 rather than a full 0..1, so a threshold
 * written as if the field spanned the unit interval silently keeps or deletes
 * the entire pattern. Everything below thresholds against this remap instead.
 */
const fbmNorm = (x: number) => clamp((x - 0.34) / 0.32, 0, 1);

interface CamoPalette {
  /** The ground colour the pattern is printed on. */
  base: [number, number, number];
  /**
   * Three overprint colours, applied in order at rising thresholds. Real
   * disruptive patterns are layered prints, not a mosaic of equal partners:
   * the first colour covers most of the ground, the last is a sparse accent.
   */
  blobs: [number, number, number][];
  thresholds: [number, number, number];
  /** Frequency of each blob field, in tiles. Different scales stop the three reading as one. */
  scales: [number, number, number];
  /**
   * Cells across the tile for a pixelated (digital) print, or 0 for an organic
   * one. Quantising the *lookup* rather than the output keeps the blob shapes
   * intact and just steps their boundaries, which is exactly what a digital
   * pattern is.
   */
  digital: number;
}

const CAMO: Record<'woodland' | 'arid' | 'desert' | 'urban', CamoPalette> = {
  // Temperate woodland: dark green ground, olive and brown over it, black last.
  woodland: {
    base: [0.088, 0.104, 0.068],
    blobs: [[0.134, 0.14, 0.086], [0.078, 0.064, 0.042], [0.03, 0.034, 0.028]],
    thresholds: [0.44, 0.6, 0.72],
    scales: [6.4, 10.5, 16],
    digital: 0,
  },
  // Multicam-adjacent: pale khaki ground with green and umber, cream highlights.
  arid: {
    base: [0.178, 0.156, 0.106],
    blobs: [[0.112, 0.118, 0.076], [0.098, 0.076, 0.048], [0.222, 0.202, 0.146]],
    thresholds: [0.42, 0.62, 0.78],
    scales: [5.6, 9.2, 15],
    digital: 0,
  },
  // Three-colour desert: sand, pale stone, and a sparse dark brown.
  desert: {
    base: [0.208, 0.18, 0.128],
    blobs: [[0.166, 0.146, 0.102], [0.242, 0.218, 0.166], [0.082, 0.066, 0.045]],
    thresholds: [0.4, 0.62, 0.8],
    scales: [4.8, 8.4, 13.5],
    digital: 0,
  },
  // Urban digital: greyscale, quantised onto a grid so the boundaries step
  // instead of curving.
  urban: {
    base: [0.136, 0.14, 0.146],
    blobs: [[0.078, 0.082, 0.09], [0.196, 0.199, 0.206], [0.036, 0.038, 0.044]],
    thresholds: [0.44, 0.64, 0.79],
    scales: [6.8, 11.5, 18],
    digital: 128,
  },
};

/**
 * Printed camouflage on ripstop combat cloth.
 *
 * Two things make this read as a uniform rather than as noise. The pattern is
 * *printed*, so it changes the albedo and nothing else — roughness, height and
 * normal all come from the weave underneath, and a blob boundary that also
 * moved the surface would read as a paint spill. And the cloth is ripstop: a
 * heavier reinforcing thread every eighth pick, which puts a faint square grid
 * over the whole garment and is the single most recognisable feature of modern
 * field clothing at any distance.
 */
function bakeCamo(o: BakeOptions, palette: CamoPalette): MapSet {
  const seed = Math.round(palette.base[0] * 9973 + palette.thresholds[0] * 331);
  const f1 = makeFbm(seed + 401, { octaves: 4, frequency: palette.scales[0] });
  const f2 = makeFbm(seed + 402, { octaves: 4, frequency: palette.scales[1] });
  const f3 = makeFbm(seed + 403, { octaves: 3, frequency: palette.scales[2] });
  const weave = makeFbm(seed + 404, { octaves: 3, frequency: 110 });
  const wear = makeFbm(seed + 405, { octaves: 4, frequency: 5.5 });
  const dirt = makeFbm(seed + 406, { octaves: 4, frequency: 3 });

  const cell = palette.digital;
  const snap = (x: number) => (cell > 0 ? (Math.floor(x * cell) + 0.5) / cell : x);

  return bake((u, v, s) => {
    // Ripstop: a fine plain weave with a heavy thread every 8th pick.
    const threads = 104;
    const warp = Math.abs(Math.sin(u * threads * Math.PI));
    const weft = Math.abs(Math.sin(v * threads * Math.PI));
    const ripU = Math.pow(Math.abs(Math.sin(u * (threads / 8) * Math.PI)), 14);
    const ripV = Math.pow(Math.abs(Math.sin(v * (threads / 8) * Math.PI)), 14);
    const rip = Math.max(ripU, ripV);
    const cloth = warp * 0.34 + weft * 0.34 + weave(u, v) * 0.32;

    const pu = snap(u);
    const pv = snap(v);
    let [r, g, b] = palette.base;
    const layer = (field: number, threshold: number, colour: [number, number, number]) => {
      // A hard step would alias badly at mip level 3+; two texels of ramp keeps
      // the edge crisp on screen and stable in the distance.
      const k = smoothstep(clamp((field - threshold) * 26, 0, 1));
      if (k <= 0) return;
      r = lerp(r, colour[0], k);
      g = lerp(g, colour[1], k);
      b = lerp(b, colour[2], k);
    };
    layer(fbmNorm(f1(pu, pv)), palette.thresholds[0], palette.blobs[0]);
    layer(fbmNorm(f2(pu, pv)), palette.thresholds[1], palette.blobs[1]);
    layer(fbmNorm(f3(pu, pv)), palette.thresholds[2], palette.blobs[2]);

    // Weave shading rides on top of the print, so threads cross blob edges.
    const shade = 0.86 + cloth * 0.24 + rip * 0.1;
    r *= shade;
    g *= shade;
    b *= shade;

    // Sun-bleaching lifts and desaturates; field dirt darkens toward umber.
    // Deliberately weak: a pattern is only camouflage while the *contrast*
    // between its colours survives, and a strong bleach pass washes four
    // distinct uniforms into four shades of the same pale sand.
    const bleach = clamp((fbmNorm(wear(u, v)) - 0.62) * 2.4, 0, 1) * 0.3;
    const grey = (r + g + b) / 3;
    r = lerp(r, lerp(grey, 0.2, 0.35), bleach);
    g = lerp(g, lerp(grey, 0.19, 0.35), bleach);
    b = lerp(b, lerp(grey, 0.175, 0.35), bleach);

    const grime = clamp((fbmNorm(dirt(u, v)) - 0.62) * 2.6, 0, 1) * 0.55;
    r = lerp(r, 0.082, grime);
    g = lerp(g, 0.072, grime);
    b = lerp(b, 0.058, grime);

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = 0;
    // Cotton-nylon field cloth is matt everywhere; the ripstop thread is the
    // only part with any sheen at all, because it is the only synthetic one.
    s.rough = clamp(0.96 - rip * 0.12 - bleach * 0.05, 0, 1);
    s.ao = 1 - grime * 0.1;
    s.height = clamp(0.6 + cloth * 0.16 + rip * 0.22, 0, 1);
  }, { normalStrength: 1.25, ...o });
}

/**
 * 1000-denier Cordura: plate carriers, pouches, slings and holsters.
 *
 * The whole point of giving kit its own bake rather than reusing the uniform's
 * is that nylon and cotton do not respond to light the same way. This weave is
 * coarse and basket-patterned rather than fine and ribbed, the fibres are
 * synthetic so there is a broad low-gloss sheen instead of a matt nap, and it
 * is far more uniform in colour — webbing does not sun-bleach in patches the
 * way a printed uniform does.
 */
function bakeCordura(o: BakeOptions): MapSet {
  const fuzz = makeFbm(20301, { octaves: 3, frequency: 140 });
  const wear = makeFbm(20302, { octaves: 4, frequency: 7 });
  const dirt = makeFbm(20303, { octaves: 4, frequency: 3.4 });

  return bake((u, v, s) => {
    // Basket weave: 2x2 bundles, so the repeat is a chequer of crossing
    // groups rather than a single-thread grid.
    const bundles = 46;
    const bu = u * bundles;
    const bv = v * bundles;
    const cellU = Math.floor(bu) % 2;
    const cellV = Math.floor(bv) % 2;
    const overUnder = cellU === cellV;
    const ridge = overUnder
      ? Math.abs(Math.sin(bv * Math.PI))
      : Math.abs(Math.sin(bu * Math.PI));
    const weave = ridge * 0.72 + fuzz(u, v) * 0.28;

    const scuff = clamp((fbmNorm(wear(u, v)) - 0.6) * 3, 0, 1);
    const grime = clamp((fbmNorm(dirt(u, v)) - 0.55) * 2.2, 0, 1) * 0.5;

    // Neutral mid-grey base: everything that uses this bake tints it, and a
    // bake that already has a colour of its own fights every tint applied to it.
    let base = 0.2 + weave * 0.075;
    base = lerp(base, 0.245, scuff * 0.5);
    const r = lerp(base * 1.01, 0.075, grime);
    const g = lerp(base, 0.07, grime);
    const b = lerp(base * 0.97, 0.062, grime);

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = 0;
    // Nylon's sheen is what separates a pouch from the shirt behind it.
    s.rough = clamp(0.78 + weave * 0.1 - scuff * 0.16, 0, 1);
    s.ao = 1 - (1 - ridge) * 0.14 - grime * 0.08;
    s.height = clamp(0.55 + weave * 0.34 - scuff * 0.08, 0, 1);
  }, { normalStrength: 1.5, ...o });
}

/**
 * Living skin. The zombie bake is the same idea run the other way: this one has
 * blood in it, so the mid-tones stay warm, the pores are shallower, and the
 * only large-scale variation is the flush over cheeks and knuckles rather than
 * lividity. Kept close to neutral in hue so the per-operator tints in
 * `SoldierMesh` decide complexion rather than fighting a baked-in one.
 */
function bakeSoldierSkin(o: BakeOptions): MapSet {
  const pores = makeFbm(20401, { octaves: 3, frequency: 150 });
  const grain = makeFbm(20402, { octaves: 4, frequency: 42 });
  const flush = makeFbm(20403, { octaves: 3, frequency: 4.5 });
  const stubbleField = makeFbm(20404, { octaves: 2, frequency: 190 });

  return bake((u, v, s) => {
    const p = pores(u, v);
    const gr = grain(u, v);
    const fl = fbmNorm(flush(u, v));

    // Warm mid-brown base. Bright enough that a dark complexion tint still has
    // somewhere to go, and neutral enough that a pale one does not go pink.
    //
    // The channel spread is small on purpose. Skin is far less saturated than
    // it looks — push the red/blue ratio past about 1.3 and every complexion,
    // whatever tint is applied on top, comes out of the tone mapper as the same
    // orange rubber.
    const tone = 0.27 + gr * 0.05 + p * 0.03;
    let r = tone * 1.07;
    let g = tone * 0.97;
    let b = tone * 0.9;

    // Capillary flush — warmer and slightly redder over the raised areas.
    r = lerp(r, r * 1.08, fl);
    g = lerp(g, g * 0.99, fl);
    b = lerp(b, b * 0.96, fl);

    // Follicles: a very fine dark speckle that keeps a shaved head and a
    // forearm from reading as moulded rubber.
    const follicle = clamp((stubbleField(u, v) - 0.58) * 5, 0, 1) * 0.16;
    r *= 1 - follicle;
    g *= 1 - follicle;
    b *= 1 - follicle * 0.9;

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = 0;
    // Skin is glossier than any cloth on the model — that contrast at the
    // collar and the cuffs is most of what sells the material split.
    s.rough = clamp(0.62 + p * 0.16 - fl * 0.06, 0, 1);
    s.ao = 1 - (1 - p) * 0.06;
    s.height = clamp(0.55 + p * 0.28 + gr * 0.1, 0, 1);
  }, { normalStrength: 0.9, ...o });
}
