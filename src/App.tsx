import { useRef, useState, useEffect } from 'react'
import { article } from './article'
import {
  useSession,
  formatTime,
  READING_DURATION_MS,
} from './useSession'
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
  { key: 'allowHeadDown', label: '允許低頭' },
  { key: 'allowTabSwitch', label: '允許切換分頁' },
  { key: 'allowWindowBlur', label: '允許視窗失焦' },
]

// ── Utilities ────────────────────────────────────────────────────────────

function msToDisplay(ms: number): string {
  return formatTime(Math.floor(ms / 1000))
}

function tsToTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function eventLabel(type: SessionEvent['eventType']): string {
  const map: Record<SessionEvent['eventType'], string> = {
    session_start: '開始閱讀',
    session_pause: '暫停',
    session_resume: '繼續',
    session_end: '結束',
    page_visibility: '頁面可見性變更',
    scroll: '捲動',
    check_in_shown: '回報提示出現',
    check_in_answered: '回報已回答',
    check_in_skipped: '回報已略過',
    session_interrupted: '已中斷（頁面重新整理）',
    camera_started: '攝影機已啟動',
    camera_stopped: '攝影機已停止',
    camera_error: '攝影機錯誤',
    face_detection_changed: '面部偵測變更',
    attention_score: '專注度估計',
    gaze_error: '眼動追蹤錯誤',
  }
  return map[type] ?? type
}

const GAZE_QUALITY_LABEL: Record<GazeQuality, string> = {
  good: '良好',
  usable: '可用',
  poor: '不足',
}

