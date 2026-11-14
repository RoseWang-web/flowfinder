import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSession, READING_DURATION_MS, CHECK_IN_THRESHOLD_MS, getCheckInThreshold } from './useSession'

// ── State machine (no fake timers needed) ────────────────────────────────

describe('useSession — state machine', () => {
  test('initial status is idle with full remainingMs', () => {
    const { result } = renderHook(() => useSession())
    expect(result.current.status).toBe('idle')
    expect(result.current.remainingMs).toBe(READING_DURATION_MS)
    expect(result.current.session).toBeNull()
  })

  test('start: idle → running', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    expect(result.current.status).toBe('running')
  })

  test('pause: running → paused', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.pause() })
    expect(result.current.status).toBe('paused')
  })

  test('resume: paused → running', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.pause() })
    act(() => { result.current.resume() })
    expect(result.current.status).toBe('running')
  })

  test('finish from running → completed, endReason manual', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.finish() })
    expect(result.current.status).toBe('completed')
    expect(result.current.session?.endReason).toBe('manual')
  })

  test('finish from paused → completed, endReason manual', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.pause() })
    act(() => { result.current.finish() })
    expect(result.current.status).toBe('completed')
    expect(result.current.session?.endReason).toBe('manual')
  })

  // ── Bug 2 regression ──────────────────────────────────────────────────
  test('[Bug 2] resetToIdle after completed → status is idle, session is null', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.finish() })
    expect(result.current.status).toBe('completed')

    act(() => { result.current.resetToIdle() })

    expect(result.current.status).toBe('idle')
    expect(result.current.session).toBeNull()
    expect(result.current.remainingMs).toBe(READING_DURATION_MS)
  })

  test('resetToIdle keeps data in localStorage (refresh can restore result)', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.finish() })
    act(() => { result.current.resetToIdle() })

    // localStorage still has the session
    const raw = localStorage.getItem('flowfinder_session_v2')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.endReason).toBe('manual')
  })

  test('deleteData clears localStorage and returns to idle', () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start() })
    act(() => { result.current.finish() })
    act(() => { result.current.deleteData() })
    expect(result.current.status).toBe('idle')
    expect(localStorage.getItem('flowfinder_session_v2')).toBeNull()
    expect(result.current.hasStoredData).toBe(false)
  })

  test('start is idempotent — double-click does not create two sessions', () => {
    const { result } = renderHook(() => useSession())
    act(() => {
      result.current.start()
      result.current.start() // second call ignored
    })
    expect(result.current.status).toBe('running')
    // Only one session_start event
    const startEvents = result.current.session?.events.filter(e => e.eventType === 'session_start')
    expect(startEvents?.length).toBe(1)
  })
})

// ── Timer-based tests ────────────────────────────────────────────────────

