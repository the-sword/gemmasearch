export type Dtype = 'fp16' | 'q8' | 'q4'

export interface Settings {
  backend: 'auto' | 'wasm'
  modalities: { vision: boolean; audio: boolean }
  dtype: { model: Dtype; vision_encoder: Dtype; audio_encoder: Dtype }
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
  dtype: { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' },
  dim: 256,
  visionTokens: 280,
  videoSegmentSec: 16,
  audioSegmentSec: 30,
  modelHost: 'hf',
  indexSpeed: 'mid',
  lang: 'zh',
}

export function modelSignature(settings: Settings): string {
  return JSON.stringify({
    dtype: settings.dtype,
    dim: settings.dim,
    visionTokens: settings.visionTokens,
  })
}
