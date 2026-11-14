import { describe, it, expect, vi } from 'vitest'
import { fmtClock, timerView, faceView, statusLine } from './view'
import { toCsv, exportFileName } from './exportFiles'
import { Dock, DEFAULT_PREFS, type DockActions } from './Dock'
import { DEFAULT_SETUP, IDLE_STATE, type EngineState } from '../../protocol'
import { detectColumnWidth } from '../column'
import type { HistoryEntry } from '@core/historyStorage'

const running = (p: Partial<EngineState> = {}): EngineState => ({
  ...IDLE_STATE, phase: 'running', setup: { ...DEFAULT_SETUP, task: 'Biology' }, totalMs: 25 * 60_000,
  reading: true, face: 'ok', ...p,
})

describe('view helpers', () => {
  it('fmtClock matches the mockup', () => {
    expect(fmtClock(754_000)).toBe('12:34')
    expect(fmtClock(3_723_000)).toBe('1:02:03')
    expect(fmtClock(-5)).toBe('00:00')
  })

  it('timerView: countdown, open-ended, extra time, paused', () => {
    expect(timerView({ elapsedMs: 60_500, totalMs: 25 * 60_000, paused: false, timeUp: false })).toEqual({ big: '24:00', sub: 'LEFT', progress: 60_000 / 1_500_000 })
    expect(timerView({ elapsedMs: 90_000, totalMs: 0, paused: false, timeUp: false })).toMatchObject({ big: '01:30', sub: 'ELAPSED', progress: 1 })
    expect(timerView({ elapsedMs: 26 * 60_000, totalMs: 25 * 60_000, paused: false, timeUp: true })).toMatchObject({ big: '+01:00', sub: 'EXTRA' })
    expect(timerView({ elapsedMs: 0, totalMs: 60_000, paused: true, timeUp: false }).sub).toBe('PAUSED')
  })

  it('faceView and statusLine', () => {
    expect(faceView('ok')).toEqual({ dot: '', text: 'Face detected' })
    expect(faceView('off').dot).toBe('off')
    expect(statusLine(running({ reading: false, inactiveReason: 'page_blur' }))).toMatch(/click the page/)
    expect(statusLine(running({ focusPercent: null }))).toBe('Screen attention · warming up')
    expect(statusLine(running({ focusPercent: 72 }))).toBe('Screen attention · 72% focused')
    expect(statusLine(running({ setup: { ...DEFAULT_SETUP, screenAttention: false } }))).toBe('Reading')
  })
})

describe('exports', () => {
  const entry = {
    session: {
      sessionId: 's', startedAt: new Date(2026, 10, 14, 9, 5).getTime(),
      events: [
        { id: '1', sessionId: 's', eventType: 'session_start', elapsedMs: 0, activeReadingMs: 0, data: { visible: false } },
        { id: '2', sessionId: 's', eventType: 'attention_score', elapsedMs: 22_000, activeReadingMs: 20_000, data: { status: 'ok', nLineReturns: 3, xProgress: 120.5, missingRatio: 0.02, score: 0.3, trend: 0.25 } },
        { id: '3', sessionId: 's', eventType: 'page_visibility', elapsedMs: 30_000, activeReadingMs: 28_000, data: { visible: false, reason: 'tab_hidden' } },
      ],
    },
  } as unknown as HistoryEntry

  it('csv has one row per event and focus = 1 − trend', () => {
    const lines = toCsv(entry).trim().split('\n')
    expect(lines[0]).toBe('elapsed_s,reading_s,event,status,focus_percent,line_returns,x_progress,missing_ratio,detail')
    expect(lines[2]).toBe('22,20,attention_score,ok,75,3,120.5,0.02,')
    expect(lines[3]).toBe('30,28,page_visibility,,,,,,"{""visible"":false,""reason"":""tab_hidden""}"')
  })

  it('file names use the local start time', () => {
    expect(exportFileName(entry, 'csv')).toBe('flowfinder-20261114-0905.csv')
  })
})

describe('detectColumnWidth', () => {
  const longText = 'x'.repeat(200)
  it('falls back to min(viewport, 700) without paragraphs', () => {
    const d = document.implementation.createHTMLDocument('t')
    expect(detectColumnWidth(d, 1200)).toBe(700)
    expect(detectColumnWidth(d, 500)).toBe(500)
  })
  it('uses the paragraphs of an <article>', () => {
    const d = document.implementation.createHTMLDocument('t')
    d.body.innerHTML = `<article><p>${longText}</p><p>${longText}</p></article>`
    const ps = d.querySelectorAll('p')
    ps.forEach(p => { p.getBoundingClientRect = () => ({ width: 640 } as DOMRect) })
    expect(detectColumnWidth(d, 1200)).toBe(640)
  })
})

function makeDock() {
  const actions: DockActions = {
    engine: vi.fn(),
    recalibrate: vi.fn(),
    openHistory: vi.fn(),
    exportEntry: vi.fn(async () => null),
    savePrefs: vi.fn(),
    fontUrl: p => `chrome-extension://x/${p}`,
  }
  const dock = new Dock(actions, DEFAULT_PREFS)
  const q = (sel: string) => dock.host.shadowRoot!.querySelector(sel) as HTMLElement
  const visible = (sel: string) => !q(sel).classList.contains('hidden')
  return { dock, actions, q, visible }
}

