import { describe, it, expect } from 'vitest'
import {
  scoreToGrade,
  scoreToColor,
  isValidScore,
  isEligibleForAverage,
  computeWeightedAverage,
  localDateString,
  addDays,
  todayString,
  getWeekDates,
  getMonthDates,
  getMonthCalendarWeeks,
  parseYM,
  groupEntriesByDay,
  filterByCategory,
  computePeriodSummary,
  msToHHMM,
  formatScore,
  GRADE_COLORS,
  NEUTRAL_COLOR,
} from './dashboardStats'
import type { HistoryEntry } from './historyStorage'
import type { Session } from './types'
import type { AnalysisResult } from './analysisTypes'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 2,
    sessionId: 'test-sess-1',
    articleId: 'article-v1',
    startedAt: Date.UTC(2026, 0, 15, 10, 0, 0), // 2026-01-15 10:00 UTC
    status: 'completed',
    durationMs: 30 * 60_000,
    activeReadingMs: 25 * 60_000,
    lastSavedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    endedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    endReason: 'manual',
    checkIn: null,
    cameraEnabled: false,
    taskSettings: {
      categoryId: 'web_reading',
      rulesVersion: 1,
      rules: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false },
    },
    events: [],
    ...overrides,
  }
}

function makeAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    sessionId: 'test-sess-1',
    status: 'ready',
    totalScore: 75,
    summary: null,
    scoringVersion: '1.0.0',
    source: 'real',
    analyzedAt: Date.now(),
    ...overrides,
  }
}

function makeEntry(sessionOverrides: Partial<Session> = {}, analysisOverrides: Partial<AnalysisResult> = {}): HistoryEntry {
  const session = makeSession(sessionOverrides)
  const analysis = makeAnalysis({ sessionId: session.sessionId, ...analysisOverrides })
  return { session, analysis, entryVersion: 1 }
}

// ── scoreToGrade ──────────────────────────────────────────────────────────────

describe('scoreToGrade', () => {
  it('returns green for 80', () => expect(scoreToGrade(80)).toBe('green'))
  it('returns green for 100', () => expect(scoreToGrade(100)).toBe('green'))
  it('returns yellow for 60', () => expect(scoreToGrade(60)).toBe('yellow'))
  it('returns yellow for 79.9', () => expect(scoreToGrade(79.9)).toBe('yellow'))
  it('returns orange for 40', () => expect(scoreToGrade(40)).toBe('orange'))
  it('returns orange for 59.9', () => expect(scoreToGrade(59.9)).toBe('orange'))
  it('returns red for 0', () => expect(scoreToGrade(0)).toBe('red'))
  it('returns red for 39.9', () => expect(scoreToGrade(39.9)).toBe('red'))
  it('grade boundaries are exclusive — 79 is yellow not green', () => expect(scoreToGrade(79)).toBe('yellow'))
})

// ── scoreToColor ──────────────────────────────────────────────────────────────

describe('scoreToColor', () => {
  it('returns GRADE_COLORS.green for score 85', () => {
    expect(scoreToColor(85)).toEqual(GRADE_COLORS.green)
  })
  it('returns GRADE_COLORS.red for score 0 (valid, not null)', () => {
    expect(scoreToColor(0)).toEqual(GRADE_COLORS.red)
  })
  it('returns NEUTRAL_COLOR for null', () => {
    expect(scoreToColor(null)).toEqual(NEUTRAL_COLOR)
  })
  it('returns NEUTRAL_COLOR for NaN', () => {
    expect(scoreToColor(NaN)).toEqual(NEUTRAL_COLOR)
  })
  it('returns NEUTRAL_COLOR for Infinity', () => {
    expect(scoreToColor(Infinity)).toEqual(NEUTRAL_COLOR)
  })
})

// ── isValidScore ──────────────────────────────────────────────────────────────

describe('isValidScore', () => {
  it('true for 0 — zero is a valid score', () => expect(isValidScore(0)).toBe(true))
  it('true for 100', () => expect(isValidScore(100)).toBe(true))
  it('true for 55.5', () => expect(isValidScore(55.5)).toBe(true))
  it('false for null', () => expect(isValidScore(null)).toBe(false))
  it('false for undefined', () => expect(isValidScore(undefined)).toBe(false))
  it('false for NaN', () => expect(isValidScore(NaN)).toBe(false))
  it('false for Infinity', () => expect(isValidScore(Infinity)).toBe(false))
  it('false for -1', () => expect(isValidScore(-1)).toBe(false))
  it('false for 101', () => expect(isValidScore(101)).toBe(false))
})

