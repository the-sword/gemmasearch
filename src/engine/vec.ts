export function truncateNormalize(vector: ArrayLike<number>, dimensions: number): Float32Array {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > vector.length) {
    throw new RangeError('dimensions must be between 1 and vector length')
  }
  let norm = 0
  const result = new Float32Array(dimensions)
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[index] ?? 0
    result[index] = value
    norm += value * value
  }
  if (!Number.isFinite(norm) || norm === 0) throw new RangeError('vector must have a finite non-zero norm')
  const inverseNorm = 1 / Math.sqrt(norm)
  for (let index = 0; index < result.length; index += 1) result[index] *= inverseNorm
  return result
}

export function float32ToFloat16(values: ArrayLike<number>): Uint16Array {
  const output = new Uint16Array(values.length)
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0
    view.setFloat32(0, value, false)
    const bits = view.getUint32(0, false)
    const sign = (bits >>> 16) & 0x8000
    const exponent = (bits >>> 23) & 0xff
    const mantissa = bits & 0x7fffff
    if (exponent === 0xff) {
      output[index] = sign | (mantissa ? 0x7e00 : 0x7c00)
      continue
    }
    const halfExponent = exponent - 127 + 15
    if (halfExponent >= 0x1f) {
      output[index] = sign | 0x7c00
    } else if (halfExponent <= 0) {
      if (halfExponent < -10) {
        output[index] = sign
      } else {
        const significand = mantissa | 0x800000
        const shift = 14 - halfExponent
        let halfMantissa = significand >>> shift
        const remainder = significand & ((1 << shift) - 1)
        const halfway = 1 << (shift - 1)
        if (remainder > halfway || (remainder === halfway && (halfMantissa & 1) === 1)) halfMantissa += 1
        output[index] = sign | halfMantissa
      }
    } else {
      let halfMantissa = mantissa >>> 13
      const remainder = mantissa & 0x1fff
      if (remainder > 0x1000 || (remainder === 0x1000 && (halfMantissa & 1) === 1)) {
        halfMantissa += 1
      }
      let roundedExponent = halfExponent
      if (halfMantissa === 0x400) {
        halfMantissa = 0
        roundedExponent += 1
      }
      output[index] = roundedExponent >= 0x1f
        ? sign | 0x7c00
        : sign | (roundedExponent << 10) | halfMantissa
    }
  }
  return output
}

export function float16ToFloat32(values: ArrayLike<number>): Float32Array {
  const output = new Float32Array(values.length)
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  for (let index = 0; index < values.length; index += 1) {
    const half = values[index] ?? 0
    const sign = (half & 0x8000) << 16
    let exponent = (half >>> 10) & 0x1f
    let mantissa = half & 0x03ff
    let bits: number
    if (exponent === 0) {
      if (mantissa === 0) {
        bits = sign
      } else {
        exponent = 1
        while ((mantissa & 0x0400) === 0) {
          mantissa <<= 1
          exponent -= 1
        }
        mantissa &= 0x03ff
        bits = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13)
      }
    } else if (exponent === 0x1f) {
      bits = sign | 0x7f800000 | (mantissa << 13)
    } else {
      bits = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13)
    }
    view.setUint32(0, bits, false)
    output[index] = view.getFloat32(0, false)
  }
  return output
}

export function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length) throw new RangeError('vector dimensions differ')
  let total = 0
  for (let index = 0; index < left.length; index += 1) total += (left[index] ?? 0) * (right[index] ?? 0)
  return total
}

export function topK(scores: ArrayLike<number>, limit: number): Array<{ index: number; score: number }> {
  return Array.from({ length: scores.length }, (_, index) => ({ index, score: scores[index] ?? 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, Math.max(0, limit))
}

export function calibrateAudioScore(similarity: number): number {
  return Math.max(0, Math.min(1, (similarity - 0.08) / (1 - 0.08)))
}