describe('Dock', () => {
  it('hidden while idle; pill while running; fonts declared on the page', () => {
    const { dock, visible } = makeDock()
    dock.update(IDLE_STATE)
    expect(dock.host.style.display).toBe('none')
    dock.update(running({ elapsedMs: 60_000 }))
    expect(dock.host.style.display).toBe('')
    expect(visible('[data-pill]')).toBe(true)
    expect(visible('[data-mini]')).toBe(false)
    expect(document.getElementById('flowfinder-dock-fonts')?.textContent).toContain('chrome-extension://x/fonts/WorkSans-latin.woff2')
    dock.destroy()
  })

  it('shows time, pause toggles to resume, expand/minimize persist prefs', () => {
    const { dock, actions, q, visible } = makeDock()
    dock.update(running({ elapsedMs: 60_000 }))
    expect(q('[data-ptime]').textContent).toBe('24:00')
    q('[data-ppz]').click()
    expect(actions.engine).toHaveBeenCalledWith('pause')
    dock.update(running({ elapsedMs: 60_000, paused: true }))
    expect(q('[data-psub]').textContent).toBe('PAUSED')
    q('[data-ppz]').click()
    expect(actions.engine).toHaveBeenLastCalledWith('resume')

    q('[aria-label="Expand"]').click()
    expect(visible('[data-mini]')).toBe(true)
    expect(actions.savePrefs).toHaveBeenLastCalledWith(expect.objectContaining({ expanded: true }))
    expect(q('[data-task]').textContent).toBe('Biology')
    q('[data-act="minimize"]').click()
    expect(visible('[data-pill]')).toBe(true)
    dock.toggle()
    expect(visible('[data-mini]')).toBe(true)
    dock.destroy()
  })

  it("time's up card, then summary with downloads", () => {
    const { dock, actions, q, visible } = makeDock()
    dock.update(running({ timeUp: true, timeUpPending: true, elapsedMs: 25 * 60_000 }))
    expect(visible('[data-upcard]')).toBe(true)
    expect(q('[data-ptime]').textContent).toBe('+00:00')
    ;(q('[data-upcard]').querySelector('[data-act="keep_going"]') as HTMLElement).click()
    expect(actions.engine).toHaveBeenCalledWith('keep_going')

    dock.update({ ...running(), phase: 'finished', summary: { sessionId: 's', task: 'Biology', sessionMs: 1_530_000, readingMs: 1_400_000, focusPercent: 68, focusNote: null, endReason: 'time_up' } })
    expect(visible('[data-summary]')).toBe(true)
    expect(visible('[data-pill]')).toBe(false)
    expect(q('[data-sum-time]').textContent).toBe('25:30')
    expect(q('[data-sum-focus]').textContent).toBe('68%')
    ;(q('[data-summary]').querySelector('[data-act="dismiss"]') as HTMLElement).click()
    expect(actions.engine).toHaveBeenLastCalledWith('dismiss')
    ;(q('[data-summary]').querySelector('[data-act="history"]') as HTMLElement).click()
    expect(actions.openHistory).toHaveBeenCalled()
    dock.destroy()
  })

  it('hides camera status when the camera is not used', () => {
    const { dock, visible } = makeDock()
    dock.update(running({ setup: { ...DEFAULT_SETUP, stayInFrame: false, screenAttention: false }, face: 'off' }))
    expect(visible('[data-camdot]')).toBe(false)
    dock.destroy()
  })

  it('hidden from the popup: no timer, but time-up and summary cards still show', () => {
    const { dock, visible } = makeDock()
    dock.update(running())
    dock.setPrefs({ hidden: true })
    expect(dock.host.style.display).toBe('none')
    dock.update(running({ timeUp: true, timeUpPending: true }))
    expect(dock.host.style.display).toBe('')
    expect(visible('[data-upcard]')).toBe(true)
    expect(visible('[data-pill]')).toBe(false)
    dock.setPrefs({ hidden: false })
    expect(visible('[data-pill]')).toBe(true)
    dock.destroy()
  })

  it('degraded tracking: warning with a Recalibrate button', () => {
    const { dock, actions, q, visible } = makeDock()
    dock.update(running({ trackingDegraded: true }))
    expect(visible('[data-degraded]')).toBe(true)
    expect(q('[data-status]').textContent).toMatch(/noisy/)
    expect(q('[data-camdot]').className).toContain('warn')
    ;(q('[data-degraded] [data-act="recalibrate"]') as HTMLElement).click()
    expect(actions.recalibrate).toHaveBeenCalled()
    dock.update(running({ trackingDegraded: true, recalibrating: true, paused: true }))
    expect(visible('[data-degraded]')).toBe(false)
    expect(q('[data-status]').textContent).toBe('Paused for recalibration')
    dock.destroy()
  })

  it('dock clicks do not reach page listeners', () => {
    const { dock, q } = makeDock()
    const pageClick = vi.fn()
    document.addEventListener('click', pageClick)
    dock.update(running())
    q('[data-ppz]').click()
    expect(pageClick).not.toHaveBeenCalled()
    document.removeEventListener('click', pageClick)
    dock.destroy()
  })
})
