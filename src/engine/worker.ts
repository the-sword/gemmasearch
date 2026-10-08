/// <reference lib="webworker" />
import {
  AutoConfig,
  AutoModel,
  AutoProcessor,
  RawImage,
  RawVideo,
  RawVideoFrame,
  env,
} from '@huggingface/transformers'
import type { Processor, PreTrainedModel } from '@huggingface/transformers'
import type { SearchItem, Modality, VideoMode } from '../host/types'
import {
  modelSignature,
  planEngine,
  WEIGHT_PROFILES,
  type DtypeProfile,
  type EffectiveBackend,
  type Settings,
  type WeightProfile,
} from '../settings'
import { float16ToFloat32, float32ToFloat16, meanNormalize, topK, truncateNormalize, calibrateAudioScore } from './vec'
import { getItems, listLibraries, removeFileRecords, removeLibrary, saveItem } from './store'
import type { EmbedInput, EngineStatus, ImageInput, PersistMeta, SearchHit, SearchOptions, WorkerRequest, WorkerResponse } from './protocol'

const MODEL_ID = 'onnx-community/embeddinggemma-2-ONNX'
const workerScope = self as DedicatedWorkerGlobalScope
let processor: Processor | undefined
let model: PreTrainedModel | undefined
let currentSettings: Settings | undefined
let currentModelSignature: string | undefined
let backend: 'webgpu' | 'wasm' = 'wasm'
let vectorItems: Array<SearchItem & { id: number }> | undefined
let vectorMatrix: Float32Array | undefined
const activeRequests = new Set<number>()
const cancelledRequests = new Set<number>()
let videoTokenBudgetLogged = false

function disposeModel(): void {
  (model as unknown as { dispose?: () => void } | undefined)?.dispose?.()
  model = undefined
}

function toArrayBuffer(values: Uint16Array): ArrayBuffer {
  return values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength) as ArrayBuffer
}

function checkCancelled(id: number): void {
  if (cancelledRequests.delete(id)) throw new DOMException('请求已取消', 'AbortError')
}

function send(message: WorkerResponse): void {
  workerScope.postMessage(message)
}

function report(id: number, progress: number, file?: string, status?: string): void {
  send({ id, type: 'progress', progress, file, status })
}

function toRawImage(image: ImageInput): RawImage {
  return new RawImage(image.data, image.width, image.height, 4)
}

function rawVideo(input: Extract<EmbedInput, { kind: 'video' }>): RawVideo {
  const frames = input.frames.map((frame) => new RawVideoFrame(toRawImage(frame), frame.timestamp))
  return new RawVideo(frames, input.duration)
}

function makeInput(input: EmbedInput): [unknown, unknown?, unknown?, unknown?] {
  switch (input.kind) {
    case 'text':
      return [`${input.role === 'query' ? 'task: search result | query: ' : `title: ${input.title || 'none'} | text: `}${input.text}`]
    case 'text-batch':
      return [input.items.map((item) => `title: ${item.title || 'none'} | text: ${item.text}`)]
    case 'image':
      return [null, [toRawImage(input)]]
    case 'images':
      return [null, input.images.map((image) => [toRawImage(image)])]
    case 'video':
      return [null, null, null, [rawVideo(input)]]
    case 'audio':
      return [null, null, [input.pcm]]
    case 'mixed':
      return [`task: search result | query: ${input.text} <|image|>`, [[toRawImage(input)]]]
  }
}

async function runModelVectors(input: EmbedInput, id: number): Promise<Float32Array[]> {
  checkCancelled(id)
  if (!currentSettings || !processor || !model) throw new Error('引擎尚未初始化')
  const args = makeInput(input)
  const prepared = await (processor as (...values: unknown[]) => Promise<unknown>)(...args)
  checkCancelled(id)
  if (input.kind === 'video' && !videoTokenBudgetLogged) {
    const videoFeatures = prepared as { num_soft_tokens_per_video?: number[]; num_frames_per_video?: number[] }
    const tokensPerFrame = videoFeatures.num_soft_tokens_per_video?.[0]
    const frameCount = videoFeatures.num_frames_per_video?.[0] ?? input.frames.length
    console.info('[GemmaSearch] video soft-token budget', {
      tokensPerFrame,
      frameCount,
      totalTokens: tokensPerFrame === undefined ? undefined : tokensPerFrame * frameCount,
    })
    videoTokenBudgetLogged = true
  }
  const output = await (model as (input: unknown) => Promise<{ sentence_embedding?: { data: ArrayLike<number>; dims?: number[] } }>)(prepared)
  checkCancelled(id)
  const embedding = output.sentence_embedding
  if (!embedding?.data) throw new Error('模型未返回 sentence_embedding')
  const dims = currentSettings.dim
  const batchCount = embedding.dims?.[0] ?? 1
  const sourceDimensions = embedding.dims?.at(-1) ?? embedding.data.length
  const vectors: Float32Array[] = []
  for (let index = 0; index < batchCount; index += 1) {
    vectors.push(truncateNormalize(Array.from({ length: sourceDimensions }, (_, dimension) => embedding.data[index * sourceDimensions + dimension] ?? 0), dims))
  }
  return vectors
}