// ── isEligibleForAverage ──────────────────────────────────────────────────────

describe('isEligibleForAverage', () => {
  it('eligible: manual, ready, valid score, activeMs > 0', () => {
    expect(isEligibleForAverage(makeEntry())).toBe(true)
  })
  it('eligible: time_up end reason', () => {
    expect(isEligibleForAverage(makeEntry({ endReason: 'time_up' }))).toBe(true)
  })
  it('not eligible: interrupted', () => {
    expect(isEligibleForAverage(makeEntry({ endReason: 'interrupted' }))).toBe(false)
  })
  it('not eligible: analysis pending', () => {
    expect(isEligibleForAverage(makeEntry({}, { status: 'pending', totalScore: null }))).toBe(false)
  })
  it('not eligible: null score', () => {
    expect(isEligibleForAverage(makeEntry({}, { totalScore: null }))).toBe(false)
  })
  it('not eligible: activeReadingMs = 0', () => {
    expect(isEligibleForAverage(makeEntry({ activeReadingMs: 0 }))).toBe(false)
  })
  it('eligible: score = 0 (valid!)', () => {
    expect(isEligibleForAverage(makeEntry({ activeReadingMs: 1000 }, { totalScore: 0 }))).toBe(true)
  })
})

// ── computeWeightedAverage ────────────────────────────────────────────────────

describe('computeWeightedAverage', () => {
  it('returns null for empty array', () => {
    expect(computeWeightedAverage([])).toBeNull()
  })
  it('returns null when no eligible entries', () => {
    const entry = makeEntry({ endReason: 'interrupted' }, { totalScore: 80 })
    expect(computeWeightedAverage([entry])).toBeNull()
  })
  it('returns score when single eligible entry', () => {
    const entry = makeEntry({ activeReadingMs: 10_000 }, { totalScore: 80 })
    expect(computeWeightedAverage([entry])).toBe(80)
  })
  it('computes weighted average correctly', () => {
    // Entry A: score=60, weight=20min → contributes 1200
    // Entry B: score=80, weight=40min → contributes 3200
    // Total weight: 60min → average: 4400/60 = 73.333...
    const a = makeEntry({ sessionId: 'a', activeReadingMs: 20 * 60_000 }, { sessionId: 'a', totalScore: 60 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 40 * 60_000 }, { sessionId: 'b', totalScore: 80 })
    const result = computeWeightedAverage([a, b])
    expect(result).toBeCloseTo(73.333, 2)
  })
  it('ignores ineligible entries in the average', () => {
    const eligible = makeEntry({ activeReadingMs: 30 * 60_000 }, { totalScore: 70 })
    const interrupted = makeEntry({ endReason: 'interrupted' }, { totalScore: 90 })
    expect(computeWeightedAverage([eligible, interrupted])).toBe(70)
  })
  it('handles score = 0 correctly (zero is valid)', () => {
    const a = makeEntry({ sessionId: 'a', activeReadingMs: 10_000 }, { sessionId: 'a', totalScore: 0 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 10_000 }, { sessionId: 'b', totalScore: 100 })
    expect(computeWeightedAverage([a, b])).toBe(50)
  })
})

// ── localDateString ───────────────────────────────────────────────────────────

describe('localDateString', () => {
  it('formats UTC midnight 2026-01-15 as 2026-01-15 in UTC tz', () => {
    const ts = Date.UTC(2026, 0, 15, 0, 0, 0)
    expect(localDateString(ts, 'UTC')).toBe('2026-01-15')
  })
  it('formats timestamp at 23:59 UTC as correct UTC date', () => {
    const ts = Date.UTC(2026, 5, 20, 23, 59, 0)
    expect(localDateString(ts, 'UTC')).toBe('2026-06-20')
  })
})

