import type { FileRecord, Library, SearchItem, ThumbnailRecord } from '../host/types'
import { modelSignature, type DtypeProfile, type EffectiveBackend, type Settings } from '../settings'
import { getDatabase, getFiles, getItems, getThumb, listLibraries, saveFile, saveLibrary } from './store'
import { decodeIndexPack, encodeIndexPack, type PackPayload } from './pack'
import { float32ToFloat16 } from './vec'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export async function exportLibraryPack(library: Library): Promise<Blob> {
  const files = await getFiles(library.id)
  const items = (await getItems(library.id)).sort((a, b) => (a.id || 0) - (b.id || 0))
  const thumbs: PackPayload['thumbs'] = []
  for (const file of files) {
    const key = `${library.id}:${file.path}`
    const thumb = await getThumb(key)
    if (!thumb) continue
    thumbs.push({
      fileKey: key,
      jpeg: thumb.jpeg ? bytesToBase64(new Uint8Array(await thumb.jpeg.arrayBuffer())) : undefined,
      peaks: thumb.peaks,
      pages: thumb.pages
        ? Object.fromEntries(await Promise.all(Object.entries(thumb.pages).map(async ([page, blob]) => [
            page,
            bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
          ])))
        : undefined,
    })
  }
  const payload: PackPayload = {
    version: 1,
    modelSig: library.modelSig,
    dim: items.length ? new Uint16Array(items[0]!.vec).length : Number(JSON.parse(library.modelSig).dim || 0),
    library: { name: library.name, kind: library.kind },
    files: files.map((file) => {
      const metadata = { ...file }
      delete (metadata as Partial<FileRecord>).libId
      return metadata
    }),
    items: items.map((item) => {
      return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'id' && key !== 'vec')) as Omit<SearchItem, 'id' | 'vec'>
    }),
    thumbs,
  }
  return new Blob([arrayBuffer(encodeIndexPack(payload, items.map((item) => item.vec)))], { type: 'application/octet-stream' })
}

export async function importLibraryPack(
  file: Blob,
  settings: Settings,
  backend?: EffectiveBackend,
  effectiveDtype?: DtypeProfile,
): Promise<{ library: Library; mismatch: boolean }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { payload, vectors } = decodeIndexPack(bytes)
  const id = crypto.randomUUID()
  const library: Library = {
    id,
    name: payload.library.name,
    kind: 'imported',
    modelSig: payload.modelSig,
    createdAt: Date.now(),
  }
  await saveLibrary(library)
  for (const value of payload.files) {
    const source = value as Omit<FileRecord, 'libId'> & { libId?: string }
    await saveFile({ ...source, libId: id } as FileRecord)
  }
  const db = await getDatabase()
  const tx = db.transaction(['items', 'thumbs'], 'readwrite')
  for (let index = 0; index < payload.items.length; index += 1) {
    const metadata = payload.items[index]!
    const sourceKey = metadata.fileKey
    const path = sourceKey.slice(sourceKey.indexOf(':') + 1)
    const vector = float32ToFloat16(vectors[index]!)
    await tx.objectStore('items').add({
      ...metadata,
      libId: id,
      fileKey: `${id}:${path}`,
      vec: vector.buffer,
    } as SearchItem)
  }
  for (const thumb of payload.thumbs) {
    const path = thumb.fileKey.slice(thumb.fileKey.indexOf(':') + 1)
    const record: ThumbnailRecord = {
      fileKey: `${id}:${path}`,
      jpeg: thumb.jpeg ? new Blob([arrayBuffer(base64ToBytes(thumb.jpeg))], { type: 'image/jpeg' }) : undefined,
      peaks: thumb.peaks,
      pages: thumb.pages
        ? Object.fromEntries(Object.entries(thumb.pages).map(([page, encoded]) => [
            Number(page),
            new Blob([arrayBuffer(base64ToBytes(encoded))], { type: 'image/jpeg' }),
          ]))
        : undefined,
    }
    await tx.objectStore('thumbs').put(record)
  }
  await tx.done
  return { library, mismatch: library.modelSig !== modelSignature(settings, backend, effectiveDtype) }
}

export async function listImportedLibraries(): Promise<Library[]> {
  return (await listLibraries()).filter((library) => library.kind === 'imported')
}
