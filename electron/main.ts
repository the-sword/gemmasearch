import { app, BrowserWindow, dialog, ipcMain, protocol, shell, type WebContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { watch, type FSWatcher } from 'chokidar'
import { createReadStream, watch as watchNative, type FSWatcher as NativeFSWatcher } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { isPathAllowed, isPathInside, parseByteRange } from './security.js'
import { isIgnoredName, walkFiles } from './fs-walk.js'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
])

type ListJob = { sender: WebContents; canceled: boolean }
type WatchRegistration = { sender: WebContents; watcher: { close(): Promise<void> } }

const authorizedRoots = new Set<string>()
let registeredRoots = new Set<string>()
const listJobs = new Map<string, ListJob>()
const watchers = new Map<string, WatchRegistration>()
const mediaAccessToken = randomBytes(32).toString('hex')
let mainWindow: BrowserWindow | undefined
let mediaServer: ReturnType<typeof createServer> | undefined
let mediaServerPort: number | undefined

function appRoot(): string {
  return app.isPackaged ? app.getAppPath() : resolve(__dirname, '..')
}

function rootsFile(): string {
  return join(app.getPath('userData'), 'authorized-roots.json')
}

async function loadAuthorizedRoots(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  try {
    const saved = JSON.parse(await readFile(rootsFile(), 'utf8')) as unknown
    if (!Array.isArray(saved)) return
    for (const root of saved) {
      if (typeof root !== 'string') continue
      try {
        const canonical = await canonicalDirectory(root)
        authorizedRoots.add(canonical)
      } catch {
        // A previously selected removable drive may no longer be mounted.
      }
    }
  } catch {
    // The allowlist is created on the first folder selection.
  }
}

async function saveAuthorizedRoots(): Promise<void> {
  await writeFile(rootsFile(), JSON.stringify([...authorizedRoots], null, 2), 'utf8')
}

async function canonicalDirectory(value: string): Promise<string> {
  const canonical = await realpath(resolve(value))
  if (!(await stat(canonical)).isDirectory()) throw new Error('不是可用的文件夹')
  return canonical
}

async function authorizeRoot(value: string): Promise<string> {
  const canonical = await canonicalDirectory(value)
  authorizedRoots.add(canonical)
  await saveAuthorizedRoots()
  registeredRoots.add(canonical)
  return canonical
}

async function setRegisteredRoots(values: string[]): Promise<void> {
  const next = new Set<string>()
  for (const value of values) {
    try {
      const canonical = await canonicalDirectory(value)
      if (authorizedRoots.has(canonical)) next.add(canonical)
    } catch {
      // Missing roots are left out until the user selects them again.
    }
  }
  registeredRoots = next
}

async function resolveRegisteredDirectory(value: string): Promise<string> {
  const canonical = await canonicalDirectory(value)
  if (!registeredRoots.has(canonical)) throw new Error('文件夹尚未注册')
  return canonical
}

async function resolveRelativeFile(root: string, filePath: string): Promise<string> {
  const canonicalRoot = await resolveRegisteredDirectory(root)
  const candidate = resolve(canonicalRoot, filePath)
  if (!isPathInside(canonicalRoot, candidate)) throw new Error('拒绝访问文件夹之外的路径')
  const canonicalFile = await realpath(candidate)
  if (!isPathInside(canonicalRoot, canonicalFile)) throw new Error('拒绝访问文件夹之外的路径')
  if (!(await stat(canonicalFile)).isFile()) throw new Error('不是可读文件')
  return canonicalFile
}

async function resolveRegisteredFile(candidate: string): Promise<string | undefined> {
  const absolute = resolve(candidate)
  if (!isPathAllowed(absolute, registeredRoots)) return undefined
  try {
    const canonicalFile = await realpath(absolute)
    const canonicalRoot = [...registeredRoots].find((root) => isPathInside(root, canonicalFile))
    if (!canonicalRoot || !(await stat(canonicalFile)).isFile()) return undefined
    return canonicalFile
  } catch {
    return undefined
  }
}

