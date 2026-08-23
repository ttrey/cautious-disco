export type QualityPreset = 'low' | 'medium' | 'high';
export type QualityPreference = 'auto' | QualityPreset;

export interface QualitySettings {
  preset: QualityPreset;
  maxPixelRatio: number;
  antialias: boolean;
  bloom: boolean;
  shadows: boolean;
  shadowMapSize: number;
  scopeSize: number;
  scopeCadence: number;
  textureScale: number;
  anisotropy: number;
}

const PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    preset: 'low',
    maxPixelRatio: 1,
    antialias: false,
    bloom: false,
    shadows: false,
    shadowMapSize: 256,
    scopeSize: 320,
    scopeCadence: 3,
    textureScale: 0.5,
    anisotropy: 2,
  },
  medium: {
    preset: 'medium',
    maxPixelRatio: 1.5,
    antialias: true,
    bloom: true,
    shadows: true,
    // 1024 keeps practical shadows from visibly stair-stepping at mid tier
    // without doubling the shadow-fill cost of the skinned horde.
    shadowMapSize: 1024,
    scopeSize: 480,
    scopeCadence: 2,
    textureScale: 0.75,
    anisotropy: 4,
  },
  high: {
    preset: 'high',
    // Modern GPUs hold a full 2x DPR buffer for the terminal's static
    // geometry, and the extra pixels are what make tight speculars and thin
    // sodium fixtures read as premium rather than soft. The adaptive
    // resolution loop is the safety valve: it steps the render scale down on
    // sustained sub-50 fps frames, so the ceiling can sit at native DPR.
    maxPixelRatio: 2,
    antialias: true,
    bloom: true,
    shadows: true,
    // 2048 matches the raised pixel ratio: contact shadows from the practical
    // lamps stay crisp on the concrete instead of blurring into the haze.
    shadowMapSize: 2048,
    scopeSize: 640,
    scopeCadence: 1,
    textureScale: 1,
    anisotropy: 8,
  },
};

/** Resolves Auto once, before any renderer or procedural texture is created. */
export function resolveQuality(preference: QualityPreference): QualitySettings {
  if (preference !== 'auto') return PRESETS[preference];

  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency || 4;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;

  // Four-core machines are common with a discrete GPU. Keep them in the
  // authored medium tier unless memory is genuinely constrained; the low tier
  // removes both shadows and bloom and makes the shipped baseline look flat.
  if ((memory !== undefined && memory <= 4) || cores <= 2) return PRESETS.low;
  if ((memory !== undefined && memory <= 8) || cores <= 8 || coarsePointer) return PRESETS.medium;
  return PRESETS.high;
}
