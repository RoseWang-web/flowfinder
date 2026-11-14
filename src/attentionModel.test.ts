import { describe, it, expect } from 'vitest'
import {
  AttentionEstimator,
  DEFAULT_MODEL,
  OnlineStats,
  computeWindowFeatures,
  featureConfig,
  mwScore,
  resampleX,
  smoothCentered,
  type GazeSample,
} from './attentionModel'
import parity from './__fixtures__/featureParity.json'

// ── Helpers ───────────────────────────────────────────────────────────────

/** Small seeded RNG so synthetic data is the same on every run */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

const COLUMN_PX = 660

/**
 * Synthetic webcam gaze while reading a 660 px column.
 * `msPerStep` controls reading speed: each step moves 45 px to the right,
 * and after the end of a line the gaze jumps back to the left edge.
 */
function readingTrace(opts: {
  startMs: number
  durationMs: number
  msPerStep: number
  noisePx: number
  seed: number
  hz?: number
}): GazeSample[] {
  const rand = mulberry32(opts.seed)
  const hz = opts.hz ?? 30
  const out: GazeSample[] = []
  let x = 20
  let nextStep = opts.startMs + opts.msPerStep
  for (let t = opts.startMs; t < opts.startMs + opts.durationMs; t += 1000 / hz) {
    while (t >= nextStep) {
      x += 45
      if (x > 640) x = 20
      nextStep += opts.msPerStep
    }
    out.push({ t, x: x + opts.noisePx * gaussian(rand), y: 300 + opts.noisePx * gaussian(rand) })
  }
  return out
}

/** Gaze parked in one spot (staring through the text) */
function staringTrace(startMs: number, durationMs: number, noisePx: number, seed: number): GazeSample[] {
  const rand = mulberry32(seed)
  const out: GazeSample[] = []
  for (let t = startMs; t < startMs + durationMs; t += 1000 / 30) {
    out.push({ t, x: 330 + noisePx * gaussian(rand), y: 300 + noisePx * gaussian(rand) })
  }
  return out
}

// ── Resample ──────────────────────────────────────────────────────────────

describe('resampleX', () => {
  it('takes the first sample at or after each grid point', () => {
    const s: GazeSample[] = [
      { t: 0, x: 1, y: 0 },
      { t: 40, x: 2, y: 0 },
      { t: 70, x: 3, y: 0 },
    ]
    // grid at 0, 33.3, 66.7 ms
    expect(resampleX(s, 0, 3, 30, 100)).toEqual([1, 2, 3])
  })

  it('marks grid points with no nearby sample as missing', () => {
    const s: GazeSample[] = [
      { t: 0, x: 1, y: 0 },
      { t: 500, x: 2, y: 0 },
    ]
    const xs = resampleX(s, 0, 4, 30, 100)
    expect(xs).toEqual([1, null, null, null])
  })

  it('keeps tracker dropouts (x = null) as missing', () => {
    const s: GazeSample[] = [
      { t: 0, x: null, y: null },
      { t: 34, x: 5, y: 0 },
    ]
    expect(resampleX(s, 0, 2, 30, 100)).toEqual([null, 5])
  })
})

// ── Smooth ────────────────────────────────────────────────────────────────

describe('smoothCentered', () => {
  // Expected values from pandas: pd.Series(x).rolling(k, center=True, min_periods=1).mean()
  const x = [0, 1, 2, null, 4, 5, 6, 7, 8, 9]

  it('matches pandas for an even window (k = 6)', () => {
    expect(smoothCentered(x, 6)).toEqual([1.0, 1.0, 1.75, 2.4, 3.6, 4.8, 6.0, 6.5, 7.0, 7.5])
  })

  it('matches pandas for an odd window (k = 5)', () => {
    expect(smoothCentered(x, 5)).toEqual([1.0, 1.0, 1.75, 3.0, 4.25, 5.5, 6.0, 7.0, 7.5, 8.0])
  })

  it('returns null only when the whole window is missing', () => {
    expect(smoothCentered([null, null, null], 2)).toEqual([null, null, null])
  })
})

// ── Features: parity with the notebook ───────────────────────────────────

describe('computeWindowFeatures (parity with notebook)', () => {
  // Fixture made by running the notebook's exact numpy/pandas code on a noisy synthetic trace
  const cfg = {
    hz: parity.hz,
    smoothSamples: parity.smoothSamples,
    lagSamples: parity.lagSamples,
    lineReturnPx: parity.lineReturnPx,
    windowSeconds: parity.windowSeconds,
  }
  const xs = parity.x as (number | null)[]

  it('smooths exactly like pandas', () => {
    const sm = smoothCentered(xs, cfg.smoothSamples)
    parity.expected.smoothed.forEach((v, i) => {
      if (v === null) expect(sm[i]).toBeNull()
      else expect(sm[i]).toBeCloseTo(v, 9)
    })
  })

  it('gives the same features as Python', () => {
    const f = computeWindowFeatures(xs, parity.windowStartIndex, cfg)
    expect(f.nLineReturns).toBe(parity.expected.nLineReturns)
    expect(f.xProgress).toBeCloseTo(parity.expected.xProgress, 6)
    expect(f.missingRatio).toBeCloseTo(parity.expected.missingRatio, 9)
  })
})

