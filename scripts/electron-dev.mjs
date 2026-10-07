import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const viteBin = require.resolve('vite/bin/vite.js')
const electronBin = require('electron')
const port = '4174'
const env = { ...process.env, GEMMA_VITE_URL: `http://127.0.0.1:${port}` }

const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', port, '--strictPort'], {
  env,
  stdio: 'inherit',
})

let stopping = false
const stop = (code = 0) => {
  if (stopping) return
  stopping = true
  vite.kill('SIGTERM')
  process.exit(code)
}

for (let attempt = 0; attempt < 80; attempt += 1) {
  try {
    const response = await fetch(env.GEMMA_VITE_URL)
    if (response.ok) break
  } catch {
    // Vite is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 250))
}

if (vite.exitCode !== null) stop(vite.exitCode || 1)
const electron = spawn(electronBin, ['.'], { env, stdio: 'inherit' })
electron.on('exit', (code) => stop(code || 0))
process.on('SIGINT', () => stop(130))
process.on('SIGTERM', () => stop(143))
