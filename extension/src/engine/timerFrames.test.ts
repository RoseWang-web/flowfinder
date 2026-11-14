import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTimerFrames } from './timerFrames'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('createTimerFrames', () => {
  it('runs every callback requested before a frame in that frame, with one timestamp', () => {
    const f = createTimerFrames(30, () => Date.now())
    const seen: number[] = []
    f.request(t => seen.push(t))
    f.request(t => seen.push(t))
    vi.advanceTimersByTime(0)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it('keeps a 30 Hz cadence even when each frame takes 15 ms of work', () => {
    // Work advances the wall clock (Date.now) but not the fake timer queue, so
    // measure frames per second of wall-clock time = timer time + work time.
    const f = createTimerFrames(30, () => Date.now())
    const start = Date.now()
    let frames = 0
    const loop = () => {
      frames++
      vi.setSystemTime(Date.now() + 15) // 15 ms of prediction work
      f.request(loop)
    }
    f.request(loop)
    vi.advanceTimersByTime(1000)
    const perSecond = frames / ((Date.now() - start) / 1000)
    expect(perSecond).toBeGreaterThan(28)
    expect(perSecond).toBeLessThan(32)
    // A plain setTimeout(cb, 33) after the work would give 1000 / (33 + 15) ≈ 21 /s
  })

  it('cancel removes a pending callback', () => {
    const f = createTimerFrames(30, () => Date.now())
    const cb = vi.fn()
    const id = f.request(cb)
    f.cancel(id)
    vi.advanceTimersByTime(100)
    expect(cb).not.toHaveBeenCalled()
  })

  it('a throwing callback does not stop the others', () => {
    const f = createTimerFrames(30, () => Date.now())
    const ok = vi.fn()
    f.request(() => { throw new Error('boom') })
    f.request(ok)
    vi.advanceTimersByTime(0)
    expect(ok).toHaveBeenCalled()
    expect(() => vi.runOnlyPendingTimers()).toThrow('boom')
  })
})