describe('computeWindowFeatures (behaviour)', () => {
  const cfg = featureConfig(DEFAULT_MODEL.params, COLUMN_PX)

  it('uses half the column width as the line return threshold', () => {
    expect(cfg.lineReturnPx).toBe(330)
    expect(cfg.smoothSamples).toBe(6)
    expect(cfg.lagSamples).toBe(15)
  })

  it('counts one return per line, not one per sample of the jump', () => {
    // Noise-free: 45 px every 250 ms → a 620 px line takes ~3.5 s → 2–3 returns in 10 s
    const samples = readingTrace({ startMs: 0, durationMs: 11_000, msPerStep: 250, noisePx: 0, seed: 1 })
    const xs = resampleX(samples, 0, 330, 30, 100)
    const f = computeWindowFeatures(xs, 30, cfg)
    expect(f.nLineReturns).toBeGreaterThanOrEqual(2)
    expect(f.nLineReturns).toBeLessThanOrEqual(3)
  })

  it('measures rightward speed in px/s', () => {
    // A steady ramp of 60 px/s
    const xs = Array.from({ length: 330 }, (_, i) => (i * 60) / 30)
    const f = computeWindowFeatures(xs, 30, cfg)
    // Slightly under 60: at the live edge the centered smoother has no future samples,
    // so the last few points flatten (same as the end of a segment in the notebook)
    expect(f.xProgress).toBeGreaterThan(59)
    expect(f.xProgress).toBeLessThanOrEqual(60)
    expect(f.nLineReturns).toBe(0)
    expect(f.missingRatio).toBe(0)
  })

  it('reports missing samples', () => {
    const xs: (number | null)[] = Array.from({ length: 330 }, (_, i) => (i % 4 === 0 ? null : 100))
    expect(computeWindowFeatures(xs, 30, cfg).missingRatio).toBeCloseTo(0.25, 2)
  })
})

// ── Online z-score ────────────────────────────────────────────────────────

describe('OnlineStats', () => {
  it('matches the batch mean and sample std (ddof = 1)', () => {
    const values = [3, 7, 7, 19, 24, 1.5]
    const s = new OnlineStats()
    values.forEach(v => s.update(v))
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1))
    expect(s.mean).toBeCloseTo(mean, 12)
    expect(s.std).toBeCloseTo(std, 12)
    expect(s.z(mean + std)).toBeCloseTo(1, 12)
  })

  it('returns z = 0 while the std is unusable', () => {
    const s = new OnlineStats()
    s.update(5)
    expect(s.z(10)).toBe(0)
    s.update(5)
    expect(s.z(10)).toBe(0) // std = 0
  })

  it('round-trips through JSON (to remember a user between sessions)', () => {
    const s = new OnlineStats()
    ;[1, 2, 3, 10].forEach(v => s.update(v))
    const back = OnlineStats.fromJSON(JSON.parse(JSON.stringify(s)))
    expect(back.mean).toBe(s.mean)
    expect(back.std).toBe(s.std)
  })
})

// ── Score ─────────────────────────────────────────────────────────────────

describe('mwScore', () => {
  it('is the logistic of intercept + weights · z', () => {
    const z = [0.5, -1]
    const lin = DEFAULT_MODEL.intercept + DEFAULT_MODEL.weights[0] * 0.5 - DEFAULT_MODEL.weights[1]
    expect(mwScore(z)).toBeCloseTo(1 / (1 + Math.exp(-lin)), 12)
  })

  it('goes up when the reader slows down (fewer returns, less progress)', () => {
    expect(mwScore([-1, -1])).toBeGreaterThan(mwScore([0, 0]))
    expect(mwScore([0, 0])).toBeGreaterThan(mwScore([1, 1]))
  })

  it('model.json has the expected shape', () => {
    expect(DEFAULT_MODEL.features).toEqual(['nLineReturns', 'xProgress'])
    expect(DEFAULT_MODEL.weights).toHaveLength(2)
    DEFAULT_MODEL.weights.forEach(w => expect(w).toBeLessThan(0))
  })
})

// ── Estimator end to end ──────────────────────────────────────────────────