// ── addDays ───────────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('adds 1 day', () => expect(addDays('2026-01-15', 1)).toBe('2026-01-16'))
  it('subtracts 1 day', () => expect(addDays('2026-01-15', -1)).toBe('2026-01-14'))
  it('crosses month boundary', () => expect(addDays('2026-01-31', 1)).toBe('2026-02-01'))
  it('crosses year boundary', () => expect(addDays('2025-12-31', 1)).toBe('2026-01-01'))
  it('adds 0 days is identity', () => expect(addDays('2026-06-01', 0)).toBe('2026-06-01'))
  it('handles leap year Feb 28 → Feb 29', () => expect(addDays('2024-02-28', 1)).toBe('2024-02-29'))
})

// ── todayString ───────────────────────────────────────────────────────────────

describe('todayString', () => {
  it('returns a string in YYYY-MM-DD format', () => {
    const result = todayString('UTC')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ── getWeekDates ──────────────────────────────────────────────────────────────

describe('getWeekDates', () => {
  it('returns 7 dates', () => {
    const dates = getWeekDates(0, 'UTC')
    expect(dates).toHaveLength(7)
  })
  it('first day is Monday', () => {
    const dates = getWeekDates(0, 'UTC')
    const dow = new Date(dates[0]).getUTCDay()
    expect(dow).toBe(1) // Monday
  })
  it('last day is Sunday', () => {
    const dates = getWeekDates(0, 'UTC')
    const dow = new Date(dates[6]).getUTCDay()
    expect(dow).toBe(0) // Sunday
  })
  it('dates are consecutive', () => {
    const dates = getWeekDates(0, 'UTC')
    for (let i = 1; i < dates.length; i++) {
      expect(addDays(dates[i - 1], 1)).toBe(dates[i])
    }
  })
  it('weekOffset -1 gives last week', () => {
    const thisWeek = getWeekDates(0, 'UTC')
    const lastWeek = getWeekDates(-1, 'UTC')
    expect(addDays(lastWeek[0], 7)).toBe(thisWeek[0])
  })
})

// ── getMonthDates ─────────────────────────────────────────────────────────────

describe('getMonthDates', () => {
  it('January 2026 has 31 days', () => {
    expect(getMonthDates(2026, 1)).toHaveLength(31)
  })
  it('February 2024 (leap) has 29 days', () => {
    expect(getMonthDates(2024, 2)).toHaveLength(29)
  })
  it('February 2025 (non-leap) has 28 days', () => {
    expect(getMonthDates(2025, 2)).toHaveLength(28)
  })
  it('first date of Jan 2026 is 2026-01-01', () => {
    expect(getMonthDates(2026, 1)[0]).toBe('2026-01-01')
  })
  it('last date of Jan 2026 is 2026-01-31', () => {
    const dates = getMonthDates(2026, 1)
    expect(dates[dates.length - 1]).toBe('2026-01-31')
  })
})

// ── getMonthCalendarWeeks ──────────────────────────────────────────────────────

describe('getMonthCalendarWeeks', () => {
  it('each row has 7 cells', () => {
    const weeks = getMonthCalendarWeeks(2026, 1)
    for (const week of weeks) {
      expect(week).toHaveLength(7)
    }
  })
  it('total cells cover all days of the month', () => {
    const weeks = getMonthCalendarWeeks(2026, 1)
    const all = weeks.flat().filter(d => d !== '')
    expect(all).toHaveLength(31)
  })
  it('January 2026 starts on Thursday (index 3 in Mon-Sun)', () => {
    const weeks = getMonthCalendarWeeks(2026, 1)
    // 2026-01-01 is Thursday; Mon-Sun means index 3
    expect(weeks[0][0]).toBe('') // Mon
    expect(weeks[0][1]).toBe('') // Tue
    expect(weeks[0][2]).toBe('') // Wed
    expect(weeks[0][3]).toBe('2026-01-01') // Thu
  })
})

// ── parseYM ───────────────────────────────────────────────────────────────────

describe('parseYM', () => {
  it('parses year and month from YYYY-MM-DD', () => {
    expect(parseYM('2026-06-15')).toEqual({ year: 2026, month: 6 })
  })
  it('handles January correctly', () => {
    expect(parseYM('2026-01-01')).toEqual({ year: 2026, month: 1 })
  })
})

// ── groupEntriesByDay ──────────────────────────────────────────────────────────

describe('groupEntriesByDay', () => {
  it('groups entries by UTC date string', () => {
    const a = makeEntry({ sessionId: 'a', startedAt: Date.UTC(2026, 0, 15, 9, 0) })
    const b = makeEntry({ sessionId: 'b', startedAt: Date.UTC(2026, 0, 15, 14, 0) })
    const c = makeEntry({ sessionId: 'c', startedAt: Date.UTC(2026, 0, 16, 9, 0) })
    const map = groupEntriesByDay([a, b, c], 'UTC')
    expect(map.get('2026-01-15')).toHaveLength(2)
    expect(map.get('2026-01-16')).toHaveLength(1)
  })
  it('returns empty map for empty input', () => {
    expect(groupEntriesByDay([], 'UTC').size).toBe(0)
  })
})

// ── filterByCategory ──────────────────────────────────────────────────────────

describe('filterByCategory', () => {
  const web = makeEntry({ taskSettings: { categoryId: 'web_reading', rulesVersion: 1, rules: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false } } })
  const study = makeEntry({ sessionId: 'b', taskSettings: { categoryId: 'study_notes', rulesVersion: 1, rules: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false } } })
  const noSettings = makeEntry({ sessionId: 'c', taskSettings: undefined })

  it('all returns all entries', () => {
    expect(filterByCategory([web, study, noSettings], 'all')).toHaveLength(3)
  })
  it('web_reading returns only web reading', () => {
    const result = filterByCategory([web, study, noSettings], 'web_reading')
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(web)
  })
  it('study_notes returns only study notes', () => {
    expect(filterByCategory([web, study, noSettings], 'study_notes')).toHaveLength(1)
  })
  it('uncategorized returns entries with no taskSettings', () => {
    expect(filterByCategory([web, study, noSettings], 'uncategorized')).toHaveLength(1)
  })
})

// ── computePeriodSummary ───────────────────────────────────────────────────────

describe('computePeriodSummary', () => {
  it('returns zero summary for empty array', () => {
    const s = computePeriodSummary([])
    expect(s).toEqual({ count: 0, totalActiveMs: 0, eligibleActiveMs: 0, weightedAvg: null })
  })
  it('counts all entries', () => {
    const entries = [makeEntry(), makeEntry({ sessionId: 'b' })]
    expect(computePeriodSummary(entries).count).toBe(2)
  })
  it('totalActiveMs sums all entries including ineligible', () => {
    const a = makeEntry({ activeReadingMs: 10_000 }, { totalScore: 80 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 5_000, endReason: 'interrupted' }, { sessionId: 'b', totalScore: null })
    expect(computePeriodSummary([a, b]).totalActiveMs).toBe(15_000)
  })
  it('eligibleActiveMs only sums eligible entries', () => {
    const a = makeEntry({ activeReadingMs: 10_000 }, { totalScore: 80 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 5_000, endReason: 'interrupted' })
    expect(computePeriodSummary([a, b]).eligibleActiveMs).toBe(10_000)
  })
  it('weightedAvg matches computeWeightedAverage', () => {
    const a = makeEntry({ activeReadingMs: 20 * 60_000 }, { totalScore: 60 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 40 * 60_000 }, { sessionId: 'b', totalScore: 80 })
    const s = computePeriodSummary([a, b])
    expect(s.weightedAvg).toBeCloseTo(73.333, 2)
  })
})

// ── msToHHMM ──────────────────────────────────────────────────────────────────

describe('msToHHMM', () => {
  it('formats 0 as 00:00', () => expect(msToHHMM(0)).toBe('00:00'))
  it('formats 90 seconds as 01:30', () => expect(msToHHMM(90_000)).toBe('01:30'))
  it('formats 1 hour as 1h 00m', () => expect(msToHHMM(3_600_000)).toBe('1h 00m'))
  it('formats 1h 30m correctly', () => expect(msToHHMM(5_400_000)).toBe('1h 30m'))
  it('rounds down sub-second ms', () => expect(msToHHMM(59_999)).toBe('00:59'))
  it('handles negative ms as 0', () => expect(msToHHMM(-1000)).toBe('00:00'))
})

// ── formatScore ───────────────────────────────────────────────────────────────

describe('formatScore', () => {
  it('rounds to nearest integer and appends %', () => expect(formatScore(75.6)).toBe('76%'))
  it('formats 0 as "0%" not "—"', () => expect(formatScore(0)).toBe('0%'))
  it('returns "—" for null', () => expect(formatScore(null)).toBe('—'))
})
