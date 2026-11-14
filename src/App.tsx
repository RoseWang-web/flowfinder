import { useRef, useState, useEffect } from 'react'
import { article } from './article'
import {
  useSession,
  formatTime,
} from './useSession'
import { DurationPicker } from './DurationPicker'
import { useGaze } from './useGaze'
import { GazeCalibration } from './GazeCalibration'
import modelJson from './model.json'
import { TimelineChart } from './TimelineChart'
import { buildTimeline } from './timeline'
import {
  CheckInAnswer,
  SessionEvent,
  type Session,
  type CategoryId,
  type TaskRules,
  type SessionTaskSettings,
  type CalibrationSummary,
  type GazeQuality,
} from './types'
import {
  CATEGORIES,
  loadRulesOrDefault,
  saveTaskPreferences,
  clearTaskPreferences,
  getDefaultRules,
} from './taskPreferences'
import { upsertHistoryEntry } from './historyStorage'
import { computeSessionAnalysis } from './sessionAnalysis'
import { Dashboard } from './Dashboard'
import './App.css'

// ── Task rule definitions ────────────────────────────────────────────────

const RULE_KEYS: Array<{ key: keyof TaskRules; label: string }> = [
  { key: 'allowHeadDown', label: 'Allow Head Down' },
  { key: 'allowTabSwitch', label: 'Allow Tab Switch' },
  { key: 'allowWindowBlur', label: 'Allow Window Blur' },
]

// ── Utilities ────────────────────────────────────────────────────────────

function msToDisplay(ms: number): string {
  return formatTime(Math.floor(ms / 1000))
}

function tsToTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function eventLabel(type: SessionEvent['eventType']): string {
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

const GAZE_QUALITY_LABEL: Record<GazeQuality, string> = {
  good: 'Good',
  usable: 'Usable',
  poor: 'Poor',
}

function checkInAnswerLabel(answer: CheckInAnswer | null): string {
  if (!answer) return '—'
  const map: Record<CheckInAnswer, string> = {
    on_task: 'Yes, focused',
    partly: 'Partly',
    off_task: 'No',
    not_sure: 'Not sure',
  }
  return map[answer]
}

/** Save the session (events, calibration, scores; no images) as a JSON file */
function downloadSession(session: Session) {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `flowfinder-session-${new Date(session.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Sub-components ───────────────────────────────────────────────────────

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className="status-badge" style={{ background: color }}>
      {label}
    </span>
  )
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  idle: { label: 'Idle', color: '#6b7280' },
  running: { label: 'In Progress', color: '#16a34a' },
  paused: { label: 'Paused', color: '#d97706' },
  checking_in: { label: 'Checking In', color: '#7c3aed' },
  completed: { label: 'Completed', color: '#6b7280' },
}

function CheckInDialog({
  onAnswer,
  onSkip,
}: {
  onAnswer: (a: CheckInAnswer) => void
  onSkip: () => void
}) {
  const options: { value: CheckInAnswer; label: string }[] = [
    { value: 'on_task', label: 'Yes' },
    { value: 'partly', label: 'Partly' },
    { value: 'off_task', label: 'No' },
    { value: 'not_sure', label: 'Not sure' },
  ]
  return (
    <div className="checkin-overlay">
      <div className="checkin-dialog" role="dialog" aria-modal="true">
        <p className="checkin-question">Was your attention on the reading before this prompt?</p>
        <div className="checkin-options">
          {options.map(o => (
            <button key={o.value} className="btn btn-checkin" onClick={() => onAnswer(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
        <button className="btn btn-skip" onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  )
}

// ── Main App ─────────────────────────────────────────────────────────────

export default function App() {
  const [appView, setAppView] = useState<'reading' | 'dashboard'>('reading')

  const {
    status,
    remainingMs,
    plannedDurationMs,
    session,
    storageError,
    checkInPending,
    hasStoredData,
    start,
    pause,
    resume,
    finish,
    resetToIdle,
    answerCheckIn,
    skipCheckIn,
    deleteData,
    recordEvent,
    articleRef,
  } = useSession()

  const [pickedDurationMs, setPickedDurationMs] = useState(1_800_000)

  // Reading column, used to scale the line-return threshold
  const columnRef = useRef<HTMLElement | null>(null)

  const gaze = useGaze({
    sessionStatus: status,
    onSessionEvent: recordEvent,
    getColumnWidth: () => columnRef.current?.clientWidth ?? 0,
  })

  // ── Dev panel state ──────────────────────────────────────────────────
  const [devPanelOpen, setDevPanelOpen] = useState(false)
  const [gazeDotVisible, setGazeDotVisible] = useState(false)

  // ── Task draft state ─────────────────────────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState<CategoryId>('web_reading')
  const [draft, setDraft] = useState<TaskRules>(() => loadRulesOrDefault('web_reading'))
  const [prefMsg, setPrefMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Save completed session to multi-session history with computed analysis
  useEffect(() => {
    if (status === 'completed' && session !== null) {
      upsertHistoryEntry({
        session,
        analysis: computeSessionAnalysis(session),
        entryVersion: 1,
      })
    }
  }, [status, session])

  // ── Dashboard view (all hooks above, conditional render here) ────────
  if (appView === 'dashboard') {
    return (
      <Dashboard
        onStartNewSession={() => {
          setAppView('reading')
          if (status !== 'idle') resetToIdle()
        }}
      />
    )
  }

  // ── Storage error banner ─────────────────────────────────────────────
  const errorBanner = storageError ? (
    <div className={`error-banner ${storageError.isLoadError ? '' : 'error-write'}`}>
      ⚠️ {storageError.message}
    </div>
  ) : null

  // ── Eye-tracking indicator (reading page) ────────────────────────────
  const gazeLive = gaze.gazeStatus === 'active' || gaze.gazeStatus === 'paused' || gaze.gazeStatus === 'ready'
  const latest = gaze.latest
  const gazeIndicator = gazeLive ? (
    <div className="gaze-indicator" aria-live="polite">
      {gaze.gazeStatus === 'paused' ? 'Eye tracking paused'
        : !latest ? 'Tracking…'
        : latest.status === 'warming_up' ? `Warming up ${latest.windowsSeen}/${latest.windowsNeeded}`
        : latest.status === 'low_quality' ? 'Low gaze signal'
        : 'Eye tracking active'}
    </div>
  ) : null

  const gazeDevRows = (
    <>
      <div className="dev-row">
        <span className="dev-label">Gaze Status</span>
        <span className="dev-value">{gaze.gazeStatus}{gaze.usedSavedBaseline ? ' (saved baseline)' : ''}</span>
      </div>
      <div className="dev-row">
        <span className="dev-label">Estimator</span>
        <span className="dev-value">{latest?.status ?? '—'}</span>
      </div>
      <div className="dev-row dev-row-mono">
        <span className="dev-label">Line returns / Progress</span>
        <span className="dev-value">
          {latest ? `${latest.features.nLineReturns} / ${Math.round(latest.features.xProgress)} px/s` : '—'}
        </span>
      </div>
      <div className="dev-row dev-row-mono">
        <span className="dev-label">Miss rate</span>
        <span className="dev-value">{latest ? `${Math.round(latest.features.missingRatio * 100)}%` : '—'}</span>
      </div>
      <div className="dev-row dev-row-mono">
        <span className="dev-label">Score / Trend</span>
        <span className="dev-value">
          {latest?.status === 'ok' ? `${latest.score.toFixed(3)} / ${latest.trend.toFixed(3)}` : '—'}
        </span>
      </div>
      <label className="dev-row">
        <span className="dev-label">Show gaze dot</span>
        <input
          type="checkbox"
          checked={gazeDotVisible}
          onChange={e => {
            setGazeDotVisible(e.target.checked)
            gaze.setGazeDotVisible(e.target.checked)
          }}
        />
      </label>
      <div className="dev-divider" />
    </>
  )

  // ── Result page ──────────────────────────────────────────────────────
  if (status === 'completed' && session !== null) {
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

    // Events to show (deduplicate scroll noise)
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

    return (
      <div className="page result-page">
        {errorBanner}
        <div className="result-card">
          <h1 className="project-name">flowfinder</h1>
          <div className={`result-icon ${isInterrupted ? 'interrupted' : ''}`}>
            {isInterrupted ? '!' : '✓'}
          </div>
          <h2 className="result-title">
            {isInterrupted ? 'Session Interrupted' : 'Session Complete'}
          </h2>
          {isInterrupted && (
            <p className="result-note">
              The page was refreshed mid-session. Last saved state (as of{' '}
              {tsToTime(session.endedAt ?? session.lastSavedAt)}).
            </p>
          )}

          <div className="result-stats">
            <div className="stat-row">
              <span className="stat-label">
                Active Reading Time
                <span className="stat-label-note">(excludes pause &amp; check-in)</span>
              </span>
              <span className="stat-value">{activeDisplay}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">End Reason</span>
              <span className="stat-value">{endReasonLabel}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">Start Time</span>
              <span className="stat-value">{tsToTime(session.startedAt)}</span>
            </div>
          </div>

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
          <div className="result-section">
            <h3 className="result-section-title">Task Settings</h3>
            {session.taskSettings ? (
              <>
                <div className="result-stats">
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
              </>
            ) : (
              <p className="result-note">No task settings saved for this session.</p>
            )}
          </div>

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
                  <span className="event-time">
                    {msToDisplay(e.elapsedMs)}
                  </span>
                  <span className="event-name">{eventLabel(e.eventType)}</span>
                  {e.eventType === 'page_visibility' && (
                    <span className="event-detail">
                      {e.data?.visible ? 'Visible' : 'Hidden'}
                    </span>
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
            <button className="btn btn-primary" onClick={() => { resetToIdle(); }}>
              New Session
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => setAppView('dashboard')}>
              View History
            </button>
            <button className="btn btn-ghost btn-small" onClick={deleteData}>
              Delete Session Data
            </button>
            <p className="privacy-note">(Personal preferences are not affected)</p>
          </div>
          <p className="privacy-note">Data is stored locally in this browser. No video is saved.</p>
        </div>
      </div>
    )
  }

  // ── Idle page ──────────────────────────────────────────────────────────
  if (status === 'idle') {
    const buildSessionSettings = (): SessionTaskSettings => ({
      categoryId: selectedCategory,
      rulesVersion: 1,
      rules: { ...draft },
    })
    const handleStartGaze = () => {
      void gaze.startTracker()
    }
    const handleGazeCalibrated = (summary: CalibrationSummary) => {
      gaze.completeCalibration()
      start({
        cameraEnabled: false,
        gazeEnabled: true,
        gaze: { calibration: summary, modelCvRocAuc: modelJson.training.cvRocAuc },
        taskSettings: buildSessionSettings(),
        plannedDurationMs: pickedDurationMs,
      })
    }
    const handleNoGazeStart = () => {
      start({ cameraEnabled: false, taskSettings: buildSessionSettings(), plannedDurationMs: pickedDurationMs })
    }

    return (
      <div className="page reading-page">
        {errorBanner}
        {gaze.gazeStatus === 'starting' && (
          <div className="gaze-overlay" role="status">
            <div className="gaze-card">
              <p className="gaze-text">Opening camera and loading eye tracking model… (first run may take a moment)</p>
            </div>
          </div>
        )}
        {gaze.gazeStatus === 'calibrating' && (
          <GazeCalibration
            tracker={gaze.tracker}
            onComplete={handleGazeCalibrated}
            onCancel={gaze.cancel}
          />
        )}
        <header className="reading-header">
          <div className="header-top">
            <div className="project-info">
              <h1 className="project-name">flowfinder</h1>
              <p className="project-desc">Focus Observer</p>
            </div>
            <div className="session-panel">
              <StatusBadge label="Ready" color="#6b7280" />
              <div className="timer-display">
                {pickedDurationMs === 0 ? '∞' : formatTime(pickedDurationMs / 1000)}
              </div>
              <button className="btn btn-ghost btn-small" onClick={() => setAppView('dashboard')}>
                History
              </button>
              {hasStoredData && (
                <button className="btn btn-ghost btn-small" onClick={deleteData}>
                  Delete Data
                </button>
              )}
            </div>
          </div>
        </header>
        <main className="article-container" ref={articleRef}>
          <article className="article">
            <h2 className="article-title">{article.title}</h2>
            <p className="article-subtitle">{article.subtitle}</p>

            {/* Task setup section */}
            <div className="task-setup">
              <div>
                <h3 className="task-setup-title">Task Setup</h3>
                <p className="task-setup-note">Settings are saved for event review. They don't block actions or confirm focus/distraction.</p>
              </div>

              <div className="task-duration-row">
                <label className="task-label">Session Duration</label>
                <DurationPicker value={pickedDurationMs} onChange={setPickedDurationMs} />
              </div>

              <div className="task-category-row">
                <label className="task-label" htmlFor="task-category">Task Category</label>
                <select
                  id="task-category"
                  className="task-select"
                  value={selectedCategory}
                  onChange={e => {
                    const cat = e.target.value as CategoryId
                    setSelectedCategory(cat)
                    setDraft(loadRulesOrDefault(cat))
                    setPrefMsg(null)
                  }}
                >
                  {CATEGORIES.map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
                <span className="task-category-hint">Switching categories will discard unsaved changes</span>
              </div>

              <div className="task-toggle-list">
                {RULE_KEYS.map(({ key, label }) => (
                  <label key={key} className="task-toggle-row">
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={e => {
                        const val = e.target.checked
                        setDraft(d => ({ ...d, [key]: val }))
                        setPrefMsg(null)
                      }}
                    />
                    <span className="task-toggle-label">{label}</span>
                  </label>
                ))}
              </div>

              <div className="task-pref-actions">
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => {
                    const err = saveTaskPreferences(selectedCategory, draft)
                    if (err) setPrefMsg({ type: 'error', text: err.message })
                    else setPrefMsg({ type: 'success', text: 'Default saved for this category.' })
                  }}
                >
                  Save as default
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => {
                    const sysDefault = getDefaultRules(selectedCategory)
                    const err = clearTaskPreferences(selectedCategory)
                    setDraft(sysDefault)
                    if (err) setPrefMsg({ type: 'error', text: `Settings reset to defaults, but ${err.message}` })
                    else setPrefMsg({ type: 'success', text: 'Reset to system defaults.' })
                  }}
                >
                  Reset to default
                </button>
              </div>

              {prefMsg && (
                <p className={`task-pref-msg task-pref-msg-${prefMsg.type}`}>
                  {prefMsg.type === 'success' ? '✓' : '⚠'} {prefMsg.text}
                </p>
              )}
            </div>

            {/* Eye-tracking section */}
            <div className="camera-consent gaze-consent">
              <p className="camera-consent-title">Eye Tracking</p>
              <p className="camera-consent-desc">
                Estimates gaze position via your camera to measure focus from reading patterns. Requires ~1 min of calibration.
                Video is processed locally and never saved. Only estimated scores are stored.
                {selectedCategory !== 'web_reading' && ' This mode is optimized for web reading; accuracy may vary for other task types.'}
              </p>
              <div className="camera-consent-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleStartGaze}
                  disabled={gaze.gazeStatus === 'starting' || gaze.gazeStatus === 'calibrating'}
                >
                  Enable Eye Tracking
                </button>
                <button className="btn btn-secondary" onClick={handleNoGazeStart}>
                  Continue without Eye Tracking
                </button>
              </div>
              {gaze.gazeError && (
                <p className="camera-error-msg">⚠️ {gaze.gazeError.message}</p>
              )}
            </div>

            <div className="article-body">
              {article.paragraphs.map((para, i) => (
                <p key={i} className="article-para">{para}</p>
              ))}
            </div>
          </article>
        </main>
      </div>
    )
  }

  // ── Reading / paused / checking_in ───────────────────────────────────
  const statusMeta = STATUS_META[status] ?? STATUS_META.running
  const isUnlimitedSession = plannedDurationMs === 0
  const progressPct = isUnlimitedSession
    ? 0
    : Math.min(100, ((plannedDurationMs - remainingMs) / plannedDurationMs) * 100)

  return (
    <div className="page reading-page">
      {errorBanner}
      {checkInPending && (
        <CheckInDialog onAnswer={answerCheckIn} onSkip={skipCheckIn} />
      )}
      <header className="reading-header">
        <div className="header-top">
          <div className="project-info">
            <h1 className="project-name">flowfinder</h1>
            <p className="project-desc">Focus Observer</p>
          </div>
          <div className="session-panel">
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
            <div className="timer-display">
              {isUnlimitedSession
                ? formatTime(Math.floor(remainingMs / 1000))
                : formatTime(Math.ceil(remainingMs / 1000))}
            </div>
            {!isUnlimitedSession && (
              <div className="progress-bar-wrap">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
            {gazeIndicator}
            <div className="controls">
              {status === 'running' && (
                <>
                  <button className="btn btn-secondary" onClick={pause} disabled={checkInPending}>
                    Pause
                  </button>
                  <button className="btn btn-danger" onClick={finish} disabled={checkInPending}>
                    End Session
                  </button>
                </>
              )}
              {status === 'paused' && (
                <>
                  <button className="btn btn-primary" onClick={resume} disabled={checkInPending}>
                    Resume
                  </button>
                  <button className="btn btn-danger" onClick={finish} disabled={checkInPending}>
                    End Session
                  </button>
                </>
              )}
              {status === 'checking_in' && (
                <span className="status-hint">Please answer the check-in first</span>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="article-container" ref={articleRef}>
        <article className="article" ref={columnRef}>
          <h2 className="article-title">{article.title}</h2>
          <p className="article-subtitle">{article.subtitle}</p>
          <div className="article-body">
            {article.paragraphs.map((para, i) => (
              <p key={i} className="article-para">{para}</p>
            ))}
          </div>
        </article>

        {/* ── Dev panel (only when eye-tracking is active) ── */}
        {gazeLive && (
          <section className="dev-panel" aria-label="Dev Panel">
            <button
              className="dev-panel-toggle"
              onClick={() => setDevPanelOpen(o => !o)}
              aria-expanded={devPanelOpen}
            >
              {devPanelOpen ? '▲' : '▼'} Dev Panel
            </button>
            {devPanelOpen && (
              <div className="dev-panel-body">
                {gazeDevRows}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}


