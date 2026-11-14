import { describe, it, expect } from 'vitest'
import { badgeFor, BADGE_COLORS } from './badge'
import { IDLE_STATE, type EngineState } from './protocol'

const running = (p: Partial<EngineState>): EngineState => ({ ...IDLE_STATE, phase: 'running', ...p })

describe('badgeFor', () => {
  it('empty when not running', () => {
    expect(badgeFor(IDLE_STATE).text).toBe('')
    expect(badgeFor({ ...IDLE_STATE, phase: 'finished' }).text).toBe('')
  })
  it('minutes left, rounded up', () => {
    expect(badgeFor(running({ totalMs: 25 * 60_000, elapsedMs: 60_000 * 10 + 1 }))).toEqual({ text: '15m', color: BADGE_COLORS.running })
  })
  it('paused, open-ended, and extra time', () => {
    expect(badgeFor(running({ paused: true })).text).toBe('II')
    expect(badgeFor(running({ totalMs: 0, elapsedMs: 7 * 60_000 + 5 })).text).toBe('7m')
    expect(badgeFor(running({ totalMs: 60_000, elapsedMs: 3 * 60_000, timeUp: true }))).toEqual({ text: '+2m', color: BADGE_COLORS.up })
  })
})