describe('useSession — timers and check-in', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('time_up fires after full reading duration', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })

    // Advance past check-in threshold, skip the dialog, then advance remaining time
    await act(async () => { vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500) })
    expect(result.current.status).toBe('checking_in')
    act(() => { result.current.skipCheckIn() })

    // Advance remaining reading time
    await act(async () => {
      vi.advanceTimersByTime(READING_DURATION_MS - CHECK_IN_THRESHOLD_MS + 500)
    })

    expect(result.current.status).toBe('completed')
    expect(result.current.session?.endReason).toBe('time_up')
    expect(result.current.remainingMs).toBe(0)
  })

  test('pausing stops effective time — session does NOT time out during pause', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })
    await act(async () => { vi.advanceTimersByTime(30_000) })
    act(() => { result.current.pause() })

    // Advance far past total duration while paused
    await act(async () => { vi.advanceTimersByTime(READING_DURATION_MS) })

    expect(result.current.status).toBe('paused')
    expect(result.current.session?.endReason).toBeNull()
  })

  // ── Bug 1 regression ──────────────────────────────────────────────────
  test('[Bug 1] check-in appears when activeReadingMs reaches threshold', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })

    await act(async () => {
      vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500)
    })

    expect(result.current.checkInPending).toBe(true)
    expect(result.current.status).toBe('checking_in')
  })

  test('[Bug 1] answerCheckIn dismisses dialog and transitions to running', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })
    await act(async () => { vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500) })

    expect(result.current.checkInPending).toBe(true)

    act(() => { result.current.answerCheckIn('on_task') })

    expect(result.current.checkInPending).toBe(false)
    expect(result.current.status).toBe('running')
    expect(result.current.session?.checkIn?.answer).toBe('on_task')
    expect(result.current.session?.checkIn?.answeredAt).toBeTypeOf('number')
  })

  test('[Bug 1] save interval does NOT revert checking_in back to running', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })
    await act(async () => { vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500) })

    expect(result.current.status).toBe('checking_in')

    // Advance 2 save-interval cycles — if bug is present, status reverts
    await act(async () => { vi.advanceTimersByTime(2_000) })

    expect(result.current.status).toBe('checking_in')
    expect(result.current.checkInPending).toBe(true)
  })

  test('[Bug 1] skipCheckIn dismisses dialog and transitions to running', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })
    await act(async () => { vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500) })

    act(() => { result.current.skipCheckIn() })

    expect(result.current.checkInPending).toBe(false)
    expect(result.current.status).toBe('running')
    expect(result.current.session?.checkIn?.skipped).toBe(true)
  })

  test('check-in only appears once per session', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })
    await act(async () => { vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500) })
    act(() => { result.current.answerCheckIn('partly') })

    // Continue reading — should NOT trigger check-in again
    await act(async () => { vi.advanceTimersByTime(10_000) })

    expect(result.current.checkInPending).toBe(false)
    expect(result.current.status).toBe('running')
  })

  test('pausing does not advance effective time toward check-in threshold', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })

    // 30s active reading
    await act(async () => { vi.advanceTimersByTime(30_000) })
    act(() => { result.current.pause() })

    // 35s pass while paused — total wall-clock > threshold, but active < threshold
    await act(async () => { vi.advanceTimersByTime(35_000) })
    act(() => { result.current.resume() })

    // 100ms after resume — active is ~30.1s, still below threshold
    await act(async () => { vi.advanceTimersByTime(100) })

    expect(result.current.checkInPending).toBe(false)
    expect(result.current.status).toBe('running')
  })

  test('answer time is not counted as effective reading time', async () => {
    const { result } = renderHook(() => useSession())
    act(() => { result.current.start({ plannedDurationMs: 120_000 }) })
    await act(async () => { vi.advanceTimersByTime(CHECK_IN_THRESHOLD_MS + 500) })

    const activeAtCheckIn = result.current.session?.checkIn?.shownActiveReadingMs ?? 0

    // User takes 10s to answer
    await act(async () => { vi.advanceTimersByTime(10_000) })
    act(() => { result.current.answerCheckIn('not_sure') })

    // Active reading should still be ~shownActiveReadingMs (not + 10s)
    const activeAfterAnswer = result.current.session?.activeReadingMs ?? 0
    expect(activeAfterAnswer).toBeCloseTo(activeAtCheckIn, -2) // within ~100ms
  })
})

// ── getCheckInThreshold ───────────────────────────────────────────────────────

describe('getCheckInThreshold', () => {
  test('returns 600_000 for unlimited sessions (plannedDurationMs = 0)', () => {
    expect(getCheckInThreshold(0)).toBe(600_000)
  })
  test('returns half of planned duration for timed sessions', () => {
    expect(getCheckInThreshold(1_800_000)).toBe(900_000)
  })
  test('enforces minimum of 60_000 when half would be less', () => {
    expect(getCheckInThreshold(60_000)).toBe(60_000)
    expect(getCheckInThreshold(30_000)).toBe(60_000)
  })
  test('returns 60_000 for the legacy 2-minute duration', () => {
    expect(getCheckInThreshold(120_000)).toBe(60_000)
  })
})