describe('AttentionEstimator', () => {
  const STEP_MS = DEFAULT_MODEL.params.stepSeconds * 1000
  const WINDOW_MS = DEFAULT_MODEL.params.windowSeconds * 1000

  function run(est: AttentionEstimator, samples: GazeSample[], fromMs: number, toMs: number) {
    const results = []
    let i = 0
    for (let now = fromMs; now <= toMs; now += STEP_MS) {
      while (i < samples.length && samples[i].t <= now) est.addSample(samples[i++])
      results.push(est.evaluate(now))
    }
    return results
  }

  it('warms up before giving scores', () => {
    const est = new AttentionEstimator({ columnWidthPx: COLUMN_PX })
    const samples = readingTrace({ startMs: 0, durationMs: 60_000, msPerStep: 250, noisePx: 40, seed: 2 })
    const results = run(est, samples, WINDOW_MS, 60_000)
    const needed = DEFAULT_MODEL.params.warmupWindows
    expect(results.slice(0, needed - 1).every(r => r.status === 'warming_up')).toBe(true)
    expect(results.slice(needed - 1).every(r => r.status === 'ok')).toBe(true)
  })

  it('flags low tracking quality instead of scoring', () => {
    const est = new AttentionEstimator({ columnWidthPx: COLUMN_PX })
    const samples = readingTrace({ startMs: 0, durationMs: 12_000, msPerStep: 250, noisePx: 40, seed: 3 })
      .map((s, i) => (i % 3 === 0 ? s : { ...s, x: null, y: null })) // 2/3 missing
    expect(run(est, samples, WINDOW_MS, WINDOW_MS)[0].status).toBe('low_quality')
  })

  it('scores staring/slow reading higher than normal reading for the same user', () => {
    const est = new AttentionEstimator({ columnWidthPx: COLUMN_PX })
    // 0–60 s normal reading (builds the baseline), 60–90 s staring, 90–120 s normal again
    const samples = [
      ...readingTrace({ startMs: 0, durationMs: 60_000, msPerStep: 250, noisePx: 60, seed: 4 }),
      ...staringTrace(60_000, 30_000, 60, 5),
      ...readingTrace({ startMs: 90_000, durationMs: 30_000, msPerStep: 250, noisePx: 60, seed: 6 }),
    ]
    const results = run(est, samples, WINDOW_MS, 120_000)
    const scoreAt = (ms: number) => {
      const r = results[(ms - WINDOW_MS) / STEP_MS]
      if (r.status !== 'ok') throw new Error(`no score at ${ms}: ${r.status}`)
      return r.score
    }
    const normal = scoreAt(56_000)
    const staring = scoreAt(86_000)   // window 76–86 s is pure staring
    const backToNormal = scoreAt(118_000)
    expect(staring).toBeGreaterThan(normal)
    expect(staring).toBeGreaterThan(backToNormal)
  })

  it('works with an irregular, slower tracker (~20 Hz with jitter)', () => {
    const rand = mulberry32(9)
    const est = new AttentionEstimator({ columnWidthPx: COLUMN_PX })
    const samples = readingTrace({ startMs: 0, durationMs: 40_000, msPerStep: 250, noisePx: 40, seed: 7, hz: 20 })
      .map(s => ({ ...s, t: s.t + rand() * 10 }))
    const results = run(est, samples, WINDOW_MS, 40_000)
    expect(results.every(r => r.status !== 'low_quality')).toBe(true)
    expect(results[0].features.nLineReturns).toBeGreaterThan(0)
  })

  it('ignores out-of-order samples', () => {
    const est = new AttentionEstimator({ columnWidthPx: COLUMN_PX })
    est.addSample({ t: 100, x: 1, y: 1 })
    est.addSample({ t: 50, x: 999, y: 1 })
    est.addSample({ t: 100, x: 999, y: 1 })
    const f = est.evaluate(200).features
    expect(f.missingRatio).toBeGreaterThan(0.9)
  })

  it('can start from a saved baseline and skip the warm-up', () => {
    const first = new AttentionEstimator({ columnWidthPx: COLUMN_PX })
    run(first, readingTrace({ startMs: 0, durationMs: 40_000, msPerStep: 250, noisePx: 40, seed: 8 }), WINDOW_MS, 40_000)
    const saved = JSON.parse(JSON.stringify(first.getStats()))
    const second = new AttentionEstimator({
      columnWidthPx: COLUMN_PX,
      initialStats: {
        nLineReturns: OnlineStats.fromJSON(saved.nLineReturns),
        xProgress: OnlineStats.fromJSON(saved.xProgress),
      },
    })
    const r = run(second, readingTrace({ startMs: 0, durationMs: 12_000, msPerStep: 250, noisePx: 40, seed: 10 }), WINDOW_MS, WINDOW_MS)
    expect(r[0].status).toBe('ok')
  })
})
