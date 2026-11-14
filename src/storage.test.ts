import { describe, test, expect, beforeEach } from 'vitest'
import { loadSession, saveSession, clearSession } from './storage'
import { Session, SCHEMA_VERSION } from './types'

const baseSession: Session = {
  schemaVersion: SCHEMA_VERSION,
  sessionId: 'test-123',
  articleId: 'reading-article-v1',
  startedAt: 1_700_000_000_000,
  status: 'completed',
  durationMs: 120_000,
  activeReadingMs: 118_000,
  lastSavedAt: 1_700_000_120_000,
  endedAt: 1_700_000_120_000,
  endReason: 'time_up',
  checkIn: null,
  events: [],
}

beforeEach(() => localStorage.clear())

describe('loadSession', () => {
  test('returns empty when nothing stored', () => {
    const result = loadSession()
    expect('empty' in result && result.empty).toBe(true)
  })

  test('returns saved session correctly', () => {
    saveSession(baseSession)
    const result = loadSession()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.session.sessionId).toBe('test-123')
      expect(result.session.status).toBe('completed')
    }
  })

  test('returns parse_error on invalid JSON', () => {
    localStorage.setItem('flowfinder_session_v2', '{invalid json')
    const result = loadSession()
    expect(result.ok).toBe(false)
    if (!result.ok && !('empty' in result)) {
      expect(result.error.kind).toBe('parse_error')
    }
  })

  test('returns version_mismatch on wrong schemaVersion', () => {
    localStorage.setItem(
      'flowfinder_session_v2',
      JSON.stringify({ ...baseSession, schemaVersion: 99 }),
    )
    const result = loadSession()
    expect(result.ok).toBe(false)
    if (!result.ok && !('empty' in result)) {
      expect(result.error.kind).toBe('version_mismatch')
    }
  })

  test('returns invalid_structure when required fields are missing', () => {
    localStorage.setItem(
      'flowfinder_session_v2',
      JSON.stringify({ schemaVersion: SCHEMA_VERSION }),
    )
    const result = loadSession()
    expect(result.ok).toBe(false)
    if (!result.ok && !('empty' in result)) {
      expect(result.error.kind).toBe('invalid_structure')
    }
  })
})

describe('saveSession + clearSession', () => {
  test('round-trips a session through localStorage', () => {
    saveSession(baseSession)
    const result = loadSession()
    expect(result.ok).toBe(true)
  })

  test('clearSession removes data so loadSession returns empty', () => {
    saveSession(baseSession)
    const err = clearSession()
    expect(err).toBeNull()  // no error on normal delete
    const result = loadSession()
    expect('empty' in result && result.empty).toBe(true)
  })
})
