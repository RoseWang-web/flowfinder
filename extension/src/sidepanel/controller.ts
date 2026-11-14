/**
 * controller.ts — Everything the side panel does, without any UI.
 *
 * Hosts the camera + WebGazer (the same createWebGazerTracker the web app uses,
 * with face_mesh served from the extension), drives calibration/validation on
 * the active page through the content script, and measures the Phase 0
 * pass/fail criteria. React reads `getState()` through `subscribe()`
 * (useSyncExternalStore); gaze samples (30–60/s) never trigger a re-render —
 * the state is published once per second and on user-visible events.
 */
import { createWebGazerTracker, parseGazeError, type GazeTracker } from '@core/gaze'
import { AttentionEstimator, DEFAULT_MODEL, type GazeSample } from '@core/attentionModel'
import { loadBaseline, saveBaseline } from '@core/useGaze'
import modelJson from '@core/model.json'
import {
  CALIBRATION_POINTS,
  CLICKS_PER_POINT,
  VALIDATION_COLLECT_MS,
  VALIDATION_POINTS,
  VALIDATION_SETTLE_MS,
  summarizeValidation,
} from '@core/calibration'
import type { CalibrationSummary } from '@core/types'
import type { ScreenMap } from '../coords'
import { PING, PORT_NAME, type ContentToPanel, type PageInfo, type PanelToContent } from '../messages'
import { bucketFor, externalUrls, quantile, summarizeRates, type FocusBucket, type RateSummary } from './metrics'
import { computeChecks, fmt } from './checks'
import { SessionRecorder, type InactiveReason } from '../session/recorder'
import {
  chromeKV,
  clearCurrentSession,
  recoverInterruptedSession,
  saveCompletedSession,
  saveCurrentSession,
  summarizeExtensionHistory,
  type HistorySummaryRow,
  type KV,
} from '../session/historyStore'

export type CameraState = 'off' | 'starting' | 'on' | 'error'

export interface ReadingState {
  status: 'idle' | 'running'
  startedAt: number | null
  elapsedMs: number
  activeMs: number
  /** Page visible and focused right now (time and scores only count then) */
  active: boolean
  inactiveReason: InactiveReason | null
  /** Focus % of the latest scored window (1 − trend), null until warmed up */
  focusPercent: number | null
  scoredWindows: number
}

export interface PanelState {
  message: string
  camera: CameraState
  cameraError: string
  faceMeshPath: string
  previewOn: boolean
  dotOn: boolean
  calibrating: boolean
  calibClicks: number
  calibTotal: number
  validation: CalibrationSummary | null
  pageInfo: PageInfo | null
  zoom: number | null
  lastSecond: { total: number; valid: number; bucket: FocusBucket | null }
  model: { status: string; missingRatio: number } | null
  rates: Record<FocusBucket, RateSummary>
  externalRequests: string[]
  webApp: { accuracyPx: number; precisionPx: number } | null
  manual: { zoomAligned: boolean; crossTabAligned: boolean }
  reading: ReadingState
  history: HistorySummaryRow[]
}

/** What the React UI needs; tests pass a fake with the same shape. */
export interface PanelController {
  getState(): PanelState
  subscribe(listener: () => void): () => void
  openPermissionPage(): void
  start(): Promise<void>
  calibrate(): Promise<void>
  setPreview(on: boolean): void
  setGazeDot(on: boolean): void
  setWebApp(accuracyPx: number | null, precisionPx: number | null): void
  setManual(patch: Partial<PanelState['manual']>): void
  startReading(): Promise<void>
  endReading(): Promise<void>
  buildReport(): unknown
}

export const IDLE_READING: ReadingState = {
  status: 'idle', startedAt: null, elapsedMs: 0, activeMs: 0,
  active: false, inactiveReason: null, focusPercent: null, scoredWindows: 0,
}

/** Reading needs a calibration that is not 'poor' — same rule as the web app's 開始閱讀 button. */
export function canStartReading(s: Pick<PanelState, 'camera' | 'validation' | 'calibrating' | 'reading'>): boolean {
  return s.camera === 'on' && !s.calibrating && s.reading.status === 'idle' &&
    s.validation !== null && s.validation.quality !== 'poor'
}

