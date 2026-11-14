/**
 * SessionView.tsx — The popup while a session runs (or just finished):
 * timer, pause / finish, and a switch for the floating timer on the page.
 */
import type { EngineState } from '../protocol'
import { faceView, fmtClock, statusLine, timerView } from '../content/dock/view'
import { FOCUS_NOTE_TEXT } from '../session/focusNote'

export type SessionAction = 'pause' | 'resume' | 'finish' | 'keep_going' | 'dismiss'

const C = 326.73 // 2π·52

export function SessionView({ state, dockHidden, onAction, onDockHidden, onHistory, onRecalibrate }: {
  state: EngineState
  dockHidden: boolean
  onAction: (a: SessionAction) => void
  onDockHidden: (hidden: boolean) => void
  onHistory: () => void
  onRecalibrate: () => void
}) {
  if (state.phase === 'finished' && state.summary) {
    const s = state.summary
    return (
      <div className="popbody">
        <h2 className="serif title">Session complete</h2>
        <p className="muted task">{s.task}</p>
        <div className="sumstats">
          <div><small>SESSION TIME</small><b>{fmtClock(s.sessionMs)}</b></div>
          <div><small>FOCUS</small><b>{s.focusPercent === null ? '—' : `${s.focusPercent}%`}</b></div>
        </div>
        {s.focusNote && <p className="muted note">{FOCUS_NOTE_TEXT[s.focusNote]}</p>}
        <div className="row2">
          <button type="button" className="btn-solid" onClick={onHistory}>Full review ↗</button>
          <button type="button" className="btn-ghost" onClick={() => onAction('dismiss')}>Done</button>
        </div>
      </div>
    )
  }

  const t = timerView(state)
  const f = faceView(state.face)
  const usesCam = !!state.setup && (state.setup.stayInFrame || state.setup.screenAttention)
  const ringClass = `ringwrap${state.paused ? ' paused' : ''}${state.timeUp ? ' up' : ''}`

  return (
    <div className="popbody">
      <p className="task-title" title={state.setup?.task}>{state.setup?.task}</p>

      {state.timeUpPending && (
        <div className="upnote" role="status">
          <b className="serif">Time's up.</b>
          <span className="muted">Keep going to count extra time, or wrap up.</span>
          <div className="row2">
            <button type="button" className="btn-solid" onClick={() => onAction('keep_going')}>Keep going</button>
            <button type="button" className="btn-ghost" onClick={() => onAction('finish')}>Finish</button>
          </div>
        </div>
      )}

      <div className="ringrow">
        <div className={ringClass}>
          <svg className="bring" viewBox="0 0 120 120" aria-hidden="true">
            <circle className="bg" cx="60" cy="60" r="52" />
            <circle className="fg" cx="60" cy="60" r="52" strokeDasharray={C} strokeDashoffset={C * (1 - t.progress)} />
          </svg>
          <div className="rt"><b>{t.big}</b><small>{t.sub.toLowerCase()}</small></div>
        </div>
        <div className="rcs">
          <button type="button" className="rc pz" onClick={() => onAction(state.paused ? 'resume' : 'pause')}>
            <span className="c">{state.paused ? <PlayIcon /> : <PauseIcon />}</span>{state.paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="rc st" onClick={() => onAction('finish')}>
            <span className="c"><StopIcon /></span>Finish
          </button>
        </div>
      </div>

      {usesCam && <div className="camline"><span className={`camdot ${f.dot}`} />{f.text}</div>}
      <p className="statusline">{statusLine(state)}</p>
      {state.setup?.screenAttention && state.trackingDegraded && !state.recalibrating && (
        <div className="degraded" role="status">
          <span>Your gaze estimate drifted (posture or light changed). Scores are paused until it is steady again.</span>
          <button type="button" className="btn-ghost" onClick={onRecalibrate}>Recalibrate</button>
        </div>
      )}

      <label className="switch">
        <input type="checkbox" checked={!dockHidden} onChange={e => onDockHidden(!e.target.checked)} />
        Show timer on page
      </label>
    </div>
  )
}

const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
)
const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
)
const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
)