function mimeType(filePath: string): string {
  const extension = extname(filePath).toLowerCase()
  return ({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.flac': 'audio/flac',
  } as Record<string, string>)[extension] || 'application/octet-stream'
}

function textResponse(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers } })
}

const mediaHeaders = {
  'Access-Control-Allow-Origin': 'app://bundle',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

function sendMediaError(response: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  const body = Buffer.from(message)
  response.writeHead(status, {
    ...mediaHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.byteLength),
    ...headers,
  })
  response.end(body)
}

async function handleMediaRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let pathname: string
  try {
    pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
  } catch {
    sendMediaError(response, 400, 'Bad request')
    return
  }
  const route = /^\/([a-f0-9]{64})\/([^/]+)$/.exec(pathname)
  if (!route || route[1] !== mediaAccessToken) {
    sendMediaError(response, 403, 'Forbidden')
    return
  }

  let candidate: string
  try {
    candidate = decodeURIComponent(route[2])
  } catch {
    sendMediaError(response, 400, 'Bad request')
    return
  }
  const filePath = await resolveRegisteredFile(candidate)
  if (!filePath) {
    sendMediaError(response, 403, 'Forbidden')
    return
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, mediaHeaders)
    response.end()
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendMediaError(response, 405, 'Method not allowed', { Allow: 'GET, HEAD, OPTIONS' })
    return
  }

  const details = await stat(filePath)
  const range = request.method === 'GET'
    ? parseByteRange(typeof request.headers.range === 'string' ? request.headers.range : null, details.size)
    : { kind: 'none' as const }
  if (range.kind === 'invalid') {
    sendMediaError(response, 416, 'Range not satisfiable', {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${details.size}`,
    })
    return
  }

  const partial = range.kind === 'range'
  const contentLength = partial ? range.end - range.start + 1 : details.size
  response.writeHead(partial ? 206 : 200, {
    ...mediaHeaders,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Length': String(contentLength),
    'Content-Type': mimeType(filePath),
    ...(partial ? { 'Content-Range': `bytes ${range.start}-${range.end}/${details.size}` } : {}),
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(filePath, partial ? { start: range.start, end: range.end } : undefined)
  response.on('close', () => {
    if (!response.writableEnded) stream.destroy()
  })
  stream.on('error', (error) => {
    if (response.headersSent) response.destroy(error)
    else sendMediaError(response, 500, 'Unable to read file')
  })
  stream.pipe(response)
}

async function startMediaServer(): Promise<void> {
  const server = createServer((request, response) => {
    void handleMediaRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined)
      else sendMediaError(response, 500, 'Internal server error')
    })
  })
  server.on('error', (error) => {
    if (mediaServerPort === undefined) return
    console.error('Loopback media server error', error)
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen)
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectListen(new Error('无法启动本地媒体服务'))
        return
      }
      mediaServer = server
      mediaServerPort = address.port
      resolveListen()
    })
  })
}

async function handleAppRequest(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url)
  if (requestUrl.hostname !== 'bundle') return textResponse('Not found', 404)
  const pathname = decodeURIComponent(requestUrl.pathname || '/')
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const distRoot = resolve(appRoot(), 'dist')
  const filePath = resolve(distRoot, relativePath)
  if (!isPathInside(distRoot, filePath)) return textResponse('Forbidden', 403)
  try {
    const details = await stat(filePath)
    if (!details.isFile()) return textResponse('Not found', 404)
    const body = request.method === 'HEAD'
      ? undefined
      : Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': mimeType(filePath),
        'Content-Length': String(details.size),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-cache',
      },
    })
  } catch {
    return textResponse('Not found', 404)
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('gemma:pick-folder', async () => {
    const configuredPath = process.env.GEMMA_E2E_PICK_FOLDER
    if (configuredPath) {
      const rootPath = await authorizeRoot(configuredPath)
      return { name: basename(rootPath) || rootPath, rootPath }
    }
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    const selectedPath = result.canceled ? undefined : result.filePaths[0]
    if (!selectedPath) return null
    const rootPath = await authorizeRoot(selectedPath)
    return { name: basename(rootPath) || rootPath, rootPath }
  })

  ipcMain.handle('gemma:register-roots', async (_event, values: unknown) => {
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) throw new Error('无效的文件夹列表')
    await setRegisteredRoots(values)
  })

  ipcMain.handle('gemma:read-file', async (_event, root: unknown, filePath: unknown) => {
    if (typeof root !== 'string' || typeof filePath !== 'string') throw new Error('无效的文件路径')
    const absolute = await resolveRelativeFile(root, filePath)
    const bytes = await readFile(absolute)
    const output = new Uint8Array(bytes.byteLength)
    output.set(bytes)
    return output.buffer
  })

  ipcMain.handle('gemma:media-url', async (_event, root: unknown, filePath: unknown) => {
    if (typeof root !== 'string' || typeof filePath !== 'string') throw new Error('无效的文件路径')
    if (mediaServerPort === undefined) throw new Error('本地媒体服务尚未启动')
    const absolute = await resolveRelativeFile(root, filePath)
    return `http://127.0.0.1:${mediaServerPort}/${mediaAccessToken}/${encodeURIComponent(absolute)}`
  })

  ipcMain.on('gemma:list-files:start', (event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const value = payload as { requestId?: unknown; root?: unknown }
    if (typeof value.requestId !== 'string' || typeof value.root !== 'string') return
    const job: ListJob = { sender: event.sender, canceled: false }
    listJobs.set(value.requestId, job)
    void (async () => {
      try {
        const root = await resolveRegisteredDirectory(value.root as string)
        let batch: Array<{ path: string; name: string; size: number; mtime: number }> = []
        for await (const entry of walkFiles(root)) {
          if (job.canceled || job.sender.isDestroyed()) return
          batch.push(entry)
          if (batch.length >= 128) {
            job.sender.send('gemma:list-files:batch', { requestId: value.requestId, entries: batch })
            batch = []
          }
        }
        if (batch.length && !job.canceled && !job.sender.isDestroyed()) {
          job.sender.send('gemma:list-files:batch', { requestId: value.requestId, entries: batch })
        }
        if (!job.canceled && !job.sender.isDestroyed()) job.sender.send('gemma:list-files:done', { requestId: value.requestId })
      } catch (error) {
        if (!job.sender.isDestroyed()) {
          job.sender.send('gemma:list-files:error', {
            requestId: value.requestId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } finally {
        listJobs.delete(value.requestId as string)
      }
    })()
  })

  ipcMain.on('gemma:list-files:cancel', (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    const job = listJobs.get(requestId)
    if (job) job.canceled = true
  })

  ipcMain.handle('gemma:watch-start', async (event, libraryId: unknown, root: unknown) => {
    if (typeof libraryId !== 'string' || typeof root !== 'string') throw new Error('无效的监听参数')
    const rootPath = await resolveRegisteredDirectory(root)
    const existing = watchers.get(libraryId)
    if (existing) await existing.watcher.close()
    const pendingEvents = new Map<string, ReturnType<typeof setTimeout>>()
    let nativeWatcher: NativeFSWatcher | undefined
    let chokidarWatcher: FSWatcher | undefined

    const clearPendingEvents = () => {
      for (const timer of pendingEvents.values()) clearTimeout(timer)
      pendingEvents.clear()
    }

    const emitFileEvent = async (relativePath: string, preferredType?: 'add' | 'change' | 'unlink') => {
      if (watchers.get(libraryId) !== registration || registration.sender.isDestroyed()) return
      const absolute = join(rootPath, ...relativePath.split('/'))
      const details = await stat(absolute).catch(() => undefined)
      if (details && !details.isFile()) return
      registration.sender.send('gemma:watch:event', {
        libraryId,
        event: {
          type: details ? (preferredType === 'add' ? 'add' : 'change') : 'unlink',
          path: relativePath,
          name: basename(absolute),
          size: details?.size,
          mtime: details?.mtimeMs,
        },
      })
    }

    const normalizeRelativePath = (value: string): string | undefined => {
      const normalized = value.split(/[\\/]/).filter(Boolean).join('/')
      if (!normalized || normalized.split('/').some((part) => part === '..' || isIgnoredName(part))) return undefined
      return normalized
    }

    const watcher = {
      async close() {
        clearPendingEvents()
        if (nativeWatcher) nativeWatcher.close()
        if (chokidarWatcher) await chokidarWatcher.close()
      },
    }
    const registration: WatchRegistration = { sender: event.sender, watcher }
    watchers.set(libraryId, registration)

    if (process.platform === 'win32' || process.platform === 'darwin') {
      nativeWatcher = watchNative(rootPath, { recursive: true }, (_eventType, filename) => {
        if (filename === null) return
        const relativePath = normalizeRelativePath(filename.toString())
        if (!relativePath) return
        const previous = pendingEvents.get(relativePath)
        if (previous) clearTimeout(previous)
        pendingEvents.set(relativePath, setTimeout(() => {
          pendingEvents.delete(relativePath)
          void emitFileEvent(relativePath)
        }, 500))
      })
      nativeWatcher.on('error', (error) => console.warn('[GemmaSearch] native watcher error', rootPath, error))
    } else {
      chokidarWatcher = watch(rootPath, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        ignored: (value) => value.split(/[\\/]/).some(isIgnoredName),
      })
      chokidarWatcher.on('error', (error) => console.warn('[GemmaSearch] chokidar watcher error', rootPath, error))
      chokidarWatcher.on('all', (type, changedPath) => {
        if (type !== 'add' && type !== 'change' && type !== 'unlink') return
        const relativePath = normalizeRelativePath(relative(rootPath, changedPath))
        if (!relativePath) return
        void emitFileEvent(relativePath, type)
      })
    }

    event.sender.once('destroyed', () => {
      if (watchers.get(libraryId) === registration) {
        watchers.delete(libraryId)
        void registration.watcher.close().catch((error: unknown) => {
          console.warn('[GemmaSearch] watcher close failed', rootPath, error)
        })
      }
    })
  })

  ipcMain.handle('gemma:watch-stop', async (_event, libraryId: unknown) => {
    if (typeof libraryId !== 'string') return
    const registration = watchers.get(libraryId)
    if (!registration) return
    watchers.delete(libraryId)
    await registration.watcher.close()
  })

  ipcMain.handle('gemma:open-path', async (_event, root: unknown, filePath: unknown) => {
    if (typeof root !== 'string' || typeof filePath !== 'string') throw new Error('无效的文件路径')
    await shell.openPath(await resolveRelativeFile(root, filePath))
  })

  ipcMain.handle('gemma:show-in-folder', async (_event, root: unknown, filePath: unknown) => {
    if (typeof root !== 'string' || typeof filePath !== 'string') throw new Error('无效的文件路径')
    shell.showItemInFolder(await resolveRelativeFile(root, filePath))
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: 'Gemma 多模态搜索',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(appRoot(), 'dist-electron', 'preload.cjs'),
    },
  })
  const devUrl = process.env.GEMMA_VITE_URL
  void (devUrl ? window.loadURL(devUrl) : window.loadURL('app://bundle/index.html'))
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('app://bundle/')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:/i.test(url)) void shell.openExternal(url)
    }
  })
  return window
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-unsafe-webgpu')
  app.commandLine.appendSwitch('enable-features', 'Vulkan')
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  void app.whenReady().then(async () => {
    await loadAuthorizedRoots()
    protocol.handle('app', handleAppRequest)
    registerIpcHandlers()
    await startMediaServer()
    mainWindow = createMainWindow()
    app.on('activate', () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow()
    })
  })
  app.on('before-quit', () => {
    for (const registration of watchers.values()) void registration.watcher.close()
    watchers.clear()
    mediaServer?.close()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
