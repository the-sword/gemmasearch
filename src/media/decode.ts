import type { Modality } from '../host/types'
import type { Settings } from '../settings'
import type { EmbedInput } from '../engine/protocol'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

export interface DecodedChunk {
  input: EmbedInput
  modality: Modality
  start?: number
  end?: number
  page?: number
  chunk?: number
  text?: string
}

export interface DecodedFile {
  chunks: DecodedChunk[]
  thumb?: Blob
  peaks?: number[]
  pagesThumbs?: Record<number, Blob>
  duration?: number
  width?: number
  height?: number
  pages?: number
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac'])
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'yaml', 'toml', 'html', 'css', 'py', 'js', 'ts', 'tsx', 'java', 'go', 'rs', 'c', 'cpp', 'h', 'kt', 'swift', 'sh'])

export function modalityForExtension(extension: string): Modality | null {
  const ext = extension.toLowerCase().replace(/^\./, '')
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return null
}

function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  video.currentTime = Math.min(seconds, Math.max(0, video.duration - 0.04))
  return new Promise((resolve, reject) => {
    video.onseeked = () => resolve()
    video.onerror = () => reject(new Error('无法解码（编码格式不受支持）'))
  })
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('无法生成预览图')), 'image/jpeg', 0.82))
}

async function imageData(blob: Blob, maxSide = 512): Promise<{ data: Uint8ClampedArray; width: number; height: number; thumb: Blob }> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法创建图像画布')
  context.drawImage(bitmap, 0, 0, width, height)
  const data = context.getImageData(0, 0, width, height).data
  const thumbCanvas = document.createElement('canvas')
  const thumbScale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height))
  thumbCanvas.width = Math.max(1, Math.round(bitmap.width * thumbScale))
  thumbCanvas.height = Math.max(1, Math.round(bitmap.height * thumbScale))
  thumbCanvas.getContext('2d')?.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height)
  bitmap.close()
  return { data, width, height, thumb: await canvasBlob(thumbCanvas) }
}

async function decodeVideo(blob: Blob, settings: Settings): Promise<DecodedFile> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.preload = 'auto'
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('无法解码（编码格式不受支持）'))
    })
    const duration = video.duration
    const stride = duration > 1800
      ? Math.max(1, Math.ceil(duration / (120 * settings.videoSegmentSec)))
      : 1
    const interval = Math.max(1, stride)
    const segmentSeconds = Math.max(settings.videoSegmentSec, Math.ceil(duration / 120))
    const samples: Array<{ data: Uint8ClampedArray; width: number; height: number; timestamp: number; thumb?: Blob }> = []
    const posterIndex = Math.floor(Math.max(0, (duration - 0.5) / interval) * 0.1)
    for (let time = 0.5; time < duration; time += interval) {
      await seek(video, time)
      const scale = Math.min(1, 512 / Math.max(video.videoWidth, video.videoHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) continue
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      samples.push({
        data: context.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
        timestamp: time,
        thumb: samples.length === posterIndex ? await canvasBlob(canvas) : undefined,
      })
    }
    const chunks: DecodedChunk[] = []
    const frameCount = Math.max(1, Math.floor(segmentSeconds / interval))
    for (let offset = 0; offset < samples.length; offset += frameCount) {
      const segment = samples.slice(offset, offset + frameCount)
      if (!segment.length) continue
      const start = segment[0]!.timestamp
      const end = Math.min(duration, (segment.at(-1)?.timestamp || start) + interval)
      chunks.push({
        modality: 'video',
        start,
        end,
        input: { kind: 'video', frames: segment.map(({ data, width, height, timestamp }) => ({ data, width, height, timestamp })), duration: end - start },
      })
    }
    const poster = samples.find((sample) => sample.thumb)?.thumb
    return { chunks, thumb: poster, duration, width: video.videoWidth, height: video.videoHeight }
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

export async function decodeAudio(blob: Blob, settings: Settings): Promise<DecodedFile> {
  const context = new AudioContext({ sampleRate: 16_000 })
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer())
    const duration = Math.min(audio.duration, 7200)
    const sampleCount = Math.floor(duration * 16_000)
    const mono = new Float32Array(sampleCount)
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const data = audio.getChannelData(channel)
      for (let index = 0; index < sampleCount; index += 1) {
        const position = index * audio.sampleRate / 16_000
        const before = Math.floor(position)
        const fraction = position - before
        mono[index] += ((data[before] || 0) * (1 - fraction) + (data[Math.min(before + 1, data.length - 1)] || 0) * fraction) / audio.numberOfChannels
      }
    }
    const peaks = Array.from({ length: 120 }, (_, peakIndex) => {
      const from = Math.floor(peakIndex * sampleCount / 120)
      const to = Math.floor((peakIndex + 1) * sampleCount / 120)
      let peak = 0
      for (let index = from; index < to; index += 1) peak = Math.max(peak, Math.abs(mono[index] || 0))
      return peak
    })
    const segmentSize = settings.audioSegmentSec * 16_000
    const chunks: DecodedChunk[] = []
    for (let start = 0; start < mono.length; start += segmentSize) {
      const end = Math.min(mono.length, start + segmentSize)
      chunks.push({
        modality: 'audio',
        start: start / 16_000,
        end: end / 16_000,
        input: { kind: 'audio', pcm: mono.slice(start, end) },
      })
    }
    return { chunks, duration, peaks }
  } finally {
    await context.close()
  }
}

