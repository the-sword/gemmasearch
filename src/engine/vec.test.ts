import { describe, expect, it } from 'vitest'
import { calibrateAudioScore, dot, float16ToFloat32, float32ToFloat16, meanNormalize, topK, truncateNormalize } from './vec'

describe('vector helpers', () => {
  it('truncates and renormalizes like the manual calculation', () => {
    const vector = [1, 2, 3, 4]
    const result = truncateNormalize(vector, 3)
    const norm = Math.sqrt(14)
    expect([...result]).toEqual([1 / norm, 2 / norm, 3 / norm].map(Math.fround))
    expect(Math.sqrt(dot(result, result))).toBeCloseTo(1, 6)
  })

  it('averages vectors and renormalizes the result', () => {
    const result = meanNormalize([new Float32Array([1, 0]), new Float32Array([0, 1])], 2)
    expect([...result]).toEqual([Math.SQRT1_2, Math.SQRT1_2].map(Math.fround))
    expect(Math.sqrt(dot(result, result))).toBeCloseTo(1, 6)
  })

  it('round-trips random unit vectors through f16 within 1e-3', () => {
    let seed = 419
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0xffffffff * 2 - 1
    }
    for (let run = 0; run < 12; run += 1) {
      const source = truncateNormalize(Array.from({ length: 768 }, random), 768)
      const restored = float16ToFloat32(float32ToFloat16(source))
      expect(Math.max(...source.map((value, index) => Math.abs(value - (restored[index] ?? 0))))).toBeLessThan(1e-3)
    }
  })

  it('orders top scores and uses stable input order for ties', () => {
    expect(topK([0.4, 0.8, 0.8, 0.2], 3)).toEqual([
      { index: 1, score: 0.8 },
      { index: 2, score: 0.8 },
      { index: 0, score: 0.4 },
    ])
  })

  it('calibrates audio similarities', () => {
    expect(calibrateAudioScore(0.08)).toBe(0)
    expect(calibrateAudioScore(1)).toBe(1)
    expect(calibrateAudioScore(0.54)).toBeCloseTo(0.5, 8)
  })
})
