/**
 * timeline.ts — Pure function that converts a Session into display-ready
 * timeline data. No side-effects, no React, no DOM.
 *
 * X axis: elapsedMs (time since session.startedAt, INCLUDING pause/check-in time)
 */

import type { Session, SessionEvent } from './types'

// ── Output types ─────────────────────────────────────────────────────────

export interface TimeSegment {
  startMs: number
  endMs: number
  /** Semantic kind — drives colour and label */
  kind:
    | 'reading' | 'paused' | 'checking_in' | 'unknown'    // session status
    | 'visible' | 'hidden'                                  // page visibility
}

export type AttentionStatus = 'ok' | 'warming_up' | 'low_quality'

/** One attention_score event (eye-tracking mode), one per model step */
export interface AttentionPoint {
  /** elapsedMs at the END of the 10 s window it describes */
  ms: number
  status: AttentionStatus
  /** Mind-wandering score of this window (higher = more likely mind wandering); null unless ok */
  score: number | null
  /** Mean score of recent windows; null unless ok */
  trend: number | null
  nLineReturns: number | null
  xProgress: number | null
  missingRatio: number | null
}

/** How the model scored the time right before the check-in, next to what the user answered */
export interface CheckInAttention {
  shownMs: number
  answer: string | null
  /** Mean window score in the CHECK_IN_LOOKBACK_MS before the prompt */
  scoreBefore: number | null
  nBefore: number
  /** Mean window score over the whole session */
  sessionMean: number | null
}

export const CHECK_IN_LOOKBACK_MS = 30_000

export interface TimelineData {
  /** Total timeline duration (elapsedMs); always ≥ 1 */
  totalMs: number
  activeReadingMs: number
  sessionStatusTrack: TimeSegment[]
  pageVisibilityTrack: TimeSegment[]
  hasGazeData: boolean
  attentionTrack: AttentionPoint[]
  checkInAttention: CheckInAttention | null
}

// ── Main entry point ──────────────────────────────────────────────────────

export function buildTimeline(session: Session): TimelineData {
  // End of timeline in elapsedMs.
  // For completed/interrupted sessions endedAt is set; fall back to lastSavedAt.
  const rawTotalMs = (session.endedAt ?? session.lastSavedAt) - session.startedAt
  const totalMs = Math.max(rawTotalMs, 1)

  // Sort events by elapsedMs, stable (preserve insertion order for ties).
  // Clamp negative elapsedMs to 0 but keep events whose ms ≤ totalMs.
  const events: (SessionEvent & { _idx: number })[] = session.events
    .map((e, i) => ({ ...e, _idx: i }))
    .sort((a, b) =>
      a.elapsedMs !== b.elapsedMs ? a.elapsedMs - b.elapsedMs : a._idx - b._idx,
    )

  const attentionTrack = buildAttentionTrack(events, totalMs)

  return {
    totalMs,
    activeReadingMs: session.activeReadingMs,
    sessionStatusTrack: buildSessionStatusTrack(events, totalMs),
    pageVisibilityTrack: buildPageVisibilityTrack(events, totalMs),
    hasGazeData: session.gazeEnabled === true || attentionTrack.length > 0,
    attentionTrack,
    checkInAttention: buildCheckInAttention(events, attentionTrack),
  }
}

// ── Generic segment builder ───────────────────────────────────────────────

type SortedEvent = SessionEvent & { _idx: number }

/**
 * State-machine segment builder.
 * getTransition returns the new kind, or null if the event does not change state.
 * Produces non-overlapping, non-negative-length segments clipped to [0, totalMs].
 */
function buildTrack(
  events: SortedEvent[],
  totalMs: number,
  initialKind: TimeSegment['kind'],
  getTransition: (e: SortedEvent, current: TimeSegment['kind']) => TimeSegment['kind'] | null,
): TimeSegment[] {
  const segments: TimeSegment[] = []
  let currentKind: TimeSegment['kind'] = initialKind
  let currentStart = 0

  for (const event of events) {
    const ms = Math.min(Math.max(event.elapsedMs, 0), totalMs)
    const newKind = getTransition(event, currentKind)
    if (newKind !== null && newKind !== currentKind) {
      if (ms > currentStart) {
        segments.push({ startMs: currentStart, endMs: ms, kind: currentKind })
      }
      currentStart = ms
      currentKind = newKind
    }
  }

  if (currentStart < totalMs) {
    segments.push({ startMs: currentStart, endMs: totalMs, kind: currentKind })
  }

  return segments.filter(s => s.endMs > s.startMs)
}

// ── Track A: Session status ───────────────────────────────────────────────

function buildSessionStatusTrack(events: SortedEvent[], totalMs: number): TimeSegment[] {
  return buildTrack(events, totalMs, 'unknown', e => {
    switch (e.eventType) {
      case 'session_start':    return 'reading'
      case 'session_pause':    return 'paused'
      case 'session_resume':   return 'reading'
      case 'check_in_shown':   return 'checking_in'
      case 'check_in_answered':
      case 'check_in_skipped': return 'reading'
      default: return null
    }
  })
}

// ── Track B: Page visibility ──────────────────────────────────────────────

function buildPageVisibilityTrack(events: SortedEvent[], totalMs: number): TimeSegment[] {
  // Derive initial visibility from session_start data.
  let initial: TimeSegment['kind'] = 'unknown'
  const startEv = events.find(e => e.eventType === 'session_start')
  if (startEv?.data?.visible === true)  initial = 'visible'
  if (startEv?.data?.visible === false) initial = 'hidden'

  return buildTrack(events, totalMs, initial, e => {
    if (e.eventType === 'page_visibility') {
      return e.data?.visible === true ? 'visible' : 'hidden'
    }
    return null
  })
}

// ── Track C: Attention (eye-tracking mode) ────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function buildAttentionTrack(events: SortedEvent[], totalMs: number): AttentionPoint[] {
  const points: AttentionPoint[] = []
  for (const e of events) {
    if (e.eventType !== 'attention_score') continue
    const st = e.data?.status
    if (st !== 'ok' && st !== 'warming_up' && st !== 'low_quality') continue
    const ok = st === 'ok'
    points.push({
      ms: Math.min(Math.max(e.elapsedMs, 0), totalMs),
      status: st,
      score: ok ? num(e.data?.score) : null,
      trend: ok ? num(e.data?.trend) : null,
      nLineReturns: num(e.data?.nLineReturns),
      xProgress: num(e.data?.xProgress),
      missingRatio: num(e.data?.missingRatio),
    })
  }
  return points
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function buildCheckInAttention(events: SortedEvent[], track: AttentionPoint[]): CheckInAttention | null {
  if (track.length === 0) return null
  const shown = events.find(e => e.eventType === 'check_in_shown')
  if (!shown) return null
  const answered = events.find(e => e.eventType === 'check_in_answered')
  const scores = track.filter(p => p.score !== null)
  const before = scores.filter(p => p.ms <= shown.elapsedMs && p.ms > shown.elapsedMs - CHECK_IN_LOOKBACK_MS)
  return {
    shownMs: shown.elapsedMs,
    answer: answered ? String(answered.data?.answer ?? '') || null : null,
    scoreBefore: mean(before.map(p => p.score as number)),
    nBefore: before.length,
    sessionMean: mean(scores.map(p => p.score as number)),
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function fmtMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