async function decodePdf(blob: Blob): Promise<DecodedFile> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const pdfDocument = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise
  const chunks: DecodedChunk[] = []
  const pagesThumbs: Record<number, Blob> = {}
  let firstThumb: Blob | undefined
  const pages = Math.min(200, pdfDocument.numPages)
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber)
    const scale = 1024 / page.getViewport({ scale: 1 }).width
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
    const image = await imageData(await canvasBlob(canvas), 1024)
    if (pageNumber === 1) firstThumb = image.thumb
    pagesThumbs[pageNumber] = image.thumb
    chunks.push({
      modality: 'pdf',
      page: pageNumber,
      input: { kind: 'image', data: image.data, width: image.width, height: image.height },
    })
  }
  return { chunks, thumb: firstThumb, pagesThumbs, pages: pdfDocument.numPages }
}

export async function decodeMedia(blob: Blob, filename: string, settings: Settings): Promise<DecodedFile> {
  const ext = filename.split('.').at(-1)?.toLowerCase() || ''
  if (IMAGE_EXTENSIONS.has(ext)) {
    const image = await imageData(blob)
    return {
      chunks: [{ modality: 'image', input: { kind: 'image', data: image.data, width: image.width, height: image.height } }],
      thumb: image.thumb,
      width: image.width,
      height: image.height,
    }
  }
  if (VIDEO_EXTENSIONS.has(ext)) return decodeVideo(blob, settings)
  if (AUDIO_EXTENSIONS.has(ext)) return decodeAudio(blob, settings)
  if (ext === 'pdf') return decodePdf(blob)
  if (TEXT_EXTENSIONS.has(ext)) {
    if (blob.size > 5 * 1024 * 1024) throw new Error('文本文件超过 5 MB')
    const content = await blob.text()
    const chunks: DecodedChunk[] = []
    const size = 1200
    const overlap = 200
    for (let start = 0, chunk = 0; start < content.length && chunk < 50; start += size - overlap, chunk += 1) {
      const text = content.slice(start, start + size)
      if (!text.trim()) continue
      chunks.push({
        modality: 'text',
        chunk,
        text: text.slice(0, 300),
        input: { kind: 'text', text, role: 'doc', title: filename },
      })
    }
    return { chunks }
  }
  throw new Error(['heic', 'heif', 'raw', 'cr2', 'nef', 'arw'].includes(ext) ? '不支持的图片格式' : '不支持的文件格式')
}
