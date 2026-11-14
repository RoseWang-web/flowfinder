/**
 * Dock.ts — The floating timer on every page ("2 · Mini pill", "3 · Expanded",
 * "5 · Time's up", "6 · Summary" in the concept mockup).
 *
 * Lives in a shadow root so page CSS cannot touch it. The DOM is built once and
 * updated in place every second (a rebuild would break dragging and hover).
 * Design rules kept: only ever in a corner, never takes keyboard focus.
 */
import type { HistoryEntry } from '@core/historyStorage'
import type { EngineState } from '../../protocol'
import { DOCK_CSS, DOCK_SIZE_CSS, fontFaceCss } from './dockStyles'
import { faceView, fmtClock, statusLine, timerView } from './view'
import { exportFileName, toCsv } from './exportFiles'
import { FOCUS_NOTE_TEXT } from '../../session/focusNote'

import { DEFAULT_PREFS, type Corner, type DockPrefs } from './prefs'
export { DEFAULT_PREFS, DOCK_PREFS_KEY, type Corner, type DockPrefs } from './prefs'

export interface DockActions {
  engine(type: 'pause' | 'resume' | 'finish' | 'keep_going' | 'dismiss'): void
  recalibrate(): void
  openHistory(): void
  exportEntry(): Promise<HistoryEntry | null>
  savePrefs(p: DockPrefs): void
  fontUrl(path: string): string
}

const IC = {
  pause: "<svg viewBox='0 0 24 24' width='16' height='16' aria-hidden='true'><rect x='6.5' y='5' width='4' height='14' rx='1' fill='currentColor'/><rect x='13.5' y='5' width='4' height='14' rx='1' fill='currentColor'/></svg>",
  play: "<svg viewBox='0 0 24 24' width='16' height='16' aria-hidden='true'><path d='M8 5.5v13l11-6.5z' fill='currentColor'/></svg>",
  stop: "<svg viewBox='0 0 24 24' width='16' height='16' aria-hidden='true'><rect x='6' y='6' width='12' height='12' rx='2' fill='currentColor'/></svg>",
}
const PILL_C = 100.53 // 2π·16
const BIG_C = 326.73 // 2π·52

const TEMPLATE = `
<div class="root">
 <div class="dock br" data-dock>
  <div class="card up hidden" data-upcard role="status">
   <h4>Time's up.</h4>
   <p>Keep going and the timer will count your extra time, or wrap up now.</p>
   <div class="row2"><button class="b-solid" data-act="keep_going">Keep going</button><button class="b-ghost" data-act="finish">Finish</button></div>
  </div>
  <div class="card hidden" data-summary role="status">
   <h4>Session complete</h4>
   <p data-sum-task></p>
   <div class="sumstats"><div><small>SESSION TIME</small><b data-sum-time>0:00</b></div><div><small>FOCUS</small><b data-sum-focus>—</b></div></div>
   <p class="note hidden" data-sum-note></p>
   <div class="row2"><button class="b-solid" data-act="history">Full review ↗</button><button class="b-ghost" data-act="dismiss">Done</button></div>
   <div class="dl"><span>Download</span><button data-act="json">.json</button><button data-act="csv">.csv</button></div>
  </div>
  <div class="mini hidden" data-mini>
   <div class="minihead" data-handle><span class="logo" style="width:20px;height:20px"><i style="width:7px;height:7px"></i></span><span class="t" data-task>My task</span><button class="ib" data-act="minimize" title="Minimize" aria-label="Minimize">–</button></div>
   <div class="minibody">
    <div class="ringrow">
     <div class="ringwrap" data-bigwrap><svg class="bring" viewBox="0 0 120 120"><circle class="bg" cx="60" cy="60" r="52"/><circle class="fg" data-bigfg cx="60" cy="60" r="52" stroke-dasharray="${BIG_C}" stroke-dashoffset="${BIG_C}"/></svg><div class="rt"><b data-bigtime>25:00</b><small data-bigsub>left</small></div></div>
     <div class="rcs"><button class="rc pz" data-act="pause"><span class="c" data-pzicon></span><span data-pzlbl>Pause</span></button><button class="rc st" data-act="finish"><span class="c">${IC.stop}</span>Finish</button></div>
    </div>
    <div class="camline" data-camline><span class="camdot" data-camdot2></span><span data-camtxt>Face detected</span></div>
    <div class="statusline" data-status></div>
    <div class="degraded hidden" data-degraded>
     <span>Your gaze estimate drifted (posture or light changed). Scores are paused until it is steady again.</span>
     <button class="b-ghost" data-act="recalibrate">Recalibrate</button>
    </div>
   </div>
   <div class="minifoot"><label><input type="checkbox" data-quiet>Fade when minimized</label><button class="linkbtn" data-act="history">Full view ↗</button></div>
  </div>
  <div class="pill hidden" data-pill title="Drag to move · click to expand">
   <svg class="mring" viewBox="0 0 40 40"><circle class="bg" cx="20" cy="20" r="16"/><circle class="fg" data-pfg cx="20" cy="20" r="16" stroke-dasharray="${PILL_C}" stroke-dashoffset="${PILL_C}"/></svg>
   <div class="timebox" data-act="expand"><span class="ptime" data-ptime>25:00</span><span class="psub" data-psub>LEFT</span></div>
   <span class="camdot" data-camdot></span>
   <button class="ib solid" data-act="pause" data-ppz aria-label="Pause"></button>
   <button class="ib" data-act="expand" aria-label="Expand">⌃</button>
  </div>
 </div>
</div>`

