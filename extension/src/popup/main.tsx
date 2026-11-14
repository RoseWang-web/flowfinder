import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Popup, type PopupApi } from './Popup'
import { isToBackground, type EngineState, type SessionSetup, type ToBackground, type ToEngine } from '../protocol'
import { DEFAULT_PREFS, DOCK_PREFS_KEY, type DockPrefs } from '../content/dock/prefs'
import '../ui/theme.css'
import './popup.css'

const SETUP_KEY = 'flowfinder_popup_setup_v1'
const send = <T,>(m: ToBackground | ToEngine) => chrome.runtime.sendMessage(m) as Promise<T>

const api: PopupApi = {
  async activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return { id: tab?.id ?? null, title: tab?.title ?? '' }
  },
  async loadSetup() {
    const r = await chrome.storage.local.get(SETUP_KEY)
    return (r[SETUP_KEY] as Partial<SessionSetup> | undefined) ?? null
  },
  async saveSetup(s) {
    // The task name comes from the tab each time; remember the rest
    const { task: _task, ...rest } = s
    await chrome.storage.local.set({ [SETUP_KEY]: rest })
  },
  async engineState() {
    try { return await send<EngineState>({ to: 'engine', type: 'get_state' }) } catch { return null } // no engine = idle
  },
  async start(setup, originTabId) {
    await send({ to: 'background', type: 'start_session', setup, originTabId })
  },
  async cancel() {
    await send({ to: 'engine', type: 'cancel' }).catch(() => {})
  },
  openHistory() { void send({ to: 'background', type: 'open_history' }) },
  recalibrate() { void send({ to: 'background', type: 'open_recalibration' }) },
  close() { window.close() },
  onEngineState(listener) {
    // The engine broadcasts its state to the background every second; listen in
    const onMessage = (m: unknown) => {
      if (isToBackground(m) && m.type === 'state') listener(m.state)
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  },
  async engineAction(a) {
    await send({ to: 'engine', type: a }).catch(() => {})
  },
  async dockHidden() {
    const r = await chrome.storage.local.get(DOCK_PREFS_KEY)
    return (r[DOCK_PREFS_KEY] as Partial<DockPrefs> | undefined)?.hidden ?? false
  },
  async setDockHidden(hidden) {
    const r = await chrome.storage.local.get(DOCK_PREFS_KEY)
    const prefs = { ...DEFAULT_PREFS, ...(r[DOCK_PREFS_KEY] as Partial<DockPrefs> | undefined), hidden }
    await chrome.storage.local.set({ [DOCK_PREFS_KEY]: prefs })
  },
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup api={api} />
  </StrictMode>,
)
