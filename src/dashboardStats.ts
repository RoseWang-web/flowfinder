/**
 * dashboardStats.ts — Pure functions for Dashboard statistics and date utilities.
 *
 * All functions are side-effect free and testable without DOM or React.
 * Date arithmetic uses UTC to avoid DST-related off-by-one errors.
 * Display uses Intl.DateTimeFormat with the browser's IANA timezone.
 */

import type { HistoryEntry } from './historyStorage'

// ── Score colour mapping ──────────────────────────────────────────────────────
// Three bands (thresholds tentative — adjust after model validation):
//   70–100 → green  (On task)
//   40–69  → yellow (Mixed)
//    0–39  → red    (Mostly elsewhere)

export type ScoreGrade = 'green' | 'yellow' | 'red'

/** Returns grade for a numeric score. Caller must ensure score is a valid number 0–100. */
export function scoreToGrade(score: number): ScoreGrade {
  if (score >= 70) return 'green'
  if (score >= 40) return 'yellow'
  return 'red'
}

export const GRADE_COLORS: Record<ScoreGrade, { bg: string; text: string; light: string }> = {
  green:  { bg: '#4F8A5B', text: '#ffffff', light: '#E8F4EB' },
  yellow: { bg: '#E0A43A', text: '#ffffff', light: '#FEF3DC' },
  red:    { bg: '#C8553D', text: '#ffffff', light: '#FAEAE7' },
}

export const GRADE_LABELS: Record<ScoreGrade, string> = {
  green:  'On task',
  yellow: 'Mixed',
  red:    'Mostly elsewhere',
}

export const NEUTRAL_COLOR = { bg: '#6b7280', text: '#ffffff', light: '#f3f4f6' }

/** Returns background colour for a score, or neutral when score is null/invalid. */
export function scoreToColor(score: number | null): { bg: string; text: string; light: string } {
  if (!isValidScore(score)) return NEUTRAL_COLOR
  return GRADE_COLORS[scoreToGrade(score as number)]
}

/**
 * Validates a raw string from the manual-override score input.
 * Returns the parsed integer on success, or a user-facing error string.
 */
export function validateScoreInput(raw: string): number | string {
  const trimmed = raw.trim()
  if (trimmed === '') return 'Please enter a score'
  const n = Number(trimmed)
  if (!isFinite(n) || isNaN(n)) return 'Please enter a valid number'
  if (!Number.isInteger(n)) return 'Score must be a whole number'
  if (n < 0 || n > 100) return 'Score must be between 0 and 100'
  return n
}

/** Validates that a score is a finite number in [0, 100]. */
export function isValidScore(score: number | null | undefined): score is number {
  if (score === null || score === undefined) return false
  if (typeof score !== 'number') return false
  if (!isFinite(score) || isNaN(score)) return false
  return score >= 0 && score <= 100
}

// ── Eligibility for weighted average ─────────────────────────────────────────
// Spec §11: only completed (time_up / manual), analysis ready, valid score, activeMs > 0

/**
 * Returns the score to use for display and aggregation:
 * - manualOverride.score if present and valid
 * - analysis.totalScore if valid
 * - null otherwise
 *
 * 0 is a valid score; never use truthy checks.
 */
export function getEffectiveScore(entry: HistoryEntry): number | null {
  const mo = entry.manualOverride
  if (mo !== undefined && isValidScore(mo.score)) return mo.score
  return isValidScore(entry.analysis.totalScore) ? entry.analysis.totalScore : null
}

export function isEligibleForAverage(entry: HistoryEntry): boolean {
  const { session } = entry
  if (session.endReason !== 'time_up' && session.endReason !== 'manual') return false
  if (session.activeReadingMs <= 0) return false
  if (!isValidScore(getEffectiveScore(entry))) return false
  return true
}

// ── Weighted average ──────────────────────────────────────────────────────────
// Formula: Σ(score × activeReadingMs) / Σ(activeReadingMs)
// Returns null when there are no eligible entries.

export function computeWeightedAverage(entries: HistoryEntry[]): number | null {
  let totalWeight = 0
  let weightedSum = 0

  for (const e of entries) {
    if (!isEligibleForAverage(e)) continue
    const score = getEffectiveScore(e) as number
    const ms = e.session.activeReadingMs
    weightedSum += score * ms
    totalWeight += ms
  }

  if (totalWeight === 0) return null
  return weightedSum / totalWeight
}

// ── Date utilities ────────────────────────────────────────────────────────────

/** Browser's IANA timezone string. */
export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * Returns 'YYYY-MM-DD' for a timestamp in the given IANA timezone.
 * Uses sv-SE locale which produces the ISO 8601 date format.
 */
export function localDateString(ts: number, tz = browserTz()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date(ts))
}

/** Add n calendar days to a 'YYYY-MM-DD' string using UTC arithmetic (DST-safe). */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d) + n * 86_400_000
  return new Date(utc).toISOString().slice(0, 10)
}

