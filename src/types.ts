export const SCHEMA_VERSION = 2

export type SessionStatus = 'idle' | 'running' | 'paused' | 'checking_in' | 'completed'

export type EndReason = 'time_up' | 'manual' | 'interrupted'

export type CheckInAnswer = 'on_task' | 'partly' | 'off_task' | 'not_sure'

export type EventType =
  | 'session_start'
  | 'session_pause'
  | 'session_resume'
  | 'session_end'
  | 'page_visibility'
  | 'scroll'
  | 'check_in_shown'
  | 'check_in_answered'
  | 'check_in_skipped'
  | 'session_interrupted'
  // Camera events (phase 3+)
  | 'camera_started'          // stream opened and model ready
  | 'camera_stopped'          // stream closed (pause/checking_in/page hidden/completed)
  | 'camera_error'            // error acquiring stream or loading model
  | 'face_detection_changed'  // detected→not_detected or vice-versa; also unavailable transitions

export interface SessionEvent {
  id: string
  sessionId: string
  eventType: EventType
  /** ms since session startedAt, INCLUDING pause time */
  elapsedMs: number
  /** activeReadingMs (閱讀計時) at moment of event — does not include pause or check-in time */
  activeReadingMs: number
  data?: Record<string, unknown>
}

export interface CheckInRecord {
  shownAt: number
  shownElapsedMs: number
  shownActiveReadingMs: number
  answeredAt: number | null
  answer: CheckInAnswer | null
  skipped: boolean
}

export interface Session {
  schemaVersion: number
  sessionId: string
  articleId: string
  startedAt: number
  status: SessionStatus
  durationMs: number
  /** 閱讀計時 — does not include pause, checking_in, or answer time */
  activeReadingMs: number
  lastSavedAt: number
  endedAt: number | null
  endReason: EndReason | null
  checkIn: CheckInRecord | null
  events: SessionEvent[]
  /** Whether user chose camera mode for this session (optional for backward compat) */
  cameraEnabled?: boolean
}
