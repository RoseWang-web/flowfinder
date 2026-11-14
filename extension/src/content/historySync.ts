/**
 * historySync.ts — Runs in the content script on the FlowFinder web app only.
 *
 * A content script shares the page's origin storage, so `localStorage` here
 * IS the web app's localStorage. We reuse the web app's own
 * upsertHistoryEntry(): idempotent by sessionId, and it respects sessions the
 * user deleted in the Dashboard (deletedIds), so they are never re-added.
 */
import { upsertHistoryEntry, type HistoryEntry, type HistoryStorageError } from '@core/historyStorage'
import { FLOWFINDER_APP_META, FLOWFINDER_ORIGINS, HISTORY_UPDATED_EVENT } from '../config'
import { HISTORY_KEY, markSynced, pendingForOrigin, type KV } from '../session/historyStore'

export function isFlowFinderApp(origin: string, doc: Document): boolean {
  return FLOWFINDER_ORIGINS.includes(origin) && doc.querySelector(`meta[name="${FLOWFINDER_APP_META}"]`) !== null
}

export interface SyncResult { written: number; failed: number }

export async function syncHistoryOnce(
  kv: KV,
  origin: string,
  upsert: (e: HistoryEntry) => HistoryStorageError | null = upsertHistoryEntry,
  target: EventTarget = window,
): Promise<SyncResult> {
  const pending = await pendingForOrigin(kv, origin)
  const ok: string[] = []
  let failed = 0
  for (const entry of pending) {
    // Write errors (storage full) leave the entry pending for the next try
    if (upsert(entry) === null) ok.push(entry.session.sessionId)
    else failed++
  }
  await markSynced(kv, origin, ok)
  if (ok.length > 0) target.dispatchEvent(new CustomEvent(HISTORY_UPDATED_EVENT, { detail: { count: ok.length } }))
  return { written: ok.length, failed }
}

/** Sync now, and again whenever the extension stores a new session. */
export function startHistorySync(kv: KV, origin: string): void {
  let running = false
  let again = false
  const run = async () => {
    if (running) { again = true; return }
    running = true
    try {
      do {
        again = false
        await syncHistoryOnce(kv, origin)
      } while (again)
    } catch (err) {
      console.warn('[FlowFinder] history sync failed', err)
    } finally {
      running = false
    }
  }
  void run()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && HISTORY_KEY in changes) void run()
  })
}
