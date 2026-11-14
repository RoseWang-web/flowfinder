import { describe, it, expect } from 'vitest'
import { buildTimeline, fmtMs } from './timeline'
import type { Session, SessionEvent } from './types'

// ── Helpers ───────────────────────────────────────────────────────────────

const BASE_SESSION: Session = {
  schemaVersion: 2,
  sessionId: 'test-session',
  articleId: 'article-v1',
  startedAt: 1_000_000,
  status: 'completed',
  durationMs: 120_000,
  activeReadingMs: 90_000,
  lastSavedAt: 1_120_000,
  endedAt: 1_120_000,
  endReason: 'time_up',
  checkIn: null,
  events: [],
}

function ev(
  eventType: SessionEvent['eventType'],
  elapsedMs: number,
  data?: Record<string, unknown>,
): SessionEvent {
  return {
    id: `${eventType}-${elapsedMs}`,
    sessionId: 'test-session',
    eventType,
    elapsedMs,
    activeReadingMs: 0,
    data,
  }
}

function session(overrides: Partial<Session> & { events: SessionEvent[] }): Session {
  return { ...BASE_SESSION, ...overrides }
}

// ── fmtMs ─────────────────────────────────────────────────────────────────

describe('fmtMs', () => {
  it('formats zero', () => expect(fmtMs(0)).toBe('0:00'))
  it('formats 90 s', () => expect(fmtMs(90_000)).toBe('1:30'))
  it('formats 2 min', () => expect(fmtMs(120_000)).toBe('2:00'))
})

// ── buildTimeline: time range ─────────────────────────────────────────────

describe('buildTimeline — time range', () => {
  it('uses endedAt - startedAt as totalMs', () => {
    const s = session({
      startedAt: 1_000_000,
      endedAt: 1_090_000,
      events: [ev('session_start', 0, { visible: true })],
    })
    expect(buildTimeline(s).totalMs).toBe(90_000)
  })

  it('falls back to lastSavedAt when endedAt is null', () => {
    const s = session({ endedAt: null, lastSavedAt: 1_060_000, events: [] })
    expect(buildTimeline(s).totalMs).toBe(60_000)
  })

  it('totalMs is at least 1 for zero-length session', () => {
    const s = session({ startedAt: 1_000_000, endedAt: 1_000_000, events: [] })
    expect(buildTimeline(s).totalMs).toBeGreaterThanOrEqual(1)
  })

  it('truncates interrupted session at lastSavedAt, not at current time', () => {
    const s = session({
      startedAt: 1_000_000,
      endedAt: 1_050_000,   // set to lastSavedAt by interrupt recovery
      lastSavedAt: 1_050_000,
      events: [ev('session_start', 0), ev('session_interrupted', 50_000)],
    })
    const tl = buildTimeline(s)
    expect(tl.totalMs).toBe(50_000)
    // All segments must be within [0, totalMs]
    for (const seg of tl.sessionStatusTrack) {
      expect(seg.startMs).toBeGreaterThanOrEqual(0)
      expect(seg.endMs).toBeLessThanOrEqual(tl.totalMs)
    }
  })
})

// ── Track A: Session status ───────────────────────────────────────────────

