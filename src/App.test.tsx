/**
 * Integration tests for Phase 4:
 * - Result page renders timeline chart
 * - Delete clears localStorage and returns to idle
 * - localStorage delete failure shows error banner
 * - Result page has no active camera stream
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { saveSession } from './storage'
import type { Session, SessionTaskSettings } from './types'

// ── Helpers ───────────────────────────────────────────────────────────────

const BASE_TS = 1_700_000_000_000

function makeCompletedSession(overrides?: Partial<Session>): Session {
  return {
    schemaVersion: 2,
    sessionId: 'sess-1',
    articleId: 'reading-article-v1',
    startedAt: BASE_TS,
    status: 'completed',
    durationMs: 120_000,
    activeReadingMs: 90_000,
    lastSavedAt: BASE_TS + 120_000,
    endedAt: BASE_TS + 120_000,
    endReason: 'time_up',
    checkIn: null,
    cameraEnabled: false,
    events: [
      { id: 'e1', sessionId: 'sess-1', eventType: 'session_start', elapsedMs: 0, activeReadingMs: 0, data: { visible: true } },
      { id: 'e2', sessionId: 'sess-1', eventType: 'session_end', elapsedMs: 120_000, activeReadingMs: 90_000 },
    ],
    ...overrides,
  }
}

afterEach(() => { vi.restoreAllMocks() })

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Result page with timeline', () => {
  it('renders timeline section heading for completed session', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    expect(screen.getByText('Timeline')).toBeDefined()
  })

  it('shows Active Reading Time stat on the result page', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    expect(screen.getAllByText(/Active Reading Time/).length).toBeGreaterThan(0)
  })

  it('delete button clears result page and returns to consent screen', async () => {
    saveSession(makeCompletedSession())
    render(<App />)
    const deleteBtn = screen.getByRole('button', { name: 'Delete Session Data' })
    await act(async () => { await userEvent.click(deleteBtn) })
    expect(screen.getByText('Eye Tracking')).toBeDefined()
    expect(localStorage.getItem('flowfinder_session_v2')).toBeNull()
  })

  it('localStorage delete failure: shows error, still returns to idle', async () => {
    saveSession(makeCompletedSession())
    vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })
    render(<App />)
    const deleteBtn = screen.getByRole('button', { name: 'Delete Session Data' })
    await act(async () => { await userEvent.click(deleteBtn) })
    // Error banner visible
    expect(screen.getByText(/Could not delete saved session/)).toBeDefined()
    // Memory cleared — app is on idle page
    expect(screen.getByText('Eye Tracking')).toBeDefined()
  })

  it('result page renders no camera video element (stream is idle)', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    // The <video> element only appears on the reading page when camera is active.
    // On the result page, cameraStatus is 'idle' so no video is rendered.
    const videos = document.querySelectorAll('video')
    expect(videos.length).toBe(0)
  })

  it('result page shows task settings when session has taskSettings', () => {
    const taskSettings: SessionTaskSettings = {
      categoryId: 'study_notes',
      rulesVersion: 1,
      rules: { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: true },
    }
    saveSession(makeCompletedSession({ taskSettings }))
    render(<App />)
    expect(screen.getByText('Task Settings')).toBeDefined()
    expect(screen.getByText('Study / Notes')).toBeDefined()
    expect(screen.getByText('Settings are saved for event review. Behavioral rules are not yet applied to scoring.')).toBeDefined()
  })

  it('result page shows "No task settings saved" for session without taskSettings', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    expect(screen.getByText('No task settings saved for this session.')).toBeDefined()
  })

  it('session with corrupt taskSettings still loads and shows timeline', () => {
    const corruptSession = {
      ...makeCompletedSession(),
      taskSettings: { categoryId: 'unknown_cat', rulesVersion: 99, rules: null },
    }
    // Write raw so storage.ts receives the corrupt field
    localStorage.setItem('flowfinder_session_v2', JSON.stringify(corruptSession))
    render(<App />)
    // Timeline still renders (session core is intact)
    expect(screen.getByText('Timeline')).toBeDefined()
    // Task settings treated as unavailable
    expect(screen.getByText('No task settings saved for this session.')).toBeDefined()
  })

  it('idle page shows task setup section with working-on input', () => {
    render(<App />)
    expect(screen.getByText('Task Setup')).toBeDefined()
    expect(screen.getByLabelText('What are you working on?')).toBeDefined()
  })

  it('gaze session: result page shows the attention band and the check-in comparison', () => {
    const events: Session['events'] = [
      { id: 's', sessionId: 'sess-1', eventType: 'session_start', elapsedMs: 0, activeReadingMs: 0, data: { visible: true } },
    ]
    for (let ms = 10_000; ms <= 110_000; ms += 2_000) {
      const ok = ms >= 28_000
      events.push({
        id: `a${ms}`, sessionId: 'sess-1', eventType: 'attention_score', elapsedMs: ms, activeReadingMs: ms,
        data: ok
          ? { status: 'ok', score: 0.5, trend: 0.5, nLineReturns: 3, xProgress: 120, missingRatio: 0 }
          : { status: 'warming_up', nLineReturns: 3, xProgress: 120, missingRatio: 0 },
      })
    }
    events.push({ id: 'c1', sessionId: 'sess-1', eventType: 'check_in_shown', elapsedMs: 60_000, activeReadingMs: 60_000 })
    events.push({ id: 'c2', sessionId: 'sess-1', eventType: 'check_in_answered', elapsedMs: 63_000, activeReadingMs: 60_000, data: { answer: 'on_task' } })
    saveSession(makeCompletedSession({
      gazeEnabled: true,
      gaze: {
        modelCvRocAuc: 0.637,
        calibration: {
          quality: 'good', accuracyPx: 80, precisionPx: 60, validRatio: 0.95,
          viewport: { width: 1000, height: 800 }, points: [], calibratedAt: BASE_TS,
        },
      },
      checkIn: { shownAt: BASE_TS + 60_000, shownElapsedMs: 60_000, shownActiveReadingMs: 60_000, answeredAt: BASE_TS + 63_000, answer: 'on_task', skipped: false },
      events,
    }))
    render(<App />)
    expect(screen.getByText('Eye Tracking')).toBeDefined()
    expect(screen.getAllByText('Focus').length).toBeGreaterThan(0)
    expect(screen.getByText('Focus trend')).toBeDefined()
    expect(screen.getByText('Check-In Comparison')).toBeDefined()
    // 15 windows in the 30 s before the prompt, focus = 1 − 0.5
    expect(screen.getByText('(15 windows)')).toBeDefined()
    expect(screen.getAllByText('0.50').length).toBe(2)
    expect(screen.getAllByRole('button', { name: /^Focus, / }).length).toBeGreaterThan(30)
    expect(screen.getByText('Download Session Data (JSON)')).toBeDefined()
    // attention_score events are summarised, not listed one by one
    expect(screen.queryAllByText('Attention Estimates').length).toBe(1)
  })

  it('non-gaze session: no attention band', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    expect(screen.queryByText('Focus trend')).toBeNull()
  })

  it('save as PDF button exists on result page and calls window.print()', async () => {
    saveSession(makeCompletedSession())
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    render(<App />)
    const pdfBtn = screen.getByRole('button', { name: 'Save as PDF' })
    expect(pdfBtn).toBeDefined()
    await act(async () => { await userEvent.click(pdfBtn) })
    expect(printSpy).toHaveBeenCalledOnce()
  })
})
