import { isAbsolute, relative, resolve, sep } from 'node:path'

export type ByteRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'invalid' }

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

export function isPathAllowed(candidate: string, roots: Iterable<string>): boolean {
  for (const root of roots) {
    if (isPathInside(root, candidate)) return true
  }
  return false
}

export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: 'none' }
  if (!Number.isSafeInteger(size) || size < 0) return { kind: 'invalid' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || size === 0 || (match[1] === '' && match[2] === '')) return { kind: 'invalid' }

  if (match[1] === '') {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' }
    return { kind: 'range', start: Math.max(0, size - suffixLength), end: size - 1 }
  }

  const start = Number(match[1])
  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start) {
    return { kind: 'invalid' }
  }
  return { kind: 'range', start, end: Math.min(requestedEnd, size - 1) }
}
