/**
 * Content script — runs inside the page being read.
 *
 * Draws the calibration / validation dots and the debug gaze dot, and keeps
 * the client↔screen mapping for this page (see coords.ts). All tracking and
 * timing happens in the side panel; this script only reports positions.
 */
import { fitMap, mapFromEvent, reanchor, toClient, toScreen, type MouseLike, type ScreenMap } from '../coords'
import { PING, PORT_NAME, type ContentToPanel, type PageInfo, type PanelToContent } from '../messages'
import { chromeKV } from '../session/historyStore'
import { isFlowFinderApp, startHistorySync } from './historySync'
import { startSessionUi } from './session'

declare global {
  interface Window { __flowfinderGaze?: boolean }
}

if (!window.__flowfinderGaze) {
  window.__flowfinderGaze = true
  main()
  // On the FlowFinder web app itself: copy the extension's sessions into its history
  if (isFlowFinderApp(location.origin, document)) startHistorySync(chromeKV, location.origin)
  // The floating timer + page activity reports for a running session
  void startSessionUi()
}

function main() {
  let port: chrome.runtime.Port | null = null
  let map: ScreenMap | null = null
  let mapSource: PageInfo['mapSource'] = 'none'
  let overlay: HTMLDivElement | null = null
  let gazeDot: HTMLDivElement | null = null
  let gazeDotVisible = false

  const send = (msg: ContentToPanel) => {
    try { port?.postMessage(msg) } catch { /* panel closed */ }
  }

  const info = (): PageInfo => ({
    host: location.host,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    windowScreenX: window.screenX,
    windowScreenY: window.screenY,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    map,
    mapSource,
    hasFocus: document.hasFocus(),
    visible: document.visibilityState === 'visible',
  })
  const sendInfo = () => send({ type: 'info', info: info() })

  // ── Mapping upkeep ────────────────────────────────────────────────────
  let lastMove = 0
  window.addEventListener('mousemove', e => {
    const now = performance.now()
    if (now - lastMove < 200) return
    lastMove = now
    if (map && mapSource === 'calibration') map = reanchor(map, e)
    else { map = mapFromEvent(e); mapSource = 'mouse' }
  }, { passive: true, capture: true })

  const notifyFocus = () => sendInfo()
  window.addEventListener('focus', notifyFocus)
  window.addEventListener('blur', notifyFocus)
  document.addEventListener('visibilitychange', notifyFocus)
  window.addEventListener('resize', notifyFocus)

  // ── DOM helpers ───────────────────────────────────────────────────────
  const Z = '2147483647'

  function ensureOverlay(): HTMLDivElement {
    if (overlay) return overlay
    const el = document.createElement('div')
    Object.assign(el.style, {
      position: 'fixed', inset: '0', zIndex: Z, background: 'rgba(255,255,255,0.92)',
      cursor: 'default', font: '15px system-ui, sans-serif', color: '#222',
    })
    // Block clicks from reaching the page underneath. Bubble phase, so the dots
    // (children of the overlay) still receive their clicks first.
    el.addEventListener('click', e => { e.stopPropagation(); e.preventDefault() })
    el.addEventListener('mousedown', e => e.stopPropagation())
    document.documentElement.appendChild(el)
    overlay = el
    return el
  }

  function clearOverlay() {
    overlay?.remove()
    overlay = null
    window.removeEventListener('keydown', onEscape, true)
  }

  function makeDot(fx: number, fy: number, color: string): HTMLDivElement {
    const d = document.createElement('div')
    Object.assign(d.style, {
      position: 'absolute', width: '28px', height: '28px', borderRadius: '50%',
      left: `calc(${fx * 100}% - 14px)`, top: `calc(${fy * 100}% - 14px)`,
      background: color, border: '3px solid #fff', boxShadow: '0 0 0 2px ' + color,
      boxSizing: 'border-box', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', font: 'bold 12px system-ui, sans-serif',
    })
    return d
  }

  function label(text: string) {
    const l = document.createElement('div')
    Object.assign(l.style, {
      position: 'absolute', left: '50%', top: '38%', transform: 'translateX(-50%)',
      textAlign: 'center', pointerEvents: 'none', maxWidth: '70%',
    })
    l.textContent = text
    return l
  }

  function onEscape(e: KeyboardEvent) {
    if (e.key !== 'Escape') return
    clearOverlay()
    send({ type: 'calib_cancelled' })
  }

  // ── Calibration: one point at a time, N clicks each ─────────────────
  function startCalibration(points: readonly { fx: number; fy: number }[], clicksPerPoint: number) {
    clearOverlay()
    const el = ensureOverlay()
    window.addEventListener('keydown', onEscape, true)
    el.appendChild(label('看著紅點，每個點點 ' + clicksPerPoint + ' 下（Esc 取消）'))
    const clicks: MouseLike[] = []
    let i = 0
    let n = 0

    const show = () => {
      el.querySelectorAll('[data-ff-dot]').forEach(d => d.remove())
      const d = makeDot(points[i].fx, points[i].fy, '#e5484d')
      d.dataset.ffDot = '1'
      d.textContent = String(clicksPerPoint - n)
      d.addEventListener('click', e => {
        clicks.push({ screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY })
        send({ type: 'calib_click', pointIndex: i, clickIndex: n, screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY })
        n++
        if (n < clicksPerPoint) { d.textContent = String(clicksPerPoint - n); return }
        n = 0
        i++
        if (i < points.length) { show(); return }
        const fitted = fitMap(clicks)
        if (fitted) { map = fitted; mapSource = 'calibration' }
        clearOverlay()
        send({ type: 'calib_done', map: fitted })
        sendInfo()
      })
      el.appendChild(d)
    }
    show()
  }

  function showValidationPoint(index: number, p: { fx: number; fy: number }) {
    const el = ensureOverlay()
    el.replaceChildren(label('只要看著藍點，不用點'))
    const d = makeDot(p.fx, p.fy, '#3e63dd')
    d.style.cursor = 'default'
    el.appendChild(d)
    // Report the target in screen space, measured from the rendered dot
    requestAnimationFrame(() => {
      const r = d.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const s = map ? toScreen(map, cx, cy) : { x: -1, y: -1 }
      send({ type: 'validation_target', index, screenX: s.x, screenY: s.y })
    })
  }

  // ── Debug gaze dot ────────────────────────────────────────────────────
  function drawGaze(x: number | null, y: number | null) {
    if (!gazeDotVisible) return
    if (!gazeDot) {
      gazeDot = document.createElement('div')
      Object.assign(gazeDot.style, {
        position: 'fixed', width: '16px', height: '16px', marginLeft: '-8px', marginTop: '-8px',
        borderRadius: '50%', background: 'rgba(229,72,77,0.75)', pointerEvents: 'none', zIndex: Z,
        left: '0', top: '0', transition: 'none',
      })
      document.documentElement.appendChild(gazeDot)
    }
    if (x === null || y === null || !map) { gazeDot.style.display = 'none'; return }
    const c = toClient(map, x, y)
    gazeDot.style.display = 'block'
    gazeDot.style.transform = `translate(${c.x}px, ${c.y}px)`
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg === PING) reply('pong')
  })

  chrome.runtime.onConnect.addListener(p => {
    if (p.name !== PORT_NAME) return
    port?.disconnect()
    port = p
    p.onDisconnect.addListener(() => {
      if (port === p) port = null
      clearOverlay()
      gazeDot?.remove()
      gazeDot = null
    })
    p.onMessage.addListener((msg: PanelToContent) => {
      switch (msg.type) {
        case 'calib_start': startCalibration(msg.points, msg.clicksPerPoint); break
        case 'validation_point': showValidationPoint(msg.index, msg.point); break
        case 'overlay_clear': clearOverlay(); break
        case 'gaze': drawGaze(msg.x, msg.y); break
        case 'gaze_dot':
          gazeDotVisible = msg.visible
          if (!msg.visible && gazeDot) gazeDot.style.display = 'none'
          break
        case 'info_request': sendInfo(); break
      }
    })
    sendInfo()
  })
}
