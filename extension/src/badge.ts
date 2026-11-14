/** Toolbar badge: time left at a glance (pure, unit-tested). */
import type { EngineState } from './protocol'

export const BADGE_COLORS = { running: '#2F4D6B', paused: '#B8B2A7', up: '#F2B23E' } as const

export function badgeFor(s: EngineState): { text: string; color: string } {
  if (s.phase !== 'running') return { text: '', color: BADGE_COLORS.running }
  if (s.paused) return { text: 'II', color: BADGE_COLORS.paused }
  const mins = (ms: number) => Math.floor(ms / 60_000)
  if (s.totalMs === 0) return { text: `${mins(s.elapsedMs)}m`, color: BADGE_COLORS.running }
  if (s.timeUp) return { text: `+${mins(s.elapsedMs - s.totalMs)}m`, color: BADGE_COLORS.up }
  return { text: `${Math.ceil((s.totalMs - s.elapsedMs) / 60_000)}m`, color: BADGE_COLORS.running }
}