function checkInAnswerLabel(answer: CheckInAnswer | null): string {
  if (!answer) return '—'
  const map: Record<CheckInAnswer, string> = {
    on_task: '是，在閱讀內容上',
    partly: '部分是',
    off_task: '否',
    not_sure: '不確定',
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
  idle: { label: '未開始', color: '#6b7280' },
  running: { label: '閱讀中', color: '#16a34a' },
  paused: { label: '已暫停', color: '#d97706' },
  checking_in: { label: '回報中', color: '#7c3aed' },
  completed: { label: '已結束', color: '#6b7280' },
}

function CheckInDialog({
  onAnswer,
  onSkip,
}: {
  onAnswer: (a: CheckInAnswer) => void
  onSkip: () => void
}) {
  const options: { value: CheckInAnswer; label: string }[] = [
    { value: 'on_task', label: '是' },
    { value: 'partly', label: '部分是' },
    { value: 'off_task', label: '否' },
    { value: 'not_sure', label: '不確定' },
  ]
  return (
    <div className="checkin-overlay">
      <div className="checkin-dialog" role="dialog" aria-modal="true">
        <p className="checkin-question">提示出現前，你的注意力在閱讀內容上嗎？</p>
        <div className="checkin-options">
          {options.map(o => (
            <button key={o.value} className="btn btn-checkin" onClick={() => onAnswer(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
        <button className="btn btn-skip" onClick={onSkip}>
          略過
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
      {gaze.gazeStatus === 'paused' ? '眼動追蹤已暫停'
        : !latest ? '眼動追蹤中…'
        : latest.status === 'warming_up' ? `暖機中 ${latest.windowsSeen}/${latest.windowsNeeded}`
        : latest.status === 'low_quality' ? '視線訊號不足'
        : '眼動追蹤中'}
    </div>
  ) : null

  const gazeDevRows = (
    <>
      <div className="dev-row">
        <span className="dev-label">眼動狀態</span>
        <span className="dev-value">{gaze.gazeStatus}{gaze.usedSavedBaseline ? '（沿用基準）' : ''}</span>
      </div>
      <div className="dev-row">
        <span className="dev-label">估計狀態</span>
        <span className="dev-value">{latest?.status ?? '—'}</span>
      </div>
      <div className="dev-row dev-row-mono">
        <span className="dev-label">換行 / 速度</span>
        <span className="dev-value">
          {latest ? `${latest.features.nLineReturns} / ${Math.round(latest.features.xProgress)} px/s` : '—'}
        </span>
      </div>
      <div className="dev-row dev-row-mono">
        <span className="dev-label">遺失比例</span>
        <span className="dev-value">{latest ? `${Math.round(latest.features.missingRatio * 100)}%` : '—'}</span>
      </div>
      <div className="dev-row dev-row-mono">
        <span className="dev-label">分數 / 趨勢</span>
        <span className="dev-value">
          {latest?.status === 'ok' ? `${latest.score.toFixed(3)} / ${latest.trend.toFixed(3)}` : '—'}
        </span>
      </div>
      <label className="dev-row">
        <span className="dev-label">顯示視線點</span>
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
        ? '時間到'
        : session.endReason === 'manual'
          ? '提前結束'
          : '已中斷'

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
            {isInterrupted ? '閱讀已中斷' : '閱讀結束'}
          </h2>
          {isInterrupted && (
            <p className="result-note">
              頁面在閱讀途中重新整理，以下為最後保存的紀錄（截至{' '}
              {tsToTime(session.endedAt ?? session.lastSavedAt)}）。
            </p>
          )}

          <div className="result-stats">
            <div className="stat-row">
              <span className="stat-label">
                閱讀計時
                <span className="stat-label-note">（不含暫停及回報時間）</span>
              </span>
              <span className="stat-value">{activeDisplay}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">結束原因</span>
              <span className="stat-value">{endReasonLabel}</span>
            </div>
            <div className="stat-row">
              <span className="stat-label">開始時間</span>
              <span className="stat-value">{tsToTime(session.startedAt)}</span>
            </div>
          </div>

          {/* Check-in section */}
          <div className="result-section">
            <h3 className="result-section-title">中途回報</h3>
            {checkInNeverShown ? (
              <p className="result-note">尚未出現回報提示（提前結束或中斷）。</p>
            ) : (
              <div className="result-stats">
                <div className="stat-row">
                  <span className="stat-label">提示出現時間</span>
                  <span className="stat-value">{tsToTime(checkIn.shownAt)}</span>
                </div>
                <div className="stat-row">
                  <span className="stat-label">提示時閱讀計時</span>
                  <span className="stat-value">{msToDisplay(checkIn.shownActiveReadingMs)}</span>
                </div>
                {checkIn.answer ? (
                  <>
                    <div className="stat-row">
                      <span className="stat-label">回答</span>
                      <span className="stat-value">{checkInAnswerLabel(checkIn.answer)}</span>
                    </div>
                    <div className="stat-row">
                      <span className="stat-label">回答時間</span>
                      <span className="stat-value">{tsToTime(checkIn.answeredAt!)}</span>
                    </div>
                  </>
                ) : checkIn.skipped ? (
                  <div className="stat-row">
                    <span className="stat-label">已略過</span>
                    <span className="stat-value">—</span>
                  </div>
                ) : (
                  <div className="stat-row">
                    <span className="stat-label">未回答</span>
                    <span className="stat-value">—</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Eye-tracking section */}
          {session.gazeEnabled && (
            <div className="result-section">
              <h3 className="result-section-title">眼動追蹤</h3>
              <div className="result-stats">
                {session.gaze && (
                  <>
                    <div className="stat-row">
                      <span className="stat-label">校準品質</span>
                      <span className="stat-value">{GAZE_QUALITY_LABEL[session.gaze.calibration.quality]}</span>
                    </div>
                    <div className="stat-row">
                      <span className="stat-label">平均偏差／抖動</span>
                      <span className="stat-value">
                        {session.gaze.calibration.accuracyPx === null ? '—' : Math.round(session.gaze.calibration.accuracyPx)}
                        {' / '}
                        {session.gaze.calibration.precisionPx === null ? '—' : Math.round(session.gaze.calibration.precisionPx)} px
                      </span>
                    </div>
                  </>
                )}
                <div className="stat-row">
                  <span className="stat-label">專注度估計</span>
                  <span className="stat-value">共 {attentionEvents.length} 筆，有效 {attentionScored} 筆</span>
                </div>
              </div>
              {timelineData.checkInAttention && (() => {
                const c = timelineData.checkInAttention
                const focus = (v: number | null) => (v === null ? '—' : (1 - v).toFixed(2))
                return (
                  <>
                    <h4 className="result-subtitle">回報前後對照</h4>
                    <div className="result-stats">
                      <div className="stat-row">
                        <span className="stat-label">你的回答</span>
                        <span className="stat-value">{checkInAnswerLabel(c.answer as CheckInAnswer | null)}</span>
                      </div>
                      <div className="stat-row">
                        <span className="stat-label">
                          回報前 30 秒的專注度
                          <span className="stat-label-note">（{c.nBefore} 個窗口）</span>
                        </span>
                        <span className="stat-value">{focus(c.scoreBefore)}</span>
                      </div>
                      <div className="stat-row">
                        <span className="stat-label">整段平均專注度</span>
                        <span className="stat-value">{focus(c.sessionMean)}</span>
                      </div>
                    </div>
                  </>
                )
              })()}
              <p className="result-note">
                專注度為相對指標（1 − 分心分數），只適合和自己比較；單次回報無法驗證準確度，累積多次紀錄才能評估。
              </p>
              <button className="btn btn-ghost btn-small" onClick={() => downloadSession(session)}>
                下載本次資料（JSON）
              </button>
            </div>
          )}

          {/* Task settings section */}
          <div className="result-section">
            <h3 className="result-section-title">本次任務設定</h3>
            {session.taskSettings ? (
              <>
                <div className="result-stats">
                  <div className="stat-row">
                    <span className="stat-label">分類</span>
                    <span className="stat-value">
                      {CATEGORIES.find(c => c.id === session.taskSettings!.categoryId)?.label
                        ?? session.taskSettings.categoryId}
                    </span>
                  </div>
                  {RULE_KEYS.map(({ key, label }) => (
                    <div key={key} className="stat-row">
                      <span className="stat-label">{label}</span>
                      <span className="stat-value">{session.taskSettings!.rules[key] ? '是' : '否'}</span>
                    </div>
                  ))}
                </div>
                <p className="result-note">本階段僅保存設定，尚未套用行為回顧規則。</p>
              </>
            ) : (
              <p className="result-note">此紀錄未保存任務設定。</p>
            )}
          </div>

          {/* Timeline chart */}
          <div className="result-section result-section-wide">
            <h3 className="result-section-title">時間軸</h3>
            <TimelineChart data={timelineData} />
          </div>

          {/* Event log */}
          <div className="result-section">
            <h3 className="result-section-title">事件紀錄</h3>
            <div className="event-list">
              {allDisplayEvents.map(e => (
                <div key={e.id} className="event-row">
                  <span className="event-time">
                    {msToDisplay(e.elapsedMs)}
                  </span>
                  <span className="event-name">{eventLabel(e.eventType)}</span>
                  {e.eventType === 'page_visibility' && (
                    <span className="event-detail">
                      {e.data?.visible ? '可見' : '隱藏'}
                    </span>
                  )}
                  {e.eventType === 'scroll' && e.data?.count !== undefined && (
                    <span className="event-detail">共 {String(e.data.count)} 次</span>
                  )}
                  {e.eventType === 'check_in_answered' && (
                    <span className="event-detail">{checkInAnswerLabel(e.data?.answer as CheckInAnswer | null)}</span>
                  )}
                  {e.eventType === 'face_detection_changed' && e.data?.status != null && (
                    <span className="event-detail">
                      {e.data.status === 'detected' ? '偵測到人臉'
                        : e.data.status === 'not_detected' ? '未偵測到人臉'
                        : '不可用'}
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
              開始新一次
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => setAppView('dashboard')}>
              查看紀錄
            </button>
            <button className="btn btn-ghost btn-small" onClick={deleteData}>
              刪除本次資料
            </button>
            <p className="privacy-note">（個人偏好設定不受影響）</p>
          </div>
          <p className="privacy-note">資料僅保存在目前瀏覽器，不保存影像。</p>
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
      })
    }
    const handleNoGazeStart = () => {
      start({ cameraEnabled: false, taskSettings: buildSessionSettings() })
    }

    return (
      <div className="page reading-page">
        {errorBanner}
        {gaze.gazeStatus === 'starting' && (
          <div className="gaze-overlay" role="status">
            <div className="gaze-card">
              <p className="gaze-text">正在開啟攝影機並載入眼動模型…（第一次可能需要數十秒）</p>
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
              <p className="project-desc">閱讀觀察工具</p>
            </div>
            <div className="session-panel">
              <StatusBadge label="未開始" color="#6b7280" />
              <div className="timer-display">{formatTime(READING_DURATION_MS / 1000)}</div>
              <button className="btn btn-ghost btn-small" onClick={() => setAppView('dashboard')}>
                查看紀錄
              </button>
              {hasStoredData && (
                <button className="btn btn-ghost btn-small" onClick={deleteData}>
                  刪除資料
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
                <h3 className="task-setup-title">本次任務設定</h3>
                <p className="task-setup-note">設定用於後續事件回顧；不會封鎖操作，也不代表已確認專注或分心。</p>
              </div>

              <div className="task-category-row">
                <label className="task-label" htmlFor="task-category">任務分類</label>
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
                <span className="task-category-hint">切換分類將丟棄未儲存的修改</span>
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
                    else setPrefMsg({ type: 'success', text: '已儲存此分類的個人預設。' })
                  }}
                >
                  儲存為個人預設
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => {
                    const sysDefault = getDefaultRules(selectedCategory)
                    const err = clearTaskPreferences(selectedCategory)
                    setDraft(sysDefault)
                    if (err) setPrefMsg({ type: 'error', text: `草稿已恢復系統預設，但${err.message}` })
                    else setPrefMsg({ type: 'success', text: '已恢復系統預設。' })
                  }}
                >
                  恢復系統預設
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
              <p className="camera-consent-title">眼動追蹤</p>
              <p className="camera-consent-desc">
                用攝影機估計視線位置，根據換行頻率與閱讀速度估計專注度。開始前需要約 1 分鐘校準。
                影像只在瀏覽器中處理，不保存影像；僅保存估計數值。
                {selectedCategory !== 'web_reading' && ' 此模式為網頁閱讀設計，其他任務分類的估計可能不準。'}
              </p>
              <div className="camera-consent-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleStartGaze}
                  disabled={gaze.gazeStatus === 'starting' || gaze.gazeStatus === 'calibrating'}
                >
                  啟用眼動追蹤
                </button>
                <button className="btn btn-secondary" onClick={handleNoGazeStart}>
                  不使用眼動追蹤繼續
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
  const progressPct = ((READING_DURATION_MS - remainingMs) / READING_DURATION_MS) * 100

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
            <p className="project-desc">閱讀觀察工具</p>
          </div>
          <div className="session-panel">
            <StatusBadge label={statusMeta.label} color={statusMeta.color} />
            <div className="timer-display">{formatTime(Math.ceil(remainingMs / 1000))}</div>
            <div className="progress-bar-wrap">
              <div
                className="progress-bar-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            {gazeIndicator}
            <div className="controls">
              {status === 'running' && (
                <>
                  <button className="btn btn-secondary" onClick={pause} disabled={checkInPending}>
                    暫停
                  </button>
                  <button className="btn btn-danger" onClick={finish} disabled={checkInPending}>
                    提前結束
                  </button>
                </>
              )}
              {status === 'paused' && (
                <>
                  <button className="btn btn-primary" onClick={resume} disabled={checkInPending}>
                    繼續
                  </button>
                  <button className="btn btn-danger" onClick={finish} disabled={checkInPending}>
                    提前結束
                  </button>
                </>
              )}
              {status === 'checking_in' && (
                <span className="status-hint">請先回答回報提示</span>
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
          <section className="dev-panel" aria-label="開發觀察">
            <button
              className="dev-panel-toggle"
              onClick={() => setDevPanelOpen(o => !o)}
              aria-expanded={devPanelOpen}
            >
              {devPanelOpen ? '▲' : '▼'} 開發觀察
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


