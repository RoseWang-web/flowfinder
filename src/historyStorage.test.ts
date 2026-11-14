import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  loadHistory,
  upsertHistoryEntry,
  deleteHistoryEntry,
  updateManualOverride,
  clearManualOverride,
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

// ── Helper: build a minimal raw entry for JSON fixture tests ─────────────────

function rawSessionWith(sessionExtra: Record<string, unknown>) {
  return {
    session: {
      schemaVersion: 2,
      sessionId: 'raw-sess',
      articleId: 'article-v1',
      startedAt: Date.UTC(2026, 0, 15, 10, 0, 0),
      status: 'completed',
      durationMs: 1_800_000,
      activeReadingMs: 1_500_000,
      lastSavedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
      endedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
      endReason: 'manual',
      checkIn: null,
      cameraEnabled: false,
      events: [],
      ...sessionExtra,
    },
    analysis: {
      sessionId: 'raw-sess',
      status: 'ready',
      totalScore: 70,
      summary: null,
      scoringVersion: '0.1.0',
      source: 'real',
      analyzedAt: 1_000,
    },
    entryVersion: 1,
  }
}

function rawEntryWith(extra: Record<string, unknown>) {
  return {
    session: {
      schemaVersion: 2,
      sessionId: 'raw-sess',
      articleId: 'article-v1',
      startedAt: Date.UTC(2026, 0, 15, 10, 0, 0),
      status: 'completed',
      durationMs: 1_800_000,
      activeReadingMs: 1_500_000,
      lastSavedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
      endedAt: Date.UTC(2026, 0, 15, 10, 30, 0),
      endReason: 'manual',
      checkIn: null,
      cameraEnabled: false,
      events: [],
    },
    analysis: {
      sessionId: 'raw-sess',
      status: 'ready',
      totalScore: 70,
      summary: null,
      scoringVersion: '0.1.0',
      source: 'real',
      analyzedAt: 1_000,
    },
    entryVersion: 1,
    ...extra,
  }
}

// ── updateManualOverride ──────────────────────────────────────────────────────

describe('updateManualOverride', () => {
  it('saves override score and preserves analysis and session', () => {
    upsertHistoryEntry(makeEntry('s1'))
    const err = updateManualOverride('s1', { score: 85, overriddenAt: 1000 })
    expect(err).toBeNull()
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 's1')!
      expect(e.manualOverride?.score).toBe(85)
      expect(e.analysis.totalScore).toBe(75) // original untouched
    }
  })

  it('no-ops silently for unknown sessionId', () => {
    const err = updateManualOverride('missing', { score: 50, overriddenAt: 1000 })
    expect(err).toBeNull()
  })

  it('stores optional reason when provided', () => {
    upsertHistoryEntry(makeEntry('s1'))
    updateManualOverride('s1', { score: 60, reason: 'Felt more accurate', overriddenAt: 2000 })
    const result = loadHistory()
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 's1')!
      expect(e.manualOverride?.reason).toBe('Felt more accurate')
    }
  })

  it('stores reason as undefined when not provided', () => {
    upsertHistoryEntry(makeEntry('s1'))
    updateManualOverride('s1', { score: 60, overriddenAt: 2000 })
    const result = loadHistory()
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 's1')!
      expect(e.manualOverride?.reason).toBeUndefined()
    }
  })

  it('returns write error when localStorage.setItem throws', () => {
    upsertHistoryEntry(makeEntry('s1'))
    vi.spyOn(localStorageMock, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    const err = updateManualOverride('s1', { score: 85, overriddenAt: 1000 })
    expect(err).not.toBeNull()
    expect(err!.kind).toBe('write_error')
  })

  it('allows override score of 0 (zero is a valid score)', () => {
    upsertHistoryEntry(makeEntry('s1'))
    updateManualOverride('s1', { score: 0, overriddenAt: 1000 })
    const result = loadHistory()
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 's1')!
      expect(e.manualOverride?.score).toBe(0)
    }
  })
})

// ── clearManualOverride ───────────────────────────────────────────────────────

describe('clearManualOverride', () => {
  it('removes override, leaves analysis and session intact', () => {
    upsertHistoryEntry(makeEntry('s1'))
    updateManualOverride('s1', { score: 90, overriddenAt: 1000 })
    clearManualOverride('s1')
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 's1')!
      expect(e.manualOverride).toBeUndefined()
      expect(e.analysis.totalScore).toBe(75)
    }
  })

  it('no-ops for unknown sessionId', () => {
    const err = clearManualOverride('missing')
    expect(err).toBeNull()
  })
})

// ── upsertHistoryEntry preserves manualOverride ───────────────────────────────

describe('upsertHistoryEntry preserves manualOverride', () => {
  it('re-upserting a session does not wipe an existing manual override', () => {
    upsertHistoryEntry(makeEntry('s1'))
    updateManualOverride('s1', { score: 90, overriddenAt: 1000 })
    // simulate analysis update arriving
    const updated = { ...makeEntry('s1'), analysis: { ...makeAnalysis('s1'), totalScore: 80 } }
    upsertHistoryEntry(updated)
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 's1')!
      expect(e.manualOverride?.score).toBe(90) // preserved
      expect(e.analysis.totalScore).toBe(80)   // updated
    }
  })

  it('new session (no existing entry) has no override', () => {
    upsertHistoryEntry(makeEntry('brand-new'))
    const result = loadHistory()
    if (result.ok) {
      const e = result.data.entries.find(e => e.session.sessionId === 'brand-new')!
      expect(e.manualOverride).toBeUndefined()
    }
  })
})

// ── validateEntry with manualOverride ─────────────────────────────────────────

describe('validateEntry with manualOverride', () => {
  it('parses valid manualOverride from raw JSON', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawEntryWith({ manualOverride: { score: 55, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries[0].manualOverride?.score).toBe(55)
    }
  })

  it('ignores manualOverride with score > 100', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawEntryWith({ manualOverride: { score: 150, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries[0].manualOverride).toBeUndefined()
    }
  })

  it('ignores manualOverride with non-integer score', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawEntryWith({ manualOverride: { score: 75.5, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries[0].manualOverride).toBeUndefined()
    }
  })

  it('ignores manualOverride with score < 0', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawEntryWith({ manualOverride: { score: -1, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries[0].manualOverride).toBeUndefined()
    }
  })

  it('backward-compat: entry without manualOverride field loads fine', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawEntryWith({})],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries[0].manualOverride).toBeUndefined()
    }
  })

  it('parses manualOverride score of 0 (valid edge case)', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawEntryWith({ manualOverride: { score: 0, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    if (result.ok) {
      expect(result.data.entries[0].manualOverride?.score).toBe(0)
    }
  })
})

// ── plannedDurationMs backward compat ─────────────────────────────────────────

describe('plannedDurationMs backward compat', () => {
  it('defaults plannedDurationMs to 120_000 when field is absent from stored session', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawSessionWith({})],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries[0].session.plannedDurationMs).toBe(120_000)
    }
  })

  it('preserves plannedDurationMs of 1_800_000 when present', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawSessionWith({ plannedDurationMs: 1_800_000 })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries[0].session.plannedDurationMs).toBe(1_800_000)
    }
  })

  it('preserves plannedDurationMs of 0 (unlimited) when present', () => {
    const raw = JSON.stringify({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: [rawSessionWith({ plannedDurationMs: 0 })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.entries[0].session.plannedDurationMs).toBe(0)
    }
  })
})
