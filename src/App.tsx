import { useRef, useState, useEffect } from 'react'
import {
  useSession,
  formatTime,
} from './useSession'
import { DurationPicker } from './DurationPicker'
import { useGaze } from './useGaze'
import { GazeCalibration } from './GazeCalibration'
import modelJson from './model.json'
import {
  type SessionTaskSettings,
  type CalibrationSummary,
  type SessionStatus,
  type TaskRules,
} from './types'
import { loadRulesOrDefault, CATEGORIES } from './taskPreferences'
import { upsertHistoryEntry } from './historyStorage'
import { computeSessionAnalysis } from './sessionAnalysis'
import { Dashboard } from './Dashboard'
import { Topbar, SessionResultPage } from './SessionResultPage'
import './App.css'

// ── Task rule definitions ────────────────────────────────────────────────

const CAT_DESC: Record<string, string> = {
  web_reading: 'Browsing, articles, research',
  study_notes: 'Studying, writing, notetaking',
}

const RULE_KEYS: Array<{ key: keyof TaskRules; label: string }> = [
  { key: 'allowHeadDown', label: 'Allow Head Down' },
  { key: 'allowTabSwitch', label: 'Allow Tab Switch' },
  { key: 'allowWindowBlur', label: 'Allow Window Blur' },
]

// ── Utilities ────────────────────────────────────────────────────────────


// ── SVG Ring Timer ───────────────────────────────────────────────────────

const C = 653.45 // circumference of r=104 circle
const RING_R = 104
const RING_SIZE = 240

function RingTimer({
  remainingMs,
  plannedDurationMs,
  status,
  overtimePending,
}: {
  remainingMs: number
  plannedDurationMs: number
  status: SessionStatus
  overtimePending: boolean
}) {
  const isUnlimited = plannedDurationMs === 0
  const isOvertimeRunning = status === 'overtime' && !overtimePending

  let progress = 0
  if (!isUnlimited && !isOvertimeRunning) {
    progress = Math.min(1, (plannedDurationMs - remainingMs) / plannedDurationMs)
  } else {
    progress = 1
  }

  const dashoffset = C * (1 - progress)

  const timeText = isOvertimeRunning
    ? `+${formatTime(Math.floor(remainingMs / 1000))}`
    : isUnlimited
      ? formatTime(Math.floor(remainingMs / 1000))
      : formatTime(Math.ceil(remainingMs / 1000))

  const subLabel = status === 'paused'
    ? 'Paused'
    : isOvertimeRunning
      ? 'extra time'
      : isUnlimited
        ? 'elapsed · no limit'
        : `left of ${formatTime(Math.ceil(plannedDurationMs / 1000))}`

  const ringClass = [
    'ringwrap',
    status === 'paused' ? 'paused' : '',
    isOvertimeRunning ? 'over' : '',
    isUnlimited ? 'open' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={ringClass}>
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
        <circle
          cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_R}
          className="ring-bg"
        />
        <circle
          cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={RING_R}
          className="ring-fill"
          strokeDasharray={C}
          strokeDashoffset={dashoffset}
        />
      </svg>
      <div className="ring-time">
        <b className="ring-time-num">{timeText}</b>
        <small className="ring-time-sub">{subLabel}</small>
      </div>
    </div>
  )
}

// ── Hash routing ─────────────────────────────────────────────────────────

