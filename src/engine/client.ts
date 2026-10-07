import type { EngineStatus, EmbedInput, EmbeddedResult, SearchOptions, SearchResult, WorkerRequest, WorkerResponse, PersistMeta } from './protocol'
import type { Settings } from '../settings'

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

  init(settings: Settings, onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<EngineStatus> {
    return this.call({ type: 'init', settings }, onProgress, signal)
  }

  embed(input: EmbedInput, persist?: PersistMeta[], onProgress?: Pending['onProgress'], signal?: AbortSignal): Promise<EmbeddedResult> {
    return this.call({ type: 'embed', input, persist }, onProgress, signal)
  }

  search(options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
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
  }
}
