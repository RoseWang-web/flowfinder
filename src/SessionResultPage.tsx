import React from 'react'
import {
  CheckInAnswer,
  SessionEvent,
  type Session,
  type TaskRules,
  type SessionTaskSettings,
  type GazeQuality,
} from './types'
import { CATEGORIES } from './taskPreferences'
import { TimelineChart } from './TimelineChart'
import { buildTimeline } from './timeline'
import { formatTime } from './useSession'

// ── Helpers ───────────────────────────────────────────────────────────────

export function msToDisplay(ms: number): string {
  return formatTime(Math.floor(ms / 1000))
}

export function tsToTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function eventLabel(type: SessionEvent['eventType']): string {
  const map: Record<SessionEvent['eventType'], string> = {
    session_start: 'Session Started',
    session_pause: 'Paused',
    session_resume: 'Resumed',
    session_end: 'Ended',
    page_visibility: 'Page Visibility Changed',
    scroll: 'Scroll',
    check_in_shown: 'Check-in Shown',
    check_in_answered: 'Check-in Answered',
    check_in_skipped: 'Check-in Skipped',
    session_interrupted: 'Interrupted (Page Reload)',
    camera_started: 'Camera Started',
    camera_stopped: 'Camera Stopped',
    camera_error: 'Camera Error',
    face_detection_changed: 'Face Detection Changed',
    attention_score: 'Attention Score',
    gaze_error: 'Eye Tracking Error',
  }
  return map[type] ?? type
}

export const GAZE_QUALITY_LABEL: Record<GazeQuality, string> = {
  good: 'Good',
  usable: 'Usable',
  poor: 'Poor',
}

export function checkInAnswerLabel(answer: CheckInAnswer | null): string {
  if (!answer) return '—'
  const map: Record<CheckInAnswer, string> = {
    on_task: 'Yes, focused',
    partly: 'Partly',
    off_task: 'No',
    not_sure: 'Not sure',
  }
  return map[answer]
}

