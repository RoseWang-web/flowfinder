import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  publicDir: false,
  resolve: { alias: { '@core': resolve(here, '../src') } },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: false, // runs after vite.config.ts
    target: 'es2022',
    lib: {
      entry: resolve(here, 'src/content/index.ts'),
      formats: ['iife'],
      name: 'FlowFinderContent',
      fileName: () => 'content.js',
    },
  },
})
