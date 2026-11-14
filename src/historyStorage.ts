/**
 * historyStorage.ts — Multi-session history stored in localStorage.
 *
 * Key: flowfinder_history_v1
 * Format: { schemaVersion: 1, entries: HistoryEntry[], deletedIds: string[] }
 *
 * Each HistoryEntry stores the full Session (for timeline/event display) plus
 * an AnalysisResult (data contract with the scoring module).
 *
 * Operations use upsert by sessionId — safe to call multiple times.
 * deletedIds prevents re-import of explicitly deleted sessions.
 *
 * Does NOT call localStorage.clear().
 */

import type { Session } from './types'
import type { AnalysisResult } from './analysisTypes'
import { makePendingAnalysis } from './analysisTypes'
import { loadSession } from './storage'

export const HISTORY_SCHEMA_VERSION = 1
const HISTORY_KEY = 'flowfinder_history_v1'

export interface HistoryEntry {
  /** Full session data — includes events for timeline/event-log display. */
  session: Session
  /** Analysis result from the scoring module (or pending stub for new sessions). */
  analysis: AnalysisResult
  entryVersion: 1
}

export interface HistoryData {
  schemaVersion: typeof HISTORY_SCHEMA_VERSION
  entries: HistoryEntry[]
  /** sessionIds explicitly deleted — blocks re-import via migrateCurrentSession. */
  deletedIds: string[]
}

export interface HistoryStorageError {
  kind: 'parse_error' | 'invalid_structure' | 'write_error'
  message: string
  isLoadError: boolean
}

export type LoadHistoryResult =
  | { ok: true; data: HistoryData }
  | { ok: false; error: HistoryStorageError }
  | { ok: false; empty: true }

function validateEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const sess = obj.session
  if (typeof sess !== 'object' || sess === null) return null
  const s = sess as Record<string, unknown>
  if (typeof s.sessionId !== 'string' || typeof s.startedAt !== 'number') return null

  const session = sess as Session
  const analysis: AnalysisResult =
    typeof obj.analysis === 'object' && obj.analysis !== null
      ? (obj.analysis as AnalysisResult)
      : makePendingAnalysis(session.sessionId)

  return { session, analysis, entryVersion: 1 }
}

export function loadHistory(): LoadHistoryResult {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (raw === null) return { ok: false, empty: true }

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: { kind: 'invalid_structure', message: '歷史紀錄格式錯誤，將從空白開始。', isLoadError: true } }
    }
    const obj = parsed as Record<string, unknown>
    if (obj.schemaVersion !== HISTORY_SCHEMA_VERSION) {
      return { ok: false, error: { kind: 'invalid_structure', message: '歷史紀錄版本不支援，將從空白開始。', isLoadError: true } }
    }
    if (!Array.isArray(obj.entries)) {
      return { ok: false, error: { kind: 'invalid_structure', message: '歷史紀錄格式錯誤，將從空白開始。', isLoadError: true } }
    }

    const entries: HistoryEntry[] = []
    for (const rawEntry of obj.entries) {
      const e = validateEntry(rawEntry)
      if (e) entries.push(e)
      // silently skip corrupt entries to preserve others
    }

    const deletedIds: string[] = Array.isArray(obj.deletedIds)
      ? (obj.deletedIds as unknown[]).filter((id): id is string => typeof id === 'string')
      : []

    return { ok: true, data: { schemaVersion: HISTORY_SCHEMA_VERSION, entries, deletedIds } }
  } catch {
    return { ok: false, error: { kind: 'parse_error', message: '歷史紀錄無法解析，將從空白開始。', isLoadError: true } }
  }
}

function writeHistory(data: HistoryData): HistoryStorageError | null {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(data))
    return null
  } catch {
    return { kind: 'write_error', message: '歷史紀錄無法寫入，請確認儲存空間是否不足。', isLoadError: false }
  }
}

function emptyHistory(): HistoryData {
  return { schemaVersion: HISTORY_SCHEMA_VERSION, entries: [], deletedIds: [] }
}

function loadOrEmpty(): HistoryData {
  const r = loadHistory()
  return r.ok ? r.data : emptyHistory()
}

/** Upsert a session into history. Idempotent — safe to call multiple times. */
export function upsertHistoryEntry(entry: HistoryEntry): HistoryStorageError | null {
  const data = loadOrEmpty()

  // Respect explicit deletes — do not re-add deleted sessions
  if (data.deletedIds.includes(entry.session.sessionId)) return null

  const idx = data.entries.findIndex(e => e.session.sessionId === entry.session.sessionId)
  if (idx >= 0) {
    data.entries[idx] = entry
  } else {
    data.entries.push(entry)
  }

  return writeHistory(data)
}

/**
 * Delete a session from history and add its id to deletedIds.
 * This prevents re-import via migrateCurrentSession.
 */
export function deleteHistoryEntry(sessionId: string): HistoryStorageError | null {
  const data = loadOrEmpty()

  data.entries = data.entries.filter(e => e.session.sessionId !== sessionId)
  if (!data.deletedIds.includes(sessionId)) {
    data.deletedIds.push(sessionId)
  }

  return writeHistory(data)
}

/**
 * One-time import of the current completed session from flowfinder_session_v2.
 * Safe to call multiple times — upsert by sessionId, skips deletedIds.
 */
export function migrateCurrentSession(): HistoryStorageError | null {
  const result = loadSession()
  if ('empty' in result || !result.ok) return null
  const session = result.session
  if (session.status !== 'completed') return null

  return upsertHistoryEntry({
    session,
    analysis: makePendingAnalysis(session.sessionId),
    entryVersion: 1,
  })
}
