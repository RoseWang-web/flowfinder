/**
 * useGaze.ts — Eye-tracking mode lifecycle.
 *
 *   idle ──startTracker()──▶ starting ──▶ calibrating ──completeCalibration()──▶ ready
 *   ready/paused ──session running──▶ active   (feeds the AttentionEstimator, scores every step)
 *   active ──session paused / checking_in──▶ paused
 *   active/paused ──session completed / idle──▶ idle   (camera released, baseline saved)
 *
 * The camera is owned by WebGazer in this mode; useCamera stays off.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AttentionEstimator,
  DEFAULT_MODEL,
  OnlineStats,
  type AttentionModel,
  type AttentionResult,
} from './attentionModel'
import { createWebGazerTracker, parseGazeError, type GazeTracker } from './gaze'
import type { CameraError } from './camera'
import type { EventType, SessionStatus } from './types'

export type GazeStatus = 'idle' | 'starting' | 'calibrating' | 'ready' | 'active' | 'paused' | 'error'

export interface UseGazeOptions {
  sessionStatus: SessionStatus
  onSessionEvent: (type: EventType, data?: Record<string, unknown>) => void
  /** Current reading column width in px (line-return threshold scales with it) */
  getColumnWidth: () => number
  tracker?: GazeTracker
  model?: AttentionModel
  /** Clock for sample timestamps and evaluation; must match the tracker's clock */
  now?: () => number
}

export interface GazeState {
  gazeStatus: GazeStatus
  gazeError: CameraError | null
  tracker: GazeTracker
  /** Most recent estimate (null before the first step) */
  latest: AttentionResult | null
  /** Whether a saved baseline from earlier sessions was loaded */
  usedSavedBaseline: boolean
  startTracker: () => Promise<boolean>
  completeCalibration: () => void
  cancel: () => void
  setGazeDotVisible: (visible: boolean) => void
}

// ── Baseline persistence (per-user z-score stats, numbers only) ────────────

const BASELINE_KEY = 'flowfinder_gaze_baseline_v1'

interface StoredBaseline {
  version: 1
  /** Baseline only valid for the same model weights */
  weights: number[]
  nLineReturns: { n: number; mean: number; m2: number }
  xProgress: { n: number; mean: number; m2: number }
}

export function loadBaseline(model: AttentionModel): { nLineReturns: OnlineStats; xProgress: OnlineStats } | null {
  try {
    const raw = localStorage.getItem(BASELINE_KEY)
    if (!raw) return null
    const b = JSON.parse(raw) as StoredBaseline
    if (b.version !== 1 || JSON.stringify(b.weights) !== JSON.stringify(model.weights)) return null
    const ok = (s: unknown) =>
      typeof s === 'object' && s !== null &&
      ['n', 'mean', 'm2'].every(k => typeof (s as Record<string, unknown>)[k] === 'number')
    if (!ok(b.nLineReturns) || !ok(b.xProgress)) return null
    return {
      nLineReturns: OnlineStats.fromJSON(b.nLineReturns),
      xProgress: OnlineStats.fromJSON(b.xProgress),
    }
  } catch {
    return null
  }
}

export function saveBaseline(model: AttentionModel, stats: { nLineReturns: OnlineStats; xProgress: OnlineStats }): void {
  if (stats.xProgress.n === 0) return
  const b: StoredBaseline = {
    version: 1,
    weights: [...model.weights],
    nLineReturns: stats.nLineReturns.toJSON(),
    xProgress: stats.xProgress.toJSON(),
  }
  try { localStorage.setItem(BASELINE_KEY, JSON.stringify(b)) } catch { /* storage full: skip */ }
}

export function clearBaseline(): void {
  try { localStorage.removeItem(BASELINE_KEY) } catch { /* ignore */ }
}