export function downloadSession(session: Session) {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `flowfinder-session-${new Date(session.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}

const RULE_KEYS: Array<{ key: keyof TaskRules; label: string }> = [
  { key: 'allowHeadDown', label: 'Allow Head Down' },
  { key: 'allowTabSwitch', label: 'Allow Tab Switch' },
  { key: 'allowWindowBlur', label: 'Allow Window Blur' },
]

// ── Topbar ────────────────────────────────────────────────────────────────

function stepClass(stepNum: number, current: number): string {
  if (stepNum === current) return 'step-pill active'
  if (stepNum < current) return 'step-pill done'
  return 'step-pill'
}

export function Topbar({
  step,
  onViewDashboard,
  rightContent,
}: {
  step: 1 | 2 | 3
  onViewDashboard: () => void
  rightContent?: React.ReactNode
}) {
  return (
    <header className="topbar">
      <div className="topbar-brand">flowfinder<em>.</em></div>
      <nav className="step-nav" aria-label="Session steps">
        <span className={stepClass(1, step)}><i className="step-num">1</i>Set up</span>
        <span className={stepClass(2, step)}><i className="step-num">2</i>Focus</span>
        <span className={stepClass(3, step)}><i className="step-num">3</i>Review</span>
      </nav>
      <div className="topbar-actions">
        {rightContent}
        <button className="btn btn-ghost btn-small" onClick={onViewDashboard}>History</button>
      </div>
    </header>
  )
}

// ── SessionResultPage ─────────────────────────────────────────────────────

interface SessionResultPageProps {
  session: Session
  errorBanner?: React.ReactNode
  /** Show "New Session" button — only for live completed sessions */
  onNewSession?: () => void
  /** Show "Delete Session Data" button — only for live completed sessions */
  onDeleteData?: () => void
  /** Navigate to history view */
  onViewHistory: () => void
  /** Back button label + action — used when viewing from history */
  onBack?: () => void
}

export function SessionResultPage({
  session,
  errorBanner,
  onNewSession,
  onDeleteData,
  onViewHistory,
  onBack,
}: SessionResultPageProps) {
  const isInterrupted = session.endReason === 'interrupted'
  const endReasonLabel =
    session.endReason === 'time_up'
      ? "Time's Up"
      : session.endReason === 'manual'
        ? 'Ended Early'
        : 'Interrupted'

  const checkIn = session.checkIn
  const checkInNeverShown = !checkIn
  const activeDisplay = msToDisplay(session.activeReadingMs)

  const shownEvents = session.events.filter(
    e => e.eventType !== 'scroll' && e.eventType !== 'attention_score',
  )
  const scrollEvents = session.events.filter(e => e.eventType === 'scroll')
  const attentionEvents = session.events.filter(e => e.eventType === 'attention_score')
  const attentionScored = attentionEvents.filter(e => e.data?.status === 'ok').length
  const scrollSummary =
    scrollEvents.length > 0
      ? [{
          id: 'scroll-summary',
          sessionId: session.sessionId,
          eventType: 'scroll' as const,
          elapsedMs: scrollEvents[scrollEvents.length - 1].elapsedMs,
          activeReadingMs: scrollEvents[scrollEvents.length - 1].activeReadingMs,
          data: { count: scrollEvents.length },
        }]
      : []

  const allDisplayEvents = [...shownEvents, ...scrollSummary].sort(
    (a, b) => a.elapsedMs - b.elapsedMs,
  )

  const timelineData = buildTimeline(session)

  const header = onBack ? (
    <header className="topbar">
      <div className="topbar-brand">flowfinder<em>.</em></div>
      <div className="topbar-actions">
        <button className="btn btn-ghost btn-small" onClick={onBack}>← Back</button>
        <button className="btn btn-ghost btn-small" onClick={onViewHistory}>History</button>
      </div>
    </header>
  ) : (
    <Topbar step={3} onViewDashboard={onViewHistory} />
  )

  return (
    <div className="page">
      {errorBanner}
      {header}

      {/* Navy band header */}
      <div className="band">
        <div className="band-kicker">SESSION COMPLETE</div>
        <h1 className={`band-title${isInterrupted ? ' interrupted' : ''}`}>
          {isInterrupted ? 'Session was interrupted.' : "Here's what was recorded."}
        </h1>
        <div className="band-metrics">
          <div className="band-metric">
            <small className="band-metric-label">Active Reading Time</small>
            <b className="band-metric-value">{activeDisplay}</b>
          </div>
          <div className="band-metric">
            <small className="band-metric-label">End Reason</small>
            <b className="band-metric-value">{endReasonLabel}</b>
          </div>
          <div className="band-metric">
            <small className="band-metric-label">Start Time</small>
            <b className="band-metric-value">{tsToTime(session.startedAt)}</b>
          </div>
        </div>
      </div>

      <div className="res-body">
        {isInterrupted && (
          <p className="result-note">
            The page was refreshed mid-session. Last saved state (as of{' '}
            {tsToTime(session.endedAt ?? session.lastSavedAt)}).
          </p>
        )}

        {/* Check-in section */}
        <div className="result-section">
          <h3 className="result-section-title">Mid-Session Check-In</h3>
          {checkInNeverShown ? (
            <p className="result-note">No check-in shown (ended early or interrupted).</p>
          ) : (
            <div className="result-stats">
              <div className="stat-row">
                <span className="stat-label">Prompt Time</span>
                <span className="stat-value">{tsToTime(checkIn.shownAt)}</span>
              </div>
              <div className="stat-row">
                <span className="stat-label">Active Time at Prompt</span>
                <span className="stat-value">{msToDisplay(checkIn.shownActiveReadingMs)}</span>
              </div>
              {checkIn.answer ? (
                <>
                  <div className="stat-row">
                    <span className="stat-label">Answer</span>
                    <span className="stat-value">{checkInAnswerLabel(checkIn.answer)}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Answered At</span>
                    <span className="stat-value">{tsToTime(checkIn.answeredAt!)}</span>
                  </div>
                </>
              ) : checkIn.skipped ? (
                <div className="stat-row">
                  <span className="stat-label">Skipped</span>
                  <span className="stat-value">—</span>
                </div>
              ) : (
                <div className="stat-row">
                  <span className="stat-label">Not Answered</span>
                  <span className="stat-value">—</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Eye-tracking section */}
        {session.gazeEnabled && (
          <div className="result-section">
            <h3 className="result-section-title">Eye Tracking</h3>
            <div className="result-stats">
              {session.gaze && (
                <>
                  <div className="stat-row">
                    <span className="stat-label">Calibration Quality</span>
                    <span className="stat-value">{GAZE_QUALITY_LABEL[session.gaze.calibration.quality]}</span>
                  </div>
                  <div className="stat-row">
                    <span className="stat-label">Avg Accuracy / Precision</span>
                    <span className="stat-value">
                      {session.gaze.calibration.accuracyPx === null ? '—' : Math.round(session.gaze.calibration.accuracyPx)}
                      {' / '}
                      {session.gaze.calibration.precisionPx === null ? '—' : Math.round(session.gaze.calibration.precisionPx)} px
                    </span>
                  </div>
                </>
              )}
              <div className="stat-row">
                <span className="stat-label">Attention Estimates</span>
                <span className="stat-value">{attentionEvents.length} total, {attentionScored} scored</span>
              </div>
            </div>
            {timelineData.checkInAttention && (() => {
              const c = timelineData.checkInAttention
              const focus = (v: number | null) => (v === null ? '—' : (1 - v).toFixed(2))
              return (
                <>
                  <h4 className="result-subtitle">Check-In Comparison</h4>
                  <div className="result-stats">
                    <div className="stat-row">
                      <span className="stat-label">Your Answer</span>
                      <span className="stat-value">{checkInAnswerLabel(c.answer as CheckInAnswer | null)}</span>
                    </div>
                    <div className="stat-row">
                      <span className="stat-label">
                        Attention in 30s before check-in
                        <span className="stat-label-note">({c.nBefore} windows)</span>
                      </span>
                      <span className="stat-value">{focus(c.scoreBefore)}</span>
                    </div>
                    <div className="stat-row">
                      <span className="stat-label">Full session avg</span>
                      <span className="stat-value">{focus(c.sessionMean)}</span>
                    </div>
                  </div>
                </>
              )
            })()}
            <p className="result-note">
              Focus score is a relative measure (1 − distraction score) — best compared against your own baseline. Single sessions cannot validate accuracy; use trends across multiple sessions.
            </p>
            <button className="btn btn-ghost btn-small" onClick={() => downloadSession(session)}>
              Download Session Data (JSON)
            </button>
          </div>
        )}

        {/* Task settings section */}
        {session.taskSettings && (
          <div className="result-section">
            <h3 className="result-section-title">Task Settings</h3>
            <div className="result-stats">
              {(session.taskSettings as SessionTaskSettings & { taskTitle?: string }).taskTitle && (
                <div className="stat-row">
                  <span className="stat-label">Working On</span>
                  <span className="stat-value">{(session.taskSettings as SessionTaskSettings & { taskTitle?: string }).taskTitle}</span>
                </div>
              )}
              <div className="stat-row">
                <span className="stat-label">Category</span>
                <span className="stat-value">
                  {CATEGORIES.find(c => c.id === session.taskSettings!.categoryId)?.label
                    ?? session.taskSettings.categoryId}
                </span>
              </div>
              {RULE_KEYS.map(({ key, label }) => (
                <div key={key} className="stat-row">
                  <span className="stat-label">{label}</span>
                  <span className="stat-value">{session.taskSettings!.rules[key] ? 'Yes' : 'No'}</span>
                </div>
              ))}
            </div>
            <p className="result-note">Settings are saved for event review. Behavioral rules are not yet applied to scoring.</p>
          </div>
        )}

        {/* Timeline chart */}
        <div className="result-section result-section-wide">
          <h3 className="result-section-title">Timeline</h3>
          <TimelineChart data={timelineData} />
        </div>

        {/* Event log */}
        <div className="result-section">
          <h3 className="result-section-title">Event Log</h3>
          <div className="event-list">
            {allDisplayEvents.map(e => (
              <div key={e.id} className="event-row">
                <span className="event-time">{msToDisplay(e.elapsedMs)}</span>
                <span className="event-name">{eventLabel(e.eventType)}</span>
                {e.eventType === 'page_visibility' && (
                  <span className="event-detail">{e.data?.visible ? 'Visible' : 'Hidden'}</span>
                )}
                {e.eventType === 'scroll' && e.data?.count !== undefined && (
                  <span className="event-detail">{String(e.data.count)} scrolls</span>
                )}
                {e.eventType === 'check_in_answered' && (
                  <span className="event-detail">{checkInAnswerLabel(e.data?.answer as CheckInAnswer | null)}</span>
                )}
                {e.eventType === 'face_detection_changed' && e.data?.status != null && (
                  <span className="event-detail">
                    {e.data.status === 'detected' ? 'Face Detected'
                      : e.data.status === 'not_detected' ? 'No Face'
                      : 'Unavailable'}
                  </span>
                )}
                {e.eventType === 'camera_stopped' && e.data?.reason != null && (
                  <span className="event-detail">{String(e.data.reason)}</span>
                )}
                {e.eventType === 'camera_error' && e.data?.kind != null && (
                  <span className="event-detail">{String(e.data.kind)}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="result-actions">
          {onNewSession && (
            <button className="btn btn-primary" onClick={onNewSession}>New Session</button>
          )}
          <button className="btn btn-secondary btn-small" onClick={() => window.print()}>
            Save as PDF
          </button>
          <button className="btn btn-secondary btn-small" onClick={onViewHistory}>
            View History
          </button>
          {onDeleteData && (
            <button className="btn btn-ghost btn-small" onClick={onDeleteData}>
              Delete Session Data
            </button>
          )}
          {onNewSession && (
            <p className="privacy-note">(Personal preferences are not affected)</p>
          )}
        </div>
        <p className="privacy-note">Data is stored locally in this browser. No video is saved.</p>
      </div>
    </div>
  )
}
