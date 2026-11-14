/**
 * Engine.ts — The extension's tracking + session engine (runs in the offscreen document).
 *
 * Owns the camera (WebGazer), the attention model, the session timer and the
 * session record. Everything it needs from the browser is injected, so the
 * whole flow is unit-tested without Chrome.
 *
 *   idle ─start─▶ preparing ─camera ok─▶ calibrating ─begin_reading─▶ running ─finish─▶ finished ─dismiss─▶ idle
 *                       │                (skipped when Screen attention is off)  ▲ pause/resume, time's up
 *                       └─permission denied─▶ needs_permission (start again after granting)
 */
import { AttentionEstimator, DEFAULT_MODEL, extractWindowFeatures, featureConfig, type AttentionModel, type GazeSample, OnlineStats } from '@core/attentionModel'
import { VALIDATION_COLLECT_MS, VALIDATION_SETTLE_MS, summarizeValidation } from '@core/calibration'
import { parseGazeError, type GazeTracker } from '@core/gaze'
import { computeGazeFocusPercent } from '@core/sessionAnalysis'
import type { CalibrationSummary } from '@core/types'
import type { HistoryEntry } from '@core/historyStorage'
import { SessionRecorder } from '../session/recorder'
import { focusNote } from '../session/focusNote'
import { JitterGuard, estimateJitterPx } from './quality'
import { clearCurrentSession, recoverInterruptedSession, saveCompletedSession, saveCurrentSession, type KV } from '../session/historyStore'
import {
  IDLE_STATE,
  usesCamera,
  type EngineState,
  type FaceReply,
  type FaceStatus,
  type InactiveReason,
  type PageState,
  type SessionSetup,
  type SessionSummary,
  type StartReply,
  type ToEngine,
} from '../protocol'

type Stats = { nLineReturns: OnlineStats; xProgress: OnlineStats }

export interface EngineDeps {
  tracker: GazeTracker
  kv: KV
  publish: (state: EngineState) => void
  /** Wall clock for the session (Date.now) */
  now?: () => number
  /** Clock of the tracker's sample timestamps (performance.now) */
  perfNow?: () => number
  model?: AttentionModel
  modelCvRocAuc?: number
  baseline?: { load: (m: AttentionModel) => Stats | null; save: (m: AttentionModel, s: Stats) => void }
}

/** A page report older than this no longer counts as "the page being read". */
export const PAGE_STALE_MS = 5000
const PERSIST_EVERY_MS = 10_000

interface PageEntry extends PageState { tabId: number; at: number }
interface ValidationPoint { target: { x: number; y: number }; start: number; end: number; samples: GazeSample[] }

export class Engine {
  private readonly tracker: GazeTracker
  private readonly kv: KV
  private readonly publishFn: (s: EngineState) => void
  private readonly now: () => number
  private readonly perfNow: () => number
  private readonly model: AttentionModel
  private readonly modelCvRocAuc: number
  private readonly baseline: NonNullable<EngineDeps['baseline']>

  private phase: EngineState['phase'] = 'idle'
  private setup: SessionSetup | null = null
  private message = ''
  private calibration: CalibrationSummary | null = null
  private validation: ValidationPoint[] = []

  private recorder: SessionRecorder | null = null
  private estimator: AttentionEstimator
  private timerAccumMs = 0
  private timerSince: number | null = null
  private paused = false
  private timeUp = false
  private timeUpPending = false
  private reading = false
  private inactiveReason: InactiveReason | null = null
  private pages = new Map<number, PageEntry>()
  private currentTabId: number | null = null
  private focusPercent: number | null = null
  private summary: SessionSummary | null = null
  private lastEntry: HistoryEntry | null = null
  private lastPersistAt = 0

  // Quality guard: raw samples of the last window, jitter baseline, recalibration
  private window: GazeSample[] = []
  private guard = new JitterGuard()
  private columnWidthPx = 660
  private trackingDegraded = false
  private recalibrating = false

  // Face presence, from the share of samples with a prediction
  private secTotal = 0
  private secValid = 0
  private face: FaceStatus = 'off'
  private faceRatio = 0
  private samplesPerSecond = 0
  private faceDetected: boolean | null = null

  constructor(deps: EngineDeps) {
    this.tracker = deps.tracker
    this.kv = deps.kv
    this.publishFn = deps.publish
    this.now = deps.now ?? Date.now
    this.perfNow = deps.perfNow ?? (() => performance.now())
    this.model = deps.model ?? DEFAULT_MODEL
    this.modelCvRocAuc = deps.modelCvRocAuc ?? 0
    this.baseline = deps.baseline ?? { load: () => null, save: () => {} }
    this.estimator = new AttentionEstimator({ columnWidthPx: 660, model: this.model })
    this.tracker.addListener(s => this.onSample(s))
  }

