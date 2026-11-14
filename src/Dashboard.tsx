import { useState, useEffect, useCallback, useRef } from 'react'
import { TimelineChart } from './TimelineChart'
import { buildTimeline } from './timeline'
import { SessionResultPage } from './SessionResultPage'
import {
  loadHistory,
  deleteHistoryEntry,
  updateManualOverride,
  clearManualOverride,
  HISTORY_UPDATED_EVENT,
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
  GRADE_LABELS,
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

// Time-grid constants (matches designer: 6 AM – midnight, 44px/hour)
const H0 = 6         // first visible hour
const H1 = 24        // last hour (exclusive)
const PX = 44        // pixels per hour
const H_TOTAL = (H1 - H0) * PX  // total column height in px
const HOURS = Array.from({ length: H1 - H0 }, (_, i) => H0 + i)

function formatHour(h: number): string {
  if (h === 0 || h === 24) return '12 AM'
  if (h === 12) return '12 PM'
  return h < 12 ? `${h} AM` : `${h - 12} PM`
}

function getBlockGeometry(session: { startedAt: number; durationMs: number }): { top: number; height: number } {
  const start = new Date(session.startedAt)
  const startMins = start.getHours() * 60 + start.getMinutes()
  const top = Math.max(0, (startMins - H0 * 60) / 60 * PX)
  const height = Math.max(28, session.durationMs / 3_600_000 * PX)
  return { top, height }
}

function nowLineTop(): number {
  const now = new Date()
  const mins = now.getHours() * 60 + now.getMinutes()
  if (mins < H0 * 60 || mins >= H1 * 60) return -1
  return (mins - H0 * 60) / 60 * PX
}

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
        <div className="detail-stat-row">
          <span className="detail-stat-label">Source</span>
          <span className="detail-stat-value">{session.source === 'extension' ? 'Browser extension' : 'Web app'}</span>
        </div>
        {session.source === 'extension' && session.pages && session.pages.length > 0 && (
          <div className="detail-stat-row">
            <span className="detail-stat-label">Sites</span>
            <span className="detail-stat-value">{[...new Set(session.pages.map(p => p.host))].join(', ')}</span>
          </div>
        )}
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

      {/* Print */}
      <button
        className="btn btn-secondary btn-small"
        onClick={() => window.print()}
        aria-label="Print Session Details"
      >
        🖨 Print Session Details
      </button>

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

// ── Now-line indicator ────────────────────────────────────────────────────────

function NowLineCal() {
  const [top, setTop] = useState(() => nowLineTop())
  useEffect(() => {
    const id = setInterval(() => setTop(nowLineTop()), 60_000)
    return () => clearInterval(id)
  }, [])
  if (top < 0) return null
  return <div className="cal-nowline" style={{ top }} aria-hidden="true" />
}

// ── Day view — time grid ──────────────────────────────────────────────────────

function DayView({
  date,
  entries,
  onSelectEntry,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: {
  date: string
  entries: HistoryEntry[]
  onSelectEntry: (entry: HistoryEntry) => void
  selectMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const isToday = date === todayString()

  return (
    <div className="cal-tgrid">
      <div className="cal-gutter" aria-hidden="true">
        {HOURS.map(h => (
          <div key={h} className="cal-gh"><span>{formatHour(h)}</span></div>
        ))}
      </div>
      <div className="cal-col-wide" style={{ height: H_TOTAL }}>
        {entries.map(entry => {
          const { session } = entry
          const { top, height } = getBlockGeometry(session)
          const effectiveScore = getEffectiveScore(entry)
          const color = scoreToColor(effectiveScore)
          const title = session.taskSettings?.taskTitle || categoryLabel(session.taskSettings?.categoryId)
          const timeLabel = `${localTimeString(session.startedAt, tz)}${session.endedAt ? ` to ${localTimeString(session.endedAt, tz)}` : ''}`
          const isChecked = selectMode && selectedIds?.has(session.sessionId)
          return (
            <button
              key={session.sessionId}
              className={`cal-blk${isChecked ? ' cal-blk-selected' : ''}`}
              style={{ top, height, background: color.bg }}
              onClick={() => selectMode ? onToggleSelect?.(session.sessionId) : onSelectEntry(entry)}
              aria-label={`${timeLabel}, ${title}, ${formatScore(effectiveScore)}`}
              aria-pressed={selectMode ? isChecked : undefined}
            >
              {isChecked && <span className="cal-blk-check" aria-hidden="true">✓</span>}
              <b className="cal-blk-title">{title}</b>
              {height > 36 && isValidScore(effectiveScore) && (
                <span className="cal-blk-score">{Math.round(effectiveScore as number)}%</span>
              )}
              {height > 56 && (
                <span className="cal-blk-meta">{msToHHMM(session.activeReadingMs)} focus</span>
              )}
            </button>
          )
        })}
        {isToday && <NowLineCal />}
        {entries.length === 0 && (
          <p className="cal-empty-day">No sessions on this day</p>
        )}
      </div>
    </div>
  )
}

// ── Week view — time grid ─────────────────────────────────────────────────────

function WeekView({
  weekDates,
  byDay,
  onSelectDay,
  onSelectEntry,
  selectMode = false,
  selectedIds,
  onToggleSelect,
}: {
  weekDates: string[]
  byDay: Map<string, HistoryEntry[]>
  onSelectDay: (date: string) => void
  onSelectEntry: (entry: HistoryEntry) => void
  selectMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = todayString()

  return (
    <div className="cal-week">
      {/* Column headers */}
      <div className="cal-whead">
        <div className="cal-gh-corner" aria-hidden="true" />
        {weekDates.map((date, i) => {
          const isToday = date === today
          const dayNum = date.slice(8).replace(/^0/, '')
          return (
            <button
              key={date}
              className={`cal-wh${isToday ? ' today' : ''}`}
              onClick={() => onSelectDay(date)}
              aria-label={date}
            >
              <span className="cal-wh-name">{WEEK_DAYS[i]}</span>
              <b className="cal-wh-date">{dayNum}</b>
            </button>
          )
        })}
      </div>

      {/* Scrollable body */}
      <div className="cal-wscroll">
        <div className="cal-gutter" aria-hidden="true">
          {HOURS.map(h => (
            <div key={h} className="cal-gh"><span>{formatHour(h)}</span></div>
          ))}
        </div>
        {weekDates.map(date => {
          const entries = byDay.get(date) ?? []
          const isToday = date === today
          return (
            <div key={date} className="cal-wcol" style={{ height: H_TOTAL }}>
              {entries.map(entry => {
                const { session } = entry
                const { top, height } = getBlockGeometry(session)
                const effectiveScore = getEffectiveScore(entry)
                const color = scoreToColor(effectiveScore)
                const title = session.taskSettings?.taskTitle || categoryLabel(session.taskSettings?.categoryId)
                const timeLabel = localTimeString(session.startedAt, tz)
                const isChecked = selectMode && selectedIds?.has(session.sessionId)
                return (
                  <button
                    key={session.sessionId}
                    className={`cal-blk${isChecked ? ' cal-blk-selected' : ''}`}
                    style={{ top, height, background: color.bg }}
                    onClick={() => selectMode ? onToggleSelect?.(session.sessionId) : onSelectEntry(entry)}
                    aria-label={`${timeLabel}, ${title}, ${formatScore(effectiveScore)}`}
                    aria-pressed={selectMode ? isChecked : undefined}
                    title={`${title} · ${timeLabel} · ${formatScore(effectiveScore)}`}
                  >
                    {isChecked && <span className="cal-blk-check" aria-hidden="true">✓</span>}
                    <b className="cal-blk-title">{title}</b>
                    {height > 36 && isValidScore(effectiveScore) && (
                      <span className="cal-blk-score">{Math.round(effectiveScore as number)}%</span>
                    )}
                    {height > 56 && (
                      <span className="cal-blk-meta">{msToHHMM(session.activeReadingMs)}</span>
                    )}
                  </button>
                )
              })}
              {isToday && <NowLineCal />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Month view ────────────────────────────────────────────────────────────────

const MAX_MONTH_DOTS = 4

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
            // Sort sessions by start time
            const sorted = [...entries].sort((a, b) => a.session.startedAt - b.session.startedAt)
            const hasData = entries.length > 0
            const isToday = date === today
            const dayNum = date.slice(8).replace(/^0/, '')
            const shown = sorted.slice(0, MAX_MONTH_DOTS)
            const overflow = sorted.length - MAX_MONTH_DOTS

            return (
              <button
                key={date}
                className={`month-day-cell ${isToday ? 'month-day-today' : ''} ${hasData ? 'month-day-has-data' : ''}`}
                onClick={() => onSelectDay(date)}
                aria-label={`${date}: ${hasData ? `${entries.length} session${entries.length > 1 ? 's' : ''}` : 'No sessions'}`}
                disabled={!hasData && date > today}
              >
                <span className="month-day-num">{dayNum}</span>
                {hasData && (
                  <span className="month-dots-row">
                    {shown.map(entry => {
                      const score = getEffectiveScore(entry)
                      const color = isValidScore(score) ? scoreToColor(score) : null
                      return (
                        <i
                          key={entry.session.sessionId}
                          className={color ? 'month-dot' : 'month-dot month-dot-hollow'}
                          style={color ? { background: color.bg } : undefined}
                          aria-hidden="true"
                        />
                      )
                    })}
                    {overflow > 0 && (
                      <span className="month-dot-overflow">+{overflow}</span>
                    )}
                  </span>
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
          <span className="summary-avg-row" style={{ color: color.bg }}>
            <span className="summary-stat-value summary-avg-score">
              {Math.round(avg as number)}%
            </span>
            <span className="summary-avg-label">
              {GRADE_LABELS[scoreToGrade(avg as number)]}
            </span>
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
  initialSessionId?: string | null
}

export function Dashboard({ onStartNewSession, initialSessionId }: DashboardProps) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const pageRef = useRef<HTMLDivElement>(null)

  // ── Mode ──────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<DashboardMode>('real')

  // ── View state ────────────────────────────────────────────────────────
  const [view, setView] = useState<ViewMode>('day')
  const [focusDate, setFocusDate] = useState<string>(() => todayString(tz))
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null)

  // ── Multi-select / bulk delete ────────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)

  // ── Data ──────────────────────────────────────────────────────────────
  const [historyData, setHistoryData] = useState<HistoryData>({
    schemaVersion: 1,
    entries: [],
    deletedIds: [],
  })
  const [loadError, setLoadError] = useState<HistoryStorageError | null>(null)
  const [writeError, setWriteError] = useState<HistoryStorageError | null>(null)
  // Bumped when the browser extension syncs sessions in while the Dashboard is open
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    const onUpdated = () => setReloadToken(t => t + 1)
    window.addEventListener(HISTORY_UPDATED_EVENT, onUpdated)
    return () => window.removeEventListener(HISTORY_UPDATED_EVENT, onUpdated)
  }, [])

  // Load data when mode changes (or new sessions arrive)
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
  }, [mode, reloadToken])

  // ── Derived data ──────────────────────────────────────────────────────
  const allEntries = historyData.entries
  const filteredEntries = filterByCategory(allEntries, categoryFilter)
  const byDay = groupEntriesByDay(filteredEntries, tz)

  // Auto-select entry when navigated via #session/{id}; clear when back at #dashboard
  useEffect(() => {
    if (!initialSessionId) { setSelectedEntry(null); return }
    const entry = allEntries.find(e => e.session.sessionId === initialSessionId)
    if (entry) setSelectedEntry(entry)
  }, [initialSessionId, allEntries])

  // Navigate to session detail via hash
  const handleSelectEntry = useCallback((entry: HistoryEntry) => {
    window.location.hash = '#session/' + entry.session.sessionId
  }, [])

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

  const handlePrintCalendar = useCallback(() => {
    const el = pageRef.current
    if (el) el.setAttribute('data-print-cal', '')
    const cleanup = () => {
      if (el) el.removeAttribute('data-print-cal')
      window.removeEventListener('afterprint', cleanup)
    }
    window.addEventListener('afterprint', cleanup)
    window.print()
  }, [])

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
    if (window.location.hash.startsWith('#session/')) {
      window.location.hash = '#dashboard'
    }
  }, [])

  // ── Bulk delete ───────────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
    setConfirmBulk(false)
  }, [])

  const handleBulkDelete = useCallback(() => {
    for (const id of selectedIds) deleteHistoryEntry(id)
    const result = loadHistory()
    if (result.ok) setHistoryData(result.data)
    exitSelectMode()
  }, [selectedIds, exitSelectMode])

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

  // ── Full-screen session view (hash navigation) ────────────────────────
  if (initialSessionId && selectedEntry) {
    return (
      <SessionResultPage
        session={selectedEntry.session}
        onBack={() => { window.location.hash = '#dashboard' }}
        onViewHistory={() => { window.location.hash = '#dashboard' }}
      />
    )
  }

  return (
    <div className="dashboard-page" ref={pageRef}>
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
                  onClick={() => { setView(v); setSelectedEntry(null); exitSelectMode() }}
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
              <button
                className="btn btn-secondary btn-small"
                onClick={handlePrintCalendar}
                aria-label={`Print ${view === 'day' ? 'Day' : view === 'week' ? 'Week' : 'Month'}`}
              >
                🖨 Print {view === 'day' ? 'Day' : view === 'week' ? 'Week' : 'Month'}
              </button>
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
            {/* Bulk-select actions (Day / Week only) */}
            {mode === 'real' && (view === 'day' || view === 'week') && (
              <div className="dash-bulk-bar">
                {!selectMode ? (
                  <button className="btn btn-ghost btn-small" onClick={() => setSelectMode(true)}>
                    Select
                  </button>
                ) : !confirmBulk ? (
                  <>
                    <span className="dash-select-count">{selectedIds.size} selected</span>
                    <button
                      className="btn btn-danger btn-small"
                      disabled={selectedIds.size === 0}
                      onClick={() => setConfirmBulk(true)}
                    >
                      Delete
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={exitSelectMode}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <span className="dash-select-count">Delete {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''}?</span>
                    <button className="btn btn-danger btn-small" onClick={handleBulkDelete}>
                      Confirm
                    </button>
                    <button className="btn btn-ghost btn-small" onClick={() => setConfirmBulk(false)}>
                      Back
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Summary */}
          <SummaryBar entries={entriesInPeriod} />

          {/* Main visual */}
          <div className="dash-main">
            {view === 'day' && (
              <DayView
                date={focusDate}
                entries={byDay.get(focusDate) ?? []}
                onSelectEntry={handleSelectEntry}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
              />
            )}
            {view === 'week' && (
              <WeekView
                weekDates={currentWeekDates}
                byDay={byDay}
                onSelectDay={handleSelectDay}
                onSelectEntry={handleSelectEntry}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
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

          {/* Detail panel — kept for non-hash fallback (demo mode) */}
          {selectedEntry && !initialSessionId && (
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
