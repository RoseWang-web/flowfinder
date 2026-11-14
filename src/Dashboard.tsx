import { useState, useEffect, useCallback } from 'react'
import { TimelineChart } from './TimelineChart'
import { buildTimeline } from './timeline'
import {
  loadHistory,
  deleteHistoryEntry,
  updateManualOverride,
  clearManualOverride,
  type HistoryData,
  type HistoryEntry,
  type HistoryStorageError,
} from './historyStorage'
import type { ManualOverride } from './analysisTypes'
import { getMockHistoryData } from './mockFixtures'
import {
  scoreToColor,
  scoreToGrade,
  isValidScore,
  computeWeightedAverage,
  computePeriodSummary,
  filterByCategory,
  groupEntriesByDay,
  getMonthCalendarWeeks,
  getMonthDates,
  localDateString,
  localTimeString,
  localDateTimeString,
  yearMonthLabel,
  msToHHMM,
  formatScore,
  todayString,
  addDays,
  parseYM,
  getEffectiveScore,
  validateScoreInput,
  type CategoryFilter,
  NEUTRAL_COLOR,
} from './dashboardStats'
import { CATEGORIES } from './taskPreferences'
import type { Session } from './types'
import './Dashboard.css'

// ── Types ─────────────────────────────────────────────────────────────────────

type ViewMode = 'day' | 'week' | 'month'
type DashboardMode = 'real' | 'demo'

// ── Utilities ─────────────────────────────────────────────────────────────────

const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function endReasonLabel(r: Session['endReason']): string {
  if (r === 'time_up') return "Time's Up"
  if (r === 'manual') return 'Ended Early'
  if (r === 'interrupted') return 'Interrupted'
  return '—'
}

function categoryLabel(categoryId: string | undefined): string {
  if (!categoryId) return 'Uncategorized'
  return CATEGORIES.find(c => c.id === categoryId)?.label ?? categoryId
}

// ── Score badge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score, size = 'sm' }: { score: number | null; size?: 'sm' | 'md' }) {
  const color = scoreToColor(score)
  const display = isValidScore(score) ? `${Math.round(score as number)}%` : '—'
  return (
    <span
      className={`score-badge score-badge-${size}`}
      style={{ background: color.bg, color: color.text }}
      aria-label={`Focus ${display}`}
    >
      {display}
    </span>
  )
}

// ── Session detail panel ──────────────────────────────────────────────────────

const GRADE_LABELS: Record<'green' | 'yellow' | 'orange' | 'red', string> = {
  green: 'Excellent', yellow: 'Good', orange: 'Fair', red: 'Low',
}

