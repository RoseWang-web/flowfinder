/**
 * historyStore.ts — The extension's own copy of finished sessions.
 *
 * Stored in chrome.storage.local (the extension cannot see the web app's
 * localStorage). Entries use the web app's HistoryEntry shape and are scored
 * with the web app's computeSessionAnalysis(), so syncing is a plain upsert.
 *
 * Sync is tracked per web-app origin (dev and production keep separate
 * localStorage), so a session synced to localhost:5173 is still offered to
 * the production site.
 */
import type { HistoryEntry } from '@core/historyStorage'
import type { Session } from '@core/types'
import { computeSessionAnalysis } from '@core/sessionAnalysis'
import { finalizeInterrupted } from './interrupted'

export interface KV {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

export const chromeKV: KV = {
  get: async key => (await chrome.storage.local.get(key))[key],
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: key => chrome.storage.local.remove(key),
}

export function memoryKV(): KV & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: async k => (k in data ? structuredClone(data[k]) : undefined),
    set: async (k, v) => { data[k] = structuredClone(v) },
    remove: async k => { delete data[k] },
  }
}

export const HISTORY_KEY = 'flowfinder_ext_history_v1'
export const CURRENT_KEY = 'flowfinder_ext_current_session_v1'

export interface ExtensionHistory {
  version: 1
  entries: HistoryEntry[]
  /** origin → sessionIds already written into that web app's history */
  syncedByOrigin: Record<string, string[]>
}

const empty = (): ExtensionHistory => ({ version: 1, entries: [], syncedByOrigin: {} })

export async function loadExtensionHistory(kv: KV): Promise<ExtensionHistory> {
  const raw = (await kv.get(HISTORY_KEY)) as ExtensionHistory | undefined
  if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return empty()
  return { version: 1, entries: raw.entries, syncedByOrigin: raw.syncedByOrigin ?? {} }
}

export function toHistoryEntry(session: Session): HistoryEntry {
  return { session, analysis: computeSessionAnalysis(session), entryVersion: 1 }
}

/** Add or replace a finished session. */
export async function saveCompletedSession(kv: KV, session: Session): Promise<HistoryEntry> {
  const h = await loadExtensionHistory(kv)
  const entry = toHistoryEntry(session)
  const i = h.entries.findIndex(e => e.session.sessionId === session.sessionId)
  if (i >= 0) h.entries[i] = entry
  else h.entries.push(entry)
  await kv.set(HISTORY_KEY, h)
  return entry
}

// ── Crash recovery for the session in progress ─────────────────────────

export const saveCurrentSession = (kv: KV, s: Session) => kv.set(CURRENT_KEY, s)
export const clearCurrentSession = (kv: KV) => kv.remove(CURRENT_KEY)

/** If the panel closed mid-session, store that session as interrupted. */
export async function recoverInterruptedSession(kv: KV, now = Date.now()): Promise<HistoryEntry | null> {
  const saved = (await kv.get(CURRENT_KEY)) as Session | undefined
  if (!saved || typeof saved.sessionId !== 'string') return null
  const entry = await saveCompletedSession(kv, finalizeInterrupted(saved, now))
  await clearCurrentSession(kv)
  return entry
}

// ── Sync bookkeeping ───────────────────────────────────────────────────

export async function pendingForOrigin(kv: KV, origin: string): Promise<HistoryEntry[]> {
  const h = await loadExtensionHistory(kv)
  const done = new Set(h.syncedByOrigin[origin] ?? [])
  return h.entries.filter(e => !done.has(e.session.sessionId))
}

export async function markSynced(kv: KV, origin: string, sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const h = await loadExtensionHistory(kv)
  const set = new Set(h.syncedByOrigin[origin] ?? [])
  sessionIds.forEach(id => set.add(id))
  h.syncedByOrigin[origin] = [...set]
  await kv.set(HISTORY_KEY, h)
}

/** Remove a session from the extension's own history (does not touch the web app). */
export async function deleteExtensionEntry(kv: KV, sessionId: string): Promise<void> {
  const h = await loadExtensionHistory(kv)
  h.entries = h.entries.filter(e => e.session.sessionId !== sessionId)
  for (const o of Object.keys(h.syncedByOrigin)) h.syncedByOrigin[o] = h.syncedByOrigin[o].filter(id => id !== sessionId)
  await kv.set(HISTORY_KEY, h)
}

export interface HistorySummaryRow {
  sessionId: string
  startedAt: number
  activeReadingMs: number
  endReason: Session['endReason']
  score: number | null
  hosts: string[]
  syncedTo: string[]
}

/** Newest first, for the side panel list. */
export async function summarizeExtensionHistory(kv: KV, limit = 10): Promise<HistorySummaryRow[]> {
  const h = await loadExtensionHistory(kv)
  return [...h.entries]
    .sort((a, b) => b.session.startedAt - a.session.startedAt)
    .slice(0, limit)
    .map(e => ({
      sessionId: e.session.sessionId,
      startedAt: e.session.startedAt,
      activeReadingMs: e.session.activeReadingMs,
      endReason: e.session.endReason,
      score: e.analysis.totalScore,
      hosts: [...new Set((e.session.pages ?? []).map(p => p.host))],
      syncedTo: Object.entries(h.syncedByOrigin).filter(([, ids]) => ids.includes(e.session.sessionId)).map(([o]) => o),
    }))
}
