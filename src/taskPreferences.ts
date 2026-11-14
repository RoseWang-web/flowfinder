import type { CategoryId, TaskRules } from './types'

export type { CategoryId, TaskRules }

export interface CategoryMeta {
  id: CategoryId
  label: string
}

export const CATEGORIES: readonly CategoryMeta[] = [
  { id: 'web_reading', label: '網頁閱讀' },
  { id: 'study_notes', label: '學習／筆記' },
] as const

export const SYSTEM_DEFAULTS: Readonly<Record<CategoryId, Readonly<TaskRules>>> = {
  web_reading: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false },
  study_notes: { allowHeadDown: true, allowTabSwitch: true, allowWindowBlur: true },
} as const

export const TASK_RULES_VERSION = 1 as const

const prefKey = (cat: CategoryId) => `flowfinder_task_pref_v1_${cat}`

export interface TaskPrefError {
  kind: 'parse_error' | 'version_mismatch' | 'invalid_structure' | 'write_error'
  message: string
}

export type LoadPrefResult =
  | { ok: true; rules: TaskRules }
  | { ok: false; empty: true }
  | { ok: false; error: TaskPrefError }

export function loadTaskPreferences(cat: CategoryId): LoadPrefResult {
  try {
    const raw = localStorage.getItem(prefKey(cat))
    if (raw === null) return { ok: false, empty: true }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, error: { kind: 'invalid_structure', message: '任務偏好格式錯誤，將使用系統預設。' } }
    }
    const obj = parsed as Record<string, unknown>
    if (obj.rulesVersion !== TASK_RULES_VERSION) {
      return { ok: false, error: { kind: 'version_mismatch', message: '任務偏好版本不支援，將使用系統預設。' } }
    }
    const rules = obj.rules
    if (typeof rules !== 'object' || rules === null) {
      return { ok: false, error: { kind: 'invalid_structure', message: '任務偏好格式錯誤，將使用系統預設。' } }
    }
    const r = rules as Record<string, unknown>
    if (
      typeof r.allowHeadDown !== 'boolean' ||
      typeof r.allowTabSwitch !== 'boolean' ||
      typeof r.allowWindowBlur !== 'boolean'
    ) {
      return { ok: false, error: { kind: 'invalid_structure', message: '任務偏好格式錯誤，將使用系統預設。' } }
    }
    return {
      ok: true,
      rules: {
        allowHeadDown: r.allowHeadDown,
        allowTabSwitch: r.allowTabSwitch,
        allowWindowBlur: r.allowWindowBlur,
      },
    }
  } catch {
    return { ok: false, error: { kind: 'parse_error', message: '任務偏好無法解析，將使用系統預設。' } }
  }
}

export function saveTaskPreferences(cat: CategoryId, rules: TaskRules): TaskPrefError | null {
  try {
    localStorage.setItem(prefKey(cat), JSON.stringify({ rulesVersion: TASK_RULES_VERSION, rules }))
    return null
  } catch {
    return { kind: 'write_error', message: '無法儲存任務偏好設定。你仍可使用目前草稿繼續。' }
  }
}

export function clearTaskPreferences(cat: CategoryId): TaskPrefError | null {
  try {
    localStorage.removeItem(prefKey(cat))
    return null
  } catch {
    return { kind: 'write_error', message: '無法清除已儲存的偏好設定。草稿已恢復系統預設。' }
  }
}

export function getDefaultRules(cat: CategoryId): TaskRules {
  return { ...SYSTEM_DEFAULTS[cat] }
}

export function loadRulesOrDefault(cat: CategoryId): TaskRules {
  const result = loadTaskPreferences(cat)
  if (result.ok) return result.rules
  return getDefaultRules(cat)
}
