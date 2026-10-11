import { describe, expect, it } from 'vitest'
import type { FileEntry, FileRecord } from '../host/types'
import { shouldReindexFile } from './retry'

const entry: FileEntry = { path: 'photo.jpg', name: 'photo.jpg', size: 100, mtime: 1 }
const previous: FileRecord = {
  ...entry,
  libId: 'library',
  ext: 'jpg',
  modality: 'image',
  status: 'error',
}

describe('index retry policy', () => {
  it('retries unchanged failures by default but not for watcher scans', () => {
    expect(shouldReindexFile(previous, entry)).toBe(true)
    expect(shouldReindexFile(previous, entry, false)).toBe(false)
  })

  it('reindexes a failed file when its size or modification time changed', () => {
    expect(shouldReindexFile(previous, { ...entry, size: 101 }, false)).toBe(true)
    expect(shouldReindexFile(previous, { ...entry, mtime: 2 }, false)).toBe(true)
  })

  it('indexes new files and retries newly enabled skipped modalities', () => {
    expect(shouldReindexFile(undefined, entry, false)).toBe(true)
    expect(shouldReindexFile({ ...previous, status: 'skipped' }, entry, false, true)).toBe(true)
  })
})
