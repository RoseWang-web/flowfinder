import { Session, SCHEMA_VERSION, SessionTaskSettings, CategoryId } from './types'

const KEY = 'flowfinder_session_v2'

function validateTaskSettings(raw: unknown): SessionTaskSettings | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  if (obj.categoryId !== 'web_reading' && obj.categoryId !== 'study_notes') return undefined
  if (obj.rulesVersion !== 1) return undefined
  const rules = obj.rules
  if (typeof rules !== 'object' || rules === null) return undefined
  const r = rules as Record<string, unknown>
  if (
    typeof r.allowHeadDown !== 'boolean' ||
    typeof r.allowTabSwitch !== 'boolean' ||
    typeof r.allowWindowBlur !== 'boolean'
  ) return undefined
  return {
    categoryId: obj.categoryId as CategoryId,
    rulesVersion: 1,
    rules: {
      allowHeadDown: r.allowHeadDown,
      allowTabSwitch: r.allowTabSwitch,
      allowWindowBlur: r.allowWindowBlur,
    },
  }
}

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
          message: 'Could not load previous session. You can still start a new one.',
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
          message: 'Could not load previous session. You can still start a new one.',
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
          message: 'Could not load previous session. You can still start a new one.',
          isLoadError: true,
        },
      }
    }
    const session = parsed as Session
    // Validate taskSettings if present — strip if corrupt so session core is preserved
    const rawObj = parsed as Record<string, unknown>
    session.taskSettings = validateTaskSettings(rawObj.taskSettings)
    return { ok: true, session }
  } catch {
    return {
      ok: false,
      error: {
        kind: 'parse_error',
        message: 'Could not load previous session. You can still start a new one.',
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
      message: 'Session could not be saved. Data may be lost after a page refresh.',
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
      message: 'Could not delete saved session, but data has been cleared from memory.',
      isLoadError: false,
    }
  }
}
