/**
 * focusNote.ts — Why a session has no focus score (shown instead of a bare "—").
 *
 * The web app's computeSessionAnalysis() scores a gaze session only when it has
 * at least 3 scored ("ok") windows. Windows are not scored during the 20-second
 * warm-up, while tracking quality is low (face lost / too many gaps), or while
 * the page is not being read.
 */
import type { Session } from '@core/types'

export type FocusNote = 'off' | 'too_short' | 'poor_tracking'

export const FOCUS_NOTE_TEXT: Record<FocusNote, string> = {
  off: 'Screen attention was off for this session.',
  too_short: 'Too short to score: about 30 seconds of reading with the page in front is needed.',
  poor_tracking: 'Not scored: your face was not tracked well enough (light, angle, or distance).',
}

export function focusNote(session: Session, score: number | null): FocusNote | null {
  if (score !== null) return null
  if (!session.gazeEnabled) return 'off'
  const windows = session.events.filter(e => e.eventType === 'attention_score')
  const lowQuality = windows.filter(e => e.data?.status === 'low_quality').length
  return windows.length > 0 && lowQuality / windows.length > 0.5 ? 'poor_tracking' : 'too_short'
}
