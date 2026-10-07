import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'dist-electron/**', 'release/**', 'build/**', 'node_modules/**', 'public/ort/**'] },
  {
    files: ['scripts/**/*.{mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
