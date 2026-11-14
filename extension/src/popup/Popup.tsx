/**
 * Popup.tsx — The toolbar popup.
 *   no session      → "1 · Setup popup" from the concept mockup
 *   session running → timer, pause / finish, show / hide the floating timer
 *   just finished   → summary
 * Closes with ✕ or by clicking anywhere outside it.
 */
import { useEffect, useState } from 'react'
import { DEFAULT_SETUP, type EngineState, type SessionSetup } from '../protocol'
import { SessionView, type SessionAction } from './SessionView'

export interface PopupApi {
  /** Title of the tab the user is on (suggested task name) */
  activeTab(): Promise<{ id: number | null; title: string }>
  loadSetup(): Promise<Partial<SessionSetup> | null>
  saveSetup(s: SessionSetup): Promise<void>
  engineState(): Promise<EngineState | null>
  start(setup: SessionSetup, originTabId: number | null): Promise<void>
  cancel(): Promise<void>
  openHistory(): void
  recalibrate(): void
  close(): void
  /** Live engine state (≈ 1/s); returns an unsubscribe function */
  onEngineState(listener: (s: EngineState) => void): () => void
  engineAction(a: SessionAction): Promise<void>
  dockHidden(): Promise<boolean>
  setDockHidden(hidden: boolean): Promise<void>
}

const DURATIONS = [15, 25, 45, 0] as const

export function Popup({ api }: { api: PopupApi }) {
  const [setup, setSetup] = useState<SessionSetup>(DEFAULT_SETUP)
  const [tabId, setTabId] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [engine, setEngine] = useState<EngineState | null>(null)
  const [starting, setStarting] = useState(false)
  const [dockHidden, setDockHiddenState] = useState(false)

  useEffect(() => {
    void (async () => {
      const [tab, saved, state, hidden] = await Promise.all([api.activeTab(), api.loadSetup(), api.engineState(), api.dockHidden()])
      setTabId(tab.id)
      setSetup(s => ({ ...s, ...(saved ?? {}), task: tab.title }))
      if (saved?.durationMin && !(DURATIONS as readonly number[]).includes(saved.durationMin)) setCustom(String(saved.durationMin))
      setEngine(state)
      setDockHiddenState(hidden)
    })()
    return api.onEngineState(setEngine)
  }, [api])

  const toggleDock = (hidden: boolean) => {
    setDockHiddenState(hidden)
    void api.setDockHidden(hidden)
  }

  const act = (a: SessionAction) => {
    void api.engineAction(a)
    if (a === 'dismiss') api.close()
  }

  const set = (patch: Partial<SessionSetup>) => setSetup(s => ({ ...s, ...patch }))

  const pickCustom = (v: string) => {
    setCustom(v)
    const n = Number(v)
    if (Number.isInteger(n) && n >= 1 && n <= 240) set({ durationMin: n })
  }

  const start = async () => {
    setStarting(true)
    await api.saveSetup(setup)
    await api.start(setup, tabId)
    api.close()
  }

  const inSession = engine?.phase === 'running' || engine?.phase === 'finished'
  const busy = engine && !inSession && engine.phase !== 'idle'
  const customSelected = custom !== '' && setup.durationMin === Number(custom)

  return (
    <div className="popup" role="dialog" aria-label="flowfinder">
      <div className="pophead">
        <span className="brand">flowfinder<em>.</em></span>
        <span className="headright">
          <button type="button" className="link" onClick={() => api.openHistory()}>History ↗</button>
          <button type="button" className="closebtn" aria-label="Close" title="Close" onClick={() => api.close()}>✕</button>
        </span>
      </div>

      {inSession && engine ? (
        <SessionView
          state={engine}
          dockHidden={dockHidden}
          onAction={act}
          onDockHidden={toggleDock}
          onHistory={() => api.openHistory()}
          onRecalibrate={() => { api.recalibrate(); api.close() }}
        />
      ) : busy ? (
        <div className="popbody">
          <p className="status">
            {engine.phase === 'preparing' && 'Starting the camera…'}
            {engine.phase === 'calibrating' && 'Calibration is open in another tab.'}
            {engine.phase === 'needs_permission' && 'Allow camera access in the tab that opened, then the session starts.'}
            {engine.phase === 'error' && (engine.message || 'Something went wrong.')}
          </p>
          <button type="button" className="btn-ghost" onClick={() => void api.cancel().then(() => api.close())}>Cancel</button>
        </div>
      ) : (
        <div className="popbody">
          <div className="plabel">WORKING ON</div>
          <input className="pin" aria-label="Working on" value={setup.task} onChange={e => set({ task: e.target.value })} />
          <div className="suggest">Suggested from this tab · edit anytime</div>

          <div className="plabel">NOTICE</div>
          <div className="chips">
            <Toggle on={setup.stayInFrame} onChange={v => set({ stayInFrame: v })}>Stay in frame</Toggle>
            <Toggle on={setup.tabActivity} onChange={v => set({ tabActivity: v })}>Tab activity</Toggle>
            <Toggle on={setup.screenAttention} onChange={v => set({ screenAttention: v })}>
              Screen attention <small>· beta</small>
            </Toggle>
          </div>
          {setup.screenAttention && <div className="suggest">Screen attention needs a 1-minute calibration first.</div>}

          <div className="plabel">HOW LONG</div>
          <div className="chips">
            {DURATIONS.map(m => (
              <button
                key={m}
                type="button"
                className={!customSelected && setup.durationMin === m ? 'chip sel' : 'chip'}
                onClick={() => { setCustom(''); set({ durationMin: m }) }}
              >
                {m === 0 ? '∞' : m}
              </button>
            ))}
            <label className={customSelected ? 'chip sel' : 'chip'}>
              <input type="number" min={1} max={240} placeholder="__" aria-label="Custom minutes" value={custom} onChange={e => pickCustom(e.target.value)} /> min
            </label>
          </div>

          <div className="popstart">
            <button type="button" className="rbtn" aria-label="Start session" disabled={starting} onClick={() => void start()}>
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor" /></svg>
            </button>
            <div>
              <b>Start session</b>
              <small>
                {setup.stayInFrame || setup.screenAttention
                  ? 'Camera permission comes next. Frames stay on this device. A small timer will float on your page.'
                  : 'No camera this time. A small timer will float on your page.'}
              </small>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Toggle({ on, onChange, children }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button type="button" className={on ? 'chip sel' : 'chip'} aria-pressed={on} onClick={() => onChange(!on)}>
      {on && '✓ '}{children}
    </button>
  )
}
