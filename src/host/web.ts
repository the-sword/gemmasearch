import { modelSignature, type DtypeProfile, type Settings } from '../settings'
import type { FileEntry, Host, Library, LibrarySource } from './types'

type DirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}
type PermissionHandle = {
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>
}

const sessionFiles = new Map<string, Map<string, File>>()

function makeId(): string {
  return crypto.randomUUID()
}

export function createFilesLibrary(
  files: File[],
  settings: Settings,
  name?: string,
  effectiveDtype?: DtypeProfile,
): Library {
  const id = makeId()
  const token = `session:${id}`
  const entries = new Map<string, File>()
  for (const file of files) entries.set(file.webkitRelativePath || file.name, file)
  sessionFiles.set(token, entries)
  return {
    id,
    name: name || (files[0]?.webkitRelativePath.split('/')[0] || '临时文件'),
    kind: 'files',
    rootPath: token,
    modelSig: modelSignature(settings, effectiveDtype),
    createdAt: Date.now(),
  }
}

export class WebHost implements Host {
  readonly kind = 'web' as const

  async pickFolder(): Promise<LibrarySource | null> {
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker
    if (picker) {
      try {
        const handle = await picker.call(window)
        return { name: handle.name, handle }
      } catch {
        return null
      }
    }
    const files = await new Promise<File[] | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.setAttribute('webkitdirectory', '')
      input.onchange = () => resolve(input.files ? Array.from(input.files) : null)
      input.click()
    })
    if (!files?.length) return null
    const id = makeId()
    const token = `session:${id}`
    sessionFiles.set(token, new Map(files.map((file) => [file.webkitRelativePath || file.name, file])))
    return { name: files[0]?.webkitRelativePath.split('/')[0] || '文件夹', rootPath: token }
  }

  async *listFiles(library: Library): AsyncIterable<FileEntry> {
    if (library.handle) {
      await this.ensurePermission(library.handle)
      yield* this.walk(library.handle, '')
      return
    }
    const files = sessionFiles.get(library.rootPath || '')
    if (!files) return
    for (const [path, file] of files) {
      yield { path, name: file.name, size: file.size, mtime: file.lastModified }
    }
  }

  private async *walk(directory: FileSystemDirectoryHandle, prefix: string): AsyncIterable<FileEntry> {
    for await (const [name, handle] of (directory as DirectoryHandle).entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (handle.kind === 'directory') {
        yield* this.walk(handle as FileSystemDirectoryHandle, path)
      } else {
        const file = await (handle as FileSystemFileHandle).getFile()
        yield { path, name: file.name, size: file.size, mtime: file.lastModified }
      }
    }
  }

  async readFile(library: Library, entry: FileEntry): Promise<Blob> {
    if (library.handle) {
      await this.ensurePermission(library.handle)
      let current: FileSystemDirectoryHandle = library.handle
      const parts = entry.path.split('/')
      for (const part of parts.slice(0, -1)) current = await current.getDirectoryHandle(part)
      return (await current.getFileHandle(parts.at(-1)!)).getFile()
    }
    const file = sessionFiles.get(library.rootPath || '')?.get(entry.path)
    if (!file) throw new Error('原文件需重新添加')
    return file
  }

  async mediaUrl(library: Library, entry: FileEntry): Promise<string> {
    return URL.createObjectURL(await this.readFile(library, entry))
  }

  async openPath(library: Library, entry: FileEntry): Promise<void> {
    const url = await this.mediaUrl(library, entry)
    window.open(url, '_blank', 'noopener')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  private async ensurePermission(handle: FileSystemDirectoryHandle): Promise<void> {
    const permissionHandle = handle as FileSystemDirectoryHandle & PermissionHandle
    if (await permissionHandle.queryPermission({ mode: 'read' }) === 'granted') return
    const result = await permissionHandle.requestPermission({ mode: 'read' })
    if (result !== 'granted') throw new Error('未授予文件夹读取权限')
  }
}

export function forgetSessionLibrary(library: Library): void {
  if (library.rootPath?.startsWith('session:')) sessionFiles.delete(library.rootPath)
}

export function hasSessionLibrary(library: Library): boolean {
  return Boolean(library.rootPath && sessionFiles.has(library.rootPath))
}
