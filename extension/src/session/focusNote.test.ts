import { describe, it, expect } from 'vitest'
import { focusNote, FOCUS_NOTE_TEXT } from './focusNote'
import { SessionRecorder } from './recorder'
import type { AttentionResult } from '@core/attentionModel'
import type { GazeSessionInfo } from '@core/types'

const GAZE: GazeSessionInfo = {
  calibration: { quality: 'good', accuracyPx: 80, precisionPx: 40, validRatio: 1, viewport: { width: 1, height: 1 }, points: [], calibratedAt: 0 },
  modelCvRocAuc: 0.6,
}
const win = (status: AttentionResult['status']): AttentionResult =>
  status === 'ok'
    ? { status, features: { nLineReturns: 1, xProgress: 100, missingRatio: 0 }, z: [0, 0], score: 0.3, trend: 0.3 }
    : { status, features: { nLineReturns: 0, xProgress: 0, missingRatio: status === 'low_quality' ? 0.9 : 0 } } as AttentionResult

function session(gaze: boolean, statuses: AttentionResult['status'][]) {
  let t = 0
  const rec = new SessionRecorder(gaze ? GAZE : null, () => t)
  rec.setActive(true)
  for (const s of statuses) { t += 2000; rec.addAttention(win(s)) }
  return rec.end()
}

describe('focusNote', () => {
  it('no note when there is a score', () => {
    expect(focusNote(session(true, ['ok', 'ok', 'ok']), 70)).toBeNull()
  })
  it('Screen attention off', () => {
    expect(focusNote(session(false, []), null)).toBe('off')
  })
  it('too short: still warming up when it ended', () => {
    expect(focusNote(session(true, Array(8).fill('warming_up')), null)).toBe('too_short')
    expect(focusNote(session(true, []), null)).toBe('too_short')
  })
  it('poor tracking: most windows had too many gaps', () => {
    expect(focusNote(session(true, ['low_quality', 'low_quality', 'low_quality', 'ok']), null)).toBe('poor_tracking')
  })
  it('every note has text', () => {
    for (const k of ['off', 'too_short', 'poor_tracking'] as const) expect(FOCUS_NOTE_TEXT[k].length).toBeGreaterThan(10)
  })
})
