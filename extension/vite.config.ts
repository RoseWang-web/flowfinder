/**
 * Build for the extension pages (side panel, permission page) and the
 * background service worker. The content script is built separately as a
 * single IIFE file (vite.content.config.ts), because content scripts cannot
 * load ES module chunks.
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchEmbind } from './build/embindPatch'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, 'dist')

/** Ship the exact face_mesh version WebGazer depends on (MV3 forbids remote code). */
function copyFaceMesh(): Plugin {
  return {
    name: 'copy-face-mesh',
    writeBundle() {
      const src = resolve(here, '../node_modules/@mediapipe/face_mesh')
      const dst = resolve(outDir, 'face_mesh')
      mkdirSync(dst, { recursive: true })
      for (const f of readdirSync(src)) {
        if (!/\.(js|wasm|data|binarypb)$/.test(f)) continue
        if (/_wasm_bin\.js$/.test(f)) {
          writeFileSync(resolve(dst, f), patchEmbind(readFileSync(resolve(src, f), 'utf8'), f))
        } else {
          cpSync(resolve(src, f), resolve(dst, f))
        }
      }
    },
  }
}

export default defineConfig({
  root: resolve(here, 'src'),
  publicDir: resolve(here, 'public'),
  base: './',
  resolve: { alias: { '@core': resolve(here, '../src') } },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        sidepanel: resolve(here, 'src/sidepanel/index.html'),
        permission: resolve(here, 'src/permission/index.html'),
        popup: resolve(here, 'src/popup/index.html'),
        calibrate: resolve(here, 'src/calibrate/index.html'),
        offscreen: resolve(here, 'src/engine/offscreen.html'),
        history: resolve(here, 'src/history/index.html'),
        background: resolve(here, 'src/background.ts'),
      },
      output: {
        entryFileNames: chunk => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  plugins: [react(), copyFaceMesh()],
})
