import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const source = resolve('node_modules/onnxruntime-web/dist')
const target = resolve('public/ort')
mkdirSync(target, { recursive: true })
for (const file of readdirSync(source)) {
  if (/^ort-wasm-simd-threaded.*\.(mjs|wasm)$/.test(file)) {
    cpSync(resolve(source, file), resolve(target, file))
  }
}
