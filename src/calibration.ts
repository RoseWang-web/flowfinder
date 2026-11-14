/**
 * calibration.ts — Calibration / validation layout and quality grading.
 *
 * Calibration: the user looks at 9 points and clicks each a few times; every
 * click gives WebGazer one training example.
 * Validation: the user looks at 5 *different* points without clicking; we
 * compare predictions with the targets to measure how good tracking is.
 *
 * Two numbers, matching the two noise types in the notebook simulation:
 *   accuracy  = distance from the mean prediction to the target  → offset / drift
 *   precision = RMS spread of predictions around their own mean   → jitter
 *
 * Thresholds assume ~48 px per degree (the ReMind setup):
 *   good   ≈ ≤ 2° (the 'webcam_typical' simulation, AUC ≈ 0.64)
 *   usable ≈ ≤ 3–4° (the 'webcam_poor' simulation, AUC ≈ 0.61)
 *   poor   = worse than anything we simulated → don't show attention scores
 */

import type { GazeSample } from './attentionModel'
import type { CalibrationPointResult, CalibrationSummary, GazeQuality } from './types'

export interface ScreenFraction { fx: number; fy: number }

/** 3×3 grid near the edges */
export const CALIBRATION_POINTS: readonly ScreenFraction[] = [0.1, 0.5, 0.9].flatMap(fy =>
  [0.1, 0.5, 0.9].map(fx => ({ fx, fy })),
)

export const CLICKS_PER_POINT = 3

/** Different from the calibration points, so we test generalisation */
export const VALIDATION_POINTS: readonly ScreenFraction[] = [
  { fx: 0.5, fy: 0.5 },
  { fx: 0.3, fy: 0.3 },
  { fx: 0.7, fy: 0.3 },
  { fx: 0.3, fy: 0.7 },
  { fx: 0.7, fy: 0.7 },
]

/** Ignore the first part of each validation point (the eyes are still moving there) */
export const VALIDATION_SETTLE_MS = 700
export const VALIDATION_COLLECT_MS = 1500

export const QUALITY_THRESHOLDS = {
  good: { accuracyPx: 100, precisionPx: 100 },
  usable: { accuracyPx: 200, precisionPx: 150 },
  /** Below this share of samples with a prediction, tracking is poor no matter what */
  minValidRatio: 0.5,
} as const

export function toPixels(p: ScreenFraction, viewport: { width: number; height: number }): { x: number; y: number } {
  return { x: Math.round(p.fx * viewport.width), y: Math.round(p.fy * viewport.height) }
}

export function pointResult(target: { x: number; y: number }, samples: readonly GazeSample[]): CalibrationPointResult {
  const valid = samples.filter((s): s is GazeSample & { x: number; y: number } => s.x !== null && s.y !== null)
  const base = { x: target.x, y: target.y, nValid: valid.length, n: samples.length }
  if (valid.length === 0) return { ...base, accuracyPx: null, precisionPx: null }

  const mx = valid.reduce((a, s) => a + s.x, 0) / valid.length
  const my = valid.reduce((a, s) => a + s.y, 0) / valid.length
  const accuracyPx = Math.hypot(mx - target.x, my - target.y)
  const precisionPx =
    valid.length < 2
      ? null
      : Math.sqrt(valid.reduce((a, s) => a + (s.x - mx) ** 2 + (s.y - my) ** 2, 0) / valid.length)
  return { ...base, accuracyPx, precisionPx }
}

export function gradeQuality(accuracyPx: number | null, precisionPx: number | null, validRatio: number): GazeQuality {
  const t = QUALITY_THRESHOLDS
  if (accuracyPx === null || precisionPx === null || validRatio < t.minValidRatio) return 'poor'
  if (accuracyPx <= t.good.accuracyPx && precisionPx <= t.good.precisionPx) return 'good'
  if (accuracyPx <= t.usable.accuracyPx && precisionPx <= t.usable.precisionPx) return 'usable'
  return 'poor'
}

function meanOrNull(values: (number | null)[]): number | null {
  // A point without predictions makes the whole summary unusable
  if (values.length === 0 || values.some(v => v === null)) return null
  return (values as number[]).reduce((a, b) => a + b, 0) / values.length
}

export function summarizeValidation(
  targets: readonly { x: number; y: number }[],
  samplesPerTarget: readonly (readonly GazeSample[])[],
  viewport: { width: number; height: number },
  calibratedAt: number,
): CalibrationSummary {
  const points = targets.map((t, i) => pointResult(t, samplesPerTarget[i] ?? []))
  const accuracyPx = meanOrNull(points.map(p => p.accuracyPx))
  const precisionPx = meanOrNull(points.map(p => p.precisionPx))
  const n = points.reduce((a, p) => a + p.n, 0)
  const validRatio = n > 0 ? points.reduce((a, p) => a + p.nValid, 0) / n : 0
  return {
    quality: gradeQuality(accuracyPx, precisionPx, validRatio),
    accuracyPx,
    precisionPx,
    validRatio,
    viewport: { ...viewport },
    points,
    calibratedAt,
  }
}
