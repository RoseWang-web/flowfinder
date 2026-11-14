import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Calibrate, type CalibrateApi } from './Calibrate'
import { CALIBRATION_POINTS, CLICKS_PER_POINT, VALIDATION_POINTS } from '@core/calibration'
import type { CalibrationSummary } from '@core/types'

const summary = (quality: CalibrationSummary['quality']): CalibrationSummary => ({
  quality, accuracyPx: 88, precisionPx: 41, validRatio: 0.97, viewport: { width: 1000, height: 700 }, points: [], calibratedAt: 0,
})

function makeApi(quality: CalibrationSummary['quality'] = 'good') {
  const api: CalibrateApi = {
    faceStatus: vi.fn(async () => ({ face: 'ok' as const, validRatio: 1, samplesPerSecond: 30 })),
    reset: vi.fn(async () => {}),
    click: vi.fn(),
    validationPoint: vi.fn(async () => {}),
    finishValidation: vi.fn(async () => summary(quality)),
    beginReading: vi.fn(async () => ({ phase: 'running' as const, message: '' })),
    done: vi.fn(),
    cancel: vi.fn(),
    startPreview: vi.fn(async () => () => {}),
    sleep: vi.fn(async () => {}),
  }
  return api
}

async function calibrate(api: CalibrateApi) {
  await act(async () => { render(<Calibrate api={api} />) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Begin' })) })
  for (let p = 0; p < CALIBRATION_POINTS.length; p++) {
    for (let k = 0; k < CLICKS_PER_POINT; k++) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: `Calibration point ${p + 1}` }), { screenX: 100 + p * 10, screenY: 200, clientX: 80 + p * 10, clientY: 120 })
      })
    }
  }
  await act(async () => {}) // let validation finish
}

describe('Calibrate', () => {
  it('positioning: camera preview and face status', async () => {
    const api = makeApi()
    await act(async () => { render(<Calibrate api={api} />) })
    expect(api.startPreview).toHaveBeenCalled()
    expect(screen.getByText(/Quick calibration/)).toBeTruthy()
  })

  it('27 clicks reach the engine as screen coordinates, then 5 validation points, then the result', async () => {
    const api = makeApi('good')
    await calibrate(api)
    expect(api.reset).toHaveBeenCalled()
    expect(api.click).toHaveBeenCalledTimes(CALIBRATION_POINTS.length * CLICKS_PER_POINT)
    expect(api.click).toHaveBeenCalledWith(100, 200)
    expect(api.validationPoint).toHaveBeenCalledTimes(VALIDATION_POINTS.length)
    expect(api.finishValidation).toHaveBeenCalled()
    expect(screen.getByText('Calibration looks good.')).toBeTruthy()
    expect(screen.getByText('88 px')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start reading' })) })
    expect(api.beginReading).toHaveBeenCalled()
    expect(api.done).toHaveBeenCalled()
  })

  it('poor calibration cannot start reading', async () => {
    const api = makeApi('poor')
    await calibrate(api)
    expect(screen.getByText('Calibration is too rough.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start reading' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Calibrate again' }))
    expect(screen.getByText(/Quick calibration/)).toBeTruthy()
  })

  it('Cancel', async () => {
    const api = makeApi()
    await act(async () => { render(<Calibrate api={api} />) })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.cancel).toHaveBeenCalled()
  })
})
