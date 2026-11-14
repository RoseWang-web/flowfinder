/**
 * protocol.ts — Messages between the parts of the extension.
 *
 *   popup ──start_session──▶ background ──(creates)──▶ offscreen ENGINE
 *   calibration tab ──calib_* / validation_*──▶ engine
 *   content script (every page) ──page_state / dock actions──▶ engine
 *   engine ──state (1/s)──▶ background ──engine_state──▶ active tab's dock + toolbar badge
 *   engine ──kv_*──▶ background (offscreen documents only get chrome.runtime, so
 *                                the background does chrome.storage for them)
 *
 * Every runtime message carries `to`, because chrome.runtime.sendMessage
 * reaches every extension page; only the addressee answers.
 */
import type { CalibrationSummary } from '@core/types'
import type { HistoryEntry } from '@core/historyStorage'
import type { FocusNote } from './session/focusNote'

// ── Session setup (from the popup) ─────────────────────────────────────
export interface SessionSetup {
  /** "Working on" — suggested from the current tab title */
  task: string
  /** 0 = open-ended (∞) */
  durationMin: number
  /** Notice: face leaving the camera frame */
  stayInFrame: boolean
  /** Notice: only count time while a page is visible and focused */
  tabActivity: boolean
  /** Notice: webcam gaze attention estimate (experimental; needs calibration) */
  screenAttention: boolean
}

export const DEFAULT_SETUP: SessionSetup = {
  task: '',
  durationMin: 25,
  stayInFrame: true,
  tabActivity: true,
  screenAttention: true,
}

export const usesCamera = (s: SessionSetup) => s.stayInFrame || s.screenAttention

// ── Engine state (to the dock, popup, badge) ───────────────────────────
export type EnginePhase =
  | 'idle'
  | 'preparing'         // camera + model loading
  | 'needs_permission'  // camera permission must be granted in a tab first
  | 'calibrating'       // calibration tab is open
  | 'running'
  | 'finished'          // summary card
  | 'error'

export type FaceStatus = 'ok' | 'weak' | 'none' | 'off'
export type InactiveReason = 'paused' | 'tab_hidden' | 'page_blur' | 'no_page'

export interface SessionSummary {
  sessionId: string
  task: string
  /** Timer time (excludes pauses) */
  sessionMs: number
  /** Time a page was actually being read (what the Dashboard calls 閱讀計時) */
  readingMs: number
  focusPercent: number | null
  /** Why there is no focus score (null when there is one) */
  focusNote: FocusNote | null
  endReason: 'manual' | 'time_up'
}

export interface EngineState {
  phase: EnginePhase
  setup: SessionSetup | null
  message: string
  /** Timer: excludes pauses */
  elapsedMs: number
  totalMs: number
  paused: boolean
  timeUp: boolean
  /** Time's-up card is showing (until Keep going / Finish) */
  timeUpPending: boolean
  /** Counting right now (not paused, and a page is visible + focused when tabActivity is on) */
  reading: boolean
  inactiveReason: InactiveReason | null
  face: FaceStatus
  /** Session-so-far gaze focus %, null until enough scored windows */
  focusPercent: number | null
  /** Most recent windows were too noisy to score (calibration drifted) — offer a recalibration */
  trackingDegraded: boolean
  /** A mid-session recalibration is in progress (session paused) */
  recalibrating: boolean
  calibration: CalibrationSummary | null
  summary: SessionSummary | null
}

export const IDLE_STATE: EngineState = {
  phase: 'idle', setup: null, message: '', elapsedMs: 0, totalMs: 0, paused: false, timeUp: false, timeUpPending: false,
  reading: false, inactiveReason: null, face: 'off', focusPercent: null, trackingDegraded: false, recalibrating: false,
  calibration: null, summary: null,
}

// ── Page state (content script → engine) ───────────────────────────────
export interface PageState {
  host: string
  visible: boolean
  hasFocus: boolean
  /** Width of the main text column in CSS px (line-return threshold scales with it) */
  columnWidthPx: number
}

// ── Messages to the engine ─────────────────────────────────────────────
export type ToEngine =
  | { to: 'engine'; type: 'start'; setup: SessionSetup }
  | { to: 'engine'; type: 'get_state' }
  | { to: 'engine'; type: 'face_status' }
  | { to: 'engine'; type: 'calib_reset' }
  | { to: 'engine'; type: 'calib_click'; screenX: number; screenY: number }
  | { to: 'engine'; type: 'validation_point'; index: number; screenX: number; screenY: number }
  | { to: 'engine'; type: 'validation_finish'; viewport: { width: number; height: number } }
  | { to: 'engine'; type: 'begin_reading' }
  | { to: 'engine'; type: 'recalibrate' }
  | { to: 'engine'; type: 'pause' }
  | { to: 'engine'; type: 'resume' }
  | { to: 'engine'; type: 'keep_going' }
  | { to: 'engine'; type: 'finish' }
  | { to: 'engine'; type: 'dismiss' }
  | { to: 'engine'; type: 'cancel' }
  | { to: 'engine'; type: 'page_state'; page: PageState }
  | { to: 'engine'; type: 'get_export' }

export interface StartReply { phase: EnginePhase; message: string }
export interface FaceReply {
  face: FaceStatus
  validRatio: number
  /** Gaze predictions in the last second — the model needs ≈ 30 (Phase 0 check ③) */
  samplesPerSecond: number
}
export type ExportReply = HistoryEntry | null

// ── Messages to the background ─────────────────────────────────────────
export type ToBackground =
  | { to: 'background'; type: 'start_session'; setup: SessionSetup; originTabId: number | null }
  | { to: 'background'; type: 'state'; state: EngineState }
  | { to: 'background'; type: 'calibration_done' }
  | { to: 'background'; type: 'calibration_cancelled' }
  | { to: 'background'; type: 'permission_granted' }
  | { to: 'background'; type: 'open_history' }
  | { to: 'background'; type: 'open_recalibration' }
  | { to: 'background'; type: 'kv_get'; key: string }
  | { to: 'background'; type: 'kv_set'; key: string; value: unknown }
  | { to: 'background'; type: 'kv_remove'; key: string }

// ── Messages to content scripts (chrome.tabs.sendMessage) ──────────────
export type ToContent =
  | { type: 'engine_state'; state: EngineState }
  | { type: 'toggle_dock' }

/** A message without its `to` field (distributes over the union, unlike plain Omit). */
export type Unaddressed<T> = T extends unknown ? Omit<T, 'to'> : never
export type EngineMessage = Unaddressed<ToEngine>
export type BackgroundMessage = Unaddressed<ToBackground>

export function isToEngine(m: unknown): m is ToEngine {
  return typeof m === 'object' && m !== null && (m as { to?: unknown }).to === 'engine'
}

export function isToBackground(m: unknown): m is ToBackground {
  return typeof m === 'object' && m !== null && (m as { to?: unknown }).to === 'background'
}
