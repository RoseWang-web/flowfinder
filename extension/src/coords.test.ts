import { describe, it, expect } from 'vitest'
import { fitAxis, fitMap, mapFromEvent, reanchor, toClient, toScreen } from './coords'

describe('coords', () => {
  it('fitAxis recovers an exact line', () => {
    const pairs = [0, 100, 250, 900].map(c => ({ client: c, screen: 1.25 * c + 40 }))
    const m = fitAxis(pairs)!
    expect(m.scale).toBeCloseTo(1.25, 10)
    expect(m.offset).toBeCloseTo(40, 10)
  })

  it('fitAxis returns null when all clicks share one client coordinate', () => {
    expect(fitAxis([{ client: 5, screen: 7 }, { client: 5, screen: 9 }])).toBeNull()
  })

  it('fitMap from calibration-like clicks (page zoom 125%, window at 200,120)', () => {
    const clicks = [0.1, 0.5, 0.9].flatMap(fy => [0.1, 0.5, 0.9].map(fx => {
      const clientX = fx * 1000
      const clientY = fy * 700
      return { clientX, clientY, screenX: 200 + 1.25 * clientX, screenY: 120 + 1.25 * clientY }
    }))
    const m = fitMap(clicks)!
    const s = toScreen(m, 333, 444)
    expect(s.x).toBeCloseTo(200 + 1.25 * 333, 6)
    expect(toClient(m, s.x, s.y).y).toBeCloseTo(444, 6)
  })

  it('mapFromEvent and reanchor keep a single event exact', () => {
    const e = { screenX: 510, screenY: 300, clientX: 10, clientY: 20 }
    expect(toScreen(mapFromEvent(e), 10, 20)).toEqual({ x: 510, y: 300 })
    const moved = reanchor({ x: { scale: 2, offset: 0 }, y: { scale: 2, offset: 0 } }, e)
    expect(toScreen(moved, 10, 20)).toEqual({ x: 510, y: 300 })
    expect(moved.x.scale).toBe(2)
  })
})
