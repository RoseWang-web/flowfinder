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
  good: { label: '良好', note: '追蹤品質足以估計閱讀專注度。' },
  usable: { label: '可用', note: '追蹤品質偏低，專注度估計會比較不準。' },
  poor: { label: '不足', note: '追蹤品質太低，無法估計專注度。可以調整光線或坐姿後重新校準。' },
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
      <div className="gaze-overlay" role="dialog" aria-modal="true" aria-label="眼動校準">
        <div className="gaze-card gaze-card-intro">
          <h2 className="gaze-title">眼動校準</h2>
          <p className="gaze-text">請把臉放在上方預覽的框內，保持頭部大致不動。</p>
          <ol className="gaze-steps">
            <li>畫面上會依序出現 {CALIBRATION_POINTS.length} 個點，請<strong>看著點</strong>並點擊 {CLICKS_PER_POINT} 次。</li>
            <li>接著會出現 {VALIDATION_POINTS.length} 個點，<strong>只要看著它</strong>，不用點擊，用來測量準確度。</li>
          </ol>
          <p className="gaze-note">影像只在你的瀏覽器裡處理，不會上傳或保存。</p>
          <div className="gaze-actions">
            <button className="btn btn-primary" onClick={startCalibration}>開始校準</button>
            <button className="btn btn-ghost" onClick={onCancel}>取消</button>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'calibrating') {
    const target = toPixels(CALIBRATION_POINTS[phase.point], viewport)
    return (
      <div className="gaze-overlay gaze-overlay-points" role="dialog" aria-modal="true" aria-label="眼動校準">
        <p className="gaze-progress">
          校準 {phase.point + 1} / {CALIBRATION_POINTS.length}：看著點並點擊（還剩 {CLICKS_PER_POINT - phase.clicks} 次）
        </p>
        <button
          className="gaze-point"
          style={{ left: target.x, top: target.y, opacity: 0.4 + (0.6 * (phase.clicks + 1)) / CLICKS_PER_POINT }}
          onClick={handlePointClick}
          aria-label={`校準點 ${phase.point + 1}`}
        />
        <button className="btn btn-ghost btn-small gaze-cancel" onClick={onCancel}>取消</button>
      </div>
    )
  }

  if (phase.kind === 'validating') {
    const target = toPixels(VALIDATION_POINTS[phase.point], viewport)
    return (
      <div className="gaze-overlay gaze-overlay-points" role="dialog" aria-modal="true" aria-label="眼動驗證">
        <p className="gaze-progress">
          驗證 {phase.point + 1} / {VALIDATION_POINTS.length}：只要看著點，不用點擊
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
    <div className="gaze-overlay" role="dialog" aria-modal="true" aria-label="校準結果">
      <div className="gaze-card">
        <h2 className="gaze-title">校準結果</h2>
        <p className={`gaze-quality gaze-quality-${summary.quality}`}>追蹤品質：{q.label}</p>
        <p className="gaze-text">{q.note}</p>
        <div className="result-stats">
          <div className="stat-row">
            <span className="stat-label">平均偏差（準確度）</span>
            <span className="stat-value">{fmt(summary.accuracyPx)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">抖動（精確度）</span>
            <span className="stat-value">{fmt(summary.precisionPx)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-label">有偵測到視線的比例</span>
            <span className="stat-value">{Math.round(summary.validRatio * 100)}%</span>
          </div>
        </div>
        <div className="gaze-actions">
          {summary.quality !== 'poor' && (
            <button className="btn btn-primary" onClick={() => onComplete(summary)}>開始閱讀</button>
          )}
          <button className="btn btn-secondary" onClick={startCalibration}>重新校準</button>
          <button className="btn btn-ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