function isWasmBadAlloc(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('std::bad_alloc')
}

async function getVectorsDetailed(
  input: EmbedInput,
  id: number,
): Promise<{ vectors: Float32Array[]; videoMode?: VideoMode }> {
  if (input.kind !== 'video') return { vectors: await runModelVectors(input, id) }
  try {
    return { vectors: await runModelVectors(input, id), videoMode: 'native' }
  } catch (error) {
    if (backend !== 'wasm' || !isWasmBadAlloc(error)) throw error
    console.warn('[GemmaSearch] native video embedding hit std::bad_alloc; using frame-mean fallback')
    const frameVectors: Float32Array[] = []
    for (const frame of input.frames) {
      checkCancelled(id)
      const [vector] = await runModelVectors(
        { kind: 'image', data: frame.data, width: frame.width, height: frame.height },
        id,
      )
      if (vector) frameVectors.push(vector)
    }
    if (frameVectors.length === 0) throw new Error('视频不包含可嵌入帧', { cause: error })
    return { vectors: [meanNormalize(frameVectors, currentSettings!.dim)], videoMode: 'frame-mean' }
  }
}

async function getVectors(input: EmbedInput, id: number): Promise<Float32Array[]> {
  return (await getVectorsDetailed(input, id)).vectors
}

async function loadBackend(
  settings: Settings,
  device: EffectiveBackend,
  profile: WeightProfile,
  id: number,
  splitAudio = false,
): Promise<{ dtype: DtypeProfile; loadMs: number }> {
  const started = performance.now()
  const dtype = { ...WEIGHT_PROFILES[profile] }
  const config = await AutoConfig.from_pretrained(MODEL_ID)
  const modalityConfig = config as typeof config & { vision_config?: unknown; audio_config?: unknown }
  if (!settings.modalities.vision) modalityConfig.vision_config = null
  if (!settings.modalities.audio || splitAudio) modalityConfig.audio_config = null
  processor = await AutoProcessor.from_pretrained(MODEL_ID)
  const processorConfig = processor as unknown as {
    image_processor?: { max_soft_tokens?: number }
  }
  if (processorConfig.image_processor) processorConfig.image_processor.max_soft_tokens = settings.visionTokens
  model = await AutoModel.from_pretrained(MODEL_ID, {
    device,
    dtype: { model: dtype.model, vision_encoder: dtype.vision_encoder, audio_encoder: dtype.audio_encoder },
    config,
    progress_callback: (event: { progress?: number; file?: string; status?: string }) => {
      checkCancelled(id)
      report(id, Math.round(event.progress || 0), event.file, event.status)
    },
  })
  checkCancelled(id)
  backend = device
  return { dtype, loadMs: performance.now() - started }
}

