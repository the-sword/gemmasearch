export type Dtype = 'fp16' | 'q8' | 'q4' | 'q4f16'
export type DtypeProfile = { model: Dtype; vision_encoder: Dtype; audio_encoder: Dtype }
export type WeightProfile = 'standard' | 'gpu-lite'
export type EffectiveBackend = 'webgpu' | 'wasm'
export type ModelHostSetting = 'auto' | 'mirror'
export type ResolvedModelHost = 'huggingface.co' | 'hf-mirror.com'

export interface Settings {
  backend: 'auto' | 'wasm'
  modalities: { vision: boolean; audio: boolean }
  weights: WeightProfile
  dim: 768 | 512 | 256 | 128
  visionTokens: 70 | 140 | 280 | 560 | 1120
  videoSegmentSec: 8 | 16
  audioSegmentSec: 30 | 60
  modelHost: ModelHostSetting
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
  modelHost: 'auto',
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
  const modelHost: ModelHostSetting = normalized.modelHost === 'mirror' ? 'mirror' : 'auto'

  return {
    ...DEFAULT_SETTINGS,
    ...normalized,
    weights,
    modelHost,
    modalities: {
      ...DEFAULT_SETTINGS.modalities,
      ...(normalized.modalities && typeof normalized.modalities === 'object'
        ? normalized.modalities as Partial<Settings['modalities']>
        : {}),
    },
  } as Settings
}

const HF_MODEL_CONFIG_URL = 'https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json'
const MIRROR_MODEL_CONFIG_URL = 'https://hf-mirror.com/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json'

async function hasCachedModelFile(url: string): Promise<boolean> {
  try {
    return Boolean(await (await caches.open('transformers-cache')).match(url))
  } catch {
    return false
  }
}

export async function resolveModelHost(
  modelHost: ModelHostSetting,
  fetchFn: typeof fetch = fetch,
  hasCached: (url: string) => Promise<boolean> = hasCachedModelFile,
): Promise<ResolvedModelHost> {
  if (modelHost === 'mirror') return 'hf-mirror.com'
  for (const [url, host] of [
    [HF_MODEL_CONFIG_URL, 'huggingface.co'],
    [MIRROR_MODEL_CONFIG_URL, 'hf-mirror.com'],
  ] as const) {
    try {
      if (await hasCached(url)) return host
    } catch {
      // Cache access can fail in private or restricted browsing contexts.
    }
  }
  try {
    const response = await fetchFn(
      HF_MODEL_CONFIG_URL,
      { method: 'GET', cache: 'no-store', signal: AbortSignal.timeout(6000) },
    )
    return response.ok ? 'huggingface.co' : 'hf-mirror.com'
  } catch {
    return 'hf-mirror.com'
  }
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
