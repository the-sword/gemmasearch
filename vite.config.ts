import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

function removeDuplicateOrtWasm(): Plugin {
  return {
    name: 'remove-duplicate-ort-wasm',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (
          output.type !== 'asset' ||
          !/^assets\/ort-wasm-simd-threaded\.asyncify-[^.]+\.wasm$/.test(fileName)
        ) {
          continue
        }
        for (const candidate of Object.values(bundle)) {
          if (candidate.type === 'chunk') {
            candidate.code = candidate.code.replaceAll(
              `/${fileName}`,
              '/ort/ort-wasm-simd-threaded.asyncify.wasm',
            )
          }
        }
        delete bundle[fileName]
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), removeDuplicateOrtWasm()],
  worker: {
    plugins: () => [removeDuplicateOrtWasm()],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
