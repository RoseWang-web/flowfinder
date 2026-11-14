import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadHistory,
  upsertHistoryEntry,
  deleteHistoryEntry,
  HISTORY_SCHEMA_VERSION,
  type HistoryEntry,
} from './historyStorage'
import type { Session } from './types'
import type { AnalysisResult } from './analysisTypes'

// ── localStorage mock ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()

vi.stubGlobal('localStorage', localStorageMock)

beforeEach(() => {
  localStorageMock.clear()
  vi.clearAllMocks()
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSession(id = 'sess-1'): Session {
  return {
    schemaVersion: 2,
    sessionId: id,
    articleId: 'article-v1',
    startedAt: Date.UTC(2026, 0, 15, 10, 0, 0),
    status: 'completed',
    durationMs: 30 * 60_000,
    activeReadingMs: 25 * 60_000,
    lastSavedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    endedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
    endReason: 'manual',
    checkIn: null,
    cameraEnabled: false,
    taskSettings: {
      categoryId: 'web_reading',
      rulesVersion: 1,
      rules: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false },
    },
    events: [],
  }
}

function makeAnalysis(sessionId = 'sess-1'): AnalysisResult {
  return {
    sessionId,
    status: 'ready',
    totalScore: 75,
    summary: null,
    scoringVersion: '1.0.0',
    source: 'real',
    analyzedAt: Date.now(),
  }
}

function makeEntry(id = 'sess-1'): HistoryEntry {
  return {
    session: makeSession(id),
    analysis: makeAnalysis(id),
    entryVersion: 1,
  }
}

// ── loadHistory ───────────────────────────────────────────────────────────────

describe('loadHistory', () => {
  it('returns empty sentinel when key does not exist', () => {
    const result = loadHistory()
    expect(result).toMatchObject({ ok: false, empty: true })
  })

  it('returns error on non-JSON data', () => {
    localStorageMock.setItem('flowfinder_history_v1', 'not-json')
    const result = loadHistory()
    expect(result).toMatchObject({ ok: false })
    if (!result.ok && !('empty' in result)) {
      expect(result.error.kind).toBe('parse_error')
    }
  })

  it('returns error on wrong schema version', () => {
    localStorageMock.setItem(
      'flowfinder_history_v1',
      JSON.stringify({ schemaVersion: 99, entries: [], deletedIds: [] }),
    )
    const result = loadHistory()
    expect(result).toMatchObject({ ok: false })
  })

  it('returns error when entries is not an array', () => {
    localStorageMock.setItem(
      'flowfinder_history_v1',
      JSON.stringify({ schemaVersion: HISTORY_SCHEMA_VERSION, entries: 'bad', deletedIds: [] }),
    )
    const result = loadHistory()
    expect(result).toMatchObject({ ok: false })
  })

  it('loads valid data correctly', () => {
    const entry = makeEntry()
    const data = { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [entry], deletedIds: [] }
    localStorageMock.setItem('flowfinder_history_v1', JSON.stringify(data))
    const result = loadHistory()
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.data.entries).toHaveLength(1)
      expect(result.data.entries[0].session.sessionId).toBe('sess-1')
    }
  })

  it('skips corrupt entries but preserves valid ones', () => {
    const valid = makeEntry()
    const corrupt = { session: null, analysis: null, entryVersion: 1 }
    const data = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [corrupt, valid],
      deletedIds: [],
    }
    localStorageMock.setItem('flowfinder_history_v1', JSON.stringify(data))
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries).toHaveLength(1)
      expect(result.data.entries[0].session.sessionId).toBe('sess-1')
    }
  })

  it('defaults deletedIds to [] when missing from stored data', () => {
    const entry = makeEntry()
    const data = { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [entry] }
    localStorageMock.setItem('flowfinder_history_v1', JSON.stringify(data))
    const result = loadHistory()
    if (result.ok) {
      expect(result.data.deletedIds).toEqual([])
    }
  })
})

// ── upsertHistoryEntry ────────────────────────────────────────────────────────

describe('upsertHistoryEntry', () => {
  it('adds a new entry when storage is empty', () => {
    const entry = makeEntry()
    const err = upsertHistoryEntry(entry)
    expect(err).toBeNull()

    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries).toHaveLength(1)
    }
  })

  it('upserts by sessionId — does not create duplicate', () => {
    const entry = makeEntry()
    upsertHistoryEntry(entry)
    upsertHistoryEntry(entry) // second call same entry

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries).toHaveLength(1)
    }
  })

  it('updates existing entry on second upsert', () => {
    const entry = makeEntry()
    upsertHistoryEntry(entry)

    const updated: HistoryEntry = {
      ...entry,
      analysis: { ...entry.analysis, totalScore: 90 },
    }
    upsertHistoryEntry(updated)

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries[0].analysis.totalScore).toBe(90)
    }
  })

  it('is safe to call multiple times (idempotent for same data)', () => {
    const entry = makeEntry()
    for (let i = 0; i < 5; i++) {
      upsertHistoryEntry(entry)
    }
    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries).toHaveLength(1)
    }
  })

  it('does not re-add a deleted session', () => {
    const entry = makeEntry('sess-deleted')
    upsertHistoryEntry(entry)
    deleteHistoryEntry('sess-deleted')

    // Try to re-insert
    upsertHistoryEntry(entry)

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries).toHaveLength(0)
      expect(result.data.deletedIds).toContain('sess-deleted')
    }
  })

  it('stores multiple entries with different sessionIds', () => {
    upsertHistoryEntry(makeEntry('a'))
    upsertHistoryEntry(makeEntry('b'))
    upsertHistoryEntry(makeEntry('c'))

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries).toHaveLength(3)
    }
  })
})

// ── deleteHistoryEntry ────────────────────────────────────────────────────────

describe('deleteHistoryEntry', () => {
  it('removes the entry from storage', () => {
    upsertHistoryEntry(makeEntry('sess-1'))
    upsertHistoryEntry(makeEntry('sess-2'))

    deleteHistoryEntry('sess-1')

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries).toHaveLength(1)
      expect(result.data.entries[0].session.sessionId).toBe('sess-2')
    }
  })

  it('adds sessionId to deletedIds', () => {
    upsertHistoryEntry(makeEntry('sess-1'))
    deleteHistoryEntry('sess-1')

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.deletedIds).toContain('sess-1')
    }
  })

  it('does not add duplicate to deletedIds when called twice', () => {
    upsertHistoryEntry(makeEntry('sess-1'))
    deleteHistoryEntry('sess-1')
    deleteHistoryEntry('sess-1')

    const result = loadHistory()
    if (result.ok) {
      const count = result.data.deletedIds.filter(id => id === 'sess-1').length
      expect(count).toBe(1)
    }
  })

  it('handles deleting a non-existent session gracefully', () => {
    const err = deleteHistoryEntry('ghost-sess')
    expect(err).toBeNull()

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.deletedIds).toContain('ghost-sess')
    }
  })

  it('returns null on success', () => {
    upsertHistoryEntry(makeEntry())
    expect(deleteHistoryEntry('sess-1')).toBeNull()
  })
})

// ── deletedIds blocks re-import ───────────────────────────────────────────────

describe('deletedIds blocking re-import', () => {
  it('upsert after delete leaves entry removed', () => {
    const entry = makeEntry('sess-x')
    upsertHistoryEntry(entry)
    deleteHistoryEntry('sess-x')

    // Simulate re-import attempt
    const err = upsertHistoryEntry(entry)
    expect(err).toBeNull() // no error — silently skipped

    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries.map(e => e.session.sessionId)).not.toContain('sess-x')
    }
  })
})
