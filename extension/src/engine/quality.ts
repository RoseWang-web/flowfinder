/**
 * quality.ts — Guard against webcam noise being read as "focused reading".
 *
 * Why: x_progress sums every rightward step of the gaze trace, so jitter
 * inflates it, and more line returns / more progress means "more focused" to
 * the model. With the same steady reading, noise growing from 40 to 160 px
 * pushed the estimate from 59 % to 71 % focused (simulation). In the notebook
 * noise was constant per person, so the per-person z-score cancelled it; in
 * real use calibration drifts (posture, head angle, light) during a session.
 *
 * What: estimate the jitter of each 10-second window and compare it with the
 * jitter right after calibration. Windows that are much noisier are not scored
 * (and never reach the per-user baseline). If most recent windows are noisy,
 * tracking is "degraded" and the UI offers a recalibration.
 */
import type { GazeSample } from '@core/attentionModel'

/**
 * Per-axis noise σ (px) from consecutive predictions.
 * For Gaussian noise σ, a difference of two samples has σ·√2, and
 * median(|d|) = 0.6745·σ·√2 ≈ 0.954·σ. Reading moves only a few px per frame
 * and line returns are rare, so the median ignores them.
 */
export function estimateJitterPx(samples: readonly GazeSample[], maxGapMs = 50): number | null {
  const d: number[] = []
  let prev: GazeSample | null = null
  for (const s of samples) {
    if (s.x === null || s.y === null) { prev = null; continue }
    if (prev && prev.x !== null && prev.y !== null && s.t - prev.t <= maxGapMs) {
      d.push(Math.abs(s.x - prev.x), Math.abs(s.y - prev.y))
    }
    prev = s
  }
  if (d.length < 40) return null // < ~1 s of valid pairs: cannot tell
  d.sort((a, b) => a - b)
  const mid = d.length >> 1
  const median = d.length % 2 ? d[mid] : (d[mid - 1] + d[mid]) / 2
  return median / 0.954
}

export const QUALITY = {
  /** Noisy when jitter exceeds the post-calibration level by this factor… */
  ratio: 1.6,
  /** …and is above this floor (tiny baselines would flag harmless changes) */
  floorPx: 30,
  /** Always noisy above this (worse than the 'usable' calibration grade) */
  absoluteMaxPx: 110,
  /** Windows used to learn the post-calibration jitter level */
  baselineWindows: 5,
  /** Degraded when this many of the last `recentWindows` windows were noisy */
  degradedNoisy: 5,
  recentWindows: 8,
} as const

export type Verdict = 'ok' | 'noisy' | 'unknown'

export class JitterGuard {
  private learned: number[] = []
  private recent: boolean[] = []

  /** Post-calibration jitter level (median of the first windows), null while learning. */
  get baselinePx(): number | null {
    if (this.learned.length < QUALITY.baselineWindows) return null
    const s = [...this.learned].sort((a, b) => a - b)
    return s[s.length >> 1]
  }

  assess(jitterPx: number | null): Verdict {
    if (jitterPx === null) return 'unknown'
    const base = this.baselinePx
    const noisy =
      jitterPx > QUALITY.absoluteMaxPx ||
      (base !== null && jitterPx > QUALITY.floorPx && jitterPx > base * QUALITY.ratio)
    this.recent.push(noisy)
    if (this.recent.length > QUALITY.recentWindows) this.recent.shift()
    return noisy ? 'noisy' : 'ok'
  }

  /** Feed the jitter of a window that was scored normally (builds the baseline). */
  learn(jitterPx: number | null): void {
    if (jitterPx !== null && this.learned.length < QUALITY.baselineWindows) this.learned.push(jitterPx)
  }

  get degraded(): boolean {
    return this.recent.filter(Boolean).length >= QUALITY.degradedNoisy
  }

  /** After a recalibration: learn the new level from scratch. */
  reset(): void {
    this.learned = []
    this.recent = []
  }
}