describe('buildTimeline — session status track', () => {
  it('normal complete session: reading, checking_in, reading', () => {
    const s = session({
      events: [
        ev('session_start', 0, { visible: true }),
        ev('check_in_shown', 60_000),
        ev('check_in_answered', 65_000),
        ev('session_end', 120_000),
      ],
    })
    const { sessionStatusTrack } = buildTimeline(s)
    expect(sessionStatusTrack[0]).toMatchObject({ kind: 'reading', startMs: 0, endMs: 60_000 })
    expect(sessionStatusTrack[1]).toMatchObject({ kind: 'checking_in', startMs: 60_000, endMs: 65_000 })
    expect(sessionStatusTrack[2]).toMatchObject({ kind: 'reading', startMs: 65_000 })
  })

  it('pause / resume produces correct segments', () => {
    const s = session({
      events: [
        ev('session_start', 0),
        ev('session_pause', 30_000),
        ev('session_resume', 50_000),
        ev('session_end', 120_000),
      ],
    })
    const { sessionStatusTrack } = buildTimeline(s)
    expect(sessionStatusTrack[0]).toMatchObject({ kind: 'reading', startMs: 0, endMs: 30_000 })
    expect(sessionStatusTrack[1]).toMatchObject({ kind: 'paused', startMs: 30_000, endMs: 50_000 })
    expect(sessionStatusTrack[2]).toMatchObject({ kind: 'reading', startMs: 50_000 })
  })

  it('no session_start → first segment is unknown', () => {
    const s = session({ events: [ev('session_pause', 30_000)] })
    const { sessionStatusTrack } = buildTimeline(s)
    expect(sessionStatusTrack[0].kind).toBe('unknown')
  })

  it('check_in_skipped also resumes reading', () => {
    const s = session({
      events: [
        ev('session_start', 0),
        ev('check_in_shown', 60_000),
        ev('check_in_skipped', 62_000),
      ],
    })
    const { sessionStatusTrack } = buildTimeline(s)
    const afterSkip = sessionStatusTrack.find(s => s.startMs === 62_000)
    expect(afterSkip?.kind).toBe('reading')
  })
})

// ── Track B: Page visibility ──────────────────────────────────────────────

describe('buildTimeline — page visibility track', () => {
  it('derives initial state from session_start data', () => {
    const s = session({ events: [ev('session_start', 0, { visible: true })] })
    const { pageVisibilityTrack } = buildTimeline(s)
    expect(pageVisibilityTrack[0].kind).toBe('visible')
  })

  it('switches visible → hidden → visible', () => {
    const s = session({
      events: [
        ev('session_start', 0, { visible: true }),
        ev('page_visibility', 20_000, { visible: false }),
        ev('page_visibility', 40_000, { visible: true }),
      ],
    })
    const { pageVisibilityTrack } = buildTimeline(s)
    expect(pageVisibilityTrack[0]).toMatchObject({ kind: 'visible', startMs: 0, endMs: 20_000 })
    expect(pageVisibilityTrack[1]).toMatchObject({ kind: 'hidden', startMs: 20_000, endMs: 40_000 })
    expect(pageVisibilityTrack[2]).toMatchObject({ kind: 'visible', startMs: 40_000 })
  })

  it('no visible data → unknown', () => {
    const s = session({ events: [] })
    const { pageVisibilityTrack } = buildTimeline(s)
    expect(pageVisibilityTrack[0].kind).toBe('unknown')
  })
})


// ── Invariants ────────────────────────────────────────────────────────────

describe('buildTimeline — invariants', () => {
  it('does not mutate input session', () => {
    const events = [ev('session_start', 0)]
    const s = session({ events })
    const originalLength = events.length
    buildTimeline(s)
    expect(s.events).toHaveLength(originalLength)
    expect(s.events[0].eventType).toBe('session_start')
  })

  it('all segments are within [0, totalMs]', () => {
    const s = session({
      events: [
        ev('session_start', 0, { visible: true }),
        ev('session_end', 120_000),
      ],
    })
    const tl = buildTimeline(s)
    const allSegs = [
      ...tl.sessionStatusTrack,
      ...tl.pageVisibilityTrack,
    ]
    for (const seg of allSegs) {
      expect(seg.startMs).toBeGreaterThanOrEqual(0)
      expect(seg.endMs).toBeLessThanOrEqual(tl.totalMs)
      expect(seg.endMs).toBeGreaterThan(seg.startMs)
    }
  })

  it('no segment has negative length or endMs ≤ startMs', () => {
    const s = session({
      events: [
        ev('session_start', 0),
        // Same timestamp events
        ev('session_pause', 50_000),
        ev('session_resume', 50_000),
      ],
    })
    const { sessionStatusTrack } = buildTimeline(s)
    for (const seg of sessionStatusTrack) {
      expect(seg.endMs - seg.startMs).toBeGreaterThan(0)
    }
  })

  it('handles empty events without crash', () => {
    const s = session({ events: [] })
    expect(() => buildTimeline(s)).not.toThrow()
    const tl = buildTimeline(s)
    expect(tl.sessionStatusTrack.length).toBeGreaterThanOrEqual(1)
  })

  it('handles old session without cameraEnabled field', () => {
    const s = session({ cameraEnabled: undefined, events: [] })
    expect(() => buildTimeline(s)).not.toThrow()
  })
})

