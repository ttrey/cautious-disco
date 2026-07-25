import {
  Color,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MeshStandardMaterialParameters,
  Texture,
  Vector2,
} from 'three';
import { MapSet, SurfaceId, surface } from './TextureForge';

/**
 * Material library.
 *
 * Textures from the forge are baked once and shared; only lightweight texture
 * *views* (clones sharing the same image) are created per tiling rate, so a
 * hundred walls at different scales still cost one bake.
 */

export interface SurfaceOptions {
  /** Texture repeats across the mesh's UV space. */
  repeat?: number | [number, number];
  /** Multiplies the baked albedo — lets one bake serve many colourways. */
  tint?: number | Color;
  /** Scales the baked roughness map. */
  roughness?: number;
  /** Scales the baked metalness map. */
  metalness?: number;
  normalScale?: number;
  aoIntensity?: number;
  emissive?: number | Color;
  emissiveIntensity?: number;
  /** Use MeshPhysicalMaterial and add a clearcoat layer (paint, wet surfaces). */
  clearcoat?: number;
  clearcoatRoughness?: number;
  extra?: MeshStandardMaterialParameters;
}

const viewCache = new Map<string, Texture>();

/** Returns a texture clone configured for a given tiling rate. */
function view(tex: Texture, rx: number, ry: number): Texture {
  const key = `${tex.uuid}:${rx}:${ry}`;
  const hit = viewCache.get(key);
  if (hit) return hit;
  const clone = tex.clone();
  clone.repeat.set(rx, ry);
  clone.needsUpdate = true;
  viewCache.set(key, clone);
  return clone;
}

function applyMaps(params: MeshStandardMaterialParameters, maps: MapSet, rx: number, ry: number) {
  params.map = view(maps.map, rx, ry);
  params.normalMap = view(maps.normalMap, rx, ry);
  params.roughnessMap = view(maps.roughnessMap, rx, ry);
  params.metalnessMap = view(maps.metalnessMap, rx, ry);
  params.aoMap = view(maps.aoMap, rx, ry);
}

export function makeSurface(id: SurfaceId, opts: SurfaceOptions = {}): MeshStandardMaterial {
  const maps = surface(id);
  const rep = opts.repeat ?? 1;
  const [rx, ry] = Array.isArray(rep) ? rep : [rep, rep];

  const params: MeshStandardMaterialParameters = {
    color: new Color(opts.tint ?? 0xffffff),
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 1,
    envMapIntensity: 1,
  };
  applyMaps(params, maps, rx, ry);

  if (opts.emissive !== undefined) {
    params.emissive = new Color(opts.emissive);
    params.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }

  const mat =
    opts.clearcoat !== undefined
      ? new MeshPhysicalMaterial({
          ...params,
          clearcoat: opts.clearcoat,
          clearcoatRoughness: opts.clearcoatRoughness ?? 0.15,
          ...opts.extra,
        })
      : new MeshStandardMaterial({ ...params, ...opts.extra });

  mat.normalScale = new Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1);
  mat.aoMapIntensity = opts.aoIntensity ?? 1;
  return mat;
}

/* ------------------------------------------------------------------ */
/* Named presets — keeps art direction consistent across the codebase. */
/* ------------------------------------------------------------------ */

export const Presets = {
  /** Weapon receivers, barrels, slides. */
  gunSteel: (tint = 0xffffff) =>
    makeSurface('gunmetal', { repeat: 1, tint, roughness: 1, metalness: 1, normalScale: 0.6 }),

  /** Bright machined parts — bolts, triggers, pins. */
  brightSteel: (tint = 0xb9bec6) =>
    makeSurface('gunmetal', {
      repeat: 1,
      tint,
      roughness: 0.62,
      metalness: 1,
      normalScale: 0.4,
    }),

  /** Rails, handguards, pistol frames. */
  gunPolymer: (tint = 0xffffff) =>
    makeSurface('polymer', { repeat: 1, tint, roughness: 1, metalness: 0, normalScale: 0.45 }),

  /** Rifle stocks and grips. */
  stockWood: (tint = 0xffffff) =>
    makeSurface('gunWood', {
      repeat: 1,
      tint,
      roughness: 0.95,
      metalness: 0,
      normalScale: 0.7,
      clearcoat: 0.5,
      clearcoatRoughness: 0.35,
    }),

  brass: () =>
    makeSurface('gunmetal', {
      repeat: 1,
      tint: 0xc9a227,
      roughness: 0.42,
      metalness: 1,
      normalScale: 0.3,
    }),
} as const;