function SessionDetail({
  entry,
  onClose,
  onDelete,
  onUpdateOverride,
  onClearOverride,
  isDemo,
}: {
  entry: HistoryEntry
  onClose: () => void
  onDelete: (sessionId: string) => void
  onUpdateOverride: (sessionId: string, override: ManualOverride) => HistoryStorageError | null
  onClearOverride: (sessionId: string) => HistoryStorageError | null
  isDemo: boolean
}) {
  const { session, analysis } = entry
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [showTimeline, setShowTimeline] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftScore, setDraftScore] = useState('')
  const [draftReason, setDraftReason] = useState('')
  const [scoreError, setScoreError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const effectiveScore = getEffectiveScore(entry)
  const color = scoreToColor(effectiveScore)
  const timelineData = buildTimeline(session)

  function handleOpenEdit() {
    if (entry.manualOverride !== undefined) {
      setDraftScore(String(entry.manualOverride.score))
      setDraftReason(entry.manualOverride.reason ?? '')
    } else if (isValidScore(analysis.totalScore)) {
      setDraftScore(String(Math.round(analysis.totalScore as number)))
      setDraftReason('')
    } else {
      setDraftScore('')
      setDraftReason('')
    }
    setScoreError(null)
    setSaveError(null)
    setEditing(true)
  }

  function handleSave() {
    const result = validateScoreInput(draftScore)
    if (typeof result === 'string') {
      setScoreError(result)
      return
    }
    const override: ManualOverride = {
      score: result,
      overriddenAt: Date.now(),
      ...(draftReason.trim() ? { reason: draftReason.trim() } : {}),
    }
    const err = onUpdateOverride(session.sessionId, override)
    if (err) {
      setSaveError(err.message)
      return
    }
    setEditing(false)
    setSaveError(null)
  }

  function handleRestore() {
    const err = onClearOverride(session.sessionId)
    if (err) {
      setSaveError(err.message)
    }
  }

  return (
    <div className="detail-panel" role="dialog" aria-modal="true" aria-label="Session Details">
      <div className="detail-header">
        <h3 className="detail-title">Session Details</h3>
        <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
      </div>

      {/* Score hero */}
      <div className="detail-score-hero" style={{ background: color.light, borderColor: color.bg }}>
        <div className="detail-score-hero-top">
          <ScoreBadge score={effectiveScore} size="md" />
          {entry.manualOverride !== undefined && (
            <span className="manual-modified-badge">Manually Adjusted</span>
          )}
        </div>
        <div className="detail-score-info">
          {isValidScore(effectiveScore) ? (
            <>
              <span className="detail-score-grade">{GRADE_LABELS[scoreToGrade(effectiveScore as number)]}</span>
              {analysis.summary && entry.manualOverride === undefined && (
                <p className="detail-score-summary">{analysis.summary}</p>
              )}
            </>
          ) : (
            <p className="detail-score-summary">No analysis available</p>
          )}
        </div>
      </div>

      {/* Manual override info */}
      {entry.manualOverride !== undefined && (
        <div className="system-score-row">
          <div className="system-score-line">
            <span className="system-score-label">AI Score: </span>
            <span className="system-score-value">
              {isValidScore(analysis.totalScore) ? `${Math.round(analysis.totalScore as number)}%` : 'No AI score yet'}
            </span>
          </div>
          <div className="system-score-meta">
            <span>Adjusted: {localDateTimeString(entry.manualOverride.overriddenAt, tz)}</span>
            {entry.manualOverride.reason && (
              <span>Reason: {entry.manualOverride.reason}</span>
            )}
          </div>
        </div>
      )}

      {analysis.source === 'mock' && (
        <p className="detail-mock-note">⚠ Demo data — not real analysis</p>
      )}

      <div className="detail-stats">
        <div className="detail-stat-row">
          <span className="detail-stat-label">Start</span>
          <span className="detail-stat-value">{localDateTimeString(session.startedAt, tz)}</span>
        </div>
        {session.endedAt && (
          <div className="detail-stat-row">
            <span className="detail-stat-label">End</span>
            <span className="detail-stat-value">{localDateTimeString(session.endedAt, tz)}</span>
          </div>
        )}
        <div className="detail-stat-row">
          <span className="detail-stat-label">Active Time</span>
          <span className="detail-stat-value">{msToHHMM(session.activeReadingMs)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">Total Elapsed</span>
          <span className="detail-stat-value">{msToHHMM(session.durationMs)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">Planned Duration</span>
          <span className="detail-stat-value">
            {session.plannedDurationMs === 0 ? '∞ Unlimited' : msToHHMM(session.plannedDurationMs ?? 120_000)}
          </span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">End Reason</span>
          <span className="detail-stat-value">{endReasonLabel(session.endReason)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">Category</span>
          <span className="detail-stat-value">{categoryLabel(session.taskSettings?.categoryId)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">Camera</span>
          <span className="detail-stat-value">{session.cameraEnabled ? 'Enabled' : 'Not Used'}</span>
        </div>
        {analysis.scoringVersion && (
          <div className="detail-stat-row">
            <span className="detail-stat-label">Analysis v</span>
            <span className="detail-stat-value">{analysis.scoringVersion}</span>
          </div>
        )}
      </div>

      <p className="detail-disclaimer">
        Colors represent the overall estimated score for each session, not minute-by-minute. Grades are UI aids — not medically or psychologically validated.
      </p>

      {/* Timeline toggle */}
      <button
        className="btn btn-secondary btn-small detail-expand-btn"
        onClick={() => setShowTimeline(v => !v)}
      >
        {showTimeline ? '▲' : '▼'} Timeline
      </button>
      {showTimeline && (
        <div className="detail-timeline">
          <TimelineChart data={timelineData} />
        </div>
      )}

      {/* Event log toggle */}
      <button
        className="btn btn-secondary btn-small detail-expand-btn"
        onClick={() => setShowEvents(v => !v)}
      >
        {showEvents ? '▲' : '▼'} Event Log
      </button>
      {showEvents && (
        <div className="detail-event-list">
          {session.events
            .filter(e => e.eventType !== 'scroll')
            .map(e => (
              <div key={e.id} className="detail-event-row">
                <span className="detail-event-time">{msToHHMM(e.elapsedMs)}</span>
                <span className="detail-event-type">{e.eventType}</span>
              </div>
            ))}
        </div>
      )}

      {/* Manual override controls */}
      {isDemo ? (
        <p className="detail-demo-note">Demo data cannot be edited</p>
      ) : editing ? (
        <div className="edit-form">
          <div className="edit-form-row">
            <label htmlFor="edit-score-input" className="edit-form-label">Score (0–100)</label>
            <input
              id="edit-score-input"
              type="number"
              min={0}
              max={100}
              step={1}
              className="edit-score-input"
              value={draftScore}
              onChange={e => { setDraftScore(e.target.value); setScoreError(null) }}
            />
          </div>
          {scoreError && <p className="edit-score-error">{scoreError}</p>}
          <div className="edit-form-row">
            <label htmlFor="edit-reason-input" className="edit-form-label">Reason (optional, max 300 chars)</label>
            <textarea
              id="edit-reason-input"
              className="edit-reason-input"
              maxLength={300}
              value={draftReason}
              onChange={e => setDraftReason(e.target.value)}
              rows={2}
            />
          </div>
          {saveError && <p className="edit-save-error">⚠ {saveError}</p>}
          <div className="edit-form-buttons">
            <button className="btn btn-primary btn-small" onClick={handleSave}>Save</button>
            <button className="btn btn-ghost btn-small" onClick={() => { setEditing(false); setSaveError(null) }}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="detail-override-controls">
          <button className="btn btn-secondary btn-small" onClick={handleOpenEdit}>Override Score</button>
          {entry.manualOverride !== undefined && (
            <button className="btn btn-ghost btn-small" onClick={handleRestore}>Restore AI Score</button>
          )}
        </div>
      )}

      {/* Delete */}
      {!isDemo && (
        <div className="detail-delete">
          {!confirmDelete ? (
            <button
              className="btn btn-ghost btn-small"
              onClick={() => setConfirmDelete(true)}
            >
              Delete Session
            </button>
          ) : (
            <div className="detail-delete-confirm">
              <p>Delete this session? This cannot be undone.</p>
              <div className="detail-delete-buttons">
                <button
                  className="btn btn-primary btn-small"
                  style={{ background: '#dc2626' }}
                  onClick={() => onDelete(session.sessionId)}
                >
                  Confirm Delete
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Day view ──────────────────────────────────────────────────────────────────

function DayView({
  entries,
  onSelectEntry,
}: {
  entries: HistoryEntry[]
  onSelectEntry: (entry: HistoryEntry) => void
}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const sorted = [...entries].sort((a, b) => a.session.startedAt - b.session.startedAt)

  if (sorted.length === 0) {
    return <p className="dash-empty-day">No sessions on this day</p>
  }

  return (
    <div className="day-view">
      {sorted.map(entry => {
        const { session } = entry
        const effectiveScore = getEffectiveScore(entry)
        const color = scoreToColor(effectiveScore)
        return (
          <button
            key={session.sessionId}
            className="day-session-card"
            style={{ borderLeftColor: color.bg }}
            onClick={() => onSelectEntry(entry)}
            aria-label={`Session at ${localTimeString(session.startedAt, tz)}, score ${formatScore(effectiveScore)}`}
          >
            <div className="day-session-time">
              <span>{localTimeString(session.startedAt, tz)}</span>
              {session.endedAt && (
                <span className="day-session-time-end">～{localTimeString(session.endedAt, tz)}</span>
              )}
            </div>
            <div className="day-session-meta">
              <span className="day-session-cat">{categoryLabel(session.taskSettings?.categoryId)}</span>
              <span className="day-session-active">{msToHHMM(session.activeReadingMs)}</span>
            </div>
            <ScoreBadge score={effectiveScore} />
          </button>
        )
      })}
    </div>
  )
}

// ── Week view ─────────────────────────────────────────────────────────────────

function WeekView({
  weekDates,
  byDay,
  onSelectDay,
}: {
  weekDates: string[]
  byDay: Map<string, HistoryEntry[]>
  onSelectDay: (date: string) => void
}) {
  const today = todayString()
  return (
    <div className="week-view">
      {weekDates.map((date, i) => {
        const entries = byDay.get(date) ?? []
        const avg = computeWeightedAverage(entries)
        const color = isValidScore(avg) ? scoreToColor(avg) : NEUTRAL_COLOR
        const totalActive = entries.reduce((s, e) => s + e.session.activeReadingMs, 0)
        const hasData = entries.length > 0
        const isToday = date === today

        return (
          <button
            key={date}
            className={`week-day-cell ${isToday ? 'week-day-today' : ''} ${!hasData ? 'week-day-empty' : ''}`}
            style={hasData ? { background: color.light, borderColor: color.bg } : {}}
            onClick={() => onSelectDay(date)}
            aria-label={`${date} ${hasData ? formatScore(avg) : 'No data'}`}
          >
            <span className="week-day-name">{WEEK_DAYS[i]}</span>
            <span className="week-day-date">{date.slice(8)}</span>
            {hasData ? (
              <>
                <ScoreBadge score={avg} />
                <span className="week-day-active">{msToHHMM(totalActive)}</span>
                <span className="week-day-count">{entries.length} session{entries.length !== 1 ? 's' : ''}</span>
              </>
            ) : (
              <span className="week-day-no-data">—</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Month view ────────────────────────────────────────────────────────────────

function MonthView({
  year,
  month,
  byDay,
  onSelectDay,
}: {
  year: number
  month: number
  byDay: Map<string, HistoryEntry[]>
  onSelectDay: (date: string) => void
}) {
  const today = todayString()
  const weeks = getMonthCalendarWeeks(year, month)

  return (
    <div className="month-view">
      <div className="month-header">
        {WEEK_DAYS.map(d => (
          <span key={d} className="month-weekday">{d}</span>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="month-week">
          {week.map((date, di) => {
            if (!date) {
              return <div key={di} className="month-day-cell month-day-empty" />
            }
            const entries = byDay.get(date) ?? []
            const avg = computeWeightedAverage(entries)
            const color = isValidScore(avg) && entries.length > 0 ? scoreToColor(avg) : NEUTRAL_COLOR
            const hasData = entries.length > 0
            const isToday = date === today
            const dayNum = date.slice(8).replace(/^0/, '')

            return (
              <button
                key={date}
                className={`month-day-cell ${isToday ? 'month-day-today' : ''} ${hasData ? 'month-day-has-data' : ''}`}
                style={hasData ? { background: color.light, borderColor: color.bg } : {}}
                onClick={() => onSelectDay(date)}
                aria-label={`${date} ${hasData ? formatScore(avg) : 'No data'}`}
                disabled={!hasData && date > today}
              >
                <span className="month-day-num">{dayNum}</span>
                {hasData && (
                  <span
                    className="month-day-dot"
                    style={{ background: color.bg }}
                    aria-hidden="true"
                  />
                )}
                {hasData && isValidScore(avg) && (
                  <span className="month-day-score">{Math.round(avg as number)}%</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ── Summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ entries }: { entries: HistoryEntry[] }) {
  const summary = computePeriodSummary(entries)
  const avg = summary.weightedAvg
  const color = isValidScore(avg) ? scoreToColor(avg) : NEUTRAL_COLOR

  return (
    <div className="summary-bar">
      <div className="summary-stat">
        <span className="summary-stat-value">{summary.count}</span>
        <span className="summary-stat-label">Sessions</span>
      </div>
      <div className="summary-stat">
        <span className="summary-stat-value">{msToHHMM(summary.totalActiveMs)}</span>
        <span className="summary-stat-label">Active Time</span>
      </div>
      <div className="summary-stat">
        <span className="summary-stat-value">{msToHHMM(summary.eligibleActiveMs)}</span>
        <span className="summary-stat-label">Scored Time</span>
      </div>
      <div className="summary-stat">
        {isValidScore(avg) ? (
          <span
            className="summary-stat-value summary-avg-score"
            style={{ color: color.bg }}
          >
            {Math.round(avg as number)}%
          </span>
        ) : (
          <span className="summary-stat-value summary-avg-score summary-avg-none">—</span>
        )}
        <span className="summary-stat-label">Avg Focus Score</span>
      </div>
    </div>
  )
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export interface DashboardProps {
  onStartNewSession: () => void
}

export function Dashboard({ onStartNewSession }: DashboardProps) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  // ── Mode ──────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<DashboardMode>('real')

  // ── View state ────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>('day')
  const [focusDate, setFocusDate] = useState<string>(() => todayString(tz))
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null)

  // ── Data ──────────────────────────────────────────────────────────────
  const [historyData, setHistoryData] = useState<HistoryData>({
    schemaVersion: 1,
    entries: [],
    deletedIds: [],
  })
  const [loadError, setLoadError] = useState<HistoryStorageError | null>(null)
  const [writeError, setWriteError] = useState<HistoryStorageError | null>(null)

  // Load data when mode changes
  useEffect(() => {
    if (mode === 'demo') {
      setHistoryData(getMockHistoryData())
      setLoadError(null)
      return
    }
    const result = loadHistory()
    if (result.ok) {
      setHistoryData(result.data)
      setLoadError(null)
    } else if ('empty' in result) {
      setHistoryData({ schemaVersion: 1, entries: [], deletedIds: [] })
      setLoadError(null)
    } else {
      setLoadError(result.error)
    }
  }, [mode])

  // ── Derived data ──────────────────────────────────────────────────────
  const allEntries = historyData.entries
  const filteredEntries = filterByCategory(allEntries, categoryFilter)
  const byDay = groupEntriesByDay(filteredEntries, tz)

  // Week / month navigation
  const focusYM = parseYM(focusDate)

  // Recalculate week containing focusDate
  const [y, m, d] = focusDate.split('-').map(Number)
  const focusUtc = Date.UTC(y, m - 1, d)
  const focusDow = new Date(focusUtc).getUTCDay()
  const focusMondayOffset = focusDow === 0 ? -6 : 1 - focusDow
  const focusMondayUtc = focusUtc + focusMondayOffset * 86_400_000
  const currentWeekDates = Array.from({ length: 7 }, (_, i) =>
    new Date(focusMondayUtc + i * 86_400_000).toISOString().slice(0, 10),
  )

  // Entries in current period
  const entriesInPeriod = (() => {
    if (view === 'day') return byDay.get(focusDate) ?? []
    if (view === 'week') {
      const set = new Set(currentWeekDates)
      return filteredEntries.filter(e => set.has(localDateString(e.session.startedAt, tz)))
    }
    // month
    const monthDates = new Set(getMonthDates(focusYM.year, focusYM.month))
    return filteredEntries.filter(e => monthDates.has(localDateString(e.session.startedAt, tz)))
  })()

  // ── Navigation ────────────────────────────────────────────────────────
  const navigate = useCallback((dir: -1 | 1) => {
    if (view === 'day') {
      setFocusDate(d => addDays(d, dir))
    } else if (view === 'week') {
      setFocusDate(d => addDays(d, dir * 7))
    } else {
      setFocusDate(d => {
        const { year, month } = parseYM(d)
        const newMonth = month + dir
        if (newMonth < 1) return `${year - 1}-12-01`
        if (newMonth > 12) return `${year + 1}-01-01`
        return `${year}-${String(newMonth).padStart(2, '0')}-01`
      })
    }
    setSelectedEntry(null)
  }, [view])

  const goToday = useCallback(() => {
    setFocusDate(todayString(tz))
    setSelectedEntry(null)
  }, [tz])

  const handleSelectDay = useCallback((date: string) => {
    setFocusDate(date)
    setView('day')
    setSelectedEntry(null)
  }, [])

  // ── Delete ────────────────────────────────────────────────────────────
  const handleDelete = useCallback((sessionId: string) => {
    const err = deleteHistoryEntry(sessionId)
    if (err) {
      setWriteError(err)
      return
    }
    setWriteError(null)
    // Reload from storage
    const result = loadHistory()
    if (result.ok) setHistoryData(result.data)
    setSelectedEntry(null)
  }, [])

  // ── Manual override ───────────────────────────────────────────────────
  const handleUpdateOverride = useCallback((sessionId: string, override: ManualOverride): HistoryStorageError | null => {
    const err = updateManualOverride(sessionId, override)
    if (err) return err
    const result = loadHistory()
    if (result.ok) {
      setHistoryData(result.data)
      const updated = result.data.entries.find(e => e.session.sessionId === sessionId)
      if (updated) setSelectedEntry(updated)
    }
    return null
  }, [])

  const handleClearOverride = useCallback((sessionId: string): HistoryStorageError | null => {
    const err = clearManualOverride(sessionId)
    if (err) return err
    const result = loadHistory()
    if (result.ok) {
      setHistoryData(result.data)
      const updated = result.data.entries.find(e => e.session.sessionId === sessionId)
      if (updated) setSelectedEntry(updated)
    }
    return null
  }, [])

  // ── Period label ──────────────────────────────────────────────────────
  const periodLabel = (() => {
    if (view === 'day') {
      const isToday = focusDate === todayString(tz)
      const isTomorrow = focusDate === addDays(todayString(tz), 1)
      const isYesterday = focusDate === addDays(todayString(tz), -1)
      if (isToday) return 'Today'
      if (isYesterday) return 'Yesterday'
      if (isTomorrow) return 'Tomorrow'
      return focusDate
    }
    if (view === 'week') {
      return `${currentWeekDates[0]} ～ ${currentWeekDates[6]}`
    }
    return yearMonthLabel(focusYM.year, focusYM.month)
  })()

  // ── Empty state ───────────────────────────────────────────────────────
  const isRealEmpty = mode === 'real' && allEntries.length === 0 && !loadError

  return (
    <div className="dashboard-page">
      {/* Header */}
      <header className="dash-header">
        <div className="dash-header-left">
          <h1 className="dash-brand">flowfinder</h1>
          <span className="dash-local-badge">Local Mode</span>
        </div>
        <div className="dash-header-right">
          <button className="btn btn-primary btn-small" onClick={onStartNewSession}>
            New Session
          </button>
        </div>
      </header>

      {/* Mode toggle */}
      <div className="dash-mode-bar">
        <button
          className={`dash-mode-btn ${mode === 'real' ? 'active' : ''}`}
          onClick={() => { setMode('real'); setSelectedEntry(null) }}
        >
          My Sessions
        </button>
        <button
          className={`dash-mode-btn ${mode === 'demo' ? 'active' : ''}`}
          onClick={() => { setMode('demo'); setSelectedEntry(null) }}
        >
          Demo Data
        </button>
        {mode === 'demo' && (
          <span className="demo-label" role="status">Demo data — not real analysis</span>
        )}
      </div>

      {/* Error banners */}
      {loadError && (
        <div className="dash-error-banner">⚠ {loadError.message}</div>
      )}
      {writeError && (
        <div className="dash-error-banner">⚠ {writeError.message}</div>
      )}

      {/* Empty state */}
      {isRealEmpty ? (
        <div className="dash-empty-state">
          <div className="dash-empty-icon">📖</div>
          <h2 className="dash-empty-title">No Sessions Yet</h2>
          <p className="dash-empty-desc">Your sessions will appear here after you complete your first one.</p>
          <div className="dash-empty-actions">
            <button className="btn btn-primary" onClick={onStartNewSession}>
              New Session
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setMode('demo')}
            >
              View Demo Data
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Controls */}
          <div className="dash-controls">
            <div className="dash-view-tabs">
              {(['day', 'week', 'month'] as const).map(v => (
                <button
                  key={v}
                  className={`dash-tab ${view === v ? 'active' : ''}`}
                  onClick={() => { setView(v); setSelectedEntry(null) }}
                >
                  {v === 'day' ? 'Day' : v === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
            <div className="dash-nav">
              <button className="btn-icon" onClick={() => navigate(-1)} aria-label="Previous">◀</button>
              <span className="dash-period-label">{periodLabel}</span>
              <button className="btn-icon" onClick={() => navigate(1)} aria-label="Next">▶</button>
              <button className="btn btn-ghost btn-small" onClick={goToday}>Today</button>
            </div>
            <div className="dash-filter">
              <label htmlFor="dash-cat-filter" className="sr-only">Filter by Category</label>
              <select
                id="dash-cat-filter"
                className="dash-select"
                value={categoryFilter}
                onChange={e => { setCategoryFilter(e.target.value as CategoryFilter); setSelectedEntry(null) }}
              >
                <option value="all">All Categories</option>
                {CATEGORIES.map(c => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
                <option value="uncategorized">Uncategorized</option>
              </select>
            </div>
          </div>

          {/* Summary */}
          <SummaryBar entries={entriesInPeriod} />

          {/* Main visual */}
          <div className="dash-main">
            {view === 'day' && (
              <DayView
                entries={byDay.get(focusDate) ?? []}
                onSelectEntry={setSelectedEntry}
              />
            )}
            {view === 'week' && (
              <WeekView
                weekDates={currentWeekDates}
                byDay={byDay}
                onSelectDay={handleSelectDay}
              />
            )}
            {view === 'month' && (
              <MonthView
                year={focusYM.year}
                month={focusYM.month}
                byDay={byDay}
                onSelectDay={handleSelectDay}
              />
            )}
          </div>

          {/* Detail panel */}
          {selectedEntry && (
            <div className="detail-overlay">
              <SessionDetail
                entry={selectedEntry}
                onClose={() => setSelectedEntry(null)}
                onDelete={handleDelete}
                onUpdateOverride={handleUpdateOverride}
                onClearOverride={handleClearOverride}
                isDemo={mode === 'demo'}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
