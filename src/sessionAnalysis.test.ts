import { describe, it, expect } from 'vitest'
import { computeGazeFocusPercent, computeSessionAnalysis } from './sessionAnalysis'
import type { Session } from './types'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 2,
    sessionId: 'test-sess',
    articleId: 'article-v1',
    startedAt: Date.UTC(2026, 0, 15, 10, 0, 0),
    status: 'completed',
    durationMs: 30 * 60_000,
    activeReadingMs: 25 * 60_000,
    lastSavedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    endedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    endReason: 'manual',
    checkIn: null,
    cameraEnabled: false,
    gazeEnabled: false,
    events: [],
    ...overrides,
  }
}

function attentionEvent(trend: number, i: number) {
  return {
    id: `ev-${i}`,
    sessionId: 'test-sess',
    eventType: 'attention_score' as const,
    elapsedMs: i * 2000,
    activeReadingMs: i * 1800,
    data: { status: 'ok', trend, score: trend, nLineReturns: 2, xProgress: 0.5, missingRatio: 0.1 },
  }
}

// ── computeGazeFocusPercent ───────────────────────────────────────────────────

describe('computeGazeFocusPercent', () => {
  it('returns null for non-gaze session', () => {
    const session = makeSession({ gazeEnabled: false })
    expect(computeGazeFocusPercent(session)).toBeNull()
  })

  it('returns null for gaze session with no attention_score events', () => {
    const session = makeSession({ gazeEnabled: true, events: [] })
    expect(computeGazeFocusPercent(session)).toBeNull()
  })

  it('returns null when fewer than 3 valid windows', () => {
    const session = makeSession({
      gazeEnabled: true,
      events: [attentionEvent(0.3, 0), attentionEvent(0.3, 1)],
    })
    expect(computeGazeFocusPercent(session)).toBeNull()
  })

  it('converts trend=0 (fully focused) to 100%', () => {
    const session = makeSession({
      gazeEnabled: true,
      events: [0, 0, 0, 0].map((t, i) => attentionEvent(t, i)),
    })
    expect(computeGazeFocusPercent(session)).toBe(100)
  })

  it('converts trend=1 (fully mind-wandering) to 0%', () => {
    const session = makeSession({
      gazeEnabled: true,
      events: [1, 1, 1, 1].map((t, i) => attentionEvent(t, i)),
    })
    expect(computeGazeFocusPercent(session)).toBe(0)
  })

  it('computes average correctly: mean trend 0.25 → 75%', () => {
    const trends = [0.2, 0.3, 0.2, 0.3]
    const session = makeSession({
      gazeEnabled: true,
      events: trends.map((t, i) => attentionEvent(t, i)),
    })
    expect(computeGazeFocusPercent(session)).toBe(75)
  })

  it('rounds to nearest integer', () => {
    // mean = 0.333... → (1 - 0.333) = 0.666... × 100 = 66.6 → rounds to 67
    const session = makeSession({
      gazeEnabled: true,
      events: [1/3, 1/3, 1/3].map((t, i) => attentionEvent(t, i)),
    })
    expect(computeGazeFocusPercent(session)).toBe(67)
  })

  it('clamps to [0, 100] for edge-case logistic outputs', () => {
    // trend slightly > 1 due to floating point
    const session = makeSession({
      gazeEnabled: true,
      events: [1.01, 1.01, 1.01].map((t, i) => attentionEvent(t, i)),
    })
    expect(computeGazeFocusPercent(session)).toBe(0)
  })

  it('ignores events that do not have a numeric trend', () => {
    const noTrend = {
      id: 'ev-no-trend', sessionId: 'test-sess',
      eventType: 'attention_score' as const,
      elapsedMs: 0, activeReadingMs: 0,
      data: { status: 'warming_up' }, // no trend field
    }
    const session = makeSession({
      gazeEnabled: true,
      events: [noTrend, noTrend, attentionEvent(0.4, 3), attentionEvent(0.4, 4), attentionEvent(0.4, 5)],
    })
    // Only 3 valid events: mean trend=0.4 → 60%
    expect(computeGazeFocusPercent(session)).toBe(60)
  })
})

// ── computeSessionAnalysis ────────────────────────────────────────────────────

describe('computeSessionAnalysis', () => {
  it('returns pending analysis for non-gaze session', () => {
    const session = makeSession({ gazeEnabled: false })
    const result = computeSessionAnalysis(session)
    expect(result.status).toBe('pending')
    expect(result.totalScore).toBeNull()
    expect(result.source).toBe('real')
  })

  it('returns pending when gaze session has insufficient data', () => {
    const session = makeSession({
      gazeEnabled: true,
      events: [attentionEvent(0.3, 0)],
    })
    const result = computeSessionAnalysis(session)
    expect(result.status).toBe('pending')
  })

  it('returns ready analysis with totalScore for valid gaze session', () => {
    const session = makeSession({
      gazeEnabled: true,
      events: [0.2, 0.3, 0.2, 0.3].map((t, i) => attentionEvent(t, i)),
    })
    const result = computeSessionAnalysis(session)
    expect(result.status).toBe('ready')
    expect(result.totalScore).toBe(75)
    expect(result.source).toBe('real')
    expect(result.sessionId).toBe('test-sess')
  })

  it('returns camera-only session as pending', () => {
    const session = makeSession({ cameraEnabled: true, gazeEnabled: false })
    const result = computeSessionAnalysis(session)
    expect(result.status).toBe('pending')
  })
})
