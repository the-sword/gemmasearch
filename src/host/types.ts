import type { Settings } from '../settings'

export type LibraryKind = 'folder' | 'files' | 'imported'
export type Modality = 'image' | 'video' | 'audio' | 'pdf' | 'text'

export interface LibrarySource {
  name: string
  rootPath?: string
  handle?: FileSystemDirectoryHandle
}

export interface Library {
  id: string
  name: string
  kind: LibraryKind
  rootPath?: string
  handle?: FileSystemDirectoryHandle
  modelSig: string
  createdAt: number
}

export interface FileEntry {
  path: string
  name: string
  size: number
  mtime: number
}

export interface FileRecord extends FileEntry {
  libId: string
  ext: string
  modality: Modality
  status: 'ok' | 'skipped' | 'error'
  reason?: string
  duration?: number
  width?: number
  height?: number
  pages?: number
}

export interface SearchItem {
  id?: number
  libId: string
  fileKey: string
  modality: Modality
  start?: number
  end?: number
  page?: number
  chunk?: number
  text?: string
  vec: ArrayBuffer
}

export interface ThumbnailRecord {
  fileKey: string
  jpeg?: Blob
  peaks?: number[]
  pages?: Record<number, Blob>
}

export interface Host {
  kind: 'web' | 'electron'
  pickFolder(): Promise<LibrarySource | null>
  listFiles(lib: Library): AsyncIterable<FileEntry>
  readFile(lib: Library, file: FileEntry): Promise<Blob>
  mediaUrl(lib: Library, file: FileEntry): Promise<string>
  watch?(lib: Library, callback: (event: { type: 'add' | 'change' | 'unlink'; path: string }) => void): () => void
  openPath?(lib: Library, file: FileEntry): Promise<void>
  showInFolder?(lib: Library, file: FileEntry): Promise<void>
}

export interface IndexerOptions {
  settings: Settings
}
