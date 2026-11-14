import { Session, SCHEMA_VERSION } from './types'

const KEY = 'flowfinder_session_v2'

export interface StorageError {
  kind: 'parse_error' | 'version_mismatch' | 'write_error' | 'invalid_structure'
  /** User-visible message */
  message: string
  /** Whether this is a load-time error (true) or a save-time error (false) */
  isLoadError: boolean
}

export type LoadResult =
  | { ok: true; session: Session }
  | { ok: false; error: StorageError }
  | { ok: false; empty: true }

export function loadSession(): LoadResult {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return { ok: false, empty: true }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {
        ok: false,
        error: {
          kind: 'invalid_structure',
          message: '無法讀取上次紀錄，你仍可開始新的閱讀。',
          isLoadError: true,
        },
      }
    }
    const obj = parsed as Record<string, unknown>
    if (obj.schemaVersion !== SCHEMA_VERSION) {
      return {
        ok: false,
        error: {
          kind: 'version_mismatch',
          message: '無法讀取上次紀錄，你仍可開始新的閱讀。',
          isLoadError: true,
        },
      }
    }
    if (
      typeof obj.sessionId !== 'string' ||
      typeof obj.startedAt !== 'number' ||
      !Array.isArray(obj.events)
    ) {
      return {
        ok: false,
        error: {
          kind: 'invalid_structure',
          message: '無法讀取上次紀錄，你仍可開始新的閱讀。',
          isLoadError: true,
        },
      }
    }
    return { ok: true, session: parsed as Session }
  } catch {
    return {
      ok: false,
      error: {
        kind: 'parse_error',
        message: '無法讀取上次紀錄，你仍可開始新的閱讀。',
        isLoadError: true,
      },
    }
  }
}

export function saveSession(session: Session): StorageError | null {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...session, lastSavedAt: Date.now() }))
    return null
  } catch {
    return {
      kind: 'write_error',
      message: '本次紀錄無法保存，重新整理後可能遺失。',
      isLoadError: false,
    }
  }
}

export function clearSession(): StorageError | null {
  try {
    localStorage.removeItem(KEY)
    return null
  } catch {
    return {
      kind: 'write_error',
      message: '無法刪除保存紀錄，但本次資料已從記憶體清除。',
      isLoadError: false,
    }
  }
}
