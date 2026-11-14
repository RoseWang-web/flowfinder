import { useEffect, useRef, useState } from 'react'
import {
  CALIBRATION_POINTS,
  CLICKS_PER_POINT,
  VALIDATION_COLLECT_MS,
  VALIDATION_POINTS,
  VALIDATION_SETTLE_MS,
  summarizeValidation,
  toPixels,
} from './calibration'
import type { GazeSample } from './attentionModel'
import type { GazeTracker } from './gaze'
import type { CalibrationSummary, GazeQuality } from './types'

type Phase =
  | { kind: 'intro' }
  | { kind: 'calibrating'; point: number; clicks: number }
  | { kind: 'validating'; point: number }
  | { kind: 'result'; summary: CalibrationSummary }

const QUALITY_TEXT: Record<GazeQuality, { label: string; note: string }> = {
  good: { label: 'Good', note: 'Tracking quality is sufficient for estimating reading attention.' },
  usable: { label: 'Usable', note: 'Tracking quality is low; attention estimates may be less accurate.' },
  poor: { label: 'Poor', note: 'Tracking quality is too low to estimate attention. Try adjusting lighting or posture and recalibrate.' },
}

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight }
}

export interface GazeCalibrationProps {
  tracker: GazeTracker
  /** Called when the user accepts a usable calibration */
  onComplete: (summary: CalibrationSummary) => void
  onCancel: () => void
  now?: () => number
}

export function GazeCalibration({ tracker, onComplete, onCancel, now = () => performance.now() }: GazeCalibrationProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' })
  const [viewport] = useState(viewportSize)
  const nowRef = useRef(now)
  nowRef.current = now

  // Preview helps positioning the face; hide it once the points start
  useEffect(() => {
    tracker.showPreview(phase.kind === 'intro')
  }, [phase.kind, tracker])

  // ── Validation: show each point, collect predictions after a settle delay ──
  const validationSamples = useRef<GazeSample[][]>([])
  useEffect(() => {
    if (phase.kind !== 'validating') return
    const index = phase.point
    const startedAt = nowRef.current()
    const from = startedAt + VALIDATION_SETTLE_MS
    const to = from + VALIDATION_COLLECT_MS
    const bucket: GazeSample[] = []
    validationSamples.current[index] = bucket

    const unsubscribe = tracker.addListener(s => {
      if (s.t >= from && s.t <= to) bucket.push(s)
    })
    const timer = setTimeout(() => {
      unsubscribe()
      if (index + 1 < VALIDATION_POINTS.length) {
        setPhase({ kind: 'validating', point: index + 1 })
      } else {
        const targets = VALIDATION_POINTS.map(p => toPixels(p, viewport))
        const summary = summarizeValidation(targets, validationSamples.current, viewport, Date.now())
        setPhase({ kind: 'result', summary })
      }
    }, VALIDATION_SETTLE_MS + VALIDATION_COLLECT_MS)

    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [phase, tracker, viewport])

  const startCalibration = async () => {
    await tracker.clearCalibration()
    validationSamples.current = []
    setPhase({ kind: 'calibrating', point: 0, clicks: 0 })
  }

  const handlePointClick = () => {
    if (phase.kind !== 'calibrating') return
    const target = toPixels(CALIBRATION_POINTS[phase.point], viewport)
    // Train on the point's centre (where the user is looking), not the exact click position
    tracker.recordCalibrationPoint(target.x, target.y)
    const clicks = phase.clicks + 1
    if (clicks < CLICKS_PER_POINT) {
      setPhase({ ...phase, clicks })
    } else if (phase.point + 1 < CALIBRATION_POINTS.length) {
      setPhase({ kind: 'calibrating', point: phase.point + 1, clicks: 0 })
    } else {
      setPhase({ kind: 'validating', point: 0 })
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  if (phase.kind === 'intro') {
    return (
      <div className="gaze-overlay" role="dialog" aria-modal="true" aria-label="Eye tracking calibration">
        <div className="gaze-card gaze-card-intro">
          <h2 className="gaze-title">Eye Tracking Calibration</h2>
          <p className="gaze-text">Keep your face inside the preview frame above and hold your head fairly still.</p>
          <ol className="gaze-steps">
            <li>{CALIBRATION_POINTS.length} points will appear in sequence. <strong>Look at each point</strong> and click it {CLICKS_PER_POINT} times.</li>
            <li>Then {VALIDATION_POINTS.length} validation points will appear. <strong>Just look at each one</strong> — no clicking needed.</li>
          </ol>
          <p className="gaze-note">Video is processed locally in your browser and never uploaded or saved.</p>
          <div className="gaze-actions">
            <button className="btn btn-primary" onClick={startCalibration}>Start Calibration</button>
            <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'calibrating') {
    const target = toPixels(CALIBRATION_POINTS[phase.point], viewport)
    return (
      <div className="gaze-overlay gaze-overlay-points" role="dialog" aria-modal="true" aria-label="Eye tracking calibration">
        <p className="gaze-progress">
          Calibration {phase.point + 1} / {CALIBRATION_POINTS.length}: look at the dot and click ({CLICKS_PER_POINT - phase.clicks} clicks left)
        </p>
        <button
          className="gaze-point"
          style={{ left: target.x, top: target.y, opacity: 0.4 + (0.6 * (phase.clicks + 1)) / CLICKS_PER_POINT }}
          onClick={handlePointClick}
          aria-label={`Calibration point ${phase.point + 1}`}
        />
        <button className="btn btn-ghost btn-small gaze-cancel" onClick={onCancel}>Cancel</button>
      </div>
    )
  }

  if (phase.kind === 'validating') {
    const target = toPixels(VALIDATION_POINTS[phase.point], viewport)
    return (
      <div className="gaze-overlay gaze-overlay-points" role="dialog" aria-modal="true" aria-label="Eye tracking validation">
        <p className="gaze-progress">
          Validation {phase.point + 1} / {VALIDATION_POINTS.length}: just look at the dot — no clicking needed
        </p>
        <div
          className="gaze-point gaze-point-validate"
          style={{ left: target.x, top: target.y }}
          data-testid="validation-point"
        />
      </div>
    )
  }

  const { summary } = phase
  const q = QUALITY_TEXT[summary.quality]
  const fmt = (v: number | null) => (v === null ? '—' : `${Math.round(v)} px`)
  return (
    <div className="gaze-overlay" role="dialog" aria-modal="true" aria-label="Calibration result">
      <div className="gaze-card">
        <h2 className="gaze-title">Calibration Result</h2>
        <p className={`gaze-quality gaze-quality-${summary.quality}`}>Tracking quality: {q.label}</p>
        <p className="gaze-text">{q.note}</p>
        <div className="result-stats">
          <div className="stat-row">
            <span className="stat-label">Avg offset (accuracy)</span>
            <span className="stat-value">{fmt(summary.accuracyPx)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Jitter (precision)</span>
            <span className="stat-value">{fmt(summary.precisionPx)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">Gaze detected ratio</span>
            <span className="stat-value">{Math.round(summary.validRatio * 100)}%</span>
          </div>
        </div>
        <div className="gaze-actions">
          {summary.quality !== 'poor' && (
            <button className="btn btn-primary" onClick={() => onComplete(summary)}>Start Reading</button>
          )}
          <button className="btn btn-secondary" onClick={startCalibration}>Recalibrate</button>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
