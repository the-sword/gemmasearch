import { contextBridge, ipcRenderer } from 'electron'
import type { FileEntry, Host, Library, LibrarySource } from '../src/host/types.js'

type WatchEvent = { type: 'add' | 'change' | 'unlink'; path: string }
type ListMessage =
  | { type: 'batch'; entries: FileEntry[] }
  | { type: 'done' }
  | { type: 'error'; error: string }

type Queue<T> = {
  push(value: T): void
  close(): void
  fail(error: Error): void
  next(): Promise<IteratorResult<T>>
}

function createQueue<T>(): Queue<T> {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  let failure: Error | undefined
  return {
    push(value) {
      if (closed || failure) return
      const waiter = waiters.shift()
      if (waiter) waiter({ done: false, value })
      else values.push(value)
    },
    close() {
      if (closed || failure) return
      closed = true
      while (waiters.length) waiters.shift()!({ done: true, value: undefined })
    },
    fail(error) {
      if (closed || failure) return
      failure = error
      while (waiters.length) waiters.shift()!({ done: true, value: undefined })
    },
    async next() {
      if (values.length) return { done: false, value: values.shift()! }
      if (failure) throw failure
      if (closed) return { done: true, value: undefined }
      return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve))
    },
  }
}

const electronHost: Host & { registerRoots(paths: string[]): Promise<void> } = {
  kind: 'electron',
  async pickFolder(): Promise<LibrarySource | null> {
    return ipcRenderer.invoke('gemma:pick-folder') as Promise<LibrarySource | null>
  },
  async listFiles(library: Library): Promise<FileEntry[]> {
    if (!library.rootPath) return []
    const requestId = crypto.randomUUID()
    const queue = createQueue<ListMessage>()
    const entries: FileEntry[] = []
    const onBatch = (_event: Electron.IpcRendererEvent, message: { requestId?: unknown; entries?: unknown }) => {
      if (message.requestId !== requestId || !Array.isArray(message.entries)) return
      queue.push({ type: 'batch', entries: message.entries as FileEntry[] })
    }
    const onDone = (_event: Electron.IpcRendererEvent, message: { requestId?: unknown }) => {
      if (message.requestId === requestId) queue.push({ type: 'done' })
    }
    const onError = (_event: Electron.IpcRendererEvent, message: { requestId?: unknown; error?: unknown }) => {
      if (message.requestId === requestId) queue.push({ type: 'error', error: typeof message.error === 'string' ? message.error : '无法读取文件夹' })
    }
    ipcRenderer.on('gemma:list-files:batch', onBatch)
    ipcRenderer.on('gemma:list-files:done', onDone)
    ipcRenderer.on('gemma:list-files:error', onError)
    ipcRenderer.send('gemma:list-files:start', { requestId, root: library.rootPath })
    try {
      while (true) {
        const message = await queue.next()
        if (message.done) return entries
        if (message.value.type === 'error') throw new Error(message.value.error)
        if (message.value.type === 'done') return entries
        entries.push(...message.value.entries)
      }
    } finally {
      ipcRenderer.removeListener('gemma:list-files:batch', onBatch)
      ipcRenderer.removeListener('gemma:list-files:done', onDone)
      ipcRenderer.removeListener('gemma:list-files:error', onError)
      ipcRenderer.send('gemma:list-files:cancel', requestId)
      queue.close()
    }
  },
  async readFile(library: Library, file: FileEntry): Promise<Blob> {
    if (!library.rootPath) throw new Error('资料库没有文件夹路径')
    const data = await ipcRenderer.invoke('gemma:read-file', library.rootPath, file.path) as ArrayBuffer
    return new Blob([data])
  },
  async mediaUrl(library: Library, file: FileEntry): Promise<string> {
    if (!library.rootPath) throw new Error('资料库没有文件夹路径')
    return ipcRenderer.invoke('gemma:media-url', library.rootPath, file.path) as Promise<string>
  },
  watch(library: Library, callback: (event: WatchEvent) => void): () => void {
    if (!library.rootPath) return () => {}
    const listener = (_event: Electron.IpcRendererEvent, message: { libraryId?: unknown; event?: WatchEvent }) => {
      if (message.libraryId === library.id && message.event) callback(message.event)
    }
    ipcRenderer.on('gemma:watch:event', listener)
    void ipcRenderer.invoke('gemma:watch-start', library.id, library.rootPath)
    return () => {
      ipcRenderer.removeListener('gemma:watch:event', listener)
      void ipcRenderer.invoke('gemma:watch-stop', library.id)
    }
  },
  async openPath(library: Library, file: FileEntry): Promise<void> {
    if (!library.rootPath) throw new Error('资料库没有文件夹路径')
    await ipcRenderer.invoke('gemma:open-path', library.rootPath, file.path)
  },
  async showInFolder(library: Library, file: FileEntry): Promise<void> {
    if (!library.rootPath) throw new Error('资料库没有文件夹路径')
    await ipcRenderer.invoke('gemma:show-in-folder', library.rootPath, file.path)
  },
  async registerRoots(paths: string[]): Promise<void> {
    await ipcRenderer.invoke('gemma:register-roots', paths)
  },
}

contextBridge.exposeInMainWorld('gemmaHost', electronHost)
