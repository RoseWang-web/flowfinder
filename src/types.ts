export const SCHEMA_VERSION = 2

export type SessionStatus = 'idle' | 'running' | 'paused' | 'checking_in' | 'overtime' | 'completed'

export type CategoryId = 'web_reading' | 'study_notes'

export interface TaskRules {
  allowHeadDown: boolean
  allowTabSwitch: boolean
  allowWindowBlur: boolean
}

export interface SessionTaskSettings {
  categoryId: CategoryId
  rulesVersion: 1
  rules: TaskRules
}

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
  // Gaze events (eye-tracking mode)
  | 'attention_score'         // one mind-wandering estimate per model step (every 2 s)
  | 'gaze_error'              // WebGazer failed during the session

// ── Gaze (eye-tracking mode) ─────────────────────────────────────────────

/** good ≈ the 'webcam_typical' simulation or better; usable ≈ 'webcam_poor'; poor = worse than simulated */
export type GazeQuality = 'good' | 'usable' | 'poor'

export interface CalibrationPointResult {
  /** Target position in px (viewport coordinates) */
  x: number
  y: number
  /** Distance from the mean prediction to the target (systematic offset); null if no predictions */
  accuracyPx: number | null
  /** RMS distance of predictions from their own mean (jitter); null if < 2 predictions */
  precisionPx: number | null
  nValid: number
  n: number
}

export interface CalibrationSummary {
  quality: GazeQuality
  accuracyPx: number | null
  precisionPx: number | null
  /** Share of validation samples that had a prediction */
  validRatio: number
  viewport: { width: number; height: number }
  points: CalibrationPointResult[]
  calibratedAt: number
}

export interface GazeSessionInfo {
  calibration: CalibrationSummary
  /** Cross-validated AUC of the model in use (from model.json), kept for later comparison */
  modelCvRocAuc: number
}

export interface SessionEvent {
  id: string
  sessionId: string
  eventType: EventType
  /** ms since session startedAt, INCLUDING pause time */
  elapsedMs: number
  /** activeReadingMs (active reading time) at moment of event — does not include pause or check-in time */
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
  /** Active reading time — does not include pause, checking_in, or answer time */
  activeReadingMs: number
  lastSavedAt: number
  endedAt: number | null
  endReason: EndReason | null
  checkIn: CheckInRecord | null
  events: SessionEvent[]
  /** Whether user chose camera mode for this session (optional for backward compat) */
  cameraEnabled?: boolean
  /** Whether the session used eye-tracking (WebGazer) mode */
  gazeEnabled?: boolean
  /** Calibration result for eye-tracking mode */
  gaze?: GazeSessionInfo
  /** Immutable copy of task settings at session start. Absent in sessions from before this feature. */
  taskSettings?: SessionTaskSettings
  /** Planned session duration in ms. 0 = unlimited (∞). Absent in old sessions — treat as 120_000. */
  plannedDurationMs?: number
}
