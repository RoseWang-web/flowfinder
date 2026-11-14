import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Popup, type PopupApi } from './Popup'
import { DEFAULT_SETUP, IDLE_STATE, type EngineState } from '../protocol'

function makeApi(opts: { saved?: object | null; state?: EngineState | null; hidden?: boolean } = {}) {
  let push: ((s: EngineState) => void) | null = null
  const api: PopupApi & { push: (s: EngineState) => void } = {
    push: s => push?.(s),
    activeTab: vi.fn(async () => ({ id: 7, title: 'Biology — Chapter 4: Cell Membranes' })),
    loadSetup: vi.fn(async () => (opts.saved ?? null) as never),
    saveSetup: vi.fn(async () => {}),
    engineState: vi.fn(async () => opts.state ?? null),
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    openHistory: vi.fn(),
    recalibrate: vi.fn(),
    close: vi.fn(),
    onEngineState: vi.fn(l => { push = l; return () => { push = null } }),
    engineAction: vi.fn(async () => {}),
    dockHidden: vi.fn(async () => opts.hidden ?? false),
    setDockHidden: vi.fn(async () => {}),
  }
  return api
}

async function renderPopup(api: PopupApi) {
  await act(async () => { render(<Popup api={api} />) })
}

describe('Popup', () => {
  it('suggests the task from the current tab and starts with the chosen setup', async () => {
    const api = makeApi()
    await renderPopup(api)
    expect((screen.getByLabelText('Working on') as HTMLInputElement).value).toBe('Biology — Chapter 4: Cell Membranes')
    fireEvent.click(screen.getByRole('button', { name: '45' }))
    fireEvent.click(screen.getByRole('button', { name: /Tab activity/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })) })
    expect(api.start).toHaveBeenCalledWith(
      { ...DEFAULT_SETUP, task: 'Biology — Chapter 4: Cell Membranes', durationMin: 45, tabActivity: false },
      7,
    )
    expect(api.saveSetup).toHaveBeenCalled()
    expect(api.close).toHaveBeenCalled()
  })

  it('custom minutes and the ∞ option', async () => {
    const api = makeApi()
    await renderPopup(api)
    fireEvent.change(screen.getByLabelText('Custom minutes'), { target: { value: '50' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start session' })) })
    expect(api.start).toHaveBeenLastCalledWith(expect.objectContaining({ durationMin: 50 }), 7)
  })

  it('remembers notice choices but not the task name', async () => {
    const api = makeApi({ saved: { durationMin: 15, screenAttention: false } })
    await renderPopup(api)
    expect(screen.getByRole('button', { name: /Screen attention/ }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '15' }).className).toContain('sel')
    expect(screen.queryByText(/calibration first/)).toBeNull()
  })

  it('while calibrating it shows status and Cancel instead of the form', async () => {
    const api = makeApi({ state: { ...IDLE_STATE, phase: 'calibrating' } })
    await renderPopup(api)
    expect(screen.getByText(/Calibration is open/)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })) })
    expect(api.cancel).toHaveBeenCalled()
  })

  it('✕ closes the popup', async () => {
    const api = makeApi()
    await renderPopup(api)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(api.close).toHaveBeenCalled()
  })

  it('History ↗ opens the web app', async () => {
    const api = makeApi()
    await renderPopup(api)
    fireEvent.click(screen.getByRole('button', { name: 'History ↗' }))
    expect(api.openHistory).toHaveBeenCalled()
  })
})

describe('Popup — during a session', () => {
  const running = (p: Partial<EngineState> = {}): EngineState => ({
    ...IDLE_STATE, phase: 'running', setup: { ...DEFAULT_SETUP, task: 'Cell Membranes' },
    totalMs: 25 * 60_000, elapsedMs: 5 * 60_000, reading: true, face: 'ok', focusPercent: 71, ...p,
  })

  it('shows the live timer and controls instead of the setup form', async () => {
    const api = makeApi({ state: running() })
    await renderPopup(api)
    expect(screen.queryByText('WORKING ON')).toBeNull()
    expect(screen.getByText('Cell Membranes')).toBeTruthy()
    expect(screen.getByText('20:00')).toBeTruthy()
    expect(screen.getByText('Screen attention · 71% focused')).toBeTruthy()
    act(() => api.push(running({ elapsedMs: 6 * 60_000, paused: true })))
    expect(screen.getByText('19:00')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Resume/ })) })
    expect(api.engineAction).toHaveBeenCalledWith('resume')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Finish/ })) })
    expect(api.engineAction).toHaveBeenCalledWith('finish')
  })

  it('"Show timer on page" hides and shows the floating timer', async () => {
    const api = makeApi({ state: running(), hidden: false })
    await renderPopup(api)
    const box = screen.getByLabelText('Show timer on page') as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(box)
    expect(api.setDockHidden).toHaveBeenCalledWith(true)
    expect(box.checked).toBe(false)
  })

  it('degraded tracking: Recalibrate from the popup', async () => {
    const api = makeApi({ state: running({ trackingDegraded: true }) })
    await renderPopup(api)
    expect(screen.getByText(/gaze estimate drifted/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Recalibrate' }))
    expect(api.recalibrate).toHaveBeenCalled()
    expect(api.close).toHaveBeenCalled()
  })

  it("time's up: keep going or finish from the popup", async () => {
    const api = makeApi({ state: running({ timeUp: true, timeUpPending: true, elapsedMs: 25 * 60_000 }) })
    await renderPopup(api)
    expect(screen.getByText("Time's up.")).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep going' })) })
    expect(api.engineAction).toHaveBeenCalledWith('keep_going')
  })

  it('after finishing: summary with Full review and Done', async () => {
    const api = makeApi({ state: { ...running(), phase: 'finished', summary: { sessionId: 's', task: 'Cell Membranes', sessionMs: 1_500_000, readingMs: 1_400_000, focusPercent: 64, focusNote: null, endReason: 'time_up' } } })
    await renderPopup(api)
    expect(screen.getByText('Session complete')).toBeTruthy()
    expect(screen.getByText('64%')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    expect(api.engineAction).toHaveBeenCalledWith('dismiss')
    expect(api.close).toHaveBeenCalled()
  })
})
