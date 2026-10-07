import { describe, expect, it } from 'vitest'
import { decodeIndexPack, encodeIndexPack, type PackPayload } from './pack'
import { float32ToFloat16 } from './vec'

describe('index pack', () => {
  it('round-trips metadata and little-endian f16 vectors', () => {
    const vector = float32ToFloat16([0.25, 0.5, 0.75, 1])
    const payload: PackPayload = {
      version: 1,
      modelSig: '{"dim":4}',
      dim: 4,
      library: { name: '相册', kind: 'files' },
      files: [{ path: 'cats.jpg' }],
      items: [{ libId: 'l1', fileKey: 'l1:cats.jpg', modality: 'image' }],
      thumbs: [],
    }
    const decoded = decodeIndexPack(encodeIndexPack(payload, [vector.buffer as ArrayBuffer]))
    expect(decoded.payload).toEqual(payload)
    expect([...decoded.vectors[0]!]).toEqual([0.25, 0.5, 0.75, 1])
  })
})
