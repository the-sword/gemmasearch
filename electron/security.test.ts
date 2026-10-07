import { describe, expect, it } from 'vitest'
import { isPathAllowed, isPathInside, parseByteRange } from './security.js'

describe('Electron media path guard', () => {
  it('allows a registered root and its descendants', () => {
    expect(isPathInside('/media/library', '/media/library')).toBe(true)
    expect(isPathAllowed('/media/library/sub/image.jpg', ['/media/library'])).toBe(true)
  })

  it('rejects traversal and similarly named sibling directories', () => {
    expect(isPathAllowed('/media/library/../secret.txt', ['/media/library'])).toBe(false)
    expect(isPathAllowed('/media/library-backup/secret.txt', ['/media/library'])).toBe(false)
  })
})

describe('HTTP byte range parser', () => {
  it('accepts full, open-ended, and suffix ranges', () => {
    expect(parseByteRange(null, 100)).toEqual({ kind: 'none' })
    expect(parseByteRange('bytes=5-9', 100)).toEqual({ kind: 'range', start: 5, end: 9 })
    expect(parseByteRange('bytes=90-', 100)).toEqual({ kind: 'range', start: 90, end: 99 })
    expect(parseByteRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 })
  })

  it('clamps ranges and rejects malformed or unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=95-120', 100)).toEqual({ kind: 'range', start: 95, end: 99 })
    expect(parseByteRange('bytes=100-', 100)).toEqual({ kind: 'invalid' })
    expect(parseByteRange('bytes=-0', 100)).toEqual({ kind: 'invalid' })
    expect(parseByteRange('bytes=1-2,4-5', 100)).toEqual({ kind: 'invalid' })
  })
})
