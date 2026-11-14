import { article } from './article'
import {
  useSession,
  formatTime,
  READING_DURATION_MS,
} from './useSession'
import { useCamera } from './useCamera'
import { TimelineChart } from './TimelineChart'
import { buildTimeline } from './timeline'
import { CheckInAnswer, SessionEvent } from './types'
import './App.css'

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
  }
  return map[type] ?? type
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

  const {
    cameraStatus,
    faceStatus,
    cameraError,
    videoRef,
    enableCamera,
    disableCamera,
  } = useCamera({
    sessionStatus: status,
    onSessionEvent: recordEvent,
  })

  // ── Storage error banner ─────────────────────────────────────────────
  const errorBanner = storageError ? (
    <div className={`error-banner ${storageError.isLoadError ? '' : 'error-write'}`}>
      ⚠️ {storageError.message}
    </div>
  ) : null

  // ── Camera indicator (reading page) ─────────────────────────────────
  const cameraIndicator = cameraStatus !== 'idle' ? (
    <div className="camera-indicator">
      <div className={`camera-preview-wrap camera-status-${cameraStatus}`}>
        <video
          ref={videoRef}
          className="camera-preview"
          autoPlay
          playsInline
          muted
          aria-label="攝影機預覽"
        />
        {cameraStatus !== 'ready' && (
          <div className="camera-overlay-label">
            {cameraStatus === 'requesting' && '等待權限…'}
            {cameraStatus === 'loading' && '模型載入中…'}
            {cameraStatus === 'off' && '已暫停'}
            {cameraStatus === 'error' && '錯誤'}
          </div>
        )}
      </div>
      {cameraStatus === 'ready' && (
        <div className={`face-status face-status-${faceStatus}`}>
          {faceStatus === 'detected' && '偵測到人臉'}
          {faceStatus === 'not_detected' && '未偵測到人臉'}
          {faceStatus === 'unavailable' && '偵測中…'}
        </div>
      )}
      {cameraError && (
        <p className="camera-error-msg">⚠️ {cameraError.message}</p>
      )}
    </div>
  ) : null

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
    const hasCameraData = session.cameraEnabled === true

    // Events to show (deduplicate scroll noise)
    const shownEvents = session.events.filter(e => e.eventType !== 'scroll')
    const scrollEvents = session.events.filter(e => e.eventType === 'scroll')
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

          {/* Timeline chart */}
          <div className="result-section result-section-wide">
            <h3 className="result-section-title">時間軸</h3>
            <TimelineChart data={timelineData} />
          </div>

          {/* Event log */}
          <div className="result-section">
            <h3 className="result-section-title">事件紀錄</h3>
            {!hasCameraData && (
              <p className="result-note camera-no-data">此紀錄沒有攝影機資料。</p>
            )}
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
            <button className="btn btn-ghost btn-small" onClick={deleteData}>
              刪除本次資料
            </button>
          </div>
          <p className="privacy-note">資料僅保存在目前瀏覽器，不保存影像。</p>
        </div>
      </div>
    )
  }

  // ── Idle page ──────────────────────────────────────────────────────────
  if (status === 'idle') {
    const handleEnableCamera = () => {
      enableCamera()
      start({ cameraEnabled: true })
    }
    const handleNoCameraStart = () => {
      disableCamera()
      start({ cameraEnabled: false })
    }

    return (
      <div className="page reading-page">
        {errorBanner}
        <header className="reading-header">
          <div className="header-top">
            <div className="project-info">
              <h1 className="project-name">flowfinder</h1>
              <p className="project-desc">閱讀觀察工具</p>
            </div>
            <div className="session-panel">
              <StatusBadge label="未開始" color="#6b7280" />
              <div className="timer-display">{formatTime(READING_DURATION_MS / 1000)}</div>
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

            {/* Camera consent section */}
            <div className="camera-consent">
              <p className="camera-consent-title">攝影機輔助（選擇性）</p>
              <p className="camera-consent-desc">
                啟用後可偵測閱讀期間是否有面部出現，僅記錄有無人在螢幕前，不保存任何影像。
              </p>
              <div className="camera-consent-actions">
                <button className="btn btn-primary" onClick={handleEnableCamera}>
                  啟用攝影機
                </button>
                <button className="btn btn-secondary" onClick={handleNoCameraStart}>
                  不使用攝影機繼續
                </button>
              </div>
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
            {/* Camera indicator in header */}
            {cameraIndicator}
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
        <article className="article">
          <h2 className="article-title">{article.title}</h2>
          <p className="article-subtitle">{article.subtitle}</p>
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


