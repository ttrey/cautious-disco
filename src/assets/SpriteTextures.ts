import { CanvasTexture, LinearFilter, NoColorSpace, SRGBColorSpace, Texture } from 'three';
import { Rng, TAU, clamp } from '../util/math';

/**
 * Canvas-drawn sprite and decal textures.
 *
 * Effects live or die on their alpha shape, so these are drawn as real
 * gradients and irregular splats rather than solid quads. All are generated
 * once at boot from a fixed seed.
 */

const cache = new Map<string, Texture>();

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, srgb = true): Texture {
  const t = new CanvasTexture(c);
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function memo(key: string, make: () => Texture): Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const t = make();
  cache.set(key, t);
  return t;
}

/** Muzzle flash: a hot core with irregular petals of burning propellant. */
export function muzzleFlashTexture(variant = 0): Texture {
  return memo(`flash${variant}`, () => {
    const S = 256;
    const [c, ctx] = canvas(S);
    const rng = new Rng(9001 + variant * 977);
    ctx.clearRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';

    const cx = S / 2;
    const cy = S / 2;

    // Petals: irregular triangular lobes radiating from the bore.
    const petals = rng.int(5, 8);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * TAU + rng.range(-0.25, 0.25);
      const len = rng.range(S * 0.22, S * 0.47);
      const width = rng.range(0.14, 0.34);
      const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      grad.addColorStop(0, 'rgba(255,246,214,0.95)');
      grad.addColorStop(0.35, 'rgba(255,186,86,0.55)');
      grad.addColorStop(1, 'rgba(255,96,20,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a - width) * len * 0.6, cy + Math.sin(a - width) * len * 0.6);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.lineTo(cx + Math.cos(a + width) * len * 0.6, cy + Math.sin(a + width) * len * 0.6);
      ctx.closePath();
      ctx.fill();
    }

    // Blown-out core.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * 0.2);
    core.addColorStop(0, 'rgba(255,255,248,1)');
    core.addColorStop(0.35, 'rgba(255,220,150,0.8)');
    core.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, S, S);

    return finish(c);
  });
}

/** Soft smoke puff with internal structure. */
export function smokeTexture(): Texture {
  return memo('smoke', () => {
    const S = 128;
    const [c, ctx] = canvas(S);
    const rng = new Rng(4242);
    ctx.clearRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const a = rng.next() * TAU;
      const r = rng.range(0, S * 0.24);
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r;
      const rad = rng.range(S * 0.1, S * 0.26);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const v = rng.range(0.5, 0.85);
      g.addColorStop(0, `rgba(${v * 255 | 0},${v * 250 | 0},${v * 240 | 0},0.16)`);
      g.addColorStop(1, 'rgba(120,116,110,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
    // Fade hard at the edges so the quad boundary never shows.
    const mask = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S * 0.5);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, S, S);
    return finish(c);
  });
}

/** Round hot spark, used for metal impacts and tracer heads. */
export function sparkTexture(): Texture {
  return memo('spark', () => {
    const S = 64;
    const [c, ctx] = canvas(S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.25, 'rgba(255,214,140,0.85)');
    g.addColorStop(0.6, 'rgba(255,130,40,0.3)');
    g.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return finish(c);
  });
}

