import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const source = resolve('node_modules/onnxruntime-web/dist')
const target = resolve('public/ort')
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(resolve(source, file), resolve(target, file))
}
