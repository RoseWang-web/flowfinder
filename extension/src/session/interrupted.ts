/**
 * interrupted.ts — Closing a session the side panel never ended.
 * Kept free of UI / tracker imports: the content script bundles it.
 */
import type { Session } from '@core/types'

export const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/** Close a session that was still running when the side panel went away (same rules as the web app). */
export function finalizeInterrupted(saved: Session, now = Date.now()): Session {
  if (saved.status === 'completed') return saved
  const last = saved.events[saved.events.length - 1]
  const events = last?.eventType === 'session_interrupted'
    ? saved.events
    : [
        ...saved.events,
        {
          id: makeId(),
          sessionId: saved.sessionId,
          eventType: 'session_interrupted' as const,
          elapsedMs: now - saved.startedAt,
          activeReadingMs: saved.activeReadingMs,
          data: { restoredAt: now },
        },
      ]
  return { ...saved, status: 'completed', endReason: 'interrupted', endedAt: saved.lastSavedAt, events, lastSavedAt: now }
}