/** Compact, JSON-safe event payload */
export function attentionEventData(r: AttentionResult): Record<string, unknown> {
  const base = {
    status: r.status,
    nLineReturns: r.features.nLineReturns,
    xProgress: Math.round(r.features.xProgress * 10) / 10,
    missingRatio: Math.round(r.features.missingRatio * 1000) / 1000,
  }
  if (r.status !== 'ok') return base
  return {
    ...base,
    score: Math.round(r.score * 1000) / 1000,
    trend: Math.round(r.trend * 1000) / 1000,
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useGaze(options: UseGazeOptions): GazeState {
  const { sessionStatus } = options
  const model = options.model ?? DEFAULT_MODEL

  const trackerRef = useRef<GazeTracker>(options.tracker ?? createWebGazerTracker())
  const nowRef = useRef(options.now ?? (() => performance.now()))
  const onEventRef = useRef(options.onSessionEvent)
  onEventRef.current = options.onSessionEvent
  const getWidthRef = useRef(options.getColumnWidth)
  getWidthRef.current = options.getColumnWidth

  const [gazeStatus, setGazeStatus] = useState<GazeStatus>('idle')
  const statusRef = useRef<GazeStatus>('idle')
  const [gazeError, setGazeError] = useState<CameraError | null>(null)
  const [latest, setLatest] = useState<AttentionResult | null>(null)
  const [usedSavedBaseline, setUsedSavedBaseline] = useState(false)

  const estimatorRef = useRef<AttentionEstimator | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  const setStatus = useCallback((s: GazeStatus) => {
    statusRef.current = s
    setGazeStatus(s)
  }, [])

  const stopInterval = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const tick = useCallback(() => {
    const est = estimatorRef.current
    if (!est) return
    const width = getWidthRef.current()
    if (width > 0) est.setColumnWidth(width)
    const r = est.evaluate(nowRef.current())
    setLatest(r)
    onEventRef.current('attention_score', attentionEventData(r))
  }, [])

  const shutdown = useCallback((saveStats: boolean) => {
    stopInterval()
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    if (saveStats && estimatorRef.current) saveBaseline(model, estimatorRef.current.getStats())
    estimatorRef.current = null
    trackerRef.current.end()
  }, [stopInterval, model])

  // ── Public actions ────────────────────────────────────────────────────

  const startTracker = useCallback(async (): Promise<boolean> => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return false
    setGazeError(null)
    setStatus('starting')
    try {
      await trackerRef.current.begin()
    } catch (err) {
      setGazeError(parseGazeError(err))
      setStatus('error')
      return false
    }
    trackerRef.current.showPreview(true)
    setStatus('calibrating')
    return true
  }, [setStatus])

  const completeCalibration = useCallback(() => {
    if (statusRef.current !== 'calibrating') return
    const tracker = trackerRef.current
    tracker.showPreview(false)
    tracker.pause() // resumed when the session starts running

    const saved = loadBaseline(model)
    setUsedSavedBaseline(saved !== null)
    const est = new AttentionEstimator({
      columnWidthPx: getWidthRef.current() || 660,
      model,
      initialStats: saved ?? undefined,
    })
    estimatorRef.current = est
    unsubscribeRef.current?.()
    unsubscribeRef.current = tracker.addListener(s => estimatorRef.current?.addSample(s))
    setLatest(null)
    setStatus('ready')
  }, [model, setStatus])

  const cancel = useCallback(() => {
    shutdown(false)
    setStatus('idle')
  }, [shutdown, setStatus])

  const setGazeDotVisible = useCallback((visible: boolean) => {
    trackerRef.current.showGazeDot(visible)
  }, [])

  // ── Follow the session ────────────────────────────────────────────────

  useEffect(() => {
    const s = statusRef.current
    const live = s === 'ready' || s === 'active' || s === 'paused'
    if (!live) return

    if (sessionStatus === 'running') {
      trackerRef.current.resume()
      stopInterval()
      intervalRef.current = setInterval(tick, model.params.stepSeconds * 1000)
      setStatus('active')
    } else if (sessionStatus === 'paused' || sessionStatus === 'checking_in') {
      stopInterval()
      trackerRef.current.pause()
      // Windows must not span the pause (or the check-in dialog)
      estimatorRef.current?.clearBuffer()
      setStatus('paused')
    } else if ((sessionStatus === 'completed' || sessionStatus === 'idle') && s !== 'ready') {
      shutdown(true)
      setStatus('idle')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus])

  // ── Cleanup on unmount ────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopInterval()
      unsubscribeRef.current?.()
      trackerRef.current.end()
    }
  }, [stopInterval])

  return {
    gazeStatus,
    gazeError,
    tracker: trackerRef.current,
    latest,
    usedSavedBaseline,
    startTracker,
    completeCalibration,
    cancel,
    setGazeDotVisible,
  }
}
