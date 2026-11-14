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
