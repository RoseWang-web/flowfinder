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
    | 'detected' | 'not_detected' | 'unavailable'          // face observation
    | 'no_camera'                                           // camera not used
}

export type MarkerKind =
  | 'check_in_shown'
  | 'check_in_answered'
  | 'check_in_skipped'
  | 'scroll'

export interface TimeMarker {
  ms: number
  kind: MarkerKind
  label: string
  detail?: string
}

export interface TimelineData {
  /** Total timeline duration (elapsedMs); always ≥ 1 */
  totalMs: number
  activeReadingMs: number
  hasCameraData: boolean
  sessionStatusTrack: TimeSegment[]
  pageVisibilityTrack: TimeSegment[]
  faceObservationTrack: TimeSegment[]
  actionMarkers: TimeMarker[]
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

  const hasCameraData =
    session.cameraEnabled === true ||
    events.some(e => e.eventType === 'camera_started')

  return {
    totalMs,
    activeReadingMs: session.activeReadingMs,
    hasCameraData,
    sessionStatusTrack: buildSessionStatusTrack(events, totalMs),
    pageVisibilityTrack: buildPageVisibilityTrack(events, totalMs),
    faceObservationTrack: hasCameraData
      ? buildFaceObservationTrack(events, totalMs)
      : [{ startMs: 0, endMs: totalMs, kind: 'no_camera' }],
    actionMarkers: buildActionMarkers(events, totalMs),
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

// ── Track C: Face observation ─────────────────────────────────────────────

function buildFaceObservationTrack(events: SortedEvent[], totalMs: number): TimeSegment[] {
  // Rules:
  // - Start at 'unavailable' (camera might not have loaded yet).
  // - face_detection_changed carries the authoritative new status.
  // - camera_stopped / camera_error close any open detection → 'unavailable'.
  //   (useCamera already emits face_detection_changed(unavailable) before camera_stopped,
  //    but we handle camera_stopped directly as a safety net for old data.)
  return buildTrack(events, totalMs, 'unavailable', (e, _current) => {
    if (e.eventType === 'face_detection_changed') {
      const s = e.data?.status
      if (s === 'detected')     return 'detected'
      if (s === 'not_detected') return 'not_detected'
      if (s === 'unavailable')  return 'unavailable'
    }
    if (e.eventType === 'camera_stopped' || e.eventType === 'camera_error') {
      return 'unavailable'
    }
    return null
  })
}

// ── Track D: Action markers ───────────────────────────────────────────────

function buildActionMarkers(events: SortedEvent[], totalMs: number): TimeMarker[] {
  const markers: TimeMarker[] = []

  // Cluster consecutive scroll events within 10 s windows.
  const scrollClusters: { ms: number; count: number }[] = []

  for (const event of events) {
    const ms = Math.min(Math.max(event.elapsedMs, 0), totalMs)

    switch (event.eventType) {
      case 'check_in_shown':
        markers.push({ ms, kind: 'check_in_shown', label: '回報提示', detail: `${fmtMs(ms)}` })
        break
      case 'check_in_answered': {
        const ans = String(event.data?.answer ?? '—')
        markers.push({ ms, kind: 'check_in_answered', label: '回答回報', detail: ans })
        break
      }
      case 'check_in_skipped':
        markers.push({ ms, kind: 'check_in_skipped', label: '略過回報', detail: `${fmtMs(ms)}` })
        break
      case 'scroll': {
        const last = scrollClusters[scrollClusters.length - 1]
        if (last && ms - last.ms < 10_000) {
          last.count++
        } else {
          scrollClusters.push({ ms, count: 1 })
        }
        break
      }
    }
  }

  for (const sc of scrollClusters) {
    markers.push({
      ms: sc.ms,
      kind: 'scroll',
      label: '捲動',
      detail: sc.count > 1 ? `×${sc.count}` : undefined,
    })
  }

  return markers.sort((a, b) => a.ms - b.ms)
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function fmtMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