function parseHash(): { view: 'reading' | 'dashboard'; sessionId: string | null } {
  const hash = window.location.hash
  if (hash === '#dashboard') return { view: 'dashboard', sessionId: null }
  const m = hash.match(/^#session\/(.+)$/)
  if (m) return { view: 'dashboard', sessionId: m[1] }
  return { view: 'reading', sessionId: null }
}

// ── Main App ─────────────────────────────────────────────────────────────

export default function App() {
  const [appView, setAppView] = useState<'reading' | 'dashboard'>(() => parseHash().view)
  const [initialSessionId, setInitialSessionId] = useState<string | null>(() => parseHash().sessionId)

  const {
    status,
    remainingMs,
    plannedDurationMs,
    overtimePending,
    session,
    storageError,
    checkInPending,
    hasStoredData,
    start,
    pause,
    resume,
    finish,
    resetToIdle,
    skipCheckIn,
    keepGoing,
    stopNow,
    deleteData,
    recordEvent,
    articleRef,
  } = useSession()

  const [pickedDurationMs, setPickedDurationMs] = useState(1_800_000)
  const columnRef = useRef<HTMLElement | null>(null)

  const gaze = useGaze({
    sessionStatus: status,
    onSessionEvent: recordEvent,
    getColumnWidth: () => columnRef.current?.clientWidth ?? 0,
  })

  const [devPanelOpen, setDevPanelOpen] = useState(false)
  const [gazeDotVisible, setGazeDotVisible] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [draft, setDraft] = useState<TaskRules>(() => loadRulesOrDefault('web_reading'))
  const [localCheckInAnswer, setLocalCheckInAnswer] = useState<string | null>(null)
  const [localCheckInTime, setLocalCheckInTime] = useState<string | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<import('./types').CategoryId>('web_reading')

  useEffect(() => {
    if (status === 'completed' && session !== null) {
      upsertHistoryEntry({
        session,
        analysis: computeSessionAnalysis(session),
        entryVersion: 1,
      })
    }
  }, [status, session])

  // Auto-skip check-in so the timer is never paused for a prompt
  useEffect(() => {
    if (checkInPending) skipCheckIn()
  }, [checkInPending, skipCheckIn])

  // React to hash changes (session click, back button)
  useEffect(() => {
    const handler = () => {
      const { view, sessionId } = parseHash()
      setAppView(view)
      setInitialSessionId(sessionId)
    }
    window.addEventListener('hashchange', handler)
    window.addEventListener('popstate', handler)
    return () => {
      window.removeEventListener('hashchange', handler)
      window.removeEventListener('popstate', handler)
    }
  }, [])

  if (appView === 'dashboard') {
    return (
      <Dashboard
        onStartNewSession={() => {
          setAppView('reading')
          if (status !== 'idle') resetToIdle()
        }}
        initialSessionId={initialSessionId}
      />
    )
  }

  const errorBanner = storageError ? (
    <div className={`error-banner ${storageError.isLoadError ? '' : 'error-write'}`}>
      ⚠️ {storageError.message}
    </div>
  ) : null

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

  // ── Review page (Step 3) ─────────────────────────────────────────────
  if (status === 'completed' && session !== null) {
    return (
      <SessionResultPage
        session={session}
        errorBanner={errorBanner}
        onNewSession={() => resetToIdle()}
        onDeleteData={deleteData}
        onViewHistory={() => setAppView('dashboard')}
      />
    )
  }

  // ── Setup page (Step 1 — idle) ───────────────────────────────────────
  if (status === 'idle') {
    const buildSessionSettings = (): SessionTaskSettings => ({
      categoryId: selectedCategory,
      rulesVersion: 1,
      rules: { ...draft },
      taskTitle: taskTitle.trim() || undefined,
    })
    const handleStartGaze = () => { void gaze.startTracker() }
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
      <div className="page">
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
        <Topbar
          step={1}
          onViewDashboard={() => setAppView('dashboard')}
          rightContent={hasStoredData ? (
            <button className="btn btn-ghost btn-small" onClick={deleteData}>Delete Data</button>
          ) : undefined}
        />
        <div className="home">
          {/* Hero */}
          <section className="hero">
            <div className="hero-kicker">FOCUS OBSERVATION TOOL</div>
            <h1 className="hero-brand">Notice where your attention goes<em>.</em></h1>
            <p className="hero-tagline">Set up a session for any task. flowfinder records visible signals so you can look back at your own attention—no scores, no judgment.</p>
            <ol className="hero-promises">
              <li><span>01</span>We only observe what you choose</li>
              <li><span>02</span>Pause, keep going, or finish anytime</li>
              <li><span>03</span>Each signal is shown separately</li>
              <li><span>04</span>No raw video saved, no focus score</li>
            </ol>
          </section>

          {/* Form */}
          <div className="form-side">
            {/* Step 1: What are you working on */}
            <div className="form-step">
              <div className="form-step-num">1</div>
              <div className="form-step-body">
                <h2 className="form-step-label">What are you working on?</h2>
                <p className="form-step-help">Anything works—studying, coding, writing, design.</p>
                <input
                  id="task-title"
                  type="text"
                  className="task-title-input"
                  placeholder="e.g. Research paper, Study notes…"
                  value={taskTitle}
                  onChange={e => setTaskTitle(e.target.value)}
                  maxLength={120}
                  aria-label="What are you working on?"
                />
                <div className="cat-cards">
                  {CATEGORIES.map(cat => (
                    <button
                      key={cat.id}
                      type="button"
                      className={`cat-card${selectedCategory === cat.id ? ' selected' : ''}`}
                      onClick={() => {
                        setSelectedCategory(cat.id)
                        setDraft(loadRulesOrDefault(cat.id))
                      }}
                      aria-pressed={selectedCategory === cat.id}
                    >
                      <span className="cat-card-label">{cat.label}</span>
                      <span className="cat-card-desc">{CAT_DESC[cat.id]}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Step 2: What should we notice */}
            <div className="form-step">
              <div className="form-step-num">2</div>
              <div className="form-step-body">
                <h2 className="form-step-label">What should we notice?</h2>
                <p className="form-step-help">Pick the signals you want recorded.</p>
                <div className="task-toggle-list">
                  {RULE_KEYS.map(({ key, label }) => (
                    <label key={key} className="task-toggle-row">
                      <input
                        type="checkbox"
                        checked={draft[key]}
                        onChange={e => {
                          const val = e.target.checked
                          setDraft(d => ({ ...d, [key]: val }))
                        }}
                      />
                      <span className="task-toggle-label">{label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* Step 3: Duration */}
            <div className="form-step">
              <div className="form-step-num">3</div>
              <div className="form-step-body">
                <h2 className="form-step-label">How long?</h2>
                <p className="form-step-help">Pick a preset, type your own, or go with no limit. When time's up, you can keep going.</p>
                <div className="form-step-label" style={{display:'none'}}>Task Setup</div>
                <DurationPicker value={pickedDurationMs} onChange={setPickedDurationMs} />
              </div>
            </div>

            {/* Step 4: Eye Tracking */}
            <div className="form-step">
              <div className="form-step-num">4</div>
              <div className="form-step-body">
                <h2 className="form-step-label">Eye Tracking</h2>
                <div className="gaze-consent-block">
                  <p className="gaze-consent-desc">
                    Estimates gaze position via your camera to measure focus from reading patterns. Requires ~1 min of calibration.
                    Video is processed locally and never saved. Only estimated scores are stored.
                  </p>
                  <div className="gaze-consent-actions">
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={handleStartGaze}
                      disabled={gaze.gazeStatus === 'starting' || gaze.gazeStatus === 'calibrating'}
                    >
                      Enable Eye Tracking
                    </button>
                  </div>
                  {gaze.gazeError && (
                    <p className="camera-error-msg">⚠️ {gaze.gazeError.message}</p>
                  )}
                </div>
              </div>
            </div>

            {/* Start */}
            <div className="start-row">
              <button className="rbtn" onClick={handleNoGazeStart} aria-label="Start session">
                <span className="inner">
                  <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true">
                    <path d="M8 5.5v13l11-6.5z" fill="currentColor"/>
                  </svg>
                  <b>Start</b>
                </span>
              </button>
              <div>
                <h3 className="start-heading">Ready when you are.</h3>
                <span className="start-alt">or enable Eye Tracking above to start with gaze tracking</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Focus page (Step 2 — running / paused / overtime) ──
  const isOvertimeRunning = status === 'overtime' && !overtimePending

  const statusLabel =
    status === 'paused' ? 'Paused'
    : status === 'overtime' && overtimePending ? "Time's Up"
    : status === 'overtime' ? 'Overtime'
    : 'In Progress'

  return (
    <div className="page">
      {errorBanner}
      <Topbar step={2} onViewDashboard={() => setAppView('dashboard')} />
      <div className="sessionv-body">

        {/* Center: timer + controls */}
        <main className="focus-center" ref={articleRef}>
          {/* Task title */}
          <div className="focus-eyebrow">NOW WORKING ON</div>
          <h1 className="focus-title">
            {session?.taskSettings?.taskTitle || taskTitle || 'Focus session'}
          </h1>

          {/* Status */}
          <div className={`focus-status${status === 'running' || status === 'checking_in' ? ' live' : status === 'paused' ? ' paused' : ''}`}>
            <i className={`focus-status-dot focus-status-${status}`} />
            {statusLabel}
          </div>

          {/* Ring timer */}
          <RingTimer
            remainingMs={remainingMs}
            plannedDurationMs={plannedDurationMs}
            status={status}
            overtimePending={overtimePending}
          />

          {/* Circular controls */}
          {!overtimePending && (
            <div className="rcontrols">
              {(status === 'running' || status === 'checking_in') && (
                <>
                  <button className="rc pz" onClick={pause} aria-label="Pause">
                    <span className="circ">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6.5" y="5" width="4" height="14" rx="1" />
                        <rect x="13.5" y="5" width="4" height="14" rx="1" />
                      </svg>
                    </span>
                    Pause
                  </button>
                  <button className="rc st" onClick={finish} aria-label="Finish">
                    <span className="circ">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    </span>
                    Finish
                  </button>
                </>
              )}
              {status === 'paused' && (
                <>
                  <button className="rc pz" onClick={resume} aria-label="Resume">
                    <span className="circ">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M8 5.5v13l11-6.5z" />
                      </svg>
                    </span>
                    Resume
                  </button>
                  <button className="rc st" onClick={finish} aria-label="Finish">
                    <span className="circ">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    </span>
                    Finish
                  </button>
                </>
              )}
              {isOvertimeRunning && (
                <button className="rc st" onClick={finish} aria-label="Finish">
                  <span className="circ">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </span>
                  Finish
                </button>
              )}
            </div>
          )}

          {/* Overtime card */}
          {overtimePending && (
            <div className="timeup">
              <h2 className="timeup-title">Time's up.</h2>
              <p className="timeup-msg">Want to keep going? The timer will count your extra time. You can finish whenever you're ready.</p>
              <div className="timeup-actions">
                <button className="btn btn-primary" onClick={keepGoing}>Keep going</button>
                <button className="btn btn-secondary" onClick={stopNow}>Finish session</button>
              </div>
            </div>
          )}

          {gazeIndicator}

          {gazeLive && (
            <section className="dev-panel" aria-label="Dev Panel" style={{ width: '100%', maxWidth: 480 }}>
              <button
                className="dev-panel-toggle"
                onClick={() => setDevPanelOpen(o => !o)}
                aria-expanded={devPanelOpen}
              >
                {devPanelOpen ? '▲' : '▼'} Dev Panel
              </button>
              {devPanelOpen && (
                <div className="dev-panel-body">{gazeDevRows}</div>
              )}
            </section>
          )}
        </main>

        {/* Right panel: what's observed + decorative check-in */}
        <aside className="panel" ref={columnRef as React.RefObject<HTMLElement>}>
          <p className="panel-ptitle">WHAT'S BEING OBSERVED</p>
          <div className="checkin-deco-card">
            <p className="panel-deco-label">QUICK CHECK-IN</p>
            <p className="checkin-deco-q">Just before this question, was your attention on your task?</p>
            <div className="checkin-deco-opts">
              {['Yes', 'Partly', 'No', 'Not sure'].map(label => (
                <button
                  key={label}
                  className={`panel-checkin-btn${localCheckInAnswer === label ? ' selected' : ''}`}
                  onClick={() => {
                    const elapsedMs = plannedDurationMs === 0
                      ? remainingMs
                      : Math.max(0, plannedDurationMs - remainingMs)
                    setLocalCheckInAnswer(label)
                    setLocalCheckInTime(formatTime(Math.floor(elapsedMs / 1000)))
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className={`checkin-deco-note${localCheckInAnswer ? ' saved' : ''}`}>
              {localCheckInAnswer
                ? `✓ Saved at ${localCheckInTime}: ${localCheckInAnswer}`
                : 'Automatic focus prompts — coming soon'}
            </p>
          </div>
        </aside>

      </div>
    </div>
  )
}
