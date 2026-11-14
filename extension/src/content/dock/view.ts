/** Pure display helpers for the on-page dock (unit-tested). */
import type { EngineState, FaceStatus, InactiveReason } from '../../protocol'

const p2 = (n: number) => String(n).padStart(2, '0')

/** 754 s → "12:34"; ≥ 1 h → "1:02:03" (same as the mockup) */
export function fmtClock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000))
  return t >= 3600 ? `${Math.floor(t / 3600)}:${p2(Math.floor((t % 3600) / 60))}:${p2(t % 60)}` : `${p2(Math.floor(t / 60))}:${p2(t % 60)}`
}

export interface TimerView { big: string; sub: 'LEFT' | 'ELAPSED' | 'EXTRA' | 'PAUSED'; progress: number }

export function timerView(s: Pick<EngineState, 'elapsedMs' | 'totalMs' | 'paused' | 'timeUp'>): TimerView {
  const open = s.totalMs === 0
  const sec = Math.floor(s.elapsedMs / 1000) * 1000
  const progress = open || s.timeUp ? 1 : Math.min(1, sec / s.totalMs)
  const big = open ? fmtClock(sec) : s.timeUp ? '+' + fmtClock(sec - s.totalMs) : fmtClock(s.totalMs - sec)
  const sub = s.paused ? 'PAUSED' : open ? 'ELAPSED' : s.timeUp ? 'EXTRA' : 'LEFT'
  return { big, sub, progress }
}

/** Camera dot style in the mockup: '' (olive) / 'warn' (mustard) / 'off' (dashed) */
export function faceView(face: FaceStatus): { dot: '' | 'warn' | 'off'; text: string } {
  switch (face) {
    case 'ok': return { dot: '', text: 'Face detected' }
    case 'weak': return { dot: 'warn', text: 'Face partly visible' }
    case 'none': return { dot: 'warn', text: 'Face not detected' }
    case 'off': return { dot: 'off', text: 'Camera off' }
  }
}

const INACTIVE: Record<InactiveReason, string> = {
  paused: 'Paused',
  tab_hidden: 'Not counting · no reading tab in front',
  page_blur: 'Not counting · click the page to continue',
  no_page: 'Not counting · open a page to read',
}

/** One line under the ring: why time is not counting, or the attention estimate. */
export function statusLine(s: EngineState): string {
  if (s.recalibrating) return 'Paused for recalibration'
  if (!s.reading && s.inactiveReason) return INACTIVE[s.inactiveReason]
  if (s.setup?.screenAttention && s.trackingDegraded) return 'Tracking got noisy · not scoring right now'
  if (!s.setup?.screenAttention) return 'Reading'
  return s.focusPercent === null ? 'Screen attention · warming up' : `Screen attention · ${s.focusPercent}% focused`
}
