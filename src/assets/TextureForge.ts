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
 * value. One pass fills all four maps; the normal map is then derived from the
 * height channel with a wrapped Sobel filter so it tiles seamlessly.
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
  const size = opts.size ?? 512;
  const strength = opts.normalStrength ?? 2.2;
  const aniso = opts.anisotropy ?? 8;

  const albedo = new ImageData(size, size);
  const rough = new ImageData(size, size);
  const metal = new ImageData(size, size);
  const ao = new ImageData(size, size);
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
      rough.data[i] = rough.data[i + 1] = rough.data[i + 2] = rv;
      rough.data[i + 3] = 255;

      const mv = clamp(scratch.metal, 0, 1) * 255;
      metal.data[i] = metal.data[i + 1] = metal.data[i + 2] = mv;
      metal.data[i + 3] = 255;

      const av = clamp(scratch.ao, 0, 1) * 255;
      ao.data[i] = ao.data[i + 1] = ao.data[i + 2] = av;
      ao.data[i + 3] = 255;

      height[y * size + x] = scratch.height;
    }
  }

  return {
    map: toTexture(albedo, size, true, aniso),
    roughnessMap: toTexture(rough, size, false, aniso),
    metalnessMap: toTexture(metal, size, false, aniso),
    aoMap: toTexture(ao, size, false, aniso),
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
  | 'zombieCloth';

const cache = new Map<string, MapSet>();

export function surface(id: SurfaceId, opts: BakeOptions = {}): MapSet {
  const key = `${id}:${opts.size ?? 512}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const built = build(id, opts);
  cache.set(key, built);
  return built;
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
  }
}

function bakeConcrete(o: BakeOptions): MapSet {
  const grain = makeFbm(1201, { octaves: 6, frequency: 8 });
  const blotch = makeFbm(1202, { octaves: 4, frequency: 2.5 });
  const cracks = makeFbm(1203, { octaves: 5, frequency: 14, ridged: true });
  const pit = makeFbm(1204, { octaves: 3, frequency: 34 });

  return bake((u, v, s) => {
    const g = grain(u, v);
    const bl = blotch(u, v);
    // Hairline cracks only. A wide, high-contrast crack network at this scale
    // reads as dried mud or an oil slick rather than as a poured slab.
    const crack = smoothstep(clamp((cracks(u, v) - 0.87) * 26, 0, 1));
    const pits = smoothstep(clamp((pit(u, v) - 0.74) * 5, 0, 1));

    // Cold grey base, warmed slightly by staining in the low areas.
    const base = 0.2 + g * 0.13 + bl * 0.06;
    s.r = base * 1.02;
    s.g = base;
    s.b = base * 0.96;

    // Water staining pulls toward a dirty umber.
    const stain = smoothstep(clamp((bl - 0.55) * 3, 0, 1)) * 0.5;
    s.r = lerp(s.r, 0.14, stain);
    s.g = lerp(s.g, 0.12, stain);
    s.b = lerp(s.b, 0.1, stain);

    // Cracks are darker and rougher, and read as recessed in the height field.
    const dark = crack * 0.4 + pits * 0.12;
    s.r *= 1 - dark;
    s.g *= 1 - dark;
    s.b *= 1 - dark;

    s.rough = clamp(0.9 + g * 0.08, 0, 1);
    s.metal = 0;
    s.ao = 1 - crack * 0.35 - pits * 0.22;
    s.height = clamp(0.55 + g * 0.3 - crack * 0.35 - pits * 0.25, 0, 1);
  }, { normalStrength: 1.7, ...o });
}

function bakePlaster(o: BakeOptions): MapSet {
  const grain = makeFbm(2101, { octaves: 5, frequency: 12 });
  const patch = makeFbm(2102, { octaves: 4, frequency: 3 });
  const damp = makeFbm(2103, { octaves: 3, frequency: 1.7 });
  const brickUnder = makeFbm(2104, { octaves: 2, frequency: 6 });

  return bake((u, v, s) => {
    const g = grain(u, v);
    const p = patch(u, v);
    const wet = smoothstep(clamp((damp(u, v) - 0.5) * 2.6, 0, 1));

    // Nicotine-stained cream plaster.
    let r = 0.44 + g * 0.1;
    let gg = 0.4 + g * 0.095;
    let b = 0.34 + g * 0.08;

    // Sections where the plaster has fallen away, exposing dark masonry.
    const fallen = smoothstep(clamp((p - 0.62) * 7, 0, 1));
    const under = brickUnder(u * 2, v * 2);
    r = lerp(r, 0.16 + under * 0.08, fallen);
    gg = lerp(gg, 0.12 + under * 0.06, fallen);
    b = lerp(b, 0.11 + under * 0.05, fallen);

    // Damp bleeding down from the ceiling line.
    const bleed = wet * (1 - v) * 0.55;
    r = lerp(r, 0.17, bleed);
    gg = lerp(gg, 0.16, bleed);
    b = lerp(b, 0.13, bleed);

    s.r = r;
    s.g = gg;
    s.b = b;
    s.rough = clamp(0.82 + g * 0.12 - wet * 0.12, 0, 1);
    s.metal = 0;
    s.ao = 1 - fallen * 0.5;
    s.height = clamp(0.7 + g * 0.12 - fallen * 0.5, 0, 1);
  }, { normalStrength: 2.0, ...o });
}

function bakeBrick(o: BakeOptions): MapSet {
  const grain = makeFbm(3101, { octaves: 5, frequency: 20 });
  const wear = makeFbm(3102, { octaves: 4, frequency: 3 });
  const COLS = 6;
  const ROWS = 16;

  return bake((u, v, s) => {
    const { edge, cell } = gridEdge(u, v, COLS, ROWS, 1);
    const mortarW = 0.09;
    const mortar = 1 - smoothstep(clamp(edge / mortarW, 0, 1));
    const g = grain(u, v);
    const w = wear(u, v);

    // Per-brick colour variation across a fired-clay range.
    const h = cellHash(cell);
    const h2 = cellHash(cell, 7);
    // Fired clay is a desaturated red-brown, not pillarbox red; the green and
    // blue channels have to carry real weight or the wall glows.
    const red = lerp(0.15, 0.28, h);
    let r = red * (0.85 + g * 0.3);
    let gg = red * (0.62 + h2 * 0.12) * (0.85 + g * 0.3);
    let b = red * (0.5 + h2 * 0.1) * (0.85 + g * 0.3);

    // Soot and weathering.
    const soot = smoothstep(clamp((w - 0.55) * 3, 0, 1)) * 0.6;
    r = lerp(r, 0.07, soot);
    gg = lerp(gg, 0.065, soot);
    b = lerp(b, 0.06, soot);

    // Pale, crumbling mortar joints.
    const mr = 0.34 + g * 0.1;
    r = lerp(r, mr, mortar);
    gg = lerp(gg, mr * 0.98, mortar);
    b = lerp(b, mr * 0.92, mortar);

    s.r = r;
    s.g = gg;
    s.b = b;
    s.rough = clamp(0.85 + g * 0.12, 0, 1);
    s.metal = 0;
    s.ao = 1 - mortar * 0.55;
    s.height = clamp(0.75 + g * 0.12 - mortar * 0.6, 0, 1);
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

  return bake((u, v, s) => {
    const rustMask = smoothstep(clamp((rustField(u, v) - 0.38) * 3.4, 0, 1));
    const pits = smoothstep(clamp((pit(u, v) - 0.55) * 5, 0, 1)) * rustMask;
    const g = grain(u, v);
    const scratches = scratchField(u, v, scr);

    // Painted steel underneath — a desaturated industrial green-grey.
    let r = 0.085 + g * 0.05;
    let gg = 0.095 + g * 0.05;
    let b = 0.09 + g * 0.05;

    // Rust runs from bright orange at the edge to dark brown in the core.
    const rustHue = rustField(u * 2.4, v * 2.4);
    const rr = lerp(0.36, 0.16, rustHue);
    const rg = lerp(0.14, 0.07, rustHue);
    const rb = lerp(0.05, 0.035, rustHue);
    r = lerp(r, rr, rustMask);
    gg = lerp(gg, rg, rustMask);
    b = lerp(b, rb, rustMask);

    s.r = r;
    s.g = gg;
    s.b = b;
    // Rust is a dielectric oxide — metalness must drop where it has taken hold.
    s.metal = clamp((1 - rustMask) * 0.95, 0, 1);
    s.rough = clamp(lerp(0.42 - scratches * 0.2, 0.93, rustMask) + pits * 0.06, 0.05, 1);
    s.ao = 1 - pits * 0.4 - rustMask * 0.15;
    s.height = clamp(0.62 + g * 0.08 - pits * 0.45 + rustMask * 0.06, 0, 1);
  }, { normalStrength: 2.4, ...o });
}

function bakeGunmetal(o: BakeOptions): MapSet {
  const grain = makeFbm(6101, { octaves: 4, frequency: 90 });
  const scr = makeFbm(6102, { octaves: 3, frequency: 6 });
  const wearField = makeFbm(6103, { octaves: 4, frequency: 4 });

  return bake((u, v, s) => {
    const g = grain(u, v);
    const scratches = scratchField(u, v, scr);
    // Finish wears through on high points, exposing bright bare steel.
    const wear = smoothstep(clamp((wearField(u, v) - 0.66) * 6, 0, 1));

    const base = 0.028 + g * 0.02;
    const bare = 0.24 + g * 0.05;
    const c = lerp(base, bare, Math.max(wear, scratches * 0.7));

    // Cold blue-grey cast typical of phosphate/parkerised finishes.
    s.r = c * 0.96;
    s.g = c * 0.99;
    s.b = c * 1.06;
    s.metal = 1;
    s.rough = clamp(0.52 + g * 0.14 - wear * 0.3 - scratches * 0.28, 0.08, 1);
    s.ao = 1;
    s.height = clamp(0.6 + g * 0.35 - scratches * 0.25, 0, 1);
  }, { normalStrength: 0.9, size: 256, ...o });
}

function bakePolymer(o: BakeOptions): MapSet {
  const pebble = makeFbm(7101, { octaves: 3, frequency: 110 });
  const macro = makeFbm(7102, { octaves: 3, frequency: 6 });
  const scuff = makeFbm(7103, { octaves: 4, frequency: 9 });

  return bake((u, v, s) => {
    // Fine moulded pebble grain — the defining look of modern gun furniture.
    const p = pebble(u, v);
    const cells = Math.pow(p, 1.6);
    const m = macro(u, v);
    const sc = smoothstep(clamp((scuff(u, v) - 0.68) * 6, 0, 1));

    const base = 0.017 + cells * 0.022 + m * 0.008;
    s.r = base;
    s.g = base * 1.02;
    s.b = base * 1.05;

    // Scuffs polish the polymer to a lighter, shinier grey.
    s.r = lerp(s.r, 0.075, sc);
    s.g = lerp(s.g, 0.077, sc);
    s.b = lerp(s.b, 0.08, sc);

    s.metal = 0;
    s.rough = clamp(0.72 - cells * 0.1 - sc * 0.22, 0.15, 1);
    s.ao = 1 - (1 - cells) * 0.12;
    s.height = clamp(0.5 + cells * 0.5, 0, 1);
  }, { normalStrength: 1.1, size: 256, ...o });
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
  const N = 8;

  return bake((u, v, s) => {
    const { edge, cell } = gridEdge(u, v, N, N);
    const grout = 1 - smoothstep(clamp(edge / 0.06, 0, 1));
    const g = grime(u, v);
    const cracks = smoothstep(clamp((craze(u, v) - 0.82) * 12, 0, 1));
    const h = cellHash(cell);

    // Institutional off-white tile, unevenly aged.
    let base = 0.4 + h * 0.08;
    base *= 1 - smoothstep(clamp((g - 0.45) * 2.5, 0, 1)) * 0.55;

    let r = base * 1.0;
    let gg = base * 1.01;
    let b = base * 0.95;

    // A few tiles are missing entirely.
    const missing = h > 0.93 ? 1 : 0;
    r = lerp(r, 0.09, missing);
    gg = lerp(gg, 0.085, missing);
    b = lerp(b, 0.08, missing);

    const groutC = 0.16 + g * 0.06;
    r = lerp(r, groutC, grout);
    gg = lerp(gg, groutC * 0.98, grout);
    b = lerp(b, groutC * 0.94, grout);

    s.r = r;
    s.g = gg;
    s.b = b;
    s.metal = 0;
    s.rough = clamp(lerp(0.22 + cracks * 0.3 + g * 0.2, 0.9, Math.max(grout, missing)), 0.05, 1);
    s.ao = 1 - grout * 0.6 - missing * 0.4;
    s.height = clamp(0.8 - grout * 0.65 - missing * 0.5 - cracks * 0.1, 0, 1);
  }, { normalStrength: 3.0, ...o });
}

function bakePaintedMetal(o: BakeOptions): MapSet {
  const chip = makeFbm(10101, { octaves: 4, frequency: 7 });
  const orange = makeFbm(10102, { octaves: 4, frequency: 30 });
  const dust = makeFbm(10103, { octaves: 4, frequency: 3 });

  return bake((u, v, s) => {
    // Neutral white base — perk machines tint this per-machine so one bake
    // serves all of them.
    const chips = smoothstep(clamp((chip(u, v) - 0.7) * 9, 0, 1));
    const peel = orange(u, v);
    const d = dust(u, v);

    let base = 0.82 - d * 0.12;
    // Chipped areas expose primer then bare steel.
    const exposed = chips;
    let r = lerp(base, 0.13, exposed);
    let g = lerp(base, 0.125, exposed);
    let b = lerp(base, 0.12, exposed);

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = exposed * 0.85;
    // Orange-peel texture in the clearcoat is what sells sprayed metal.
    s.rough = clamp(lerp(0.18 + peel * 0.12 + d * 0.1, 0.7, exposed), 0.04, 1);
    s.ao = 1 - exposed * 0.25;
    s.height = clamp(0.7 + peel * 0.12 - exposed * 0.35, 0, 1);
  }, { normalStrength: 1.5, ...o });
}

function bakeZombieSkin(o: BakeOptions): MapSet {
  const mottle = makeFbm(11101, { octaves: 5, frequency: 6 });
  const pores = makeFbm(11102, { octaves: 3, frequency: 90 });
  const veins = makeFbm(11103, { octaves: 4, frequency: 7, ridged: true });
  const rot = makeFbm(11104, { octaves: 4, frequency: 3 });
  const bruise = makeFbm(11105, { octaves: 3, frequency: 2 });

  return bake((u, v, s) => {
    const m = mottle(u, v);
    const p = pores(u, v);
    const vein = smoothstep(clamp((veins(u, v) - 0.74) * 8, 0, 1));
    const necrosis = smoothstep(clamp((rot(u, v) - 0.5) * 3, 0, 1));
    const br = bruise(u, v);

    // Drained, sallow flesh — desaturated with a sickly green undertone.
    let r = 0.235 + m * 0.11 + p * 0.03;
    let g = 0.215 + m * 0.105 + p * 0.028;
    let b = 0.18 + m * 0.08 + p * 0.022;

    // Necrotic patches go grey-green and dark.
    r = lerp(r, 0.1, necrosis * 0.85);
    g = lerp(g, 0.115, necrosis * 0.85);
    b = lerp(b, 0.085, necrosis * 0.85);

    // Subdermal bruising: purple bleeding under the surface.
    const bruising = smoothstep(clamp((br - 0.55) * 3, 0, 1)) * 0.6;
    r = lerp(r, 0.14, bruising);
    g = lerp(g, 0.08, bruising);
    b = lerp(b, 0.13, bruising);

    // Dark, engorged vessels close to the surface.
    r = lerp(r, 0.075, vein * 0.7);
    g = lerp(g, 0.055, vein * 0.7);
    b = lerp(b, 0.07, vein * 0.7);

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = 0;
    // Wet necrosis is glossier than the dry surrounding skin — this contrast is
    // what stops the model reading as plastic.
    s.rough = clamp(0.78 - necrosis * 0.3 + p * 0.1, 0.18, 1);
    s.ao = 1 - vein * 0.3 - necrosis * 0.2;
    s.height = clamp(0.6 + p * 0.25 - vein * 0.35 - necrosis * 0.15, 0, 1);
  }, { normalStrength: 1.8, ...o });
}

function bakeZombieCloth(o: BakeOptions): MapSet {
  const weave = makeFbm(12101, { octaves: 3, frequency: 120 });
  const dirt = makeFbm(12102, { octaves: 5, frequency: 4 });
  const tear = makeFbm(12103, { octaves: 4, frequency: 3.5, ridged: true });
  const blood = makeFbm(12104, { octaves: 4, frequency: 3 });

  return bake((u, v, s) => {
    // Cross-hatched weave gives cloth its characteristic micro-normal.
    // 64 cycles over a 512px bake keeps the weave above 8 texels per thread —
    // any tighter and it aliases into hard black cracks under mipmapping.
    const warp = Math.abs(Math.sin(u * 64 * Math.PI));
    const weft = Math.abs(Math.sin(v * 64 * Math.PI));
    const cloth = (warp * 0.5 + weft * 0.5) * 0.5 + weave(u, v) * 0.5;

    const d = dirt(u, v);
    // A handful of holes, not an all-over pattern: a high threshold with a
    // soft ramp keeps the garment reading as cloth that has been through
    // something, rather than as camouflage print.
    const rip = smoothstep(clamp((tear(u, v) - 0.93) * 9, 0, 1));
    const bl = smoothstep(clamp((blood(u, v) - 0.66) * 3.2, 0, 1));

    // Faded workwear, filthy. Kept mid-value so the per-zombie tints in
    // ZombieMesh actually read as different garments rather than all black.
    let r = 0.2 + cloth * 0.07;
    let g = 0.205 + cloth * 0.072;
    let b = 0.215 + cloth * 0.075;

    const grime = smoothstep(clamp((d - 0.4) * 2.4, 0, 1)) * 0.7;
    r = lerp(r, 0.09, grime);
    g = lerp(g, 0.081, grime);
    b = lerp(b, 0.066, grime);

    // Dried arterial staining — dark, desaturated, not comic-book red.
    r = lerp(r, 0.085, bl);
    g = lerp(g, 0.016, bl);
    b = lerp(b, 0.014, bl);

    // Torn-through areas darken to shadow.
    r *= 1 - rip * 0.62;
    g *= 1 - rip * 0.62;
    b *= 1 - rip * 0.62;

    s.r = r;
    s.g = g;
    s.b = b;
    s.metal = 0;
    s.rough = clamp(0.94 - bl * 0.18, 0, 1);
    s.ao = 1 - rip * 0.45 - grime * 0.1;
    s.height = clamp(0.62 + cloth * 0.16 - rip * 0.4, 0, 1);
  }, { normalStrength: 1.6, ...o });
}
