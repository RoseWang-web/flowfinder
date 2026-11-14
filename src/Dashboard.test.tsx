/**
 * Dashboard time-grid tests:
 * - Week view renders hour labels in the time gutter
 * - Day view renders a session block with the task title
 * - Session block has accessible label with time info
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dashboard } from './Dashboard'
import { upsertHistoryEntry } from './historyStorage'
import { makePendingAnalysis } from './analysisTypes'
import type { Session } from './types'
import type { AnalysisResult } from './analysisTypes'

afterEach(() => {
  localStorage.clear()
})

// A completed session that starts at 9:00 AM today and lasts 30 minutes
function makeEntry(overrides?: Partial<Session>) {
  const today = new Date()
  today.setHours(9, 0, 0, 0)
  const startedAt = today.getTime()
  const durationMs = 30 * 60 * 1000

  const session: Session = {
    schemaVersion: 2,
    sessionId: 'dash-test-1',
    articleId: 'test',
    startedAt,
    status: 'completed',
    durationMs,
    activeReadingMs: durationMs,
    lastSavedAt: startedAt + durationMs,
    endedAt: startedAt + durationMs,
    endReason: 'manual',
    checkIn: null,
    cameraEnabled: false,
    events: [],
    taskSettings: {
      categoryId: 'study_notes',
      rulesVersion: 1,
      rules: { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: true },
      taskTitle: 'Morning Study',
    },
    ...overrides,
  }
  upsertHistoryEntry({ session, analysis: makePendingAnalysis(), entryVersion: 1 })
  return session
}

describe('Dashboard time-grid', () => {
  it('week view renders hour labels in the time gutter', async () => {
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    // Switch to week view
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /week/i })) })
    // Time gutter should show at least "6 AM" and "12 PM"
    expect(screen.getByText('6 AM')).toBeDefined()
    expect(screen.getByText('12 PM')).toBeDefined()
  })

  it('day view renders a session block with the task title', async () => {
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    // Day view is default — block should appear with task title
    expect(screen.getAllByText(/Morning Study/).length).toBeGreaterThan(0)
  })

  it('day view session block has an accessible label including the start time', async () => {
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    // Block button should have an aria-label mentioning the time
    const blocks = screen.getAllByRole('button', { name: /9:00/ })
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('week view shows session block with task title in the correct day column', async () => {
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /week/i })) })
    expect(screen.getAllByText(/Morning Study/).length).toBeGreaterThan(0)
  })

  it('week view has a Print Week button that calls window.print', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /week/i })) })
    const printBtn = screen.getByRole('button', { name: /print week/i })
    await act(async () => { await userEvent.click(printBtn) })
    expect(printSpy).toHaveBeenCalledOnce()
    printSpy.mockRestore()
  })

  it('month view has a Print Month button that calls window.print', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /month/i })) })
    const printBtn = screen.getByRole('button', { name: /print month/i })
    await act(async () => { await userEvent.click(printBtn) })
    expect(printSpy).toHaveBeenCalledOnce()
    printSpy.mockRestore()
  })

  it('day view block shows score % inside the block button', async () => {
    const today = new Date()
    today.setHours(9, 0, 0, 0)
    const session: Session = {
      schemaVersion: 2, sessionId: 'score-test', articleId: 'test',
      startedAt: today.getTime(), status: 'completed',
      durationMs: 60 * 60 * 1000, activeReadingMs: 60 * 60 * 1000,
      lastSavedAt: today.getTime() + 60 * 60 * 1000,
      endedAt: today.getTime() + 60 * 60 * 1000,
      endReason: 'manual', checkIn: null, cameraEnabled: false, events: [],
      taskSettings: { categoryId: 'study_notes', rulesVersion: 1,
        rules: { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: true },
        taskTitle: 'Morning Study' },
    }
    const analysis: AnalysisResult = {
      sessionId: 'score-test', status: 'ready', totalScore: 80,
      summary: null, scoringVersion: '1.0.0', source: 'real', analyzedAt: Date.now(),
    }
    upsertHistoryEntry({ session, analysis, entryVersion: 1 })
    render(<Dashboard onStartNewSession={() => {}} />)
    // The session block button itself must contain "80%" as text
    const block = screen.getAllByRole('button', { name: /9:00/ })[0]
    expect(block.textContent).toContain('80%')
  })

  it('month view shows one dot per session on the same day', async () => {
    // Two sessions on same day at different times
    const today = new Date()
    today.setHours(9, 0, 0, 0)
    makeEntry({ sessionId: 'dot-a', startedAt: today.getTime() })
    today.setHours(14, 0, 0, 0)
    makeEntry({ sessionId: 'dot-b', startedAt: today.getTime() })
    render(<Dashboard onStartNewSession={() => {}} />)
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /month/i })) })
    // Today's cell should show a label mentioning 2 sessions
    const todayCell = screen.getByRole('button', { name: /2 sessions/ })
    expect(todayCell).toBeDefined()
  })

  it('month view shows "+N" when a day has more than 4 sessions', async () => {
    const today = new Date()
    for (let h = 8; h <= 13; h++) {
      today.setHours(h, 0, 0, 0)
      makeEntry({ sessionId: `overflow-${h}`, startedAt: today.getTime() })
    }
    render(<Dashboard onStartNewSession={() => {}} />)
    await act(async () => { await userEvent.click(screen.getByRole('button', { name: /month/i })) })
    expect(screen.getByText('+2')).toBeDefined()
  })

  it('session detail panel has a Print button that calls window.print', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    makeEntry()
    render(<Dashboard onStartNewSession={() => {}} />)
    // Click the session block to open the detail panel
    const blocks = screen.getAllByRole('button', { name: /9:00/ })
    await act(async () => { await userEvent.click(blocks[0]) })
    // Print button should appear in the detail panel
    const printBtn = screen.getByRole('button', { name: /print session/i })
    await act(async () => { await userEvent.click(printBtn) })
    expect(printSpy).toHaveBeenCalledOnce()
    printSpy.mockRestore()
  })
})
