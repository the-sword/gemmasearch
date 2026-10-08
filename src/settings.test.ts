import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  estimateModelDownloadMB,
  modelSignature,
  normalizeSettings,
  planEngine,
  WEIGHT_PROFILES,
  type Settings,
} from './settings'

describe('unified model weight settings', () => {
  it('defines the shared standard and GPU-lite profiles', () => {
    expect(WEIGHT_PROFILES).toEqual({
      standard: { model: 'fp16', vision_encoder: 'fp16', audio_encoder: 'q8' },
      'gpu-lite': { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' },
    })
    expect(DEFAULT_SETTINGS.weights).toBe('standard')
  })

  it.each([
    { dtype: { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' } },
    {
      dtype: {
        webgpu: { model: 'q4', vision_encoder: 'q4', audio_encoder: 'q8' },
        wasm: { model: 'fp16', vision_encoder: 'fp16', audio_encoder: 'q4' },
      },
    },
  ])('migrates legacy dtype profiles to standard weights and drops dtype', (legacy) => {
    const settings = normalizeSettings({ ...legacy, weights: 'gpu-lite' })

    expect(settings.weights).toBe('standard')
    expect('dtype' in settings).toBe(false)
  })

  it('keeps standard signatures equal across devices and separates weight profiles', () => {
    const webgpuSettings = { ...DEFAULT_SETTINGS, backend: 'auto' as const }
    const wasmSettings = { ...DEFAULT_SETTINGS, backend: 'wasm' as const }
    const standardWebGPU = modelSignature(webgpuSettings, WEIGHT_PROFILES.standard)
    const standardWasm = modelSignature(wasmSettings, WEIGHT_PROFILES.standard)
    const gpuLite = modelSignature(webgpuSettings, WEIGHT_PROFILES['gpu-lite'])

    expect(standardWebGPU).toBe(standardWasm)
    expect(standardWebGPU).not.toBe(gpuLite)
    expect(JSON.parse(standardWebGPU)).toEqual({
      dtype: WEIGHT_PROFILES.standard,
      dim: DEFAULT_SETTINGS.dim,
      visionTokens: DEFAULT_SETTINGS.visionTokens,
    })
  })

  it.each([
    [
      { backend: 'auto', weights: 'standard', hasWebGPU: true, shaderF16: true },
      { device: 'webgpu', profile: 'standard' },
    ],
    [
      { backend: 'auto', weights: 'standard', hasWebGPU: true, shaderF16: false },
      { device: 'wasm', profile: 'standard', reason: 'GPU 不支持 shader-f16，改用 CPU 运行同一套权重' },
    ],
    [
      { backend: 'auto', weights: 'standard', hasWebGPU: false, shaderF16: false },
      { device: 'wasm', profile: 'standard' },
    ],
    [
      { backend: 'wasm', weights: 'standard', hasWebGPU: true, shaderF16: true },
      { device: 'wasm', profile: 'standard' },
    ],
    [
      { backend: 'auto', weights: 'gpu-lite', hasWebGPU: true, shaderF16: true },
      { device: 'webgpu', profile: 'gpu-lite' },
    ],
    [
      { backend: 'auto', weights: 'gpu-lite', hasWebGPU: true, shaderF16: false },
      { device: 'webgpu', profile: 'gpu-lite' },
    ],
    [
      { backend: 'auto', weights: 'gpu-lite', hasWebGPU: false, shaderF16: false },
      { device: 'wasm', profile: 'standard', reason: 'CPU 无法加载轻量权重，已改用标准权重（需重建索引）' },
    ],
    [
      { backend: 'wasm', weights: 'gpu-lite', hasWebGPU: true, shaderF16: true },
      { device: 'wasm', profile: 'standard', reason: 'CPU 无法加载轻量权重，已改用标准权重（需重建索引）' },
    ],
  ] as const)('plans an effective backend and profile for %o', (input, expected) => {
    expect(planEngine(input)).toEqual(expected)
  })

  it('estimates downloads from the selected weights and enabled modalities', () => {
    const allOn: Settings['modalities'] = { vision: true, audio: true }

    expect(estimateModelDownloadMB('standard', allOn)).toBe(1218.4)
    expect(estimateModelDownloadMB('gpu-lite', allOn)).toBe(624)
    expect(estimateModelDownloadMB('standard', { vision: false, audio: true })).toBe(882.8)
    expect(estimateModelDownloadMB('gpu-lite', { vision: false, audio: true })).toBe(514.8)
    expect(estimateModelDownloadMB('standard', { vision: true, audio: false })).toBe(878.1)
    expect(estimateModelDownloadMB('gpu-lite', { vision: true, audio: false })).toBe(283.7)
  })
})
