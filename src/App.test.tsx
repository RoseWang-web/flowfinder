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
    expect(screen.getByText('時間軸')).toBeDefined()
  })

  it('shows 閱讀計時 and 本次經過時間 in timeline stats', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    expect(screen.getAllByText('閱讀計時').length).toBeGreaterThan(0)
    expect(screen.getByText('本次經過時間')).toBeDefined()
  })

  it('shows "此紀錄沒有攝影機資料" for session without camera', () => {
    saveSession(makeCompletedSession({ cameraEnabled: false }))
    render(<App />)
    expect(screen.getByText('此紀錄沒有攝影機資料。')).toBeDefined()
  })

  it('does not show no-camera note when session has camera_started event', () => {
    const events: Session['events'] = [
      { id: 'e1', sessionId: 's1', eventType: 'session_start', elapsedMs: 0, activeReadingMs: 0, data: { visible: true } },
      { id: 'e2', sessionId: 's1', eventType: 'camera_started', elapsedMs: 1_000, activeReadingMs: 0 },
      { id: 'e3', sessionId: 's1', eventType: 'session_end', elapsedMs: 60_000, activeReadingMs: 55_000 },
    ]
    saveSession(makeCompletedSession({ cameraEnabled: true, events }))
    render(<App />)
    expect(screen.queryByText('此紀錄沒有攝影機資料。')).toBeNull()
  })

  it('delete button clears result page and returns to consent screen', async () => {
    saveSession(makeCompletedSession())
    render(<App />)
    const deleteBtn = screen.getByRole('button', { name: '刪除本次資料' })
    await act(async () => { await userEvent.click(deleteBtn) })
    expect(screen.getByText('攝影機輔助（選擇性）')).toBeDefined()
    expect(localStorage.getItem('flowfinder_session_v2')).toBeNull()
  })

  it('localStorage delete failure: shows error, still returns to idle', async () => {
    saveSession(makeCompletedSession())
    vi.spyOn(localStorage, 'removeItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded')
    })
    render(<App />)
    const deleteBtn = screen.getByRole('button', { name: '刪除本次資料' })
    await act(async () => { await userEvent.click(deleteBtn) })
    // Error banner visible
    expect(screen.getByText(/無法刪除保存紀錄/)).toBeDefined()
    // Memory cleared — app is on idle page
    expect(screen.getByText('攝影機輔助（選擇性）')).toBeDefined()
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
    expect(screen.getByText('本次任務設定')).toBeDefined()
    expect(screen.getByText('學習／筆記')).toBeDefined()
    expect(screen.getByText('本階段僅保存設定，尚未套用行為回顧規則。')).toBeDefined()
  })

  it('result page shows "此紀錄未保存任務設定" for session without taskSettings', () => {
    saveSession(makeCompletedSession())
    render(<App />)
    expect(screen.getByText('此紀錄未保存任務設定。')).toBeDefined()
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
    expect(screen.getByText('時間軸')).toBeDefined()
    // Task settings treated as unavailable
    expect(screen.getByText('此紀錄未保存任務設定。')).toBeDefined()
  })

  it('idle page shows task category selector', () => {
    render(<App />)
    expect(screen.getByText('本次任務設定')).toBeDefined()
    expect(screen.getByRole('combobox')).toBeDefined()
  })
})
