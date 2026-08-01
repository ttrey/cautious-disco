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
    shadowMapSize: 512,
    scopeSize: 480,
    scopeCadence: 2,
    textureScale: 0.75,
    anisotropy: 4,
  },
  high: {
    preset: 'high',
    maxPixelRatio: 2,
    antialias: true,
    bloom: true,
    shadows: true,
    shadowMapSize: 1024,
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

  if ((memory !== undefined && memory <= 4) || cores <= 4) return PRESETS.low;
  if ((memory !== undefined && memory <= 8) || cores <= 8 || coarsePointer) return PRESETS.medium;
  return PRESETS.high;
}