/** Returns today's date string in the given timezone. */
export function todayString(tz = browserTz()): string {
  return localDateString(Date.now(), tz)
}

/**
 * Returns 7 'YYYY-MM-DD' strings for the week containing weekOffset relative to today.
 * Weeks start on Monday. 0 = this week, -1 = last week, +1 = next week.
 */
export function getWeekDates(weekOffset = 0, tz = browserTz()): string[] {
  const today = todayString(tz)
  const [y, m, d] = today.split('-').map(Number)
  const utcMidnight = Date.UTC(y, m - 1, d)
  const dow = new Date(utcMidnight).getUTCDay() // 0=Sun
  const mondayDiff = dow === 0 ? -6 : 1 - dow
  const mondayUtc = utcMidnight + (mondayDiff + weekOffset * 7) * 86_400_000
  return Array.from({ length: 7 }, (_, i) =>
    new Date(mondayUtc + i * 86_400_000).toISOString().slice(0, 10),
  )
}

/**
 * Returns the ISO week number label "YYYY-WNN" for a given date string.
 * Not used for display, used for grouping/navigation.
 */
export function weekLabel(dates: string[]): string {
  const first = dates[0]
  const [y, m, d] = first.split('-').map(Number)
  // ISO week: Thursday of the week determines the year
  return `${y}-W${String(getISOWeekNumber(y, m, d)).padStart(2, '0')}`
}

function getISOWeekNumber(y: number, m: number, d: number): number {
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

/**
 * Returns all date strings for a given year/month as a flat array.
 * year is full year (e.g. 2026), month is 1-based.
 */
export function getMonthDates(year: number, month: number): string[] {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Array.from({ length: daysInMonth }, (_, i) => {
    const d = String(i + 1).padStart(2, '0')
    const mo = String(month).padStart(2, '0')
    return `${year}-${mo}-${d}`
  })
}

/**
 * Returns weeks (arrays of 7 date strings) for a month's calendar.
 * Pads with '' for days outside the month.
 * Weeks start Monday.
 */
export function getMonthCalendarWeeks(year: number, month: number): string[][] {
  const dates = getMonthDates(year, month)
  const firstDay = dates[0]
  const [fy, fm, fd] = firstDay.split('-').map(Number)
  const firstUtc = Date.UTC(fy, fm - 1, fd)
  const firstDow = new Date(firstUtc).getUTCDay() // 0=Sun
  const paddingBefore = firstDow === 0 ? 6 : firstDow - 1

  const cells: string[] = [
    ...Array(paddingBefore).fill(''),
    ...dates,
  ]
  // Pad end to multiple of 7
  while (cells.length % 7 !== 0) cells.push('')

  const weeks: string[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }
  return weeks
}

/** Extract { year, month } from a 'YYYY-MM-DD' string. */
export function parseYM(dateStr: string): { year: number; month: number } {
  const [y, m] = dateStr.split('-').map(Number)
  return { year: y, month: m }
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/**
 * Groups history entries by their local start date.
 * For cross-midnight sessions, V1 assigns to the start date (spec §11).
 */
export function groupEntriesByDay(
  entries: HistoryEntry[],
  tz = browserTz(),
): Map<string, HistoryEntry[]> {
  const map = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    const dateStr = localDateString(entry.session.startedAt, tz)
    const existing = map.get(dateStr) ?? []
    existing.push(entry)
    map.set(dateStr, existing)
  }
  return map
}

// ── Category filtering ────────────────────────────────────────────────────────

export type CategoryFilter = 'all' | 'web_reading' | 'study_notes' | 'uncategorized'

export function filterByCategory(
  entries: HistoryEntry[],
  filter: CategoryFilter,
): HistoryEntry[] {
  if (filter === 'all') return entries
  if (filter === 'uncategorized') {
    return entries.filter(e => !e.session.taskSettings?.categoryId)
  }
  return entries.filter(e => e.session.taskSettings?.categoryId === filter)
}

// ── Period summary ────────────────────────────────────────────────────────────

export interface PeriodSummary {
  count: number
  totalActiveMs: number
  eligibleActiveMs: number  // ms from eligible sessions (for "Scored Time")
  weightedAvg: number | null
}

export function computePeriodSummary(entries: HistoryEntry[]): PeriodSummary {
  let totalActiveMs = 0
  let eligibleActiveMs = 0

  for (const e of entries) {
    totalActiveMs += e.session.activeReadingMs
    if (isEligibleForAverage(e)) eligibleActiveMs += e.session.activeReadingMs
  }

  return {
    count: entries.length,
    totalActiveMs,
    eligibleActiveMs,
    weightedAvg: computeWeightedAverage(entries),
  }
}

// ── Time formatting ───────────────────────────────────────────────────────────

export function msToHHMM(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatScore(score: number | null): string {
  if (!isValidScore(score)) return '—'
  return `${Math.round(score as number)}%`
}

export function localTimeString(ts: number, tz = browserTz()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

export function localDateTimeString(ts: number, tz = browserTz()): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

export function yearMonthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  )
}
