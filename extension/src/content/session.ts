/**
 * session.ts — The content script's part of a reading session:
 * shows the dock and tells the engine whether this page is being read.
 */
import type { HistoryEntry } from '@core/historyStorage'
import { isToEngine, type BackgroundMessage, type EngineMessage, type EngineState, type PageState, type ToContent } from '../protocol'
import { detectColumnWidth } from './column'
import { DEFAULT_PREFS, DOCK_PREFS_KEY, Dock, type DockPrefs } from './dock/Dock'

const PREFS_KEY = DOCK_PREFS_KEY
const HEARTBEAT_MS = 2000

const toEngine = <T>(m: EngineMessage) => chrome.runtime.sendMessage({ to: 'engine', ...m }) as Promise<T>
const toBackground = (m: BackgroundMessage) => chrome.runtime.sendMessage({ to: 'background', ...m })

export function pageState(doc: Document = document): PageState {
  return {
    host: location.host,
    visible: doc.visibilityState === 'visible',
    hasFocus: doc.hasFocus(),
    columnWidthPx: detectColumnWidth(doc),
  }
}

export async function startSessionUi(): Promise<void> {
  // Top frame only: one dock per tab
  if (window.top !== window) return
  // A dock left behind by an older copy of the extension (reloaded / updated) no longer updates
  document.querySelectorAll('flowfinder-dock').forEach(el => el.remove())
  document.getElementById('flowfinder-dock-fonts')?.remove()

  let dock: Dock | null = null
  let phase: EngineState['phase'] = 'idle'
  let heartbeat: ReturnType<typeof setInterval> | null = null

  const got = (await chrome.storage.local.get(PREFS_KEY).catch(() => ({}))) as Record<string, unknown>
  const stored = got[PREFS_KEY] as Partial<DockPrefs> | undefined
  const prefs: DockPrefs = { ...DEFAULT_PREFS, ...(stored ?? {}) }

  const report = () => {
    if (phase !== 'running') return
    void toEngine({ type: 'page_state', page: pageState() }).catch(() => {})
  }

  const onState = (state: EngineState) => {
    phase = state.phase
    const show = state.phase === 'running' || state.phase === 'finished'
    if (show && !dock) {
      dock = new Dock({
        engine: type => { void toEngine({ type }).catch(() => {}) },
        openHistory: () => { void toBackground({ type: 'open_history' }) },
        recalibrate: () => { void toBackground({ type: 'open_recalibration' }) },
        exportEntry: () => toEngine<HistoryEntry | null>({ type: 'get_export' }).catch(() => null),
        savePrefs: p => { void chrome.storage.local.set({ [PREFS_KEY]: p }) },
        fontUrl: path => chrome.runtime.getURL(path),
      }, prefs)
    }
    dock?.update(state)
    if (!show && dock) { dock.destroy(); dock = null }

    if (state.phase === 'running' && heartbeat === null) {
      heartbeat = setInterval(report, HEARTBEAT_MS)
      report()
    } else if (state.phase !== 'running' && heartbeat !== null) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  chrome.runtime.onMessage.addListener((msg: ToContent | unknown) => {
    if (isToEngine(msg)) return // not for us
    const m = msg as ToContent
    if (m?.type === 'engine_state') onState(m.state)
    else if (m?.type === 'toggle_dock') dock?.toggle()
  })

  // The popup can hide / show the floating timer
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(PREFS_KEY in changes)) return
    Object.assign(prefs, changes[PREFS_KEY].newValue ?? {})
    dock?.setPrefs(prefs)
  })

  for (const ev of ['focus', 'blur'] as const) window.addEventListener(ev, report)
  document.addEventListener('visibilitychange', report)

  // A session may already be running when this page loads
  try { onState(await toEngine<EngineState>({ type: 'get_state' })) } catch { /* no engine = idle */ }
}
