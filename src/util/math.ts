/** Small deterministic math helpers shared across generators and gameplay. */

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t: number) => t * t * (3 - 2 * t);
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential smoothing. `rate` is roughly "per second". */
export const damp = (current: number, target: number, rate: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

/** Mulberry32 — tiny, fast, deterministic PRNG so every generated asset is reproducible. */
export class Rng {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number) {
    return lo + this.next() * (hi - lo);
  }
  int(lo: number, hi: number) {
    return Math.floor(this.range(lo, hi + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  chance(p: number) {
    return this.next() < p;
  }
}

/**
 * Tileable 2D value noise. Gradients are hashed on a wrapped lattice so the
 * result tiles seamlessly at `period` — essential for texture maps that repeat
 * across large surfaces without visible seams.
 */
export function makeNoise2D(seed: number) {
  const perm = new Uint8Array(512);
  const rng = new Rng(seed);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  // 8 evenly spaced gradient directions — cheap and free of axis bias.
  const gx = new Float32Array(8);
  const gy = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    gx[i] = Math.cos((i / 8) * TAU);
    gy[i] = Math.sin((i / 8) * TAU);
  }

  return function noise(x: number, y: number, period = 256): number {
    const wrap = (n: number) => ((n % period) + period) % period;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const u = smoothstep(fx);
    const v = smoothstep(fy);

    const dot = (ix: number, iy: number, dx: number, dy: number) => {
      const h = perm[(perm[wrap(ix) & 255] + (wrap(iy) & 255)) & 255] & 7;
      return gx[h] * dx + gy[h] * dy;
    };

    const n00 = dot(x0, y0, fx, fy);
    const n10 = dot(x0 + 1, y0, fx - 1, fy);
    const n01 = dot(x0, y0 + 1, fx, fy - 1);
    const n11 = dot(x0 + 1, y0 + 1, fx - 1, fy - 1);

    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  };
}

export interface FbmOptions {
  octaves?: number;
  frequency?: number;
  lacunarity?: number;
  gain?: number;
  ridged?: boolean;
}

/** Fractal Brownian motion over the tileable noise above. Returns roughly 0..1. */
export function makeFbm(seed: number, opts: FbmOptions = {}) {
  const { octaves = 5, frequency = 4, lacunarity = 2, gain = 0.5, ridged = false } = opts;
  const noise = makeNoise2D(seed);
  return function fbm(u: number, v: number): number {
    let amp = 1;
    let freq = frequency;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      let n = noise(u * freq, v * freq, freq);
      n = ridged ? 1 - Math.abs(n) * 2 : n * 0.5 + 0.5;
      sum += n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };
}