/** Irregular blood splat with satellite droplets — used for hit bursts. */
export function bloodSplatTexture(variant = 0): Texture {
  return memo(`blood${variant}`, () => {
    const S = 256;
    const [c, ctx] = canvas(S);
    const rng = new Rng(777 + variant * 313);
    ctx.clearRect(0, 0, S, S);

    const blob = (x: number, y: number, r: number, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(96,10,8,${alpha})`);
      g.addColorStop(0.62, `rgba(64,6,6,${alpha * 0.92})`);
      g.addColorStop(1, 'rgba(40,4,4,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      // Wobble the outline so it never reads as a circle.
      const pts = 22;
      for (let i = 0; i <= pts; i++) {
        const a = (i / pts) * TAU;
        const rr = r * (0.68 + rng.range(0, 0.34));
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    };

    blob(S / 2, S / 2, S * 0.3, 0.95);
    for (let i = 0; i < 16; i++) {
      const a = rng.next() * TAU;
      const d = rng.range(S * 0.2, S * 0.46);
      blob(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, rng.range(S * 0.02, S * 0.075), 0.85);
    }
    // Runs and drips off the main mass.
    ctx.strokeStyle = 'rgba(70,7,7,0.7)';
    for (let i = 0; i < 6; i++) {
      const a = rng.next() * TAU;
      ctx.lineWidth = rng.range(1.5, 5);
      ctx.beginPath();
      ctx.moveTo(S / 2 + Math.cos(a) * S * 0.24, S / 2 + Math.sin(a) * S * 0.24);
      ctx.lineTo(S / 2 + Math.cos(a) * S * 0.44, S / 2 + Math.sin(a) * S * 0.44);
      ctx.stroke();
    }
    return finish(c);
  });
}

/** Bullet hole: dark punched core with a bright cratered rim. */
export function bulletHoleTexture(): Texture {
  return memo('hole', () => {
    const S = 128;
    const [c, ctx] = canvas(S);
    const rng = new Rng(31337);
    ctx.clearRect(0, 0, S, S);

    // Dust ring.
    const ring = ctx.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S * 0.48);
    ring.addColorStop(0, 'rgba(180,172,160,0.55)');
    ring.addColorStop(0.55, 'rgba(120,114,105,0.28)');
    ring.addColorStop(1, 'rgba(90,86,80,0)');
    ctx.fillStyle = ring;
    ctx.fillRect(0, 0, S, S);

    // Punched core with a chipped outline.
    ctx.fillStyle = 'rgba(12,10,9,0.96)';
    ctx.beginPath();
    for (let i = 0; i <= 20; i++) {
      const a = (i / 20) * TAU;
      const r = S * rng.range(0.11, 0.16);
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // Radial cracks.
    ctx.strokeStyle = 'rgba(30,27,24,0.5)';
    for (let i = 0; i < 7; i++) {
      const a = rng.next() * TAU;
      ctx.lineWidth = rng.range(0.8, 2.2);
      ctx.beginPath();
      ctx.moveTo(S / 2, S / 2);
      ctx.lineTo(S / 2 + Math.cos(a) * S * rng.range(0.2, 0.4), S / 2 + Math.sin(a) * S * rng.range(0.2, 0.4));
      ctx.stroke();
    }
    return finish(c);
  });
}

/** Ground blood pool decal — flatter and darker than the airborne splat. */
export function bloodPoolTexture(): Texture {
  return memo('pool', () => {
    const S = 256;
    const [c, ctx] = canvas(S);
    const rng = new Rng(5150);
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath();
    const pts = 40;
    for (let i = 0; i <= pts; i++) {
      const a = (i / pts) * TAU;
      const r = S * 0.4 * (0.62 + 0.38 * Math.abs(Math.sin(a * 2.7 + rng.range(0, 0.4))));
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r * 0.88;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.45);
    g.addColorStop(0, 'rgba(52,5,5,0.95)');
    g.addColorStop(0.7, 'rgba(38,4,4,0.8)');
    g.addColorStop(1, 'rgba(26,3,3,0)');
    ctx.fillStyle = g;
    ctx.fill();
    return finish(c);
  });
}

/** Soft round falloff — light cookies, glow cards, dust motes. */
export function glowTexture(): Texture {
  return memo('glow', () => {
    const S = 128;
    const [c, ctx] = canvas(S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return finish(c);
  });
}

/**
 * Soft elliptical contact shadow — black core, feathered edge, alpha falloff.
 *
 * Used as a normal-blended darkening card: the RGB stays black everywhere and
 * the alpha gradient does all the work, so whatever is behind it loses a
 * fraction of its brightness in the centre and none at the rim. Drawn wider
 * than tall because the shadow it stands in for (a weapon held against the
 * body) spreads horizontally across the torso.
 */
export function contactShadowTexture(): Texture {
  return memo('contactShadow', () => {
    const S = 128;
    const [c, ctx] = canvas(S);
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.9)');
    g.addColorStop(0.45, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    // Stretch the falloff horizontally for the wide, low shape of a shouldered
    // weapon's occlusion zone.
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.scale(1.35, 1);
    ctx.translate(-S / 2, -S / 2);
    ctx.fillRect(0, 0, S, S);
    ctx.restore();
    return finish(c);
  });
}

/** Simple text label baked to a texture — perk machine and wall-buy signage. */
export function labelTexture(
  lines: string[],
  opts: { width?: number; height?: number; color?: string; bg?: string; font?: string; size?: number } = {},
): Texture {
  const w = opts.width ?? 512;
  const h = opts.height ?? 256;
  const size = opts.size ?? Math.floor(h / (lines.length + 1));
  const color = opts.color ?? '#f4e4c1';
  const bg = opts.bg ?? 'rgba(0,0,0,0)';
  const font = opts.font ?? '700';
  const key = `label:${JSON.stringify([lines, w, h, color, bg, font, size])}`;

  return memo(key, () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${font} ${size}px "Rajdhani", "Oswald", sans-serif`;
    const step = h / (lines.length + 1);
    lines.forEach((line, i) => {
      ctx.fillText(line, w / 2, step * (i + 1), w * 0.92);
    });
    const t = new CanvasTexture(c);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  });
}

/** Clamps a 0..1 value into a byte for inline canvas colour strings. */
export const byte = (v: number) => Math.round(clamp(v, 0, 1) * 255);
