export type Dtype = 'fp16' | 'q8' | 'q4' | 'q4f16'
export type DtypeProfile = { model: Dtype; vision_encoder: Dtype; audio_encoder: Dtype }
export type EffectiveBackend = 'webgpu' | 'wasm'

export interface Settings {
  backend: 'auto' | 'wasm'
  modalities: { vision: boolean; audio: boolean }
  dtype: { webgpu: DtypeProfile; wasm: DtypeProfile }
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
  dtype: {
    webgpu: { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' },
    wasm: { model: 'fp16', vision_encoder: 'fp16', audio_encoder: 'q4' },
  },
  dim: 256,
  visionTokens: 280,
  videoSegmentSec: 16,
  audioSegmentSec: 30,
  modelHost: 'hf',
  indexSpeed: 'mid',
  lang: 'zh',
}

export function normalizeSettings(value: unknown): Settings {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const savedDtype = saved.dtype && typeof saved.dtype === 'object'
    ? saved.dtype as Record<string, unknown>
    : {}
  const hasBackendProfiles = 'webgpu' in savedDtype || 'wasm' in savedDtype
  const oldProfile = savedDtype as Partial<DtypeProfile>
  const webgpuProfile = savedDtype.webgpu && typeof savedDtype.webgpu === 'object'
    ? savedDtype.webgpu as Partial<DtypeProfile>
    : {}
  const wasmProfile = savedDtype.wasm && typeof savedDtype.wasm === 'object'
    ? savedDtype.wasm as Partial<DtypeProfile>
    : {}

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    modalities: {
      ...DEFAULT_SETTINGS.modalities,
      ...(saved.modalities && typeof saved.modalities === 'object'
        ? saved.modalities as Partial<Settings['modalities']>
        : {}),
    },
    dtype: hasBackendProfiles
      ? {
          webgpu: { ...DEFAULT_SETTINGS.dtype.webgpu, ...webgpuProfile },
          wasm: { ...DEFAULT_SETTINGS.dtype.wasm, ...wasmProfile },
        }
      : {
          webgpu: { ...DEFAULT_SETTINGS.dtype.webgpu, ...oldProfile },
          wasm: { ...DEFAULT_SETTINGS.dtype.wasm, ...oldProfile },
        },
  } as Settings
}

export function modelSignature(
  settings: Settings,
  backend: EffectiveBackend = settings.backend === 'wasm' ? 'wasm' : 'webgpu',
  effectiveDtype: DtypeProfile = settings.dtype[backend],
): string {
  return JSON.stringify({
    backend,
    dtype: effectiveDtype,
    dim: settings.dim,
    visionTokens: settings.visionTokens,
  })
}
