import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useGaze, loadBaseline, saveBaseline, attentionEventData } from './useGaze'
import { DEFAULT_MODEL, OnlineStats } from './attentionModel'
import { createMockTracker } from './gazeTestUtils'
import type { SessionStatus } from './types'

const STEP_MS = DEFAULT_MODEL.params.stepSeconds * 1000

function setup(opts: { failBegin?: Error } = {}) {
  const mock = createMockTracker(opts)
  const onSessionEvent = vi.fn()
  let clock = 0
  const hook = renderHook(
    ({ sessionStatus }: { sessionStatus: SessionStatus }) =>
      useGaze({
        sessionStatus,
        onSessionEvent,
        getColumnWidth: () => 660,
        tracker: mock.tracker,
        now: () => clock,
      }),
    { initialProps: { sessionStatus: 'idle' as SessionStatus } },
  )
  return {
    ...hook,
    mock,
    onSessionEvent,
    setClock: (ms: number) => { clock = ms },
    attentionEvents: () => onSessionEvent.mock.calls.filter(c => c[0] === 'attention_score'),
  }
}

async function calibrate(h: ReturnType<typeof setup>) {
  await act(async () => { await h.result.current.startTracker() })
  act(() => { h.result.current.completeCalibration() })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('useGaze — lifecycle', () => {
  it('starts idle', () => {
    const h = setup()
    expect(h.result.current.gazeStatus).toBe('idle')
  })

  it('startTracker → calibrating, with the face preview shown', async () => {
    const h = setup()
    await act(async () => { await h.result.current.startTracker() })
    expect(h.mock.tracker.begin).toHaveBeenCalledTimes(1)
    expect(h.mock.tracker.showPreview).toHaveBeenLastCalledWith(true)
    expect(h.result.current.gazeStatus).toBe('calibrating')
  })

  it('a camera permission error → error status with a readable message', async () => {
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const h = setup({ failBegin: err })
    let ok = true
    await act(async () => { ok = await h.result.current.startTracker() })
    expect(ok).toBe(false)
    expect(h.result.current.gazeStatus).toBe('error')
    expect(h.result.current.gazeError?.kind).toBe('permission_denied')
  })

  it('completeCalibration → ready, preview hidden, tracker paused until reading starts', async () => {
    const h = setup()
    await calibrate(h)
    expect(h.result.current.gazeStatus).toBe('ready')
    expect(h.mock.tracker.showPreview).toHaveBeenLastCalledWith(false)
    expect(h.mock.tracker.pause).toHaveBeenCalled()
    expect(h.mock.listenerCount()).toBe(1)
  })

  it('does not shut down while calibrating even though the session is idle', async () => {
    const h = setup()
    await act(async () => { await h.result.current.startTracker() })
    h.rerender({ sessionStatus: 'idle' })
    expect(h.mock.tracker.end).not.toHaveBeenCalled()
  })

  it('cancel releases the camera', async () => {
    const h = setup()
    await act(async () => { await h.result.current.startTracker() })
    act(() => { h.result.current.cancel() })
    expect(h.mock.tracker.end).toHaveBeenCalled()
    expect(h.result.current.gazeStatus).toBe('idle')
  })
})

describe('useGaze — following the session', () => {
  it('running → active and one attention_score event per step', async () => {
    const h = setup()
    await calibrate(h)
    h.rerender({ sessionStatus: 'running' })
    expect(h.result.current.gazeStatus).toBe('active')
    expect(h.mock.tracker.resume).toHaveBeenCalled()

    act(() => {
      h.setClock(STEP_MS * 3)
      vi.advanceTimersByTime(STEP_MS * 3)
    })
    expect(h.attentionEvents()).toHaveLength(3)
    // No samples were emitted → tracking quality is too low to score
    expect(h.attentionEvents()[0][1]).toMatchObject({ status: 'low_quality' })
    expect(h.result.current.latest?.status).toBe('low_quality')
  })

  it('feeds tracker samples into the estimator', async () => {
    const h = setup()
    await calibrate(h)
    h.rerender({ sessionStatus: 'running' })
    act(() => {
      for (let t = 0; t <= 10_000; t += 33) h.mock.emit({ t, x: 100 + (t % 3000) / 10, y: 300 })
      h.setClock(10_000)
      vi.advanceTimersByTime(STEP_MS)
    })
    const latest = h.result.current.latest
    expect(latest?.status).toBe('warming_up')
    expect(latest?.features.missingRatio).toBeLessThan(0.1)
  })

  it('paused / checking_in → tracker paused, no scoring', async () => {
    const h = setup()
    await calibrate(h)
    h.rerender({ sessionStatus: 'running' })
    h.rerender({ sessionStatus: 'checking_in' })
    expect(h.result.current.gazeStatus).toBe('paused')
    const before = h.attentionEvents().length
    act(() => { vi.advanceTimersByTime(STEP_MS * 5) })
    expect(h.attentionEvents()).toHaveLength(before)

    h.rerender({ sessionStatus: 'running' })
    expect(h.result.current.gazeStatus).toBe('active')
  })

  it('completed → camera released and baseline saved', async () => {
    const h = setup()
    await calibrate(h)
    h.rerender({ sessionStatus: 'running' })
    act(() => {
      for (let t = 0; t <= 10_000; t += 33) h.mock.emit({ t, x: 100 + (t % 3000) / 10, y: 300 })
      h.setClock(10_000)
      vi.advanceTimersByTime(STEP_MS)
    })
    h.rerender({ sessionStatus: 'completed' })
    expect(h.mock.tracker.end).toHaveBeenCalled()
    expect(h.result.current.gazeStatus).toBe('idle')
    expect(loadBaseline(DEFAULT_MODEL)?.xProgress.n).toBe(1)
  })

  it('uses a saved baseline on the next session', async () => {
    const stats = { nLineReturns: new OnlineStats(), xProgress: new OnlineStats() }
    for (let i = 0; i < 20; i++) { stats.nLineReturns.update(i % 3); stats.xProgress.update(100 + i) }
    saveBaseline(DEFAULT_MODEL, stats)
    const h = setup()
    await calibrate(h)
    expect(h.result.current.usedSavedBaseline).toBe(true)
  })
})

describe('baseline storage', () => {
  it('ignores a baseline saved for different model weights', () => {
    const stats = { nLineReturns: new OnlineStats(), xProgress: new OnlineStats() }
    stats.xProgress.update(1)
    saveBaseline({ ...DEFAULT_MODEL, weights: [1, 2] }, stats)
    expect(loadBaseline(DEFAULT_MODEL)).toBeNull()
  })

  it('ignores corrupt data', () => {
    localStorage.setItem('flowfinder_gaze_baseline_v1', '{not json')
    expect(loadBaseline(DEFAULT_MODEL)).toBeNull()
  })
})

describe('attentionEventData', () => {
  it('keeps the payload small and JSON-safe', () => {
    const d = attentionEventData({
      status: 'ok',
      features: { nLineReturns: 2, xProgress: 123.456, missingRatio: 0.03333 },
      z: [0.1, 0.2],
      score: 0.512345,
      trend: 0.498765,
    })
    expect(d).toEqual({ status: 'ok', nLineReturns: 2, xProgress: 123.5, missingRatio: 0.033, score: 0.512, trend: 0.499 })
  })
})