export class Dock {
  readonly host: HTMLElement
  private readonly root: ShadowRoot
  private state: EngineState | null = null
  private prefs: DockPrefs

  constructor(private readonly actions: DockActions, prefs: DockPrefs = DEFAULT_PREFS, doc: Document = document) {
    this.prefs = { ...prefs }
    if (!doc.getElementById('flowfinder-dock-fonts')) {
      const style = doc.createElement('style')
      style.id = 'flowfinder-dock-fonts'
      style.textContent = fontFaceCss(actions.fontUrl)
      ;(doc.head ?? doc.documentElement).appendChild(style)
    }
    this.host = doc.createElement('flowfinder-dock')
    this.host.style.display = 'none'
    this.root = this.host.attachShadow({ mode: 'open' })
    this.root.innerHTML = `<style>${DOCK_CSS}${DOCK_SIZE_CSS}</style>${TEMPLATE}`
    doc.documentElement.appendChild(this.host)
    this.wire()
    this.applyPrefs()
  }

  private q<T extends Element = HTMLElement>(sel: string): T { return this.root.querySelector(sel) as T }
  private all(sel: string) { return [...this.root.querySelectorAll<HTMLElement>(sel)] }

  /** Expand ⇄ minimize (toolbar icon while a session runs). */
  toggle(): void {
    this.prefs.expanded = !this.prefs.expanded
    this.persist()
    this.render()
  }

  update(state: EngineState): void {
    this.state = state
    this.render()
  }

  /** Prefs changed elsewhere (the popup's "Show timer on page"). */
  setPrefs(p: Partial<DockPrefs>): void {
    this.prefs = { ...this.prefs, ...p }
    this.applyPrefs()
    this.render()
  }

  destroy(): void { this.host.remove() }

  // ── Rendering ────────────────────────────────────────────────────────
  private render() {
    const s = this.state
    const visible = !!s && (s.phase === 'finished' || (s.phase === 'running' && (!this.prefs.hidden || s.timeUpPending)))
    this.host.style.display = visible ? '' : 'none'
    if (!s || !visible) return

    const running = s.phase === 'running'
    const timer = running && !this.prefs.hidden
    this.q('[data-pill]').classList.toggle('hidden', !timer || this.prefs.expanded)
    this.q('[data-mini]').classList.toggle('hidden', !timer || !this.prefs.expanded)
    this.q('[data-upcard]').classList.toggle('hidden', !running || !s.timeUpPending)
    this.q('[data-summary]').classList.toggle('hidden', s.phase !== 'finished')

    if (running) {
      const t = timerView(s)
      this.q('[data-pfg]').setAttribute('stroke-dashoffset', String(PILL_C * (1 - t.progress)))
      this.q('[data-bigfg]').setAttribute('stroke-dashoffset', String(BIG_C * (1 - t.progress)))
      this.q('[data-ptime]').textContent = t.big
      this.q('[data-psub]').textContent = t.sub
      this.q('[data-bigtime]').textContent = t.big
      this.q('[data-bigsub]').textContent = t.sub.toLowerCase()
      for (const el of [this.q('[data-pill]'), this.q('[data-mini]'), this.q('[data-bigwrap]')]) {
        el.classList.toggle('paused', s.paused)
        el.classList.toggle('up', s.timeUp)
      }
      const icon = s.paused ? IC.play : IC.pause
      this.q('[data-pzicon]').innerHTML = icon
      this.q('[data-ppz]').innerHTML = icon
      this.q('[data-ppz]').setAttribute('aria-label', s.paused ? 'Resume' : 'Pause')
      this.q('[data-pzlbl]').textContent = s.paused ? 'Resume' : 'Pause'
      this.all('[data-act="pause"], [data-act="resume"]').forEach(b => { b.dataset.act = s.paused ? 'resume' : 'pause' })
      this.q('[data-task]').textContent = s.setup?.task ?? ''

      const f = faceView(s.face)
      const usesCam = !!s.setup && (s.setup.stayInFrame || s.setup.screenAttention)
      this.q('[data-camdot]').className = `camdot ${f.dot}`
      this.q('[data-camdot]').title = `Camera: ${f.text}`
      this.q('[data-camdot]').classList.toggle('hidden', !usesCam)
      this.q('[data-camline]').classList.toggle('hidden', !usesCam)
      this.q('[data-camdot2]').className = `camdot ${f.dot}`
      this.q('[data-camtxt]').textContent = f.text
      this.q('[data-status]').textContent = statusLine(s)
      const degraded = !!s.setup?.screenAttention && s.trackingDegraded && !s.recalibrating
      this.q('[data-degraded]').classList.toggle('hidden', !degraded)
      if (degraded) this.q('[data-camdot]').className = 'camdot warn'
    }

    if (s.phase === 'finished' && s.summary) {
      this.q('[data-sum-task]').textContent = s.summary.task
      this.q('[data-sum-time]').textContent = fmtClock(s.summary.sessionMs)
      this.q('[data-sum-focus]').textContent = s.summary.focusPercent === null ? '—' : `${s.summary.focusPercent}%`
      const note = s.summary.focusNote
      this.q('[data-sum-note]').textContent = note ? FOCUS_NOTE_TEXT[note] : ''
      this.q('[data-sum-note]').classList.toggle('hidden', !note)
    }
  }

