import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { HistoryPage, focusSeries, type HistoryApi } from './HistoryPage'
import { findWebApp } from '../webApp'
import { SessionRecorder } from '../session/recorder'
import { deleteExtensionEntry, loadExtensionHistory, markSynced, memoryKV, saveCompletedSession, toHistoryEntry } from '../session/historyStore'
import type { AttentionResult } from '@core/attentionModel'

const ok = (trend: number): AttentionResult => ({ status: 'ok', features: { nLineReturns: 1, xProgress: 100, missingRatio: 0 }, z: [0, 0], score: trend, trend })

function entry(start: number, title: string, trends: number[]) {
  let t = start
  const rec = new SessionRecorder(
    { calibration: { quality: 'good', accuracyPx: 80, precisionPx: 40, validRatio: 1, viewport: { width: 1, height: 1 }, points: [], calibratedAt: 0 }, modelCvRocAuc: 0.6 },
    () => t,
    { taskTitle: title, plannedDurationMs: 25 * 60_000 },
  )
  rec.enterPage('en.wikipedia.org')
  rec.setActive(true)
  for (const tr of trends) { t += 2000; rec.addAttention(ok(tr)) }
  return toHistoryEntry(rec.end('manual'))
}

describe('findWebApp', () => {
  const page = (html: string, ok = true) => vi.fn(async () => ({ ok, status: ok ? 200 : 500, text: async () => html }) as Response)

  it('returns the origin serving the FlowFinder marker', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('http://localhost:4173')) return { ok: true, status: 200, text: async () => '<meta name="flowfinder-app" content="1" />' } as Response
      throw new TypeError('Failed to fetch') // dev server not running
    })
    expect(await findWebApp(['http://localhost:5173', 'http://localhost:4173'], fetcher as never)).toBe('http://localhost:4173')
  })

  it('null when nothing answers, or another app runs on the port', async () => {
    expect(await findWebApp(['http://localhost:5173'], vi.fn(async () => { throw new TypeError('x') }) as never)).toBeNull()
    expect(await findWebApp(['http://localhost:5173'], page('<html>some other vite app</html>') as never)).toBeNull()
  })
})

describe('extension history store', () => {
  it('delete removes the entry and its sync marks', async () => {
    const kv = memoryKV()
    const e = entry(1000, 'A', [0.3, 0.3, 0.3])
    await saveCompletedSession(kv, e.session)
    await markSynced(kv, 'http://localhost:5173', [e.session.sessionId])
    await deleteExtensionEntry(kv, e.session.sessionId)
    const h = await loadExtensionHistory(kv)
    expect(h.entries).toEqual([])
    expect(h.syncedByOrigin['http://localhost:5173']).toEqual([])
  })
})

describe('HistoryPage', () => {
  function makeApi(entries = [entry(1_000_000, 'Older', [0.4, 0.4, 0.4]), entry(9_000_000, 'Cell Membranes', [0.2, 0.3, 0.25])], web: string | null = null) {
    const api: HistoryApi = {
      load: vi.fn(async () => entries),
      remove: vi.fn(async () => {}),
      webAppUrl: vi.fn(async () => web),
      open: vi.fn(),
      download: vi.fn(),
    }
    return api
  }

  it('lists sessions newest first with task, time and focus', async () => {
    await act(async () => { render(<HistoryPage api={makeApi()} />) })
    const tasks = screen.getAllByText(/Cell Membranes|Older/).map(el => el.textContent)
    expect(tasks).toEqual(['Cell Membranes', 'Older'])
    expect(screen.getByText('75%')).toBeTruthy()
    expect(screen.getByText(/npm run dev/)).toBeTruthy()
  })

  it('detail: planned length, sites, focus chart, downloads, delete', async () => {
    const api = makeApi()
    await act(async () => { render(<HistoryPage api={api} />) })
    fireEvent.click(screen.getByText('Cell Membranes'))
    expect(screen.getByText('25:00')).toBeTruthy()
    expect(screen.getByText('Sites: en.wikipedia.org')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Focus over the session' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '.csv' }))
    expect(api.download).toHaveBeenCalledWith(expect.stringMatching(/\.csv$/), expect.stringContaining('attention_score'), 'text/csv')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(api.remove).toHaveBeenCalled()
    expect(screen.queryByText('Cell Membranes')).toBeNull()
  })

  it('offers the full Dashboard when the web app is running', async () => {
    const api = makeApi(undefined, 'http://localhost:5173')
    await act(async () => { render(<HistoryPage api={api} />) })
    fireEvent.click(screen.getByRole('button', { name: /Open the full Dashboard/ }))
    expect(api.open).toHaveBeenCalledWith('http://localhost:5173/#dashboard')
  })

  it('empty state', async () => {
    await act(async () => { render(<HistoryPage api={makeApi([])} />) })
    expect(screen.getByText(/No sessions yet/)).toBeTruthy()
  })

  it('focusSeries = 1 − trend of attention events', () => {
    expect(focusSeries(entry(0, 'x', [0.2, 0.4])).map(p => Math.round(p.focus * 10) / 10)).toEqual([0.8, 0.6])
  })
})
