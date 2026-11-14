import { useState, useEffect, useCallback } from 'react'
import { TimelineChart } from './TimelineChart'
import { buildTimeline } from './timeline'
import {
  loadHistory,
  deleteHistoryEntry,
  type HistoryData,
  type HistoryEntry,
  type HistoryStorageError,
} from './historyStorage'
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

const WEEK_DAYS = ['一', '二', '三', '四', '五', '六', '日']

function endReasonLabel(r: Session['endReason']): string {
  if (r === 'time_up') return '時間到'
  if (r === 'manual') return '提前結束'
  if (r === 'interrupted') return '已中斷'
  return '—'
}

function categoryLabel(categoryId: string | undefined): string {
  if (!categoryId) return '未分類'
  return CATEGORIES.find(c => c.id === categoryId)?.label ?? categoryId
}

// ── Score badge ───────────────────────────────────────────────────────────────

function ScoreBadge({ score, size = 'sm' }: { score: number | null; size?: 'sm' | 'md' }) {
  const color = scoreToColor(score)
  const display = isValidScore(score) ? String(Math.round(score as number)) : '—'
  return (
    <span
      className={`score-badge score-badge-${size}`}
      style={{ background: color.bg, color: color.text }}
      aria-label={`分數 ${display}`}
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
  isDemo,
}: {
  entry: HistoryEntry
  onClose: () => void
  onDelete: (sessionId: string) => void
  isDemo: boolean
}) {
  const { session, analysis } = entry
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [showTimeline, setShowTimeline] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const color = scoreToColor(analysis.totalScore)
  const timelineData = buildTimeline(session)

  return (
    <div className="detail-panel" role="dialog" aria-modal="true" aria-label="閱讀場次詳情">
      <div className="detail-header">
        <h3 className="detail-title">場次詳情</h3>
        <button className="btn-icon" onClick={onClose} aria-label="關閉">✕</button>
      </div>

      {/* Score hero */}
      <div className="detail-score-hero" style={{ background: color.light, borderColor: color.bg }}>
        <ScoreBadge score={analysis.totalScore} size="md" />
        <div className="detail-score-info">
          {isValidScore(analysis.totalScore) ? (
            <>
              <span className="detail-score-grade">
                {['green','yellow','orange','red'].includes(scoreToGrade(analysis.totalScore as number))
                  ? (['優秀','良好','普通','偏低'] as const)[['green','yellow','orange','red'].indexOf(scoreToGrade(analysis.totalScore as number))]
                  : ''}
              </span>
              {analysis.summary && (
                <p className="detail-score-summary">{analysis.summary}</p>
              )}
            </>
          ) : (
            <p className="detail-score-summary">尚無分析結果</p>
          )}
        </div>
      </div>

      {analysis.source === 'mock' && (
        <p className="detail-mock-note">⚠ 示範資料，非真實分析</p>
      )}

      <div className="detail-stats">
        <div className="detail-stat-row">
          <span className="detail-stat-label">開始時間</span>
          <span className="detail-stat-value">{localDateTimeString(session.startedAt, tz)}</span>
        </div>
        {session.endedAt && (
          <div className="detail-stat-row">
            <span className="detail-stat-label">結束時間</span>
            <span className="detail-stat-value">{localDateTimeString(session.endedAt, tz)}</span>
          </div>
        )}
        <div className="detail-stat-row">
          <span className="detail-stat-label">閱讀計時</span>
          <span className="detail-stat-value">{msToHHMM(session.activeReadingMs)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">本次經過</span>
          <span className="detail-stat-value">{msToHHMM(session.durationMs)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">結束原因</span>
          <span className="detail-stat-value">{endReasonLabel(session.endReason)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">任務分類</span>
          <span className="detail-stat-value">{categoryLabel(session.taskSettings?.categoryId)}</span>
        </div>
        <div className="detail-stat-row">
          <span className="detail-stat-label">攝影機</span>
          <span className="detail-stat-value">{session.cameraEnabled ? '已啟用' : '未使用'}</span>
        </div>
        {analysis.scoringVersion && (
          <div className="detail-stat-row">
            <span className="detail-stat-label">分析版本</span>
            <span className="detail-stat-value">{analysis.scoringVersion}</span>
          </div>
        )}
      </div>

      <p className="detail-disclaimer">
        每場顏色代表整場估計分數，不代表其中每一分鐘的狀態。
        顏色分級僅為介面輔助，非經驗證的醫學或心理分界。
      </p>

      {/* Timeline toggle */}
      <button
        className="btn btn-secondary btn-small detail-expand-btn"
        onClick={() => setShowTimeline(v => !v)}
      >
        {showTimeline ? '▲' : '▼'} 觀察時間軸
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
        {showEvents ? '▲' : '▼'} 事件紀錄
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

      {/* Delete */}
      {!isDemo && (
        <div className="detail-delete">
          {!confirmDelete ? (
            <button
              className="btn btn-ghost btn-small"
              onClick={() => setConfirmDelete(true)}
            >
              刪除此紀錄
            </button>
          ) : (
            <div className="detail-delete-confirm">
              <p>確定要刪除此紀錄嗎？刪除後無法復原。</p>
              <div className="detail-delete-buttons">
                <button
                  className="btn btn-primary btn-small"
                  style={{ background: '#dc2626' }}
                  onClick={() => onDelete(session.sessionId)}
                >
                  確定刪除
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => setConfirmDelete(false)}
                >
                  取消
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
    return <p className="dash-empty-day">當日無紀錄</p>
  }

  return (
    <div className="day-view">
      {sorted.map(entry => {
        const { session, analysis } = entry
        const color = scoreToColor(analysis.totalScore)
        return (
          <button
            key={session.sessionId}
            className="day-session-card"
            style={{ borderLeftColor: color.bg }}
            onClick={() => onSelectEntry(entry)}
            aria-label={`場次 ${localTimeString(session.startedAt, tz)}, 分數 ${formatScore(analysis.totalScore)}`}
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
            <ScoreBadge score={analysis.totalScore} />
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
            aria-label={`${date} ${hasData ? formatScore(avg) + '分' : '無紀錄'}`}
          >
            <span className="week-day-name">{WEEK_DAYS[i]}</span>
            <span className="week-day-date">{date.slice(8)}</span>
            {hasData ? (
              <>
                <ScoreBadge score={avg} />
                <span className="week-day-active">{msToHHMM(totalActive)}</span>
                <span className="week-day-count">{entries.length}場</span>
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
                aria-label={`${date} ${hasData ? formatScore(avg) + '分' : '無紀錄'}`}
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
                  <span className="month-day-score">{Math.round(avg as number)}</span>
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
        <span className="summary-stat-label">場次</span>
      </div>
      <div className="summary-stat">
        <span className="summary-stat-value">{msToHHMM(summary.totalActiveMs)}</span>
        <span className="summary-stat-label">閱讀計時</span>
      </div>
      <div className="summary-stat">
        <span className="summary-stat-value">{msToHHMM(summary.eligibleActiveMs)}</span>
        <span className="summary-stat-label">計分時長</span>
      </div>
      <div className="summary-stat">
        {isValidScore(avg) ? (
          <span
            className="summary-stat-value summary-avg-score"
            style={{ color: color.bg }}
          >
            {Math.round(avg as number)}
          </span>
        ) : (
          <span className="summary-stat-value summary-avg-score summary-avg-none">—</span>
        )}
        <span className="summary-stat-label">加權平均</span>
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

  // ── Period label ──────────────────────────────────────────────────────
  const periodLabel = (() => {
    if (view === 'day') {
      const isToday = focusDate === todayString(tz)
      const isTomorrow = focusDate === addDays(todayString(tz), 1)
      const isYesterday = focusDate === addDays(todayString(tz), -1)
      if (isToday) return '今天'
      if (isYesterday) return '昨天'
      if (isTomorrow) return '明天'
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
          <span className="dash-local-badge">本機模式</span>
        </div>
        <div className="dash-header-right">
          <button className="btn btn-primary btn-small" onClick={onStartNewSession}>
            開始新閱讀
          </button>
        </div>
      </header>

      {/* Mode toggle */}
      <div className="dash-mode-bar">
        <button
          className={`dash-mode-btn ${mode === 'real' ? 'active' : ''}`}
          onClick={() => { setMode('real'); setSelectedEntry(null) }}
        >
          我的紀錄
        </button>
        <button
          className={`dash-mode-btn ${mode === 'demo' ? 'active' : ''}`}
          onClick={() => { setMode('demo'); setSelectedEntry(null) }}
        >
          示範資料
        </button>
        {mode === 'demo' && (
          <span className="demo-label" role="status">示範資料，非真實分析</span>
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
          <h2 className="dash-empty-title">尚無閱讀紀錄</h2>
          <p className="dash-empty-desc">完成第一場閱讀後，紀錄會出現在這裡。</p>
          <div className="dash-empty-actions">
            <button className="btn btn-primary" onClick={onStartNewSession}>
              開始新閱讀
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setMode('demo')}
            >
              查看示範資料
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
                  {v === 'day' ? '日' : v === 'week' ? '週' : '月'}
                </button>
              ))}
            </div>
            <div className="dash-nav">
              <button className="btn-icon" onClick={() => navigate(-1)} aria-label="上一個">◀</button>
              <span className="dash-period-label">{periodLabel}</span>
              <button className="btn-icon" onClick={() => navigate(1)} aria-label="下一個">▶</button>
              <button className="btn btn-ghost btn-small" onClick={goToday}>今天</button>
            </div>
            <div className="dash-filter">
              <label htmlFor="dash-cat-filter" className="sr-only">分類篩選</label>
              <select
                id="dash-cat-filter"
                className="dash-select"
                value={categoryFilter}
                onChange={e => { setCategoryFilter(e.target.value as CategoryFilter); setSelectedEntry(null) }}
              >
                <option value="all">全部分類</option>
                {CATEGORIES.map(c => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
                <option value="uncategorized">未分類</option>
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
                isDemo={mode === 'demo'}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
