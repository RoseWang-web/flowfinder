import { describe, it, expect } from 'vitest'
import { SessionRecorder, finalizeInterrupted, EXTENSION_ARTICLE_ID } from './recorder'
import { computeSessionAnalysis } from '@core/sessionAnalysis'
import type { AttentionResult } from '@core/attentionModel'
import type { GazeSessionInfo } from '@core/types'

const GAZE: GazeSessionInfo = {
  calibration: {
    quality: 'good', accuracyPx: 80, precisionPx: 40, validRatio: 1,
    viewport: { width: 1200, height: 800 }, points: [], calibratedAt: 0,
  },
  modelCvRocAuc: 0.637,
}

const ok = (trend: number): AttentionResult => ({
  status: 'ok',
  features: { nLineReturns: 2, xProgress: 120, missingRatio: 0.02 },
  z: [0, 0],
  score: trend,
  trend,
})

function setup() {
  let t = 1_000_000
  const rec = new SessionRecorder(GAZE, () => t)
  return { rec, advance: (ms: number) => { t += ms } }
}

describe('SessionRecorder', () => {
  it('starts a web-app-compatible running session', () => {
    const { rec } = setup()
    const s = rec.snapshot()
    expect(s).toMatchObject({
      status: 'running', articleId: EXTENSION_ARTICLE_ID, source: 'extension',
      gazeEnabled: true, cameraEnabled: false, endReason: null, checkIn: null,
      taskSettings: { categoryId: 'web_reading', rules: { allowTabSwitch: true } },
    })
    expect(s.events.map(e => e.eventType)).toEqual(['session_start'])
    expect(s.events[0].sessionId).toBe(s.sessionId)
  })

  it('counts reading time only while active and logs each change', () => {
    const { rec, advance } = setup()
    advance(5_000)              // not reading yet
    rec.setActive(true)
    advance(30_000)             // reading
    rec.setActive(false, 'tab_hidden')
    advance(10_000)             // away
    rec.setActive(false, 'page_blur') // no change → no event
    rec.setActive(true)
    advance(15_000)
    const s = rec.end('manual')
    expect(s.activeReadingMs).toBe(45_000)
    expect(s.durationMs).toBe(60_000)
    expect(s.status).toBe('completed')
    expect(s.endReason).toBe('manual')
    const vis = s.events.filter(e => e.eventType === 'page_visibility').map(e => e.data)
    expect(vis).toEqual([{ visible: true }, { visible: false, reason: 'tab_hidden' }, { visible: true }, { visible: false, reason: undefined }])
    expect(s.events[s.events.length - 1]).toMatchObject({ eventType: 'session_end', elapsedMs: 60_000, activeReadingMs: 45_000 })
  })

  it('records sites by hostname, ignoring repeats', () => {
    const { rec, advance } = setup()
    rec.enterPage('en.wikipedia.org')
    advance(1000)
    rec.enterPage('en.wikipedia.org')
    rec.enterPage('medium.com')
    expect(rec.snapshot().pages).toEqual([
      { host: 'en.wikipedia.org', enteredElapsedMs: 0 },
      { host: 'medium.com', enteredElapsedMs: 1000 },
    ])
  })

  it('attention events use the web app payload and are scored by computeSessionAnalysis', () => {
    const { rec, advance } = setup()
    rec.setActive(true)
    for (const trend of [0.2, 0.3, 0.4]) { advance(2000); rec.addAttention(ok(trend)) }
    const s = rec.end()
    const events = s.events.filter(e => e.eventType === 'attention_score')
    expect(events[0].data).toEqual({ status: 'ok', nLineReturns: 2, xProgress: 120, missingRatio: 0.02, score: 0.2, trend: 0.2 })
    expect(computeSessionAnalysis(s)).toMatchObject({ status: 'ready', totalScore: 70, source: 'real' })
  })

  it('ignores calls after the session ended', () => {
    const { rec } = setup()
    const s = rec.end()
    rec.addAttention(ok(0.1))
    rec.setActive(true)
    expect(rec.end()).toBe(s)
    expect(s.events.filter(e => e.eventType === 'attention_score')).toHaveLength(0)
  })
})

describe('finalizeInterrupted', () => {
  it('closes a saved running session like the web app does', () => {
    const { rec, advance } = setup()
    rec.setActive(true)
    advance(20_000)
    const saved = rec.snapshot()
    const s = finalizeInterrupted(saved, saved.lastSavedAt + 60_000)
    expect(s).toMatchObject({ status: 'completed', endReason: 'interrupted', endedAt: saved.lastSavedAt, activeReadingMs: 20_000 })
    const last = s.events[s.events.length - 1]
    expect(last.eventType).toBe('session_interrupted')
    expect(finalizeInterrupted(s)).toBe(s) // already completed
  })
})
