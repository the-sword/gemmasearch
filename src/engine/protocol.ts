import type { Modality, SearchItem } from '../host/types'
import type { Settings } from '../settings'

export type ImageInput = { data: Uint8ClampedArray; width: number; height: number }

export type EmbedInput =
  | { kind: 'text'; text: string; role: 'query' | 'doc'; title?: string }
  | { kind: 'text-batch'; items: Array<{ text: string; title?: string }> }
  | { kind: 'image'; data: Uint8ClampedArray; width: number; height: number }
  | { kind: 'images'; images: ImageInput[] }
  | { kind: 'video'; frames: Array<ImageInput & { timestamp: number }>; duration: number }
  | { kind: 'audio'; pcm: Float32Array }
  | { kind: 'mixed'; text: string; data: Uint8ClampedArray; width: number; height: number }

export interface PersistMeta {
  libId: string
  fileKey: string
  modality: Modality
  start?: number
  end?: number
  page?: number
  chunk?: number
  text?: string
}

export interface SearchOptions {
  query: EmbedInput | { itemId: number }
  modalities?: Modality[]
  libIds?: string[]
  minScore?: number
  limit?: number
}

export interface SearchHit {
  fileKey: string
  libId: string
  score: number
  segments: Array<{ score: number; start?: number; end?: number; page?: number; chunk?: number; itemId: number }>
  modality: Modality
}

export type WorkerRequest =
  | { id: number; type: 'cancel'; targetId: number }
  | { id: number; type: 'init'; settings: Settings }
  | { id: number; type: 'embed'; input: EmbedInput; persist?: PersistMeta[] }
  | { id: number; type: 'search'; options: SearchOptions }
  | { id: number; type: 'remove-file'; fileKey: string }
  | { id: number; type: 'remove-library'; libId: string }
  | { id: number; type: 'refresh' }

export type WorkerResponse =
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'progress'; progress: number; file?: string; status?: string }

export interface EngineStatus {
  backend: 'webgpu' | 'wasm'
  adapter?: string
  shaderF16: boolean
  fallbackReason?: string
  loadMs: number
  actualDtype: Settings['dtype']
}

export interface EmbeddedResult {
  vectors: Float32Array[]
  elapsedMs: number
  persistedIds?: number[]
}

export interface SearchResult {
  hits: SearchHit[]
  elapsedMs: number
  totalVectors: number
}

export type StoredItem = SearchItem & { id: number }
