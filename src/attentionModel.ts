/**
 * attentionModel.ts — Mind-wandering score from webcam gaze during reading.
 *
 * Pure logic, no React, no DOM, no camera. It mirrors "Part 2/3" of the
 * training notebook (notebook.ipynb in the parent folder):
 *
 *   gaze samples (any rate, px)
 *     → resample to 30 Hz on a fixed grid        (notebook: downsample)
 *     → centered moving average, 0.2 s           (notebook: smooth)
 *     → features for one 10 s window             (notebook: webcam_windows_one_file)
 *         nLineReturns: x drops by > lineReturnPx within 0.5 s (onsets only)
 *         xProgress:    total rightward movement / window seconds (px/s)
 *     → per-user online z-score                  (notebook: z-score by subject)
 *     → logistic score                           (weights from model.json)
 *
 * The score is a RANKING (class_weight="balanced" in training), not a
 * calibrated probability: use it for trends and comparisons.
 */

import modelJson from './model.json'

// ── Types ─────────────────────────────────────────────────────────────────

export interface GazeSample {
  /** Timestamp in ms (e.g. performance.now()); samples must arrive in increasing order */
  t: number
  /** Screen x in px, or null when the tracker had no prediction (no face, blink, …) */
  x: number | null
  y: number | null
}

export interface ModelParams {
  sampleHz: number
  windowSeconds: number
  stepSeconds: number
  smoothSeconds: number
  lineReturnLookbackSeconds: number
  /** Line return threshold as a fraction of the reading column width */
  lineReturnColumnFraction: number
  /** A grid point with no sample within this many ms counts as missing */
  maxGapMs: number
  /** Windows with more missing samples than this are skipped */
  maxMissingRatio: number
  /** Windows needed before z-scores are trusted */
  warmupWindows: number
  /** Number of recent window scores averaged into the trend */
  trendWindows: number
}

export interface AttentionModel {
  features: string[]
  weights: number[]
  intercept: number
  params: ModelParams
}

export const DEFAULT_MODEL: AttentionModel = modelJson as AttentionModel

export interface WindowFeatures {
  nLineReturns: number
  /** px per second */
  xProgress: number
  missingRatio: number
}

// ── Step 1: resample ──────────────────────────────────────────────────────

