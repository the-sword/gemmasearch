import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  estimateModelDownloadMB,
  modelSignature,
  normalizeSettings,
  planEngine,
  resolveModelHost,
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
    expect(DEFAULT_SETTINGS.modelHost).toBe('auto')
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

  it.each([
    [{ modelHost: 'hf' }, 'auto'],
    [{}, 'auto'],
    [{ modelHost: 'mirror' }, 'mirror'],
  ] as const)('migrates model host setting %o to %s', (saved, expected) => {
    expect(normalizeSettings(saved).modelHost).toBe(expected)
  })

  it('uses Hugging Face when its model config probe succeeds', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response)
    const hasCached = vi.fn(async () => false)

    await expect(resolveModelHost('auto', fetchFn, hasCached)).resolves.toBe('huggingface.co')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }),
    )
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(hasCached).toHaveBeenCalledWith(
      'https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json',
    )
    expect(hasCached).toHaveBeenCalledWith(
      'https://hf-mirror.com/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json',
    )
  })

  it('falls back to the mirror on a non-ok response or a failed probe', async () => {
    await expect(
      resolveModelHost(
        'auto',
        vi.fn<typeof fetch>().mockResolvedValue({ ok: false } as Response),
        async () => false,
      ),
    ).resolves.toBe('hf-mirror.com')
    await expect(
      resolveModelHost(
        'auto',
        vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError')),
        async () => false,
      ),
    ).resolves.toBe('hf-mirror.com')
    await expect(
      resolveModelHost('auto', vi.fn<typeof fetch>().mockResolvedValue({ ok: true } as Response), async () => {
        throw new Error('cache unavailable')
      }),
    ).resolves.toBe('huggingface.co')
  })

  it.each([
    ['https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json', 'huggingface.co'],
    ['https://hf-mirror.com/onnx-community/embeddinggemma-2-ONNX/resolve/main/config.json', 'hf-mirror.com'],
  ] as const)('uses cached model metadata from %s without a network probe', async (cachedUrl, expectedHost) => {
    const fetchFn = vi.fn<typeof fetch>()
    const hasCached = vi.fn(async (url: string) => url === cachedUrl)

    await expect(resolveModelHost('auto', fetchFn, hasCached)).resolves.toBe(expectedHost)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not probe Hugging Face when the mirror is selected', async () => {
    const fetchFn = vi.fn<typeof fetch>()
    const hasCached = vi.fn(async () => false)

    await expect(resolveModelHost('mirror', fetchFn, hasCached)).resolves.toBe('hf-mirror.com')
    expect(fetchFn).not.toHaveBeenCalled()
    expect(hasCached).not.toHaveBeenCalled()
  })
})