  private applyPrefs() {
    this.q('[data-dock]').className = `dock ${this.prefs.corner}`
    this.q<HTMLInputElement>('[data-quiet]').checked = this.prefs.quiet
    this.q('[data-pill]').classList.toggle('quiet', this.prefs.quiet)
  }

  private persist() { this.actions.savePrefs({ ...this.prefs }) }

  // ── Events ───────────────────────────────────────────────────────────
  private wire() {
    this.root.addEventListener('click', e => {
      const el = (e.target as Element).closest<HTMLElement>('[data-act]')
      if (!el) return
      // Never let page handlers (or the page's focus logic) see dock clicks
      e.stopPropagation()
      const act = el.dataset.act
      switch (act) {
        case 'pause': case 'resume': case 'finish': case 'keep_going': case 'dismiss':
          this.actions.engine(act)
          break
        case 'expand': if (!this.dragMoved) { this.prefs.expanded = true; this.persist(); this.render() } break
        case 'minimize': this.prefs.expanded = false; this.persist(); this.render(); break
        case 'history': this.actions.openHistory(); break
        case 'recalibrate': this.actions.recalibrate(); break
        case 'json': case 'csv': void this.download(act); break
      }
    })
    this.q<HTMLInputElement>('[data-quiet]').addEventListener('change', e => {
      this.prefs.quiet = (e.target as HTMLInputElement).checked
      this.applyPrefs()
      this.persist()
    })
    this.wireDrag()
  }

  private async download(kind: 'json' | 'csv') {
    const entry = await this.actions.exportEntry()
    if (!entry) return
    const body = kind === 'json' ? JSON.stringify(entry, null, 2) : toCsv(entry)
    const url = URL.createObjectURL(new Blob([body], { type: kind === 'json' ? 'application/json' : 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = exportFileName(entry, kind)
    this.root.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  // Drag the pill / mini header; drop snaps to the nearest corner
  private dragMoved = false
  private wireDrag() {
    const dock = this.q('[data-dock]')
    let drag: { dx: number; dy: number; moved: boolean } | null = null
    const down = (e: PointerEvent) => {
      if ((e.target as Element).closest('button')) return
      const r = dock.getBoundingClientRect()
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false }
      this.dragMoved = false
      dock.style.transition = 'none'
    }
    const move = (e: PointerEvent) => {
      if (!drag) return
      if (!drag.moved && Math.abs(e.movementX) + Math.abs(e.movementY) < 2) return
      drag.moved = true
      dock.className = 'dock'
      Object.assign(dock.style, { left: `${e.clientX - drag.dx}px`, top: `${e.clientY - drag.dy}px`, right: 'auto', bottom: 'auto' })
    }
    const up = (e: PointerEvent) => {
      if (!drag) return
      const moved = drag.moved
      drag = null
      dock.removeAttribute('style')
      if (!moved) { this.applyPrefs(); return }
      this.dragMoved = true
      setTimeout(() => { this.dragMoved = false }, 0) // swallow the click that ends a drag
      this.prefs.corner = `${e.clientY < window.innerHeight / 2 ? 't' : 'b'}${e.clientX < window.innerWidth / 2 ? 'l' : 'r'}` as Corner
      this.applyPrefs()
      this.persist()
    }
    this.q('[data-pill]').addEventListener('pointerdown', down)
    this.q('[data-handle]').addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
  }
}
