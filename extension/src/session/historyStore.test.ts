import { describe, it, expect } from 'vitest'
import {
  CURRENT_KEY,
  HISTORY_KEY,
  loadExtensionHistory,
  markSynced,
  memoryKV,
  pendingForOrigin,
  recoverInterruptedSession,
  saveCompletedSession,
  saveCurrentSession,
  summarizeExtensionHistory,
} from './historyStore'
import { SessionRecorder } from './recorder'
import type { AttentionResult } from '@core/attentionModel'
import type { GazeSessionInfo } from '@core/types'

const GAZE: GazeSessionInfo = {
  calibration: { quality: 'good', accuracyPx: 80, precisionPx: 40, validRatio: 1, viewport: { width: 1, height: 1 }, points: [], calibratedAt: 0 },
  modelCvRocAuc: 0.637,
}
const ok = (trend: number): AttentionResult => ({ status: 'ok', features: { nLineReturns: 1, xProgress: 100, missingRatio: 0 }, z: [0, 0], score: trend, trend })

function finished(start: number, trends: number[] = [0.3, 0.3, 0.3], host = 'example.org') {
  let t = start
  const rec = new SessionRecorder(GAZE, () => t)
  rec.enterPage(host)
  rec.setActive(true)
  for (const tr of trends) { t += 2000; rec.addAttention(ok(tr)) }
  return { rec, session: rec.end() }
}

describe('historyStore', () => {
  it('stores finished sessions as web-app HistoryEntries with the web app score', async () => {
    const kv = memoryKV()
    const { session } = finished(1000)
    const entry = await saveCompletedSession(kv, session)
    expect(entry).toMatchObject({ entryVersion: 1, analysis: { status: 'ready', totalScore: 70 } })
    expect((await loadExtensionHistory(kv)).entries).toHaveLength(1)
    await saveCompletedSession(kv, session) // same id → replaced, not duplicated
    expect((await loadExtensionHistory(kv)).entries).toHaveLength(1)
  })

  it('a session with too few scored windows is stored with a pending analysis', async () => {
    const kv = memoryKV()
    const entry = await saveCompletedSession(kv, finished(1000, [0.2]).session)
    expect(entry.analysis.status).toBe('pending')
    expect(entry.analysis.totalScore).toBeNull()
  })

  it('tracks sync separately for each web-app origin', async () => {
    const kv = memoryKV()
    const a = finished(1000).session
    const b = finished(5000).session
    await saveCompletedSession(kv, a)
    await saveCompletedSession(kv, b)
    await markSynced(kv, 'http://localhost:5173', [a.sessionId])
    expect((await pendingForOrigin(kv, 'http://localhost:5173')).map(e => e.session.sessionId)).toEqual([b.sessionId])
    expect(await pendingForOrigin(kv, 'https://flowfinder.example')).toHaveLength(2)
  })

  it('recovers a session left running when the panel closed', async () => {
    const kv = memoryKV()
    const { rec } = finished(1000)
    // simulate: still running, snapshot persisted
    let t = 50_000
    const running = new SessionRecorder(GAZE, () => t)
    running.setActive(true)
    t += 30_000
    await saveCurrentSession(kv, running.snapshot())
    void rec
    const entry = await recoverInterruptedSession(kv, t + 1000)
    expect(entry?.session.endReason).toBe('interrupted')
    expect(kv.data[CURRENT_KEY]).toBeUndefined()
    expect(await recoverInterruptedSession(kv)).toBeNull()
  })

  it('summarizes newest first with hosts and sync status', async () => {
    const kv = memoryKV()
    const old = finished(1000, [0.3, 0.3, 0.3], 'old.example').session
    const recent = finished(9_000_000, [0.1, 0.1, 0.1], 'new.example').session
    await saveCompletedSession(kv, old)
    await saveCompletedSession(kv, recent)
    await markSynced(kv, 'http://localhost:5173', [old.sessionId])
    const rows = await summarizeExtensionHistory(kv)
    expect(rows.map(r => r.hosts[0])).toEqual(['new.example', 'old.example'])
    expect(rows[0]).toMatchObject({ score: 90, syncedTo: [] })
    expect(rows[1].syncedTo).toEqual(['http://localhost:5173'])
  })

  it('ignores a corrupt store', async () => {
    const kv = memoryKV()
    kv.data[HISTORY_KEY] = { version: 99 }
    expect((await loadExtensionHistory(kv)).entries).toEqual([])
  })
})
