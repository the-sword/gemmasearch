import type { FileEntry, FileRecord, Library, Modality } from '../host/types'
import type { DecodedChunk, DecodedFile, MediaSource } from '../media/decode'
import { decodeMedia, modalityForExtension } from '../media/decode'
import type { Settings } from '../settings'
import { EngineClient } from '../engine/client'
import type { PersistMeta } from '../engine/protocol'
import { getFiles, getFile, getThumb, saveFile, saveThumb } from '../engine/store'
import { host } from '../host'
import { shouldReindexFile } from './retry'

export interface IndexProgress {
  done: number
  total: number
  file?: string
  status: string
}

const SPEED_DELAY: Record<Settings['indexSpeed'], number> = { low: 200, mid: 50, high: 0 }
const MAX_PENDING_VIDEO_SEGMENTS = 4
const ABORT_MESSAGE = '请求已取消'

function abortError(): DOMException {
  return new DOMException(ABORT_MESSAGE, 'AbortError')
}

function fileKey(library: Library, entry: FileEntry): string {
  return `${library.id}:${entry.path}`
}

function isEnabled(modality: Modality, settings: Settings): boolean {
  return modality === 'audio' ? settings.modalities.audio : modality === 'image' || modality === 'video' || modality === 'pdf'
    ? settings.modalities.vision
    : true
}

function toMetadata(library: Library, key: string, chunk: DecodedChunk): PersistMeta {
  return {
    libId: library.id,
    fileKey: key,
    modality: chunk.modality,
    start: chunk.start,
    end: chunk.end,
    page: chunk.page,
    chunk: chunk.chunk,
    text: chunk.text,
  }
}

export class Indexer {
  private paused = false
  private stopped = false
  private listeners = new Set<(progress: IndexProgress) => void>()
  private currentProgress: IndexProgress = { done: 0, total: 0, status: '准备索引' }
  private readonly engine: EngineClient
  private readonly settings: Settings

  constructor(engine: EngineClient, settings: Settings) {
    this.engine = engine
    this.settings = settings
  }

  onProgress(listener: (progress: IndexProgress) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pause(): void {
    this.paused = true
    this.emit({ ...this.currentProgress, status: '已暂停' })
  }

  resume(): void {
    this.paused = false
    this.emit({ ...this.currentProgress, status: '继续索引' })
  }

  stop(): void {
    this.stopped = true
  }

  private emit(progress: IndexProgress): void {
    if (this.paused && progress.status !== '已暂停') progress = { ...progress, status: '已暂停' }
    this.currentProgress = progress
    this.listeners.forEach((listener) => listener(progress))
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) await new Promise((resolve) => window.setTimeout(resolve, 150))
  }

  /**
   * Decodes a video while embedding each segment as soon as it is ready, so
   * seeking and inference overlap instead of running back to back. Embeds run
   * serially (one worker request at a time) while the decoder may run ahead by
   * up to MAX_PENDING_VIDEO_SEGMENTS segments.
   * Returns undefined when the scan was stopped mid-decode (partial vectors
   * are kept, matching the previous stop semantics).
   */
  private async decodeAndEmbedVideo(
    library: Library,
    key: string,
    entry: FileEntry,
    source: MediaSource,
    done: number,
    total: number,
  ): Promise<DecodedFile | undefined> {
    let embedQueue: Promise<void> = Promise.resolve()
    let pendingSegments = 0
    let embedError: unknown
    const enqueue = (chunk: DecodedChunk): void => {
      pendingSegments += 1
      embedQueue = embedQueue.then(async () => {
        try {
          if (this.stopped) return
          await this.engine.embed(chunk.input, [toMetadata(library, key, chunk)])
          this.emit({ done, total, file: entry.path, status: '正在写入索引' })
        } catch (error) {
          embedError ??= error
        } finally {
          pendingSegments -= 1
        }
      })
    }
    const throwIfFailed = (): void => {
      if (embedError) throw embedError instanceof Error ? embedError : new Error(String(embedError))
    }
    let decoded: DecodedFile | undefined
    try {
      decoded = await decodeMedia(source, entry.name, this.settings, {
        onProgress: (sampled, totalSamples) => this.emit({
          done,
          total,
          file: entry.path,
          status: `正在解码 ${Math.round((sampled / Math.max(1, totalSamples)) * 100)}%`,
        }),
        onChunks: async (chunks) => {
          await this.waitWhilePaused()
          if (this.stopped) throw abortError()
          throwIfFailed()
          while (pendingSegments >= MAX_PENDING_VIDEO_SEGMENTS && !this.stopped && !embedError) {
            await new Promise((resolve) => window.setTimeout(resolve, 50))
          }
          if (this.stopped) throw abortError()
          throwIfFailed()
          chunks.forEach(enqueue)
        },
      })
    } catch (error) {
      await embedQueue
      throwIfFailed()
      if (this.stopped && error instanceof DOMException && error.name === 'AbortError') return undefined
      throw error
    }
    await embedQueue
    throwIfFailed()
    return decoded
  }

