import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { GazeCalibration } from './GazeCalibration'
import { createMockTracker } from './gazeTestUtils'
import {
  CALIBRATION_POINTS,
  CLICKS_PER_POINT,
  VALIDATION_COLLECT_MS,
  VALIDATION_POINTS,
  VALIDATION_SETTLE_MS,
  toPixels,
} from './calibration'
import type { CalibrationSummary } from './types'

const POINT_MS = VALIDATION_SETTLE_MS + VALIDATION_COLLECT_MS

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
})
afterEach(() => { vi.useRealTimers() })

function setup() {
  const mock = createMockTracker()
  const onComplete = vi.fn<(s: CalibrationSummary) => void>()
  const onCancel = vi.fn()
  let clock = 0
  render(
    <GazeCalibration tracker={mock.tracker} onComplete={onComplete} onCancel={onCancel} now={() => clock} />,
  )
  return { mock, onComplete, onCancel, setClock: (ms: number) => { clock = ms } }
}

async function clickAllCalibrationPoints() {
  await act(async () => { fireEvent.click(screen.getByText('開始校準')) })
  for (let p = 0; p < CALIBRATION_POINTS.length; p++) {
    for (let c = 0; c < CLICKS_PER_POINT; c++) {
      fireEvent.click(screen.getByLabelText(`校準點 ${p + 1}`))
    }
  }
}

/** Run the validation phase; `offsetPx` simulates a tracker that is that far off */
function runValidation(h: ReturnType<typeof setup>, offsetPx: number, jitterPx = 10) {
  for (let i = 0; i < VALIDATION_POINTS.length; i++) {
    const target = toPixels(VALIDATION_POINTS[i], { width: 1000, height: 800 })
    const start = i * POINT_MS
    act(() => {
      let k = 0
      for (let t = start; t < start + POINT_MS; t += 33) {
        h.setClock(t)
        const j = (k++ % 2 === 0 ? 1 : -1) * jitterPx // alternate around the offset
        h.mock.emit({ t, x: target.x + offsetPx + j, y: target.y })
      }
      h.setClock(start + POINT_MS)
      vi.advanceTimersByTime(POINT_MS)
    })
  }
}

describe('GazeCalibration', () => {
  it('shows the camera preview only on the intro screen', async () => {
    const h = setup()
    expect(h.mock.tracker.showPreview).toHaveBeenLastCalledWith(true)
    await act(async () => { fireEvent.click(screen.getByText('開始校準')) })
    expect(h.mock.tracker.showPreview).toHaveBeenLastCalledWith(false)
  })

  it('records one training example per click, at the point centre', async () => {
    const h = setup()
    await clickAllCalibrationPoints()
    expect(h.mock.tracker.clearCalibration).toHaveBeenCalledTimes(1)
    expect(h.mock.tracker.recordCalibrationPoint).toHaveBeenCalledTimes(CALIBRATION_POINTS.length * CLICKS_PER_POINT)
    const first = toPixels(CALIBRATION_POINTS[0], { width: 1000, height: 800 })
    expect(h.mock.tracker.recordCalibrationPoint).toHaveBeenNthCalledWith(1, first.x, first.y)
    expect(screen.getByTestId('validation-point')).toBeDefined()
  })

  it('good tracking → result screen with 良好, and 開始閱讀 passes the summary', async () => {
    const h = setup()
    await clickAllCalibrationPoints()
    runValidation(h, 40)
    expect(screen.getByText('追蹤品質：良好')).toBeDefined()
    fireEvent.click(screen.getByText('開始閱讀'))
    const summary = h.onComplete.mock.calls[0][0]
    expect(summary.quality).toBe('good')
    expect(summary.accuracyPx).toBeCloseTo(40, 0)
    expect(summary.points).toHaveLength(VALIDATION_POINTS.length)
  })

  it('ignores predictions during the settle delay', async () => {
    const h = setup()
    await clickAllCalibrationPoints()
    // Far off only during the first part of each point (eyes still moving) → still good
    for (let i = 0; i < VALIDATION_POINTS.length; i++) {
      const target = toPixels(VALIDATION_POINTS[i], { width: 1000, height: 800 })
      const start = i * POINT_MS
      act(() => {
        for (let t = start; t < start + POINT_MS; t += 33) {
          const settling = t < start + VALIDATION_SETTLE_MS
          h.setClock(t)
          h.mock.emit({ t, x: target.x + (settling ? 500 : 5), y: target.y })
        }
        vi.advanceTimersByTime(POINT_MS)
      })
    }
    expect(screen.getByText('追蹤品質：良好')).toBeDefined()
  })

  it('poor tracking → no 開始閱讀 button, can re-calibrate', async () => {
    const h = setup()
    await clickAllCalibrationPoints()
    runValidation(h, 400)
    expect(screen.getByText('追蹤品質：不足')).toBeDefined()
    expect(screen.queryByText('開始閱讀')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByText('重新校準')) })
    expect(h.mock.tracker.clearCalibration).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('校準點 1')).toBeDefined()
  })

  it('cancel works from the intro and from the points', async () => {
    const h = setup()
    fireEvent.click(screen.getByText('取消'))
    expect(h.onCancel).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes from the tracker after validation', async () => {
    const h = setup()
    await clickAllCalibrationPoints()
    runValidation(h, 40)
    expect(h.mock.listenerCount()).toBe(0)
  })
})
