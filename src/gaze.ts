/**
 * gaze.ts — Eye-tracking adapter (WebGazer).
 *
 * GazeTracker is the boundary that tests mock, like CameraAdapter in camera.ts.
 * WebGazer is loaded with a dynamic import, so it (and TensorFlow.js) is only
 * downloaded when the user turns on eye-tracking mode.
 *
 * License note: WebGazer is GPL-3.0-or-later. Fine for research and prototypes;
 * a closed-source product would need to replace it (e.g. iris landmarks from
 * the MediaPipe Face Landmarker we already use + our own ridge regression).
 */

import type { GazeSample } from './attentionModel'
import { parseCameraError, type CameraError } from './camera'

export interface GazeTracker {
  /** Ask for the camera, load the face model, start predicting. */
  begin(): Promise<void>
  /** Subscribe to predictions; x/y are null when there is no face. Returns an unsubscribe function. */
  addListener(listener: (sample: GazeSample) => void): () => void
  /** Add one training example: the user is looking at (x, y) right now (viewport px). */
  recordCalibrationPoint(x: number, y: number): void
  /** Forget all calibration examples (before re-calibrating). */
  clearCalibration(): Promise<void>
  /** Show the camera preview with the face box (used while positioning the face). */
  showPreview(visible: boolean): void
  /** Show WebGazer's red dot at the predicted gaze (debug). */
  showGazeDot(visible: boolean): void
  pause(): void
  resume(): void
  /** Stop predicting AND release the camera. */
  end(): void
}

// Minimal typing for the parts of WebGazer we use
interface WebGazerPrediction { x: number; y: number }
interface WebGazerModule {
  params: { faceMeshSolutionPath: string; videoContainerId: string }
  setRegression(name: string): WebGazerModule
  saveDataAcrossSessions(v: boolean): WebGazerModule
  applyKalmanFilter(v: boolean): WebGazerModule
  showVideoPreview(v: boolean): WebGazerModule
  showFaceOverlay(v: boolean): WebGazerModule
  showFaceFeedbackBox(v: boolean): WebGazerModule
  showPredictionPoints(v: boolean): WebGazerModule
  setGazeListener(fn: (data: WebGazerPrediction | null, elapsedMs: number) => void): WebGazerModule
  clearGazeListener(): WebGazerModule
  removeMouseEventListeners(): WebGazerModule
  recordScreenPosition(x: number, y: number, eventType?: string): WebGazerModule
  clearData(): Promise<void>
  begin(onFail?: () => void): Promise<WebGazerModule>
  pause(): WebGazerModule
  resume(): Promise<WebGazerModule>
  stopVideo(): WebGazerModule
  end(): WebGazerModule
}

// face_mesh version that WebGazer 3.5.3's face-landmarks-detection depends on
const FACE_MESH_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619'

export function parseGazeError(err: unknown): CameraError {
  if (err instanceof Error && /fetch|load|wasm|import/i.test(err.message)) {
    return { kind: 'model_load_failed', message: `Eye tracking model failed to load: ${err.message}` }
  }
  return parseCameraError(err)
}

export interface WebGazerTrackerOptions {
  /** Where face_mesh's JS/WASM/data files are served from (default: jsdelivr CDN).
   *  The browser extension serves a bundled copy of the same version. */
  faceMeshPath?: string
}

export function createWebGazerTracker(options: WebGazerTrackerOptions = {}): GazeTracker {
  const faceMeshPath = options.faceMeshPath ?? FACE_MESH_CDN
  let wg: WebGazerModule | null = null
  let running = false
  const listeners = new Set<(s: GazeSample) => void>()

  const emit = (data: WebGazerPrediction | null) => {
    const t = performance.now()
    const sample: GazeSample = data
      ? { t, x: data.x, y: data.y }
      : { t, x: null, y: null }
    listeners.forEach(fn => fn(sample))
  }

  const container = (): HTMLElement | null =>
    wg ? document.getElementById(wg.params.videoContainerId) : null

  return {
    async begin() {
      if (running) return
      if (!wg) {
        const mod = await import(/* @vite-ignore */ 'webgazer')
        wg = (mod.default ?? mod) as unknown as WebGazerModule
        wg.params.faceMeshSolutionPath = faceMeshPath
      }
      wg.setRegression('ridge')
        .saveDataAcrossSessions(false)   // never keep face data in the browser
        .applyKalmanFilter(true)
        .showPredictionPoints(false)
        .setGazeListener(data => { if (running) emit(data) })
      await wg.begin()
      // We record calibration clicks ourselves; random mouse moves while reading
      // would otherwise keep re-training (and corrupting) the model.
      wg.removeMouseEventListeners()
      running = true
    },

    addListener(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    recordCalibrationPoint(x, y) {
      wg?.recordScreenPosition(x, y, 'click')
    },

    async clearCalibration() {
      await wg?.clearData()
    },

    showPreview(visible) {
      if (!wg) return
      wg.showVideoPreview(visible).showFaceOverlay(visible).showFaceFeedbackBox(visible)
      const el = container()
      if (el && visible) {
        // WebGazer pins the preview to the top-left corner; centre it above our overlay
        el.style.left = '50%'
        el.style.top = '96px'
        el.style.transform = 'translateX(-50%)'
        el.style.zIndex = '1001'
      }
    },

    showGazeDot(visible) {
      wg?.showPredictionPoints(visible)
    },

    pause() {
      wg?.pause()
    },

    resume() {
      void wg?.resume()
    },

    end() {
      if (!wg || !running) return
      running = false
      try { wg.clearGazeListener() } catch { /* already cleared */ }
      try { wg.stopVideo() } catch { /* stream already gone */ }
      try { wg.end() } catch { /* DOM already removed */ }
    },
  }
}