// ── Attention track (eye-tracking mode) ───────────────────────────────────

describe('buildTimeline — attention track', () => {
  const att = (ms: number, data: Record<string, unknown>) => ev('attention_score', ms, data)

  it('is empty and hasGazeData false for sessions without eye-tracking', () => {
    const t = buildTimeline(session({ events: [ev('session_start', 0, { visible: true })] }))
    expect(t.hasGazeData).toBe(false)
    expect(t.attentionTrack).toEqual([])
    expect(t.checkInAttention).toBeNull()
  })

  it('turns attention_score events into points, keeping scores only for ok windows', () => {
    const t = buildTimeline(session({
      gazeEnabled: true,
      events: [
        ev('session_start', 0, { visible: true }),
        att(10_000, { status: 'warming_up', nLineReturns: 2, xProgress: 120, missingRatio: 0.01 }),
        att(12_000, { status: 'low_quality', nLineReturns: 0, xProgress: 5, missingRatio: 0.8 }),
        att(14_000, { status: 'ok', score: 0.42, trend: 0.45, nLineReturns: 3, xProgress: 130, missingRatio: 0 }),
      ],
    }))
    expect(t.hasGazeData).toBe(true)
    expect(t.attentionTrack.map(p => p.status)).toEqual(['warming_up', 'low_quality', 'ok'])
    expect(t.attentionTrack[0].score).toBeNull()
    expect(t.attentionTrack[2]).toMatchObject({ ms: 14_000, score: 0.42, trend: 0.45, nLineReturns: 3 })
  })

  it('skips malformed events', () => {
    const t = buildTimeline(session({
      events: [att(5_000, { status: 'weird' }), att(6_000, { status: 'ok', score: 'x' })],
    }))
    expect(t.attentionTrack).toHaveLength(1)
    expect(t.attentionTrack[0].score).toBeNull()
  })

  it('compares the 30 s before the check-in with the whole session', () => {
    const events = [ev('session_start', 0, { visible: true })]
    // Scores 0.3 before 30 s, 0.7 in the 30 s right before the prompt at 60 s, 0.3 after
    for (let ms = 20_000; ms <= 110_000; ms += 2_000) {
      const score = ms > 30_000 && ms <= 60_000 ? 0.7 : 0.3
      events.push(att(ms, { status: 'ok', score, trend: score }))
    }
    events.push(ev('check_in_shown', 60_000))
    events.push(ev('check_in_answered', 65_000, { answer: 'off_task' }))
    const t = buildTimeline(session({ gazeEnabled: true, events }))
    const c = t.checkInAttention!
    expect(c.answer).toBe('off_task')
    expect(c.nBefore).toBe(15)
    expect(c.scoreBefore).toBeCloseTo(0.7, 9)
    expect(c.sessionMean!).toBeLessThan(c.scoreBefore!)
  })

  it('reports a skipped check-in as no answer', () => {
    const t = buildTimeline(session({
      gazeEnabled: true,
      events: [
        att(50_000, { status: 'ok', score: 0.5, trend: 0.5 }),
        ev('check_in_shown', 60_000),
        ev('check_in_skipped', 62_000),
      ],
    }))
    expect(t.checkInAttention?.answer).toBeNull()
  })
})
