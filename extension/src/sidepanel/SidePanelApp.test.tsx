import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { SidePanelApp } from './SidePanelApp'
import { createFakeController } from './testController'
import { summarizeRates } from './metrics'
import { IDLE_READING } from './controller'

const button = (name: string) => screen.getByRole('button', { name })
const row = (key: string) => document.querySelector(`[data-check="${key}"]`)!

describe('SidePanelApp', () => {
  it('before starting: only permission and start are enabled', () => {
    const { controller } = createFakeController()
    render(<SidePanelApp controller={controller} />)
    expect((button('① 授權攝影機') as HTMLButtonElement).disabled).toBe(false)
    expect((button('② 啟動追蹤') as HTMLButtonElement).disabled).toBe(false)
    expect((button('③ 校準＋驗證') as HTMLButtonElement).disabled).toBe(true)
    expect((button('顯示紅點') as HTMLButtonElement).disabled).toBe(true)
    expect(row('camera').getAttribute('data-verdict')).toBe('pending')
  })

  it('buttons call the controller', () => {
    const { controller } = createFakeController()
    render(<SidePanelApp controller={controller} />)
    fireEvent.click(button('① 授權攝影機'))
    fireEvent.click(button('② 啟動追蹤'))
    expect(controller.openPermissionPage).toHaveBeenCalled()
    expect(controller.start).toHaveBeenCalled()
  })

  it('re-renders when the controller publishes a new state', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    act(() => fake.publish({ camera: 'on', message: '追蹤中', lastSecond: { total: 35, valid: 30, bucket: 'page' } }))
    expect(screen.getByRole('status').textContent).toBe('追蹤中')
    expect((button('② 啟動追蹤') as HTMLButtonElement).disabled).toBe(true)
    expect((button('③ 校準＋驗證') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText('30 有效 / 35 筆')).toBeTruthy()
    expect(screen.getByText(/網頁 ✔/)).toBeTruthy()
    expect(row('camera').getAttribute('data-verdict')).toBe('pass')
  })

  it('calibrate is disabled while calibrating', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    act(() => fake.publish({ camera: 'on', calibrating: true }))
    expect((button('③ 校準＋驗證') as HTMLButtonElement).disabled).toBe(true)
  })

  it('toggles preview and gaze dot from the current state', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    act(() => fake.publish({ camera: 'on', previewOn: true, dotOn: false }))
    fireEvent.click(button('隱藏臉部預覽'))
    fireEvent.click(button('顯示紅點'))
    expect(fake.controller.setPreview).toHaveBeenCalledWith(false)
    expect(fake.controller.setGazeDot).toHaveBeenCalledWith(true)
  })

  it('web app numbers are parsed and passed on', () => {
    const { controller } = createFakeController()
    render(<SidePanelApp controller={controller} />)
    const [acc, prec] = screen.getAllByRole('spinbutton')
    fireEvent.change(acc, { target: { value: '95' } })
    fireEvent.change(prec, { target: { value: '42' } })
    expect(controller.setWebApp).toHaveBeenLastCalledWith(95, 42)
    fireEvent.change(prec, { target: { value: '' } })
    expect(controller.setWebApp).toHaveBeenLastCalledWith(95, null)
  })

  it('manual checkboxes update the controller', () => {
    const { controller } = createFakeController()
    render(<SidePanelApp controller={controller} />)
    fireEvent.click(screen.getByLabelText(/縮放/))
    expect(controller.setManual).toHaveBeenCalledWith({ zoomAligned: true })
  })

  it('shows the rate check result', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    act(() => fake.publish({ rates: { panel: summarizeRates([]), page: summarizeRates(Array(40).fill(12)), other: summarizeRates([]) } }))
    expect(row('rate').getAttribute('data-verdict')).toBe('fail')
  })

  it('report button shows the JSON', async () => {
    const { controller } = createFakeController()
    render(<SidePanelApp controller={controller} />)
    await act(async () => { fireEvent.click(button('複製報告 JSON')) })
    expect(controller.buildReport).toHaveBeenCalled()
    expect(screen.getByText(/test-report/)).toBeTruthy()
  })
})

describe('SidePanelApp — reading and history', () => {
  const validation = (quality: 'good' | 'usable' | 'poor') => ({
    quality, accuracyPx: 80, precisionPx: 40, validRatio: 1, viewport: { width: 1, height: 1 }, points: [], calibratedAt: 0,
  })

  it('開始閱讀 needs a running camera and a calibration that is not poor', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    expect((button('開始閱讀') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('先啟動追蹤')).toBeTruthy()
    act(() => fake.publish({ camera: 'on', validation: validation('poor') }))
    expect((button('開始閱讀') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('校準品質太差，請重新校準')).toBeTruthy()
    act(() => fake.publish({ validation: validation('usable') }))
    expect((button('開始閱讀') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button('開始閱讀'))
    expect(fake.controller.startReading).toHaveBeenCalled()
  })

  it('while reading: timers, pause reason, end button; calibration is locked', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    act(() => fake.publish({
      camera: 'on',
      validation: validation('good'),
      reading: { ...IDLE_READING, status: 'running', startedAt: 0, elapsedMs: 125_000, activeMs: 65_000, active: false, inactiveReason: 'tab_hidden', focusPercent: 72, scoredWindows: 9 },
    }))
    expect(screen.getByText('01:05')).toBeTruthy()
    expect(screen.getByText('02:05')).toBeTruthy()
    expect(screen.getByText(/分頁不在前景/)).toBeTruthy()
    expect(screen.getByText('72%（9 個視窗）')).toBeTruthy()
    expect((button('③ 校準＋驗證') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button('結束閱讀並儲存'))
    expect(fake.controller.endReading).toHaveBeenCalled()
  })

  it('lists history with score, sites and sync status', () => {
    const fake = createFakeController()
    render(<SidePanelApp controller={fake.controller} />)
    expect(screen.getByText('還沒有紀錄。')).toBeTruthy()
    act(() => fake.publish({
      history: [
        { sessionId: 'a', startedAt: Date.UTC(2026, 10, 14, 3, 0), activeReadingMs: 600_000, endReason: 'manual', score: 81, hosts: ['en.wikipedia.org'], syncedTo: ['http://localhost:5173'] },
        { sessionId: 'b', startedAt: Date.UTC(2026, 10, 13, 3, 0), activeReadingMs: 30_000, endReason: 'interrupted', score: null, hosts: [], syncedTo: [] },
      ],
    }))
    expect(screen.getByText(/專注度 81%/)).toBeTruthy()
    expect(screen.getByText('en.wikipedia.org')).toBeTruthy()
    expect(screen.getByText('✓ 已同步到網頁版')).toBeTruthy()
    expect(screen.getByText(/尚未同步/)).toBeTruthy()
    expect(screen.getByText('（中斷）')).toBeTruthy()
  })
})