/** First index i with samples[i].t >= t (binary search; like numpy searchsorted). */
function searchSorted(samples: readonly GazeSample[], t: number): number {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (samples[mid].t < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Put irregular samples on a fixed grid: grid point g takes the first sample
 * at or after g (same rule as the notebook's downsample). If that sample is
 * more than maxGapMs away, or has no x, the grid point is null.
 */
export function resampleX(
  samples: readonly GazeSample[],
  gridStartMs: number,
  count: number,
  hz: number,
  maxGapMs: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(count)
  const dt = 1000 / hz
  let idx = searchSorted(samples, gridStartMs)
  for (let i = 0; i < count; i++) {
    const g = gridStartMs + i * dt
    while (idx < samples.length && samples[idx].t < g) idx++
    const s = samples[idx]
    out[i] = s !== undefined && s.t - g <= maxGapMs ? s.x : null
  }
  return out
}

// ── Step 2: smooth ────────────────────────────────────────────────────────

/**
 * Centered moving average that ignores nulls, identical to pandas
 * rolling(k, center=True, min_periods=1).mean(). For even k the window is
 * [i - k/2, i + k/2 - 1].
 */
export function smoothCentered(xs: readonly (number | null)[], k: number): (number | null)[] {
  const half = Math.floor(k / 2)
  const out: (number | null)[] = new Array(xs.length)
  for (let i = 0; i < xs.length; i++) {
    let sum = 0
    let n = 0
    const lo = Math.max(0, i - half)
    const hi = Math.min(xs.length - 1, i + k - 1 - half)
    for (let j = lo; j <= hi; j++) {
      const v = xs[j]
      if (v !== null) { sum += v; n++ }
    }
    out[i] = n > 0 ? sum / n : null
  }
  return out
}

// ── Step 3: features for one window ───────────────────────────────────────

export interface FeatureConfig {
  hz: number
  smoothSamples: number
  lagSamples: number
  lineReturnPx: number
  windowSeconds: number
}

export function featureConfig(params: ModelParams, columnWidthPx: number): FeatureConfig {
  return {
    hz: params.sampleHz,
    smoothSamples: Math.max(1, Math.round(params.smoothSeconds * params.sampleHz)),
    lagSamples: Math.round(params.lineReturnLookbackSeconds * params.sampleHz),
    lineReturnPx: params.lineReturnColumnFraction * columnWidthPx,
    windowSeconds: params.windowSeconds,
  }
}

/**
 * Samples needed before the window starts, so the first samples of the
 * window see the same history as in the notebook (which computed over the
 * whole segment): the lookback lag, half the smoother, and one diff.
 */
export function marginSamples(cfg: FeatureConfig): number {
  return cfg.lagSamples + Math.floor(cfg.smoothSamples / 2) + 1
}

/**
 * Features for one window. `xs` is the resampled x series covering
 * [margin + window]; the window itself starts at `windowStartIndex`.
 */
export function computeWindowFeatures(
  xs: readonly (number | null)[],
  windowStartIndex: number,
  cfg: FeatureConfig,
): WindowFeatures {
  const sm = smoothCentered(xs, cfg.smoothSamples)
  const lag = cfg.lagSamples

  const isReturnAt = (i: number): boolean => {
    if (i < lag) return false
    const a = sm[i]
    const b = sm[i - lag]
    return a !== null && b !== null && a - b < -cfg.lineReturnPx
  }

  let nLineReturns = 0
  let rightward = 0
  let missing = 0
  for (let i = windowStartIndex; i < xs.length; i++) {
    // Count the onset of each return, not every sample of it
    if (isReturnAt(i) && !isReturnAt(i - 1)) nLineReturns++

    const cur = sm[i]
    const prev = i > 0 ? sm[i - 1] : null
    if (cur !== null && prev !== null && cur > prev) rightward += cur - prev

    if (xs[i] === null) missing++
  }

  const windowLength = xs.length - windowStartIndex
  return {
    nLineReturns,
    xProgress: rightward / cfg.windowSeconds,
    missingRatio: windowLength > 0 ? missing / windowLength : 1,
  }
}

/** Resample + features for the window that ends at windowEndMs. */
export function extractWindowFeatures(
  samples: readonly GazeSample[],
  windowEndMs: number,
  cfg: FeatureConfig,
  maxGapMs: number,
): WindowFeatures {
  const windowCount = Math.round(cfg.windowSeconds * cfg.hz)
  const margin = marginSamples(cfg)
  const dt = 1000 / cfg.hz
  const gridStart = windowEndMs - windowCount * dt - margin * dt
  const xs = resampleX(samples, gridStart, margin + windowCount, cfg.hz, maxGapMs)
  return computeWindowFeatures(xs, margin, cfg)
}

// ── Step 4: per-user online z-score ───────────────────────────────────────

/** Running mean / sample std (ddof = 1, like pandas) with Welford's algorithm. */
export class OnlineStats {
  n = 0
  mean = 0
  private m2 = 0

  update(x: number): void {
    this.n++
    const d = x - this.mean
    this.mean += d / this.n
    this.m2 += d * (x - this.mean)
  }

  get std(): number {
    return this.n < 2 ? NaN : Math.sqrt(this.m2 / (this.n - 1))
  }

  /** z-score of x; 0 when the std is not usable yet (or is zero). */
  z(x: number): number {
    const s = this.std
    return Number.isFinite(s) && s > 0 ? (x - this.mean) / s : 0
  }

  toJSON(): { n: number; mean: number; m2: number } {
    return { n: this.n, mean: this.mean, m2: this.m2 }
  }

  static fromJSON(v: { n: number; mean: number; m2: number }): OnlineStats {
    const s = new OnlineStats()
    s.n = v.n
    s.mean = v.mean
    s.m2 = v.m2
    return s
  }
}

// ── Step 5: score ─────────────────────────────────────────────────────────

/** Logistic score in (0, 1); higher = more likely mind wandering. */
export function mwScore(z: readonly number[], model: AttentionModel = DEFAULT_MODEL): number {
  let s = model.intercept
  for (let i = 0; i < model.weights.length; i++) s += model.weights[i] * z[i]
  return 1 / (1 + Math.exp(-s))
}

// ── Putting it together ───────────────────────────────────────────────────

export type AttentionResult =
  | { status: 'low_quality'; features: WindowFeatures }
  | { status: 'warming_up'; features: WindowFeatures; windowsSeen: number; windowsNeeded: number }
  | {
      status: 'ok'
      features: WindowFeatures
      z: number[]
      /** Score of this window alone (noisy) */
      score: number
      /** Mean score of the last `trendWindows` windows (use this in the UI) */
      trend: number
    }

export interface AttentionEstimatorOptions {
  /** Width of the reading column in px (line return threshold scales with it) */
  columnWidthPx: number
  model?: AttentionModel
  /** Stats from earlier sessions of the same user, to skip most of the warm-up */
  initialStats?: { nLineReturns: OnlineStats; xProgress: OnlineStats }
}

/**
 * Streaming estimator. Feed every gaze sample with addSample(); call
 * evaluate(now) once per step (every params.stepSeconds).
 */
export class AttentionEstimator {
  readonly model: AttentionModel
  private cfg: FeatureConfig
  private samples: GazeSample[] = []
  private stats: { nLineReturns: OnlineStats; xProgress: OnlineStats }
  private recentScores: number[] = []

  constructor(options: AttentionEstimatorOptions) {
    this.model = options.model ?? DEFAULT_MODEL
    this.cfg = featureConfig(this.model.params, options.columnWidthPx)
    this.stats = options.initialStats ?? {
      nLineReturns: new OnlineStats(),
      xProgress: new OnlineStats(),
    }
  }

  /** Change the column width (e.g. on window resize). */
  setColumnWidth(columnWidthPx: number): void {
    this.cfg = featureConfig(this.model.params, columnWidthPx)
  }

  addSample(sample: GazeSample): void {
    const last = this.samples[this.samples.length - 1]
    if (last && sample.t <= last.t) return // keep timestamps strictly increasing
    this.samples.push(sample)
  }

  evaluate(nowMs: number): AttentionResult {
    const p = this.model.params
    this.trim(nowMs)

    const features = extractWindowFeatures(this.samples, nowMs, this.cfg, p.maxGapMs)
    if (features.missingRatio > p.maxMissingRatio) {
      return { status: 'low_quality', features }
    }

    // Update the user's baseline first (training z-scored over all of a subject's windows)
    this.stats.nLineReturns.update(features.nLineReturns)
    this.stats.xProgress.update(features.xProgress)

    const seen = this.stats.xProgress.n
    if (seen < p.warmupWindows) {
      return { status: 'warming_up', features, windowsSeen: seen, windowsNeeded: p.warmupWindows }
    }

    const z = [
      this.stats.nLineReturns.z(features.nLineReturns),
      this.stats.xProgress.z(features.xProgress),
    ]
    const score = mwScore(z, this.model)

    this.recentScores.push(score)
    if (this.recentScores.length > p.trendWindows) this.recentScores.shift()
    const trend = this.recentScores.reduce((a, b) => a + b, 0) / this.recentScores.length

    return { status: 'ok', features, z, score, trend }
  }

  /** The user's baseline, to save and pass back as initialStats next session. */
  getStats(): { nLineReturns: OnlineStats; xProgress: OnlineStats } {
    return this.stats
  }

  /** Forget buffered samples and the trend (e.g. after a pause); keeps the baseline. */
  clearBuffer(): void {
    this.samples = []
    this.recentScores = []
  }

  /** Drop samples older than the window + margin (+1 s slack). */
  private trim(nowMs: number): void {
    const keepMs =
      (this.cfg.windowSeconds + (marginSamples(this.cfg) + 1) / this.cfg.hz + 1) * 1000
    const cutoff = nowMs - keepMs
    let i = 0
    while (i < this.samples.length && this.samples[i].t < cutoff) i++
    if (i > 0) this.samples.splice(0, i)
  }
}