const PERSIST_EVERY_MS = 10_000

const MAX_SECONDS = 600
const emptyRates = (): Record<FocusBucket, RateSummary> => ({
  panel: summarizeRates([]),
  page: summarizeRates([]),
  other: summarizeRates([]),
})

export class SidePanelController implements PanelController {
  private state: PanelState
  private readonly listeners = new Set<() => void>()
  private readonly tracker: GazeTracker

  private tabId: number | null = null
  private port: chrome.runtime.Port | null = null
  private calibrationMap: ScreenMap | null = null
  private calibrationZoom: number | null = null

  private estimator = new AttentionEstimator({ columnWidthPx: 660, model: DEFAULT_MODEL })
  private readonly kv: KV = chromeKV
  private recorder: SessionRecorder | null = null
  private lastPersistAt = 0
  private readonly missingByBucket: Record<FocusBucket, number[]> = { panel: [], page: [], other: [] }
  private readonly ratesByBucket: Record<FocusBucket, number[]> = { panel: [], page: [], other: [] }
  private secTotal = 0
  private secValid = 0

  private collect: { start: number; end: number; samples: GazeSample[] } | null = null
  private pendingTarget: ((t: { x: number; y: number } | null) => void) | null = null
  private readonly resourceUrls: string[] = []

  constructor() {
    const faceMeshPath = chrome.runtime.getURL('face_mesh').replace(/\/$/, '')
    this.tracker = createWebGazerTracker({ faceMeshPath })
    this.state = {
      message: '',
      camera: 'off',
      cameraError: '',
      faceMeshPath,
      previewOn: false,
      dotOn: false,
      calibrating: false,
      calibClicks: 0,
      calibTotal: CALIBRATION_POINTS.length * CLICKS_PER_POINT,
      validation: null,
      pageInfo: null,
      zoom: null,
      lastSecond: { total: 0, valid: 0, bucket: null },
      model: null,
      rates: emptyRates(),
      externalRequests: [],
      webApp: null,
      manual: { zoomAligned: false, crossTabAligned: false },
      reading: IDLE_READING,
      history: [],
    }

    new PerformanceObserver(list => {
      for (const e of list.getEntries()) this.resourceUrls.push(e.name)
    }).observe({ type: 'resource', buffered: true })

    this.tracker.addListener(s => this.onSample(s))

    chrome.tabs.onActivated.addListener(() => { void this.connectActiveTab() })
    chrome.windows.onFocusChanged.addListener(() => { void this.connectActiveTab() })
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (id === this.tabId && change.status === 'complete') {
        this.port?.disconnect()
        this.port = null
        this.tabId = null
        void this.connectActiveTab()
      }
    })
    chrome.tabs.onZoomChange.addListener(z => {
      if (z.tabId === this.tabId) this.set({ zoom: z.newZoomFactor })
    })

    setInterval(() => this.everySecond(), 1000)
    setInterval(() => this.everyStep(), DEFAULT_MODEL.params.stepSeconds * 1000)
    // Page focus only changes on focus/blur events; poll as a safety net
    setInterval(() => this.post({ type: 'info_request' }), 2000)

    void this.connectActiveTab()
    void this.initHistory()
  }

  // ── Store ────────────────────────────────────────────────────────────
  getState = (): PanelState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(patch: Partial<PanelState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(l => l())
  }

  // ── Content script connection ──────────────────────────────────────
  private post(m: PanelToContent) {
    try { this.port?.postMessage(m) } catch { /* tab gone */ }
  }

  private async ensureContent(id: number): Promise<boolean> {
    try {
      if ((await chrome.tabs.sendMessage(id, PING)) === 'pong') return true
    } catch { /* not injected yet (tab was open before install) */ }
    try {
      await chrome.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] })
      return true
    } catch {
      return false // chrome:// pages, the Web Store, PDF viewer…
    }
  }

  private async connectActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab?.id) return
    if (tab.id === this.tabId && this.port) return
    this.port?.disconnect()
    this.port = null
    this.tabId = tab.id
    // Gaze windows must not span two pages
    this.estimator.clearBuffer()
    this.set({ pageInfo: null })

    if (!(await this.ensureContent(tab.id))) {
      this.set({ message: '這個分頁不能注入（例如 chrome:// 頁面）。請切到一般網頁。' })
      return
    }
    const p = chrome.tabs.connect(tab.id, { name: PORT_NAME })
    this.port = p
    p.onMessage.addListener((m: ContentToPanel) => this.onContentMessage(m))
    p.onDisconnect.addListener(() => {
      if (this.port === p) { this.port = null; this.set({ pageInfo: null }) }
    })
    this.post({ type: 'gaze_dot', visible: this.state.dotOn })
    let zoom: number | null = null
    try { zoom = await chrome.tabs.getZoom(tab.id) } catch { /* closed */ }
    this.set({ zoom })
  }

  private onContentMessage(m: ContentToPanel) {
    switch (m.type) {
      case 'info':
        this.set({ pageInfo: m.info })
        this.recorder?.enterPage(m.info.host)
        this.updateActive()
        break
      case 'calib_click': {
        this.tracker.recordCalibrationPoint(m.screenX, m.screenY)
        const calibClicks = this.state.calibClicks + 1
        this.set({ calibClicks, message: `校準中… ${calibClicks} / ${this.state.calibTotal}` })
        break
      }
      case 'calib_done':
        this.calibrationMap = m.map
        this.calibrationZoom = this.state.zoom
        void this.runValidation()
        break
      case 'calib_cancelled':
        this.set({ calibrating: false, message: '校準已取消' })
        break
      case 'validation_target':
        this.pendingTarget?.(m.screenX === -1 ? null : { x: m.screenX, y: m.screenY })
        this.pendingTarget = null
        break
    }
  }

  // ── Tracking & measurements ─────────────────────────────────────────
  private onSample(s: GazeSample) {
    this.secTotal++
    if (s.x !== null) this.secValid++
    this.estimator.addSample(s)
    const c = this.collect
    if (c && s.t >= c.start && s.t <= c.end) c.samples.push(s)
    if (this.state.dotOn) this.post({ type: 'gaze', x: s.x, y: s.y })
  }

  private bucket(): FocusBucket {
    return bucketFor(document.hasFocus(), this.state.pageInfo?.hasFocus ?? false)
  }

  private everySecond() {
    this.tickReading()
    const externalRequests = externalUrls(this.resourceUrls)
    if (this.state.camera !== 'on') {
      if (externalRequests.length !== this.state.externalRequests.length) this.set({ externalRequests })
      return
    }
    const bucket = this.bucket()
    const arr = this.ratesByBucket[bucket]
    arr.push(this.secValid)
    if (arr.length > MAX_SECONDS) arr.shift()
    const lastSecond = { total: this.secTotal, valid: this.secValid, bucket }
    this.secTotal = 0
    this.secValid = 0
    this.set({
      lastSecond,
      externalRequests,
      rates: {
        panel: summarizeRates(this.ratesByBucket.panel),
        page: summarizeRates(this.ratesByBucket.page),
        other: summarizeRates(this.ratesByBucket.other),
      },
    })
  }

  private everyStep() {
    if (this.state.camera !== 'on') return
    const r = this.estimator.evaluate(performance.now())
    const arr = this.missingByBucket[this.bucket()]
    arr.push(r.features.missingRatio)
    if (arr.length > MAX_SECONDS) arr.shift()
    let reading = this.state.reading
    if (this.recorder?.isActive) {
      this.recorder.addAttention(r)
      if (r.status === 'ok') {
        reading = { ...reading, focusPercent: Math.round((1 - r.trend) * 100), scoredWindows: reading.scoredWindows + 1 }
      }
    }
    this.set({ model: { status: r.status, missingRatio: r.features.missingRatio }, reading })
  }

  // ── Reading session (history) ───────────────────────────────────────
  private async initHistory() {
    try {
      const recovered = await recoverInterruptedSession(this.kv)
      if (recovered) this.set({ message: '上次的閱讀沒有正常結束，已存成「中斷」紀錄。' })
    } catch (err) {
      console.warn('[FlowFinder] could not recover the previous session', err)
    }
    await this.refreshHistory()
  }

  private async refreshHistory() {
    try {
      this.set({ history: await summarizeExtensionHistory(this.kv) })
    } catch (err) {
      console.warn('[FlowFinder] could not load history', err)
    }
  }

  /** Reading counts only while the page is connected, visible and focused. */
  private updateActive() {
    const rec = this.recorder
    if (!rec) return
    const p = this.state.pageInfo
    const reason: InactiveReason | null = !this.port || !p ? 'not_connected' : !p.visible ? 'tab_hidden' : !p.hasFocus ? 'page_blur' : null
    const active = reason === null
    if (active !== rec.isActive) {
      // A model window must not mix reading with not-reading
      this.estimator.clearBuffer()
      rec.setActive(active, reason ?? undefined)
    }
    if (active !== this.state.reading.active || reason !== this.state.reading.inactiveReason) {
      this.set({ reading: { ...this.state.reading, active, inactiveReason: reason } })
    }
  }

  private tickReading() {
    const rec = this.recorder
    if (!rec) return
    this.updateActive()
    const snap = rec.snapshot()
    this.set({ reading: { ...this.state.reading, elapsedMs: snap.durationMs, activeMs: snap.activeReadingMs } })
    if (Date.now() - this.lastPersistAt >= PERSIST_EVERY_MS) void this.persistCurrent()
  }

  private async persistCurrent() {
    if (!this.recorder) return
    this.lastPersistAt = Date.now()
    try { await saveCurrentSession(this.kv, this.recorder.snapshot()) } catch { /* retried next tick */ }
  }

  async startReading(): Promise<void> {
    if (!canStartReading(this.state) || !this.state.validation) return
    // Same per-user baseline as the web app's eye-tracking mode (stored per origin)
    this.estimator = new AttentionEstimator({
      columnWidthPx: 660,
      model: DEFAULT_MODEL,
      initialStats: loadBaseline(DEFAULT_MODEL) ?? undefined,
    })
    const rec = new SessionRecorder({ calibration: this.state.validation, modelCvRocAuc: modelJson.training.cvRocAuc })
    this.recorder = rec
    if (this.state.pageInfo) rec.enterPage(this.state.pageInfo.host)
    this.set({
      reading: { ...IDLE_READING, status: 'running', startedAt: Date.now() },
      message: '閱讀中。點一下網頁開始讀；切到別的分頁也會繼續記錄。',
    })
    this.updateActive()
    await this.persistCurrent()
  }

  async endReading(): Promise<void> {
    const rec = this.recorder
    if (!rec) return
    this.recorder = null
    const session = rec.end('manual')
    saveBaseline(DEFAULT_MODEL, this.estimator.getStats())
    try {
      const entry = await saveCompletedSession(this.kv, session)
      await clearCurrentSession(this.kv)
      const score = entry.analysis.totalScore
      this.set({
        reading: IDLE_READING,
        message: score === null
          ? '已儲存。資料不足，沒有算出專注度（至少要 3 個有效視窗）。打開 FlowFinder 網頁版就會同步。'
          : `已儲存：專注度 ${score}%。打開 FlowFinder 網頁版就會同步到 Dashboard。`,
      })
    } catch (err) {
      this.set({ reading: IDLE_READING, message: '儲存失敗：' + (err instanceof Error ? err.message : String(err)) })
    }
    await this.refreshHistory()
  }

  // ── Actions ─────────────────────────────────────────────────────────
  openPermissionPage(): void {
    void chrome.tabs.create({ url: chrome.runtime.getURL('permission/index.html') })
  }

  async start(): Promise<void> {
    if (this.state.camera === 'starting' || this.state.camera === 'on') return
    this.set({ camera: 'starting', cameraError: '', message: '啟動中…（第一次載入模型要幾秒）' })
    try {
      await this.tracker.begin()
      this.set({ camera: 'on', message: '追蹤中。把臉放在框框中間，然後按「校準＋驗證」。' })
      this.setPreview(true)
    } catch (err) {
      const e = parseGazeError(err)
      this.set({
        camera: 'error',
        cameraError: `${e.kind}: ${e.message}`,
        message: e.kind === 'permission_denied' ? '沒有攝影機權限 → 先按「① 授權攝影機」' : '啟動失敗：' + e.message,
      })
    }
    await this.connectActiveTab()
  }

  async calibrate(): Promise<void> {
    await this.connectActiveTab()
    if (!this.port) { this.set({ message: '沒有連上網頁。請切到一般網頁再試。' }); return }
    await this.tracker.clearCalibration()
    this.set({ calibrating: true, calibClicks: 0, validation: null, message: '到左邊網頁，看著紅點並點擊。' })
    this.post({ type: 'calib_start', points: CALIBRATION_POINTS, clicksPerPoint: CLICKS_PER_POINT })
  }

  setPreview(on: boolean): void {
    this.tracker.showPreview(on)
    this.set({ previewOn: on })
  }

  setGazeDot(on: boolean): void {
    this.post({ type: 'gaze_dot', visible: on })
    this.set({ dotOn: on })
  }

  setWebApp(accuracyPx: number | null, precisionPx: number | null): void {
    const ok = accuracyPx !== null && precisionPx !== null && accuracyPx > 0 && precisionPx > 0
    this.set({ webApp: ok ? { accuracyPx, precisionPx } : null })
  }

  setManual(patch: Partial<PanelState['manual']>): void {
    this.set({ manual: { ...this.state.manual, ...patch } })
  }

  private async runValidation() {
    this.set({ message: '驗證中… 看著藍點就好，不用點。' })
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const targets: { x: number; y: number }[] = []
    const samples: GazeSample[][] = []
    for (let i = 0; i < VALIDATION_POINTS.length; i++) {
      const target = await new Promise<{ x: number; y: number } | null>(resolve => {
        this.pendingTarget = resolve
        this.post({ type: 'validation_point', index: i, point: VALIDATION_POINTS[i] })
        setTimeout(() => {
          if (this.pendingTarget === resolve) { this.pendingTarget = null; resolve(null) }
        }, 2000)
      })
      const start = performance.now() + VALIDATION_SETTLE_MS
      const collect = { start, end: start + VALIDATION_COLLECT_MS, samples: [] as GazeSample[] }
      this.collect = collect
      await sleep(VALIDATION_SETTLE_MS + VALIDATION_COLLECT_MS)
      targets.push(target ?? { x: NaN, y: NaN })
      samples.push(target ? collect.samples : [])
      this.collect = null
    }
    this.post({ type: 'overlay_clear' })
    const v = summarizeValidation(
      targets,
      samples,
      { width: this.state.pageInfo?.innerWidth ?? 0, height: this.state.pageInfo?.innerHeight ?? 0 },
      Date.now(),
    )
    this.set({
      calibrating: false,
      validation: v,
      message: `校準完成：${v.quality}，accuracy ${fmt(v.accuracyPx)} px、precision ${fmt(v.precisionPx)} px`,
    })
  }

  buildReport() {
    const s = this.state
    const med = (xs: number[]) => quantile(xs, 0.5)
    return {
      kind: 'flowfinder-extension-phase0',
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      checks: computeChecks(s).map(({ label, verdict, detail }) => ({ label, verdict, detail })),
      rates: {
        pageFocused: summarizeRates(this.ratesByBucket.page),
        panelFocused: summarizeRates(this.ratesByBucket.panel),
        otherFocused: summarizeRates(this.ratesByBucket.other),
      },
      missingRatioMedian: {
        pageFocused: med(this.missingByBucket.page),
        panelFocused: med(this.missingByBucket.panel),
      },
      calibration: {
        extension: s.validation,
        webApp: s.webApp,
        fittedMap: this.calibrationMap,
        zoomAtCalibration: this.calibrationZoom,
      },
      page: s.pageInfo && { ...s.pageInfo, host: undefined }, // no hostnames in the report
      zoom: s.zoom,
      panelDevicePixelRatio: window.devicePixelRatio,
      externalRequests: externalUrls(this.resourceUrls),
      manual: s.manual,
    }
  }
}