  /** Store a session left running by a crashed / closed engine as interrupted. */
  async init(): Promise<void> {
    try { await recoverInterruptedSession(this.kv, this.now()) } catch { /* nothing to recover */ }
  }

  getState(): EngineState {
    if (this.phase === 'idle') return { ...IDLE_STATE }
    return {
      phase: this.phase,
      setup: this.setup,
      message: this.message,
      elapsedMs: this.elapsedMs(),
      totalMs: (this.setup?.durationMin ?? 0) * 60_000,
      paused: this.paused,
      timeUp: this.timeUp,
      timeUpPending: this.timeUpPending,
      reading: this.reading,
      inactiveReason: this.inactiveReason,
      face: this.face,
      focusPercent: this.focusPercent,
      trackingDegraded: this.trackingDegraded,
      recalibrating: this.recalibrating,
      calibration: this.calibration,
      summary: this.summary,
    }
  }

  private publish() { this.publishFn(this.getState()) }

  private elapsedMs(): number {
    return this.timerAccumMs + (this.timerSince !== null ? this.now() - this.timerSince : 0)
  }

  // ── Message entry point ────────────────────────────────────────────
  async handle(msg: ToEngine, senderTabId: number | null = null): Promise<unknown> {
    switch (msg.type) {
      case 'start': return this.start(msg.setup)
      case 'get_state': return this.getState()
      case 'face_status': return { face: this.face, validRatio: this.faceRatio, samplesPerSecond: this.samplesPerSecond } satisfies FaceReply
      case 'calib_reset':
        await this.tracker.clearCalibration()
        this.calibration = null
        this.validation = []
        this.publish()
        return true
      case 'calib_click':
        if (this.phase === 'calibrating' || this.recalibrating) this.tracker.recordCalibrationPoint(msg.screenX, msg.screenY)
        return true
      case 'validation_point': {
        const start = this.perfNow() + VALIDATION_SETTLE_MS
        this.validation[msg.index] = { target: { x: msg.screenX, y: msg.screenY }, start, end: start + VALIDATION_COLLECT_MS, samples: [] }
        return true
      }
      case 'validation_finish': {
        const pts = this.validation.filter(Boolean)
        this.calibration = summarizeValidation(pts.map(p => p.target), pts.map(p => p.samples), msg.viewport, this.now())
        this.validation = []
        this.publish()
        return this.calibration
      }
      case 'begin_reading': return this.recalibrating ? this.finishRecalibration() : this.beginReading()
      case 'recalibrate': return this.startRecalibration()
      case 'pause': this.setPaused(true); return true
      case 'resume': this.setPaused(false); return true
      case 'keep_going': this.timeUpPending = false; this.publish(); return true
      case 'finish': await this.finish(); return true
      case 'dismiss': this.reset(); return true
      case 'cancel': this.cancel(); return true
      case 'page_state':
        if (senderTabId !== null) this.onPage(senderTabId, msg.page)
        return true
      case 'get_export': return this.lastEntry
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  async start(setup: SessionSetup): Promise<StartReply> {
    if (!['idle', 'finished', 'error', 'needs_permission'].includes(this.phase)) {
      return { phase: this.phase, message: this.message }
    }
    this.reset(false)
    this.setup = { ...setup, task: setup.task.trim() || 'My focus task' }
    this.phase = 'preparing'
    this.message = usesCamera(setup) ? 'Starting the camera…' : ''
    this.publish()

    if (usesCamera(setup)) {
      try {
        await this.tracker.begin()
      } catch (err) {
        const e = parseGazeError(err)
        this.phase = e.kind === 'permission_denied' ? 'needs_permission' : 'error'
        this.message = e.message
        this.publish()
        return { phase: this.phase, message: this.message }
      }
      this.face = 'none'
    }
    if (setup.screenAttention) {
      await this.tracker.clearCalibration()
      this.phase = 'calibrating'
      this.message = ''
      this.publish()
    } else {
      this.beginReading()
    }
    return { phase: this.phase, message: this.message }
  }

  beginReading(): StartReply {
    const setup = this.setup
    const okPhase = this.phase === 'calibrating' || (this.phase === 'preparing' && setup && !setup.screenAttention)
    if (!setup || !okPhase) return { phase: this.phase, message: this.message }
    if (setup.screenAttention && (!this.calibration || this.calibration.quality === 'poor')) {
      return { phase: this.phase, message: 'Calibration is needed before reading.' }
    }
    const gaze = setup.screenAttention && this.calibration
      ? { calibration: this.calibration, modelCvRocAuc: this.modelCvRocAuc }
      : null
    this.recorder = new SessionRecorder(gaze, this.now, {
      taskTitle: setup.task,
      plannedDurationMs: setup.durationMin * 60_000,
      rules: { allowHeadDown: !setup.stayInFrame, allowTabSwitch: !setup.tabActivity, allowWindowBlur: !setup.tabActivity },
    })
    const page = this.activePage()
    this.estimator = new AttentionEstimator({
      columnWidthPx: page?.columnWidthPx || 660,
      model: this.model,
      initialStats: this.baseline.load(this.model) ?? undefined,
    })
    this.timerAccumMs = 0
    this.timerSince = this.now()
    this.phase = 'running'
    this.message = ''
    this.currentTabId = null
    this.updateReading()
    void this.persistCurrent()
    this.publish()
    return { phase: this.phase, message: '' }
  }

  private setPaused(p: boolean) {
    if (this.phase !== 'running' || this.paused === p) return
    const t = this.now()
    if (p) {
      this.timerAccumMs += t - (this.timerSince ?? t)
      this.timerSince = null
      this.recorder?.pause()
    } else {
      this.timerSince = t
      this.recorder?.resume()
    }
    this.paused = p
    this.updateReading()
    this.publish()
  }

  async finish(): Promise<void> {
    const rec = this.recorder
    if (this.phase !== 'running' || !rec) return
    if (this.timerSince !== null) this.timerAccumMs += this.now() - this.timerSince
    this.timerSince = null
    this.recorder = null
    const endReason = this.timeUp ? 'time_up' : 'manual'
    const session = rec.end(endReason)
    if (session.gazeEnabled) this.baseline.save(this.model, this.estimator.getStats())
    this.tracker.end()
    this.face = 'off'
    this.reading = false
    this.inactiveReason = null
    this.timeUpPending = false
    try {
      this.lastEntry = await saveCompletedSession(this.kv, session)
      await clearCurrentSession(this.kv)
    } catch (err) {
      this.message = 'Could not save this session: ' + (err instanceof Error ? err.message : String(err))
    }
    this.summary = {
      sessionId: session.sessionId,
      task: this.setup?.task ?? '',
      sessionMs: this.timerAccumMs,
      readingMs: session.activeReadingMs,
      focusPercent: this.lastEntry?.analysis.totalScore ?? null,
      focusNote: focusNote(session, this.lastEntry?.analysis.totalScore ?? null),
      endReason,
    }
    this.phase = 'finished'
    this.publish()
  }

  // ── Mid-session recalibration (tracking degraded) ──────────────────
  private startRecalibration(): StartReply {
    if (this.phase !== 'running' || !this.setup?.screenAttention || this.recalibrating) {
      return { phase: this.phase, message: '' }
    }
    this.setPaused(true)
    this.recalibrating = true
    this.publish()
    return { phase: 'calibrating', message: '' }
  }

  private finishRecalibration(): StartReply {
    if (!this.calibration || this.calibration.quality === 'poor') {
      return { phase: this.phase, message: 'Calibration is too rough — try again.' }
    }
    this.endRecalibration()
    return { phase: 'running', message: '' }
  }

  private endRecalibration() {
    this.recalibrating = false
    this.trackingDegraded = false
    this.guard.reset() // learn the new noise level
    this.window = []
    this.estimator.clearBuffer()
    this.setPaused(false)
  }

  private cancel() {
    if (this.recalibrating) { this.endRecalibration(); return }
    if (this.phase === 'running') return // use finish
    this.tracker.end()
    this.reset()
  }

  private reset(publish = true) {
    this.phase = 'idle'
    this.setup = null
    this.message = ''
    this.calibration = null
    this.validation = []
    this.recorder = null
    this.timerAccumMs = 0
    this.timerSince = null
    this.paused = false
    this.timeUp = false
    this.timeUpPending = false
    this.reading = false
    this.inactiveReason = null
    this.currentTabId = null
    this.focusPercent = null
    this.summary = null
    this.window = []
    this.guard.reset()
    this.trackingDegraded = false
    this.recalibrating = false
    this.face = 'off'
    this.faceDetected = null
    if (publish) this.publish()
  }

  // ── Pages ──────────────────────────────────────────────────────────
  private onPage(tabId: number, page: PageState) {
    this.pages.set(tabId, { ...page, tabId, at: this.now() })
    this.updateReading()
  }

  private activePage(): PageEntry | null {
    const t = this.now()
    let best: PageEntry | null = null
    for (const p of this.pages.values()) {
      if (t - p.at > PAGE_STALE_MS || !p.visible || !p.hasFocus) continue
      if (!best || p.at > best.at) best = p
    }
    return best
  }

  private updateReading() {
    const rec = this.recorder
    if (this.phase !== 'running' || !rec || !this.setup) { this.reading = false; return }
    const page = this.activePage()

    if (page && page.tabId !== this.currentTabId) {
      // New page: a model window must not span two layouts
      this.currentTabId = page.tabId
      this.estimator.clearBuffer()
      this.window = []
      if (page.columnWidthPx > 0) {
        this.columnWidthPx = page.columnWidthPx
        this.estimator.setColumnWidth(page.columnWidthPx)
      }
      rec.enterPage(page.host)
    }

    let reason: InactiveReason | null = null
    if (this.paused) reason = 'paused'
    else if (this.setup.tabActivity && !page) {
      const fresh = [...this.pages.values()].filter(p => this.now() - p.at <= PAGE_STALE_MS)
      reason = fresh.length === 0 ? 'no_page' : fresh.some(p => p.visible) ? 'page_blur' : 'tab_hidden'
    }
    const reading = reason === null
    if (reading !== this.reading) {
      this.estimator.clearBuffer()
      this.window = []
      rec.setActive(reading, reason ?? undefined)
    }
    this.reading = reading
    this.inactiveReason = reason
  }

  // ── Samples and clocks ─────────────────────────────────────────────
  private onSample(s: GazeSample) {
    this.secTotal++
    if (s.x !== null) this.secValid++
    for (const p of this.validation) if (p && s.t >= p.start && s.t <= p.end) p.samples.push(s)
    if (this.phase === 'running' && this.setup?.screenAttention) {
      this.estimator.addSample(s)
      this.window.push(s)
      const cutoff = s.t - this.model.params.windowSeconds * 1000
      while (this.window.length && this.window[0].t < cutoff) this.window.shift()
    }
  }

  /** Call once per second. */
  tick(): void {
    if (this.phase === 'idle') return
    if (this.setup && usesCamera(this.setup) && this.face !== 'off') {
      this.faceRatio = this.secTotal > 0 ? this.secValid / this.secTotal : 0
      this.samplesPerSecond = this.secTotal
      this.face = this.secTotal === 0 || this.secValid === 0 ? 'none' : this.faceRatio >= 0.6 ? 'ok' : 'weak'
      this.secTotal = 0
      this.secValid = 0
    }
    if (this.phase === 'running') {
      this.updateReading()
      if (this.setup?.stayInFrame && this.recorder) {
        const detected = this.face !== 'none'
        if (detected !== this.faceDetected) {
          if (this.faceDetected !== null) this.recorder.faceChanged(detected)
          this.faceDetected = detected
        }
      }
      const total = (this.setup?.durationMin ?? 0) * 60_000
      if (total > 0 && !this.timeUp && this.elapsedMs() >= total) {
        this.timeUp = true
        this.timeUpPending = true
      }
      if (this.now() - this.lastPersistAt >= PERSIST_EVERY_MS) void this.persistCurrent()
    }
    this.publish()
  }

  /** Call every model step (stepSeconds). */
  step(): void {
    const rec = this.recorder
    if (this.phase !== 'running' || !rec || !this.setup?.screenAttention || !rec.isActive) return
    const now = this.perfNow()
    const jitter = estimateJitterPx(this.window)
    const jitterPx = jitter === null ? null : Math.round(jitter)

    if (this.guard.assess(jitter) === 'noisy') {
      // Too noisy to trust: record why, but never score it or let it reach the baseline
      const features = extractWindowFeatures(this.window, now, featureConfig(this.model.params, this.columnWidthPx), this.model.params.maxGapMs)
      rec.addAttention({ status: 'low_quality', features }, { reason: 'noisy', jitterPx })
    } else {
      const r = this.estimator.evaluate(now)
      rec.addAttention(r, jitterPx === null ? undefined : { jitterPx })
      if (r.status !== 'low_quality') this.guard.learn(jitter)
    }
    this.trackingDegraded = this.guard.degraded
    this.focusPercent = computeGazeFocusPercent(rec.snapshot())
  }

  private async persistCurrent() {
    if (!this.recorder) return
    this.lastPersistAt = this.now()
    try { await saveCurrentSession(this.kv, this.recorder.snapshot()) } catch { /* retried next tick */ }
  }
}
