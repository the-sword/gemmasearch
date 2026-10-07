import { float16ToFloat32 } from './vec'

export interface PackItem {
  id?: number
  libId: string
  fileKey: string
  modality: string
  start?: number
  end?: number
  page?: number
  chunk?: number
  text?: string
  vec?: ArrayBuffer
}

export interface PackPayload {
  version: 1
  modelSig: string
  dim: number
  library: { name: string; kind: string }
  files: unknown[]
  items: Array<Omit<PackItem, 'vec'>>
  thumbs: Array<{ fileKey: string; jpeg?: string; peaks?: number[]; pages?: Record<number, string> }>
}

const MAGIC = new TextEncoder().encode('GSIDX1\n')

export function encodeIndexPack(payload: PackPayload, vectors: ArrayBuffer[]): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const prefix = new Uint8Array(MAGIC.length + 4 + json.length)
  prefix.set(MAGIC)
  new DataView(prefix.buffer).setUint32(MAGIC.length, json.length, true)
  prefix.set(json, MAGIC.length + 4)
  const length = vectors.reduce((sum, vector) => sum + vector.byteLength, 0)
  const result = new Uint8Array(prefix.length + length)
  result.set(prefix)
  let offset = prefix.length
  for (const vector of vectors) {
    result.set(new Uint8Array(vector), offset)
    offset += vector.byteLength
  }
  return result
}

export function decodeIndexPack(bytes: Uint8Array): { payload: PackPayload; vectors: Float32Array[] } {
  if (MAGIC.some((value, index) => bytes[index] !== value)) throw new Error('无效的索引包')
  const jsonLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(MAGIC.length, true)
  const jsonStart = MAGIC.length + 4
  const payload = JSON.parse(new TextDecoder().decode(bytes.subarray(jsonStart, jsonStart + jsonLength))) as PackPayload
  if (payload.version !== 1 || !Number.isInteger(payload.dim) || payload.dim < 1) {
    throw new Error('不支持的索引包版本')
  }
  const vectorBytes = bytes.subarray(jsonStart + jsonLength)
  const expectedBytes = payload.items.length * payload.dim * 2
  if (vectorBytes.byteLength !== expectedBytes) throw new Error('索引向量数据长度不匹配')
  const vectors: Float32Array[] = []
  for (let item = 0; item < payload.items.length; item += 1) {
    const view = new DataView(vectorBytes.buffer, vectorBytes.byteOffset + item * payload.dim * 2, payload.dim * 2)
    const halves = new Uint16Array(payload.dim)
    for (let dimension = 0; dimension < payload.dim; dimension += 1) halves[dimension] = view.getUint16(dimension * 2, true)
    vectors.push(float16ToFloat32(halves))
  }
  return { payload, vectors }
}