async function init(settings: Settings, id: number, splitAudioWasm: boolean): Promise<EngineStatus> {
  checkCancelled(id)
  disposeModel()
  processor = undefined
  currentSettings = settings
  currentModelSignature = undefined
  videoTokenBudgetLogged = false
  vectorItems = undefined
  vectorMatrix = undefined
  env.remoteHost = settings.modelHost === 'mirror' ? 'https://hf-mirror.com/' : 'https://huggingface.co/'
  const wasmEnvironment = env.backends.onnx.wasm
  if (!wasmEnvironment) throw new Error('当前 transformers.js 未提供 WASM 后端')
  wasmEnvironment.wasmPaths = `${workerScope.location.origin}/ort/`
  wasmEnvironment.numThreads = crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1
  const started = performance.now()
  let adapterName: string | undefined
  let shaderF16 = false
  let adapter: GPUAdapter | null = null
  let adapterError: string | undefined
  if (settings.backend === 'auto' && navigator.gpu) {
    try {
      adapter = await navigator.gpu.requestAdapter()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      adapterError = error instanceof Error ? error.message : String(error)
    }
  }
  if (adapter) {
    adapterName = adapter.info?.description || adapter.info?.device
    shaderF16 = adapter.features.has('shader-f16')
  }
  let plan = planEngine({
    backend: settings.backend,
    weights: settings.weights,
    hasWebGPU: Boolean(adapter),
    shaderF16,
  })
  let fallbackReason = plan.reason
  if (!adapter && !fallbackReason) {
    fallbackReason = settings.backend === 'wasm'
      ? '已强制使用 WASM'
      : adapterError || (navigator.gpu ? '未找到可用的 WebGPU adapter' : '浏览器未提供 WebGPU')
  }
  if (plan.device === 'webgpu') {
    try {
      const loaded = await loadBackend(settings, 'webgpu', plan.profile, id)
      checkCancelled(id)
      const selfTest = await getVectors({ kind: 'text', text: 'a photograph', role: 'query' }, id)
      checkCancelled(id)
      const norm = Math.sqrt(selfTest[0]?.reduce((sum, value) => sum + value * value, 0) || 0)
      if (!Number.isFinite(norm) || norm <= 0) throw new Error('WebGPU 自检向量无效')
      currentModelSignature = modelSignature(settings, loaded.dtype)
      return {
        backend: 'webgpu',
        profile: plan.profile,
        adapter: adapterName,
        shaderF16,
        loadMs: performance.now() - started,
        actualDtype: loaded.dtype,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const detail = error instanceof Error ? error.message : String(error)
      fallbackReason = `WebGPU 初始化失败：${detail}；已改用 CPU 标准权重`
      disposeModel()
      processor = undefined
      plan = { device: 'wasm', profile: 'standard' }
    }
  }
  const loaded = await loadBackend(
    settings,
    'wasm',
    plan.profile,
    id,
    splitAudioWasm && settings.modalities.vision && settings.modalities.audio,
  )
  checkCancelled(id)
  const selfTest = await getVectors({ kind: 'text', text: 'a photograph', role: 'query' }, id)
  checkCancelled(id)
  if (!selfTest[0]?.every(Number.isFinite) || Math.sqrt(selfTest[0]?.reduce((sum, value) => sum + value * value, 0) || 0) <= 0) {
    throw new Error('WASM 自检向量无效')
  }
  currentModelSignature = modelSignature(settings, loaded.dtype)
  return {
    backend: 'wasm',
    profile: plan.profile,
    adapter: adapterName,
    shaderF16,
    fallbackReason,
    loadMs: performance.now() - started,
    actualDtype: loaded.dtype,
  }
}

async function embed(input: EmbedInput, persist: PersistMeta[] | undefined, id: number): Promise<unknown> {
  const started = performance.now()
  const batchInputs: EmbedInput[] = []
  if (input.kind === 'images') {
    const batchLimit = backend === 'webgpu'
      ? Math.max(1, Math.floor(2700 / (currentSettings?.visionTokens || 280)))
      : 8
    for (let offset = 0; offset < input.images.length; offset += batchLimit) {
      batchInputs.push({ kind: 'images', images: input.images.slice(offset, offset + batchLimit) })
    }
  } else if (input.kind === 'text-batch') {
    for (let offset = 0; offset < input.items.length; offset += 8) {
      batchInputs.push({ kind: 'text-batch', items: input.items.slice(offset, offset + 8) })
    }
  } else {
    batchInputs.push(input)
  }
  const vectors: Float32Array[] = []
  let videoMode: VideoMode | undefined
  for (const batch of batchInputs) {
    checkCancelled(id)
    const embedded = await getVectorsDetailed(batch, id)
    vectors.push(...embedded.vectors)
    videoMode = embedded.videoMode ?? videoMode
    checkCancelled(id)
  }
  const persistedIds: number[] = []
  if (persist) {
    if (persist.length !== vectors.length) throw new Error('持久化元数据和向量数量不匹配')
    for (let index = 0; index < vectors.length; index += 1) {
      const metadata = persist[index]!
      persistedIds.push(await saveItem({
        ...metadata,
        ...(metadata.modality === 'video' && videoMode ? { videoMode } : {}),
        vec: toArrayBuffer(float32ToFloat16(vectors[index]!)),
      }))
      vectorItems = undefined
      vectorMatrix = undefined
      report(id, Math.round((index + 1) / vectors.length * 100), metadata.fileKey, '写入向量')
    }
  }
  const elapsedMs = performance.now() - started
  if (input.kind === 'video') {
    console.info('[GemmaSearch] video embedding complete', {
      videoMode,
      frameCount: input.frames.length,
      elapsedMs,
    })
  }
  return { vectors, elapsedMs, persistedIds, videoMode }
}

async function search(options: SearchOptions, id: number): Promise<unknown> {
  checkCancelled(id)
  if (!currentSettings) throw new Error('引擎尚未初始化')
  const started = performance.now()
  const signature = currentModelSignature
  if (!signature) throw new Error('模型签名尚未就绪')
  const libraries = new Map((await listLibraries()).map((library) => [library.id, library]))
  checkCancelled(id)
  if (!vectorItems || !vectorMatrix) {
    vectorItems = (await getItems()).filter((item): item is SearchItem & { id: number } =>
      item.id !== undefined &&
      libraries.get(item.libId)?.modelSig === signature &&
      new Uint16Array(item.vec).length === currentSettings!.dim,
    )
    vectorMatrix = new Float32Array(vectorItems.length * currentSettings.dim)
    vectorItems.forEach((item, index) => {
      vectorMatrix!.set(float16ToFloat32(new Uint16Array(item.vec)), index * currentSettings!.dim)
    })
  }
  const queryItemId = 'itemId' in options.query ? options.query.itemId : undefined
  const query = queryItemId === undefined ? undefined : vectorItems.find((item) => item.id === queryItemId)
  if (queryItemId !== undefined && !query) throw new Error('找不到用于相似搜索的向量')
  const queryVector = query
    ? float16ToFloat32(new Uint16Array(query.vec))
    : options.queryVector || (await getVectors(options.query as EmbedInput, id))[0]!
  checkCancelled(id)
  const allowedLibraries = options.libIds ? new Set(options.libIds) : undefined
  const allowedModalities = options.modalities ? new Set(options.modalities) : undefined
  const candidateIndices = vectorItems.map((item, index) => ({ item, index })).filter(({ item }) =>
    (!allowedLibraries || allowedLibraries.has(item.libId)) &&
    (!allowedModalities || allowedModalities.has(item.modality)) &&
    (item.modality === 'audio' ? currentSettings!.modalities.audio
      : item.modality === 'image' || item.modality === 'video' || item.modality === 'pdf'
        ? currentSettings!.modalities.vision
        : true) &&
    Boolean(item.id),
  )
  const scores = candidateIndices.map(({ item, index }) => {
    let score = 0
    for (let dimension = 0; dimension < queryVector.length; dimension += 1) {
      score += queryVector[dimension]! * (vectorMatrix![index * currentSettings!.dim + dimension] || 0)
    }
    if (item.modality === 'audio') score = calibrateAudioScore(score)
    return score
  })
  const ranked = topK(scores, candidateIndices.length)
    .filter(({ score }) => score >= (options.minScore || 0))
  const grouped = new Map<string, SearchHit>()
  for (const { index, score } of ranked) {
    const item = candidateIndices[index]!.item
    const library = libraries.get(item.libId)
    if (!library || library.modelSig !== signature) continue
    const hit = grouped.get(item.fileKey) || {
      fileKey: item.fileKey,
      libId: item.libId,
      score,
      modality: item.modality as Modality,
      segments: [],
    }
    hit.score = Math.max(hit.score, score)
    hit.segments.push({ score, start: item.start, end: item.end, page: item.page, chunk: item.chunk, itemId: item.id })
    grouped.set(item.fileKey, hit)
  }
  const hits = [...grouped.values()]
    .map((hit) => ({ ...hit, segments: hit.segments.sort((a, b) => b.score - a.score).slice(0, 5) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 60)
  return { hits, elapsedMs: performance.now() - started, totalVectors: candidateIndices.length }
}

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') {
    if (activeRequests.has(request.targetId)) cancelledRequests.add(request.targetId)
    send({ id: request.id, type: 'result', value: undefined })
    return
  }
  activeRequests.add(request.id)
  try {
    let value: unknown
    checkCancelled(request.id)
    switch (request.type) {
      case 'init':
        value = await init(request.settings, request.id, request.splitAudioWasm ?? false)
        break
      case 'embed':
        value = await embed(request.input, request.persist, request.id)
        break
      case 'search':
        value = await search(request.options, request.id)
        break
      case 'remove-file':
        await removeFileRecords(request.fileKey)
        vectorItems = undefined
        vectorMatrix = undefined
        value = undefined
        break
      case 'remove-library':
        await removeLibrary(request.libId)
        vectorItems = undefined
        vectorMatrix = undefined
        value = undefined
        break
      case 'refresh':
        vectorItems = undefined
        vectorMatrix = undefined
        value = undefined
        break
    }
    checkCancelled(request.id)
    send({ id: request.id, type: 'result', value })
  } catch (error) {
    send({ id: request.id, type: 'error', error: error instanceof Error ? error.message : String(error) })
  } finally {
    activeRequests.delete(request.id)
    cancelledRequests.delete(request.id)
  }
}
