import type { EngineStatus, EmbedInput, EmbeddedResult, SearchOptions, SearchResult, WorkerRequest, WorkerResponse, PersistMeta } from './protocol'
import type { Settings, WeightProfile } from '../settings'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  onProgress?: (progress: number, file?: string, status?: string) => void
  cleanup?: () => void
}

type WorkerMessage = WorkerRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never

export class EngineClient {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  private nextId = 1
  private pending = new Map<number, Pending>()
  private settings: Settings | undefined
  private splitAudio = false
  private effectiveProfile: WeightProfile = 'standard'
  private audioClient: EngineClient | undefined
  private audioClientPromise: Promise<EngineClient> | undefined

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      const pending = this.pending.get(message.id)
      if (!pending) return
      if (message.type === 'progress') {
        pending.onProgress?.(message.progress, message.file, message.status)
      } else {
        this.pending.delete(message.id)
        pending.cleanup?.()
        if (message.type === 'error') pending.reject(new Error(message.error))
        else pending.resolve(message.value)
      }
    }
    this.worker.onerror = (event) => {
      for (const pending of this.pending.values()) {
        pending.cleanup?.()
        pending.reject(new Error(event.message || '推理工作线程异常'))
      }
      this.pending.clear()
    }
  }

  private call<T>(request: WorkerMessage, onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (value: unknown) => void, reject, onProgress }
      this.pending.set(id, pending)
      if (signal) {
        const abort = () => {
          this.pending.delete(id)
          pending.cleanup?.()
          this.worker.postMessage({ id: this.nextId++, type: 'cancel', targetId: id } satisfies WorkerRequest)
          reject(signal.reason instanceof Error ? signal.reason : new DOMException('请求已取消', 'AbortError'))
        }
        pending.cleanup = () => signal.removeEventListener('abort', abort)
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
      }
      this.worker.postMessage({ ...request, id } as WorkerRequest)
    })
  }

  async init(settings: Settings, onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<EngineStatus> {
    this.audioClient?.dispose()
    this.audioClient = undefined
    this.audioClientPromise = undefined
    this.settings = settings
    this.splitAudio = false
    const status = await this.call<EngineStatus>({
      type: 'init',
      settings,
      splitAudioWasm: settings.modalities.vision && settings.modalities.audio,
    }, onProgress, signal)
    this.splitAudio = status.backend === 'wasm' && settings.modalities.vision && settings.modalities.audio
    this.effectiveProfile = status.profile
    return status
  }

  async embed(input: EmbedInput, persist?: PersistMeta[], onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<EmbeddedResult> {
    if (this.splitAudio && input.kind === 'audio') {
      const audioClient = await this.getAudioClient(onProgress, signal)
      const result = await audioClient.embed(input, persist, onProgress, signal)
      if (persist) await this.refresh()
      return result
    }
    return this.call({ type: 'embed', input, persist }, onProgress, signal)
  }

  async search(options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
    if (this.splitAudio && 'kind' in options.query && options.query.kind === 'audio') {
      const audioClient = await this.getAudioClient(undefined, signal)
      const embedded = await audioClient.embed(options.query, undefined, undefined, signal)
      const queryVector = embedded.vectors[0]
      if (!queryVector) throw new Error('音频查询未生成向量')
      return this.call({
        type: 'search',
        options: {
          ...options,
          query: { kind: 'text', text: '', role: 'query' },
          queryVector,
        },
      }, undefined, signal)
    }
    return this.call({ type: 'search', options }, undefined, signal)
  }

  removeFile(fileKey: string): Promise<void> {
    return this.call({ type: 'remove-file', fileKey })
  }

  removeLibrary(libId: string): Promise<void> {
    return this.call({ type: 'remove-library', libId })
  }

  refresh(): Promise<void> {
    return this.call({ type: 'refresh' })
  }

  dispose(): void {
    this.worker.terminate()
    this.audioClient?.dispose()
    this.audioClient = undefined
    this.audioClientPromise = undefined
  }

  private getAudioClient(onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<EngineClient> {
    if (!this.settings) return Promise.reject(new Error('引擎尚未初始化'))
    if (!this.audioClientPromise) {
      const client = new EngineClient()
      this.audioClient = client
      const settings: Settings = {
        ...this.settings,
        backend: 'wasm',
        weights: this.effectiveProfile,
        modalities: { vision: false, audio: true },
      }
      this.audioClientPromise = client.init(settings, onProgress, signal)
        .then(() => client)
        .catch((error: unknown) => {
          client.dispose()
          if (this.audioClient === client) {
            this.audioClient = undefined
            this.audioClientPromise = undefined
          }
          throw error
        })
    }
    return this.audioClientPromise
  }
}
