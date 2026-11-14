/**
 * Offscreen document entry — hosts the Engine (camera + WebGazer + session).
 *
 * Order matters: the timer-driven rAF must be installed before WebGazer and
 * TF.js are imported (they look up requestAnimationFrame when they load).
 */
import { installTimerFrames } from './timerFrames'
import { Engine } from './Engine'
import { createWebGazerTracker } from '@core/gaze'
import { DEFAULT_MODEL } from '@core/attentionModel'
import { loadBaseline, saveBaseline } from '@core/useGaze'
import modelJson from '@core/model.json'
import { isToEngine, type ToBackground } from '../protocol'
import type { KV } from '../session/historyStore'

installTimerFrames(30)

// WebGazer 3.5.3 alert()s on any non-https page, including chrome-extension://
// (a secure context). An alert would block this document forever.
window.alert = (message?: unknown) => console.info('[engine] alert suppressed:', message)

const toBackground = <T>(m: ToBackground) => chrome.runtime.sendMessage(m) as Promise<T>

/** Offscreen documents only get chrome.runtime, so storage goes through the background. */
const remoteKV: KV = {
  get: key => toBackground({ to: 'background', type: 'kv_get', key }),
  set: (key, value) => toBackground({ to: 'background', type: 'kv_set', key, value }),
  remove: key => toBackground({ to: 'background', type: 'kv_remove', key }),
}

const engine = new Engine({
  tracker: createWebGazerTracker({ faceMeshPath: chrome.runtime.getURL('face_mesh').replace(/\/$/, '') }),
  kv: remoteKV,
  publish: state => { void toBackground({ to: 'background', type: 'state', state }).catch(() => {}) },
  modelCvRocAuc: modelJson.training.cvRocAuc,
  // Same per-user z-score baseline as the side panel (same extension origin)
  baseline: { load: loadBaseline, save: saveBaseline },
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isToEngine(msg)) return
  engine.handle(msg, sender.tab?.id ?? null).then(sendResponse, err => sendResponse({ error: String(err) }))
  return true // async response
})

setInterval(() => engine.tick(), 1000)
setInterval(() => engine.step(), DEFAULT_MODEL.params.stepSeconds * 1000)
void engine.init()
