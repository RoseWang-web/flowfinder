import { describe, it, expect } from 'vitest'
import { estimateJitterPx, JitterGuard, QUALITY } from './quality'
import type { GazeSample } from '@core/attentionModel'

function trace(sd: number, seconds = 10, seed = 3): GazeSample[] {
  let s = seed
  const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const g = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  const out: GazeSample[] = []
  for (let k = 0; k < seconds * 30; k++) {
    const t = k * (1000 / 30)
    out.push({ t, x: 30 + ((t % 3000) / 3000) * 600 + g() * sd, y: 300 + g() * sd }) // steady reading + noise
  }
  return out
}

describe('estimateJitterPx', () => {
  it('recovers the noise level of a reading trace (reading motion and line returns barely matter)', () => {
    for (const sd of [20, 40, 80, 150]) {
      const est = estimateJitterPx(trace(sd))!
      expect(Math.abs(est - sd) / sd).toBeLessThan(0.2)
    }
  })
  it('null without enough valid consecutive samples', () => {
    expect(estimateJitterPx(trace(40, 1).slice(0, 15))).toBeNull()
    expect(estimateJitterPx(trace(40).map(s => ({ ...s, x: null, y: null })))).toBeNull()
  })
  it('ignores pairs across a tracking gap', () => {
    const t = trace(10)
    const gapped = t.map((s, i) => (i % 2 ? { ...s, x: null, y: null } : s))
    expect(estimateJitterPx(gapped)).toBeNull()
  })
})

describe('JitterGuard', () => {
  it('learns the post-calibration level, then flags windows 1.6× noisier', () => {
    const g = new JitterGuard()
    for (let i = 0; i < QUALITY.baselineWindows; i++) { expect(g.assess(40)).toBe('ok'); g.learn(40) }
    expect(g.baselinePx).toBe(40)
    expect(g.assess(60)).toBe('ok')
    expect(g.assess(70)).toBe('noisy')
  })
  it('a small baseline does not flag harmless changes below the floor', () => {
    const g = new JitterGuard()
    for (let i = 0; i < QUALITY.baselineWindows; i++) g.learn(10)
    expect(g.assess(25)).toBe('ok')
  })
  it('anything above the absolute maximum is noisy, even while learning', () => {
    expect(new JitterGuard().assess(QUALITY.absoluteMaxPx + 1)).toBe('noisy')
  })
  it('degraded after most recent windows were noisy; reset clears it', () => {
    const g = new JitterGuard()
    for (let i = 0; i < QUALITY.degradedNoisy; i++) g.assess(500)
    expect(g.degraded).toBe(true)
    g.reset()
    expect(g.degraded).toBe(false)
    expect(g.baselinePx).toBeNull()
  })
  it('unknown jitter is neither ok nor noisy', () => {
    expect(new JitterGuard().assess(null)).toBe('unknown')
  })
})
