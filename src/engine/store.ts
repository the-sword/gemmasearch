import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { FileRecord, Library, SearchItem, ThumbnailRecord } from '../host/types'

interface SearchDatabase extends DBSchema {
  libraries: { key: string; value: Library }
  files: {
    key: string
    value: FileRecord
    indexes: { 'by-library': string }
  }
  items: {
    key: number
    value: SearchItem
    indexes: { 'by-library': string; 'by-file': string }
  }
  thumbs: { key: string; value: ThumbnailRecord }
  kv: { key: string; value: unknown }
}

let database: Promise<IDBPDatabase<SearchDatabase>> | undefined

export function getDatabase(): Promise<IDBPDatabase<SearchDatabase>> {
  database ??= openDB<SearchDatabase>('gemma-search', 1, {
    upgrade(db) {
      db.createObjectStore('libraries', { keyPath: 'id' })
      const files = db.createObjectStore('files', { keyPath: 'key' })
      files.createIndex('by-library', 'libId')
      const items = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true })
      items.createIndex('by-library', 'libId')
      items.createIndex('by-file', 'fileKey')
      db.createObjectStore('thumbs', { keyPath: 'fileKey' })
      db.createObjectStore('kv')
    },
  })
  return database
}

export async function listLibraries(): Promise<Library[]> {
  return (await getDatabase()).getAll('libraries')
}

export async function getLibrary(id: string): Promise<Library | undefined> {
  return (await getDatabase()).get('libraries', id)
}

export async function saveLibrary(library: Library): Promise<void> {
  await (await getDatabase()).put('libraries', library)
}

export async function getFiles(libId?: string): Promise<FileRecord[]> {
  const db = await getDatabase()
  return libId ? db.getAllFromIndex('files', 'by-library', libId) : db.getAll('files')
}

export async function getFile(fileKey: string): Promise<FileRecord | undefined> {
  return (await getDatabase()).get('files', fileKey)
}

export async function saveFile(file: FileRecord): Promise<void> {
  await (await getDatabase()).put('files', { ...file, key: `${file.libId}:${file.path}` } as FileRecord)
}

export async function removeFileRecords(fileKey: string): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['files', 'items', 'thumbs'], 'readwrite')
  await Promise.all([
    tx.objectStore('files').delete(fileKey),
    tx.objectStore('thumbs').delete(fileKey),
    (async () => {
      const ids = await tx.objectStore('items').index('by-file').getAllKeys(fileKey)
      await Promise.all(ids.map((id) => tx.objectStore('items').delete(id)))
    })(),
  ])
  await tx.done
}

export async function saveItem(item: SearchItem): Promise<number> {
  return (await getDatabase()).add('items', item) as Promise<number>
}

export async function getItems(libId?: string): Promise<SearchItem[]> {
  const db = await getDatabase()
  return libId ? db.getAllFromIndex('items', 'by-library', libId) : db.getAll('items')
}

export async function saveThumb(thumb: ThumbnailRecord): Promise<void> {
  await (await getDatabase()).put('thumbs', thumb)
}

export async function getThumb(fileKey: string): Promise<ThumbnailRecord | undefined> {
  return (await getDatabase()).get('thumbs', fileKey)
}

export async function removeLibrary(libId: string): Promise<void> {
  const db = await getDatabase()
  const tx = db.transaction(['libraries', 'files', 'items', 'thumbs'], 'readwrite')
  await tx.objectStore('libraries').delete(libId)
  for (const file of await tx.objectStore('files').index('by-library').getAll(libId)) {
    await tx.objectStore('thumbs').delete(`${libId}:${file.path}`)
  }
  for (const item of await tx.objectStore('items').index('by-library').getAllKeys(libId)) {
    await tx.objectStore('items').delete(item)
  }
  for (const file of await tx.objectStore('files').index('by-library').getAllKeys(libId)) {
    await tx.objectStore('files').delete(file)
  }
  await tx.done
}

export async function readSetting<T>(key: string): Promise<T | undefined> {
  return (await getDatabase()).get('kv', key) as Promise<T | undefined>
}

export async function saveSetting<T>(key: string, value: T): Promise<void> {
  await (await getDatabase()).put('kv', value, key)
}
