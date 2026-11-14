/**
 * recorder.ts — Builds a web-app-compatible Session while the user reads
 * with the extension.
 *
 * Same shape and conventions as useSession.ts in the web app, so the record
 * can be written straight into the web app's history and scored by
 * computeSessionAnalysis():
 *   - durationMs     = now − startedAt (includes inactive time)
 *   - activeReadingMs only counts time while the page is being read
 *     (tab visible + page focused); changes are logged as page_visibility
 *   - attention_score events carry attentionEventData() payloads
 *   - an unfinished session is closed as endReason 'interrupted' with a
 *     session_interrupted event, like the web app does on reload
 */
import { SCHEMA_VERSION, type EndReason, type EventType, type GazeSessionInfo, type Session, type SessionTaskSettings, type TaskRules } from '@core/types'
import type { AttentionResult } from '@core/attentionModel'
import { attentionEventData } from '@core/useGaze'
import { SYSTEM_DEFAULTS, TASK_RULES_VERSION } from '@core/taskPreferences'
import { makeId } from './interrupted'

export { finalizeInterrupted } from './interrupted'

export const EXTENSION_ARTICLE_ID = 'extension-web-reading'

export type InactiveReason = 'tab_hidden' | 'page_blur' | 'not_connected' | 'no_page' | 'paused'

/** Reading across sites is the point of the extension, so tab switches are allowed. */
export const EXTENSION_TASK_SETTINGS: SessionTaskSettings = {
  categoryId: 'web_reading',
  rulesVersion: TASK_RULES_VERSION,
  rules: { ...SYSTEM_DEFAULTS.web_reading, allowTabSwitch: true },
}


export class SessionRecorder {
  private session: Session
  private activeSince: number | null = null
  private accumulatedMs = 0

  /**
   * @param gaze calibration + model info; null when the gaze estimate is off
   *             (the session then has no attention_score events and no score)
   */
  constructor(
    gaze: GazeSessionInfo | null,
    private readonly now: () => number = Date.now,
    opts: {
      /** "Working on" — stored where the web app keeps it (taskSettings.taskTitle) */
      taskTitle?: string
      rules?: TaskRules
      /** Planned length in ms; 0 = open-ended (∞), like the web app */
      plannedDurationMs?: number
    } = {},
  ) {
    const t = now()
    const sessionId = makeId()
    this.session = {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      articleId: EXTENSION_ARTICLE_ID,
      startedAt: t,
      status: 'running',
      durationMs: 0,
      activeReadingMs: 0,
      lastSavedAt: t,
      endedAt: null,
      endReason: null,
      checkIn: null,
      cameraEnabled: false,
      gazeEnabled: gaze !== null,
      ...(gaze ? { gaze } : {}),
      plannedDurationMs: opts.plannedDurationMs ?? 0,
      taskSettings: {
        ...EXTENSION_TASK_SETTINGS,
        rules: { ...(opts.rules ?? EXTENSION_TASK_SETTINGS.rules) },
        ...(opts.taskTitle ? { taskTitle: opts.taskTitle } : {}),
      },
      source: 'extension',
      pages: [],
      events: [],
    }
    this.push('session_start', { visible: false })
  }

  get id(): string { return this.session.sessionId }
  get isActive(): boolean { return this.activeSince !== null }

  activeReadingMs(at = this.now()): number {
    return this.accumulatedMs + (this.activeSince !== null ? at - this.activeSince : 0)
  }

  /** Reading started or stopped (tab visibility / page focus). Logs only real changes. */
  setActive(active: boolean, reason?: InactiveReason): void {
    if (this.session.status !== 'running' || active === this.isActive) return
    const t = this.now()
    if (active) {
      this.activeSince = t
    } else {
      this.accumulatedMs += t - (this.activeSince ?? t)
      this.activeSince = null
    }
    this.push('page_visibility', active ? { visible: true } : { visible: false, reason })
  }

  /** The user is now on this site (hostname only). Consecutive duplicates are ignored. */
  enterPage(host: string): void {
    if (this.session.status !== 'running' || !host) return
    const pages = this.session.pages ?? []
    if (pages[pages.length - 1]?.host === host) return
    this.session = { ...this.session, pages: [...pages, { host, enteredElapsedMs: this.now() - this.session.startedAt }] }
  }

  /** User pressed pause / resume (logged like the web app; reading time is handled by setActive). */
  pause(): void { if (this.session.status === 'running') this.push('session_pause') }
  resume(): void { if (this.session.status === 'running') this.push('session_resume') }

  /** Face entered / left the camera frame ("Stay in frame"). */
  faceChanged(detected: boolean): void {
    if (this.session.status === 'running') this.push('face_detection_changed', { detected })
  }

  /** @param extra e.g. { reason: 'noisy', jitterPx } for windows the quality guard rejected */
  addAttention(result: AttentionResult, extra?: Record<string, unknown>): void {
    if (this.session.status !== 'running') return
    this.push('attention_score', { ...attentionEventData(result), ...(extra ?? {}) })
  }

  /** Current state, safe to persist (for crash recovery). */
  snapshot(): Session {
    const t = this.now()
    return { ...this.session, durationMs: t - this.session.startedAt, activeReadingMs: this.activeReadingMs(t), lastSavedAt: t }
  }

  end(reason: EndReason = 'manual'): Session {
    if (this.session.status === 'running') {
      if (this.isActive) this.setActive(false)
      const t = this.now()
      this.push('session_end', { reason })
      this.session = {
        ...this.session,
        status: 'completed',
        endedAt: t,
        endReason: reason,
        durationMs: t - this.session.startedAt,
        activeReadingMs: this.accumulatedMs,
        lastSavedAt: t,
      }
    }
    return this.session
  }

  private push(eventType: EventType, data?: Record<string, unknown>) {
    const t = this.now()
    this.session = {
      ...this.session,
      events: [
        ...this.session.events,
        {
          id: makeId(),
          sessionId: this.session.sessionId,
          eventType,
          elapsedMs: t - this.session.startedAt,
          activeReadingMs: this.activeReadingMs(t),
          ...(data ? { data } : {}),
        },
      ],
    }
  }
}
