/**
 * Background service worker — glue only; the engine lives in the offscreen document.
 *
 *  - creates / closes the offscreen engine
 *  - opens the calibration tab and the camera-permission tab when needed
 *  - forwards engine state to the active tab's dock and to the toolbar badge
 *  - the toolbar icon always opens the popup (setup, or the running session's controls)
 *  - does chrome.storage for the engine (offscreen documents cannot)
 */
import { findWebApp } from './webApp'
import { badgeFor } from './badge'
import { chromeKV } from './session/historyStore'
import { DEFAULT_PREFS, DOCK_PREFS_KEY, type DockPrefs } from './content/dock/prefs'
import { PING } from './messages'
import { isToBackground, type EngineMessage, type EngineState, type SessionSetup, type StartReply, type ToBackground, type ToContent } from './protocol'

const OFFSCREEN_URL = 'engine/offscreen.html'

// The side panel stays available as a developer tool (Chrome's side panel menu),
// but the toolbar icon opens the popup.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {})

let lastPhase: EngineState['phase'] = 'idle'

// ── Engine (offscreen document) ────────────────────────────────────────
async function hasEngine(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })
  return contexts.length > 0
}

const toEngine = <T>(m: EngineMessage) => chrome.runtime.sendMessage({ to: 'engine', ...m }) as Promise<T>

async function ensureEngine(): Promise<void> {
  if (!(await hasEngine())) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Webcam gaze tracking for the reading session (frames never leave the device).',
    })
  }
  // Wait until its message listener is up
  for (let i = 0; i < 50; i++) {
    try { await toEngine({ type: 'get_state' }); return } catch { await new Promise(r => setTimeout(r, 100)) }
  }
  throw new Error('engine did not start')
}

async function closeEngine(): Promise<void> {
  if (await hasEngine()) await chrome.offscreen.closeDocument().catch(() => {})
}

// ── Content script in tabs that were open before install / update ──────
// Chrome only injects manifest content scripts into pages loaded afterwards,
// so without this the floating timer is missing until the user reloads.
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  await Promise.all(tabs.map(async tab => {
    if (tab.id === undefined) return
    try {
      if ((await chrome.tabs.sendMessage(tab.id, PING)) === 'pong') return
    } catch { /* not injected */ }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {})
  }))
}
chrome.runtime.onInstalled.addListener(() => { void injectIntoOpenTabs() })

/** Every session starts with the small pill visible (corner and fade are kept). */
async function resetDockForNewSession(): Promise<void> {
  const got = await chrome.storage.local.get(DOCK_PREFS_KEY)
  const prefs: DockPrefs = { ...DEFAULT_PREFS, ...(got[DOCK_PREFS_KEY] as Partial<DockPrefs> | undefined), hidden: false, expanded: false }
  await chrome.storage.local.set({ [DOCK_PREFS_KEY]: prefs })
}

// ── Session start (popup / after camera permission) ────────────────────
async function startSession(setup: SessionSetup, originTabId: number | null): Promise<StartReply> {
  await chrome.storage.session.set({ pendingSetup: setup, originTabId })
  await resetDockForNewSession()
  await injectIntoOpenTabs()
  await ensureEngine()
  const reply = await toEngine<StartReply>({ type: 'start', setup })
  if (reply.phase === 'calibrating') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('calibrate/index.html') })
  } else if (reply.phase === 'needs_permission') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('permission/index.html?then=start') })
  } else if (reply.phase === 'running') {
    await returnToOrigin()
  }
  return reply
}

async function returnToOrigin(closeTabId?: number) {
  const { originTabId } = await chrome.storage.session.get('originTabId')
  if (typeof originTabId === 'number') await chrome.tabs.update(originTabId, { active: true }).catch(() => {})
  if (closeTabId !== undefined) await chrome.tabs.remove(closeTabId).catch(() => {})
}

// ── Engine state → badge, popup mode, active tab ───────────────────────
async function onEngineState(state: EngineState) {
  const badge = badgeFor(state)
  await chrome.action.setBadgeText({ text: badge.text })
  if (badge.text) await chrome.action.setBadgeBackgroundColor({ color: badge.color })
  lastPhase = state.phase

  await sendToActiveTab({ type: 'engine_state', state })
  if (state.phase === 'idle') await closeEngine()
}

async function sendToActiveTab(m: ToContent) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id !== undefined) await chrome.tabs.sendMessage(tab.id, m).catch(() => {}) // chrome:// pages etc.
}

// A newly activated tab gets the dock right away instead of on the next tick
chrome.tabs.onActivated.addListener(async () => {
  if (lastPhase === 'idle' || !(await hasEngine())) return
  try { await sendToActiveTab({ type: 'engine_state', state: await toEngine<EngineState>({ type: 'get_state' }) }) } catch { /* engine busy */ }
})

// ── Messages ───────────────────────────────────────────────────────────
async function handle(m: ToBackground, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (m.type) {
    case 'start_session': return startSession(m.setup, m.originTabId)
    case 'state': await onEngineState(m.state); return true
    case 'permission_granted': {
      const { pendingSetup, originTabId } = await chrome.storage.session.get(['pendingSetup', 'originTabId'])
      if (sender.tab?.id !== undefined) await chrome.tabs.remove(sender.tab.id).catch(() => {})
      return pendingSetup ? startSession(pendingSetup as SessionSetup, (originTabId as number | undefined) ?? null) : null
    }
    case 'open_recalibration': {
      // Tracking got noisy mid-session: pause, recalibrate, then come back to this tab
      const reply = await toEngine<StartReply>({ type: 'recalibrate' })
      if (reply.phase === 'calibrating') {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        await chrome.storage.session.set({ originTabId: sender.tab?.id ?? tab?.id ?? null })
        await chrome.tabs.create({ url: chrome.runtime.getURL('calibrate/index.html?mode=recalibrate') })
      }
      return reply
    }
    case 'calibration_done': await returnToOrigin(sender.tab?.id); return true
    case 'calibration_cancelled':
      await toEngine({ type: 'cancel' }).catch(() => {})
      await returnToOrigin(sender.tab?.id)
      return true
    case 'open_history': {
      // The web app's Dashboard when it is running, otherwise the extension's own history page
      const webApp = await findWebApp()
      await chrome.tabs.create({ url: webApp ? `${webApp}/#dashboard` : chrome.runtime.getURL('history/index.html') })
      return true
    }
    case 'kv_get': return chromeKV.get(m.key)
    case 'kv_set': await chromeKV.set(m.key, m.value); return true
    case 'kv_remove': await chromeKV.remove(m.key); return true
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isToBackground(msg)) return
  handle(msg, sender).then(sendResponse, err => sendResponse({ error: String(err) }))
  return true
})
