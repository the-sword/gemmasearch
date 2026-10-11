import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { FileEntry } from '../src/host/types.js'

const IGNORED_FILES = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db'])

export function isIgnoredName(name: string): boolean {
  const normalized = name.toLowerCase()
  return name.startsWith('.') ||
    normalized === 'node_modules' ||
    name.startsWith('$') ||
    normalized === 'system volume information' ||
    IGNORED_FILES.has(normalized)
}

export function fileEntry(root: string, absolute: string, size: number, mtime: number): FileEntry {
  const path = relative(root, absolute).split(sep).join('/')
  return { path, name: basename(absolute), size, mtime }
}

export async function* walkFiles(root: string, prefix = ''): AsyncGenerator<FileEntry> {
  const directory = prefix ? join(root, prefix) : root
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    console.warn('[GemmaSearch] skipping unreadable directory', directory, error)
    return
  }

  for (const entry of entries) {
    if (isIgnoredName(entry.name)) continue
    const childPath = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      yield* walkFiles(root, childPath)
    } else if (entry.isFile()) {
      const absolute = join(root, childPath)
      try {
        const details = await stat(absolute)
        yield fileEntry(root, absolute, details.size, details.mtimeMs)
      } catch (error) {
        console.warn('[GemmaSearch] skipping unreadable file', absolute, error)
      }
    }
  }
}
