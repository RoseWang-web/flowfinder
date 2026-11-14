/**
 * Sync writes into the web app's real history code (localStorage in jsdom),
 * then the Dashboard's loader must see the sessions.
 */
import { describe, it, expect, vi } from 'vitest'
import { deleteHistoryEntry, loadHistory, HISTORY_UPDATED_EVENT } from '@core/historyStorage'
import { isFlowFinderApp, syncHistoryOnce } from './historySync'
import { markSynced, memoryKV, pendingForOrigin, saveCompletedSession } from '../session/historyStore'
import { SessionRecorder } from '../session/recorder'
import type { AttentionResult } from '@core/attentionModel'
import type { GazeSessionInfo } from '@core/types'

const ORIGIN = 'http://localhost:5173'
const GAZE: GazeSessionInfo = {
  calibration: { quality: 'good', accuracyPx: 80, precisionPx: 40, validRatio: 1, viewport: { width: 1, height: 1 }, points: [], calibratedAt: 0 },
  modelCvRocAuc: 0.637,
}
const ok = (trend: number): AttentionResult => ({ status: 'ok', features: { nLineReturns: 1, xProgress: 100, missingRatio: 0 }, z: [0, 0], score: trend, trend })

function finished(start: number) {
  let t = start
  const rec = new SessionRecorder(GAZE, () => t)
  rec.enterPage('en.wikipedia.org')
  rec.setActive(true)
  for (let i = 0; i < 3; i++) { t += 2000; rec.addAttention(ok(0.25)) }
  t += 1000
  return rec.end()
}

function doc(withMeta: boolean): Document {
  const d = document.implementation.createHTMLDocument('x')
  if (withMeta) {
    const m = d.createElement('meta')
    m.name = 'flowfinder-app'
    d.head.appendChild(m)
  }
  return d
}

describe('isFlowFinderApp', () => {
  it('needs an allowed origin AND the app marker', () => {
    expect(isFlowFinderApp(ORIGIN, doc(true))).toBe(true)
    expect(isFlowFinderApp(ORIGIN, doc(false))).toBe(false)              // another app on port 5173
    expect(isFlowFinderApp('https://evil.example', doc(true))).toBe(false) // copied the marker
  })
})

describe('syncHistoryOnce', () => {
  it('writes pending sessions into the web app history, marks them synced, notifies the page', async () => {
    const kv = memoryKV()
    const a = finished(1000)
    const b = finished(100_000)
    await saveCompletedSession(kv, a)
    await saveCompletedSession(kv, b)
    const target = new EventTarget()
    const onUpdated = vi.fn()
    target.addEventListener(HISTORY_UPDATED_EVENT, onUpdated)

    expect(await syncHistoryOnce(kv, ORIGIN, undefined, target)).toEqual({ written: 2, failed: 0 })

    const h = loadHistory()
    expect(h.ok && h.data.entries.map(e => e.session.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort())
    const entry = h.ok ? h.data.entries.find(e => e.session.sessionId === a.sessionId) : undefined
    expect(entry?.session.source).toBe('extension')
    expect(entry?.analysis).toMatchObject({ status: 'ready', totalScore: 75 })
    expect(await pendingForOrigin(kv, ORIGIN)).toHaveLength(0)
    expect(onUpdated).toHaveBeenCalledTimes(1)

    // Nothing new → nothing written, no event
    expect(await syncHistoryOnce(kv, ORIGIN, undefined, target)).toEqual({ written: 0, failed: 0 })
    expect(onUpdated).toHaveBeenCalledTimes(1)
  })

  it('never re-adds a session the user deleted in the Dashboard', async () => {
    const kv = memoryKV()
    const a = finished(1000)
    await saveCompletedSession(kv, a)
    deleteHistoryEntry(a.sessionId)
    // Pretend sync state was lost (e.g. a different origin's bookkeeping)
    await markSynced(kv, 'other', [])
    await syncHistoryOnce(kv, ORIGIN, undefined, new EventTarget())
    const h = loadHistory()
    expect(h.ok && h.data.entries).toEqual([])
  })

  it('keeps an entry pending when the web app storage write fails', async () => {
    const kv = memoryKV()
    await saveCompletedSession(kv, finished(1000))
    const failing = () => ({ kind: 'write_error' as const, message: 'full', isLoadError: false })
    expect(await syncHistoryOnce(kv, ORIGIN, failing, new EventTarget())).toEqual({ written: 0, failed: 1 })
    expect(await pendingForOrigin(kv, ORIGIN)).toHaveLength(1)
  })
})