  async scan(library: Library, { retryErrors = true }: { retryErrors?: boolean } = {}): Promise<void> {
    this.stopped = false
    this.emit({ done: 0, total: 0, status: '正在扫描文件夹…' })
    const entries: FileEntry[] = []
    for await (const entry of await host.listFiles(library)) entries.push(entry)
    const seen = new Set(entries.map((entry) => fileKey(library, entry)))
    const existing = await getFiles(library.id)
    for (const file of existing) {
      const key = fileKey(library, file)
      if (!seen.has(key)) await this.engine.removeFile(key)
    }
    const updates: FileEntry[] = []
    for (const entry of entries) {
      const previous = await getFile(fileKey(library, entry))
      const modality = modalityForExtension(entry.name.split('.').at(-1)?.toLowerCase() || '') || 'text'
      const retryEnabledModality = previous?.status === 'skipped' &&
        previous.reason === '该模态未启用' &&
        isEnabled(modality, this.settings)
      if (shouldReindexFile(previous, entry, retryErrors, retryEnabledModality)) updates.push(entry)
    }
    let done = 0
    this.emit({ done, total: updates.length, status: '准备索引' })
    for (const entry of updates) {
      await this.waitWhilePaused()
      if (this.stopped) break
      const extension = entry.name.split('.').at(-1)?.toLowerCase() || ''
      const modality = modalityForExtension(extension) || 'text'
      const key = fileKey(library, entry)
      await this.engine.removeFile(key)
      const record: FileRecord = {
        ...entry,
        libId: library.id,
        ext: extension,
        modality,
        status: 'ok',
      }
      try {
        if (!modalityForExtension(extension)) {
          record.status = 'skipped'
          record.reason = ['heic', 'heif', 'raw', 'cr2', 'nef', 'arw'].includes(extension)
            ? '不支持的图片格式'
            : '不支持的文件格式'
        } else if (!isEnabled(modality, this.settings)) {
          record.status = 'skipped'
          record.reason = '该模态未启用'
        } else {
          this.emit({ done, total: updates.length, file: entry.path, status: '正在解码' })
          const source = modality === 'video'
            ? await host.mediaUrl(library, entry)
            : await host.readFile(library, entry)
          const decoded = modality === 'video'
            ? await this.decodeAndEmbedVideo(library, key, entry, source, done, updates.length)
            : await decodeMedia(source, entry.name, this.settings)
          if (decoded) {
            record.duration = decoded.duration
            record.width = decoded.width
            record.height = decoded.height
            record.pages = decoded.pages
            if (decoded.thumb || decoded.peaks || decoded.pagesThumbs) {
              await saveThumb({ fileKey: key, jpeg: decoded.thumb, peaks: decoded.peaks, pages: decoded.pagesThumbs })
            }
          }
          // Video chunks are already embedded during decoding; other modalities embed here.
          for (let offset = 0; decoded && modality !== 'video' && offset < decoded.chunks.length;) {
            await this.waitWhilePaused()
            if (this.stopped) break
            const chunk = decoded.chunks[offset]!
            if (chunk.input.kind === 'text') {
              const group = decoded.chunks.slice(offset, offset + 8).filter((item) => item.input.kind === 'text')
              await this.engine.embed(
                { kind: 'text-batch', items: group.map((item) => ({ text: (item.input as Extract<typeof chunk.input, { kind: 'text' }>).text, title: (item.input as Extract<typeof chunk.input, { kind: 'text' }>).title })) },
                group.map((item) => toMetadata(library, key, item)),
              )
              offset += group.length
            } else if (chunk.input.kind === 'image') {
              const group = decoded.chunks.slice(offset, offset + 8).filter((item) => item.input.kind === 'image')
              await this.engine.embed(
                {
                  kind: 'images',
                  images: group.map((item) => {
                    const image = item.input as Extract<typeof chunk.input, { kind: 'image' }>
                    return { data: image.data, width: image.width, height: image.height }
                  }),
                },
                group.map((item) => toMetadata(library, key, item)),
              )
              offset += group.length
            } else {
              await this.engine.embed(chunk.input, [toMetadata(library, key, chunk)])
              offset += 1
            }
            this.emit({ done, total: updates.length, file: entry.path, status: '正在写入索引' })
          }
        }
      } catch (error) {
        record.reason = error instanceof Error ? error.message : String(error)
        record.status = (modality === 'video' && record.reason === '无法解码（编码格式不受支持）') ||
          (modality === 'text' && record.reason === '文本文件超过 5 MB')
          ? 'skipped'
          : 'error'
      }
      await saveFile(record)
      done += 1
      this.emit({ done, total: updates.length, file: entry.path, status: record.status === 'error' ? record.reason || '索引失败' : '已完成' })
      const delay = SPEED_DELAY[this.settings.indexSpeed]
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay))
    }
    await this.engine.refresh()
    this.emit({ done, total: updates.length, status: this.stopped ? '已暂停' : '索引完成' })
  }
}

export async function thumbnailForFile(key: string): Promise<Blob | undefined> {
  return (await getThumb(key))?.jpeg
}
