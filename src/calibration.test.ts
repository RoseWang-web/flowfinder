import { describe, it, expect } from 'vitest'
import {
  CALIBRATION_POINTS,
  VALIDATION_POINTS,
  gradeQuality,
  pointResult,
  summarizeValidation,
  toPixels,
} from './calibration'
import type { GazeSample } from './attentionModel'

const VIEWPORT = { width: 1000, height: 800 }

function samplesAround(cx: number, cy: number, offsets: [number, number][]): GazeSample[] {
  return offsets.map(([dx, dy], i) => ({ t: i * 33, x: cx + dx, y: cy + dy }))
}

describe('layout', () => {
  it('has 9 calibration points and 5 different validation points', () => {
    expect(CALIBRATION_POINTS).toHaveLength(9)
    expect(VALIDATION_POINTS).toHaveLength(5)
    const key = (p: { fx: number; fy: number }) => `${p.fx},${p.fy}`
    const calib = new Set(CALIBRATION_POINTS.map(key))
    // The centre is shared; the other validation points test positions we never trained on
    expect(VALIDATION_POINTS.filter(p => !calib.has(key(p)))).toHaveLength(4)
  })

  it('converts fractions to viewport pixels', () => {
    expect(toPixels({ fx: 0.1, fy: 0.9 }, VIEWPORT)).toEqual({ x: 100, y: 720 })
  })
})

describe('pointResult', () => {
  it('separates offset (accuracy) from jitter (precision)', () => {
    // Predictions centred 30 px right of the target, spread ±10 px
    const s = samplesAround(530, 400, [[-10, 0], [10, 0], [0, -10], [0, 10]])
    const r = pointResult({ x: 500, y: 400 }, s)
    expect(r.accuracyPx).toBeCloseTo(30, 9)
    expect(r.precisionPx).toBeCloseTo(10, 9)
    expect(r.nValid).toBe(4)
  })

  it('ignores missing predictions but counts them', () => {
    const s: GazeSample[] = [
      { t: 0, x: 500, y: 400 },
      { t: 33, x: null, y: null },
      { t: 66, x: 500, y: 400 },
    ]
    const r = pointResult({ x: 500, y: 400 }, s)
    expect(r.n).toBe(3)
    expect(r.nValid).toBe(2)
    expect(r.accuracyPx).toBe(0)
  })

  it('returns nulls when there are no predictions', () => {
    const r = pointResult({ x: 1, y: 1 }, [{ t: 0, x: null, y: null }])
    expect(r.accuracyPx).toBeNull()
    expect(r.precisionPx).toBeNull()
  })
})

describe('gradeQuality', () => {
  it('grades by the worse of accuracy and precision', () => {
    expect(gradeQuality(80, 60, 1)).toBe('good')
    expect(gradeQuality(150, 60, 1)).toBe('usable')
    expect(gradeQuality(80, 140, 1)).toBe('usable')
    expect(gradeQuality(250, 60, 1)).toBe('poor')
    expect(gradeQuality(80, 200, 1)).toBe('poor')
  })

  it('is poor when too many samples are missing', () => {
    expect(gradeQuality(10, 10, 0.3)).toBe('poor')
  })

  it('is poor without numbers', () => {
    expect(gradeQuality(null, 10, 1)).toBe('poor')
  })
})

describe('summarizeValidation', () => {
  const targets = VALIDATION_POINTS.map(p => toPixels(p, VIEWPORT))

  it('averages over points', () => {
    const samples = targets.map(t => samplesAround(t.x + 50, t.y, [[-20, 0], [20, 0]]))
    const s = summarizeValidation(targets, samples, VIEWPORT, 123)
    expect(s.accuracyPx).toBeCloseTo(50, 9)
    expect(s.precisionPx).toBeCloseTo(20, 9)
    expect(s.validRatio).toBe(1)
    expect(s.quality).toBe('good')
    expect(s.points).toHaveLength(5)
    expect(s.calibratedAt).toBe(123)
  })

  it('is poor if one point had no predictions at all', () => {
    const samples = targets.map((t, i) =>
      i === 2 ? [{ t: 0, x: null, y: null }] : samplesAround(t.x, t.y, [[0, 0], [1, 1]]),
    )
    const s = summarizeValidation(targets, samples, VIEWPORT, 0)
    expect(s.accuracyPx).toBeNull()
    expect(s.quality).toBe('poor')
  })

  it('is JSON-safe (no Infinity / NaN) so it can be stored with the session', () => {
    const s = summarizeValidation(targets, targets.map(() => []), VIEWPORT, 0)
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
  })
})
