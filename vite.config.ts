import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Keep tasks-vision/face_detection excluded: camera.ts still exists in src/
    // and Vite would otherwise eagerly bundle their WASM runners, causing
    // Module.arguments conflicts even though those files are not imported at runtime.
    exclude: [
      '@mediapipe/tasks-vision',
      '@mediapipe/face_detection',
    ],
    // webgazer is CJS; include forces the CJS→ESM conversion so the browser
    // doesn't get a raw `module.exports = ...` that crashes with "module is not defined".
    // face_mesh (webgazer's dep) stays out of exclude so it bundles inline with webgazer.
    // localforage is likewise CJS and needs the same treatment.
    include: [
      'webgazer',
      'localforage',
    ],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
