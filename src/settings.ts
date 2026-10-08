export type Dtype = 'fp16' | 'q8' | 'q4' | 'q4f16'
export type DtypeProfile = { model: Dtype; vision_encoder: Dtype; audio_encoder: Dtype }
export type WeightProfile = 'standard' | 'gpu-lite'
export type EffectiveBackend = 'webgpu' | 'wasm'

export interface Settings {
  backend: 'auto' | 'wasm'
  modalities: { vision: boolean; audio: boolean }
  weights: WeightProfile
  dim: 768 | 512 | 256 | 128
  visionTokens: 70 | 140 | 280 | 560 | 1120
  videoSegmentSec: 8 | 16
  audioSegmentSec: 30 | 60
  modelHost: 'hf' | 'mirror'
  indexSpeed: 'low' | 'mid' | 'high'
  lang: 'zh' | 'en'
}

export const DEFAULT_SETTINGS: Settings = {
  backend: 'auto',
  modalities: { vision: true, audio: true },
  weights: 'standard',
  dim: 256,
  visionTokens: 280,
  videoSegmentSec: 16,
  audioSegmentSec: 30,
  modelHost: 'hf',
  indexSpeed: 'mid',
  lang: 'zh',
}

export const WEIGHT_PROFILES: Record<WeightProfile, DtypeProfile> = {
  standard: { model: 'fp16', vision_encoder: 'fp16', audio_encoder: 'q8' },
  'gpu-lite': { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' },
}

const DOWNLOAD_SIZES_MB: Record<WeightProfile, { model: number; vision: number; audio: number }> = {
  standard: { model: 542.5, vision: 335.6, audio: 340.3 },
  'gpu-lite': { model: 174.5, vision: 109.2, audio: 340.3 },
}

export function normalizeSettings(value: unknown): Settings {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const normalized = { ...saved }
  const hasLegacyDtype = Object.prototype.hasOwnProperty.call(normalized, 'dtype')
  delete normalized.dtype
  const weights: WeightProfile = hasLegacyDtype
    ? 'standard'
    : normalized.weights === 'gpu-lite'
      ? 'gpu-lite'
      : 'standard'

  return {
    ...DEFAULT_SETTINGS,
    ...normalized,
    weights,
    modalities: {
      ...DEFAULT_SETTINGS.modalities,
      ...(normalized.modalities && typeof normalized.modalities === 'object'
        ? normalized.modalities as Partial<Settings['modalities']>
        : {}),
    },
  } as Settings
}

export function modelSignature(
  settings: Settings,
  effectiveDtype: DtypeProfile = WEIGHT_PROFILES[settings.weights],
): string {
  return JSON.stringify({
    dtype: effectiveDtype,
    dim: settings.dim,
    visionTokens: settings.visionTokens,
  })
}

export function estimateModelDownloadMB(
  weights: WeightProfile,
  modalities: Settings['modalities'],
): number {
  const sizes = DOWNLOAD_SIZES_MB[weights]
  return sizes.model + (modalities.vision ? sizes.vision : 0) + (modalities.audio ? sizes.audio : 0)
}

export function planEngine({
  backend,
  weights,
  hasWebGPU,
  shaderF16,
}: {
  backend: Settings['backend']
  weights: WeightProfile
  hasWebGPU: boolean
  shaderF16: boolean
}): { device: EffectiveBackend; profile: WeightProfile; reason?: string } {
  if (weights === 'standard') {
    if (backend === 'auto' && hasWebGPU && shaderF16) return { device: 'webgpu', profile: 'standard' }
    if (backend === 'auto' && hasWebGPU) {
      return {
        device: 'wasm',
        profile: 'standard',
        reason: 'GPU 不支持 shader-f16，改用 CPU 运行同一套权重',
      }
    }
    return { device: 'wasm', profile: 'standard' }
  }

  if (backend === 'auto' && hasWebGPU) return { device: 'webgpu', profile: 'gpu-lite' }
  return {
    device: 'wasm',
    profile: 'standard',
    reason: 'CPU 无法加载轻量权重，已改用标准权重（需重建索引）',
  }
}
