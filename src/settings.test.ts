import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, modelSignature, normalizeSettings } from './settings'

describe('backend-specific model settings', () => {
  it('uses the smallest verified WASM dtype for each component', () => {
    expect(DEFAULT_SETTINGS.dtype.wasm).toEqual({
      model: 'fp16',
      vision_encoder: 'fp16',
      audio_encoder: 'q4',
    })
    expect(DEFAULT_SETTINGS.dtype.webgpu).toEqual({
      model: 'q4',
      vision_encoder: 'q4',
      audio_encoder: 'q8',
    })
  })

  it('signs indexes with the effective backend dtype', () => {
    const webgpu = modelSignature(DEFAULT_SETTINGS, 'webgpu')
    const wasm = modelSignature(DEFAULT_SETTINGS, 'wasm')
    const fallback = modelSignature(DEFAULT_SETTINGS, 'webgpu', {
      model: 'q4',
      vision_encoder: 'q4',
      audio_encoder: 'q4',
    })

    expect(webgpu).not.toBe(wasm)
    expect(webgpu).not.toBe(fallback)
    expect(JSON.parse(wasm)).toMatchObject({ backend: 'wasm', dtype: DEFAULT_SETTINGS.dtype.wasm })
  })

  it('migrates a saved single-profile dtype configuration', () => {
    const legacyDtype = { model: 'fp16', vision_encoder: 'fp16', audio_encoder: 'fp16' }

    expect(normalizeSettings({ dtype: legacyDtype }).dtype).toEqual({
      webgpu: legacyDtype,
      wasm: legacyDtype,
    })
  })
})
