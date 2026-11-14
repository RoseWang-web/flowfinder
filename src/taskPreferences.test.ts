import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SYSTEM_DEFAULTS,
  TASK_RULES_VERSION,
  loadTaskPreferences,
  saveTaskPreferences,
  clearTaskPreferences,
  loadRulesOrDefault,
  getDefaultRules,
} from './taskPreferences'
import type { TaskRules } from './types'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('taskPreferences', () => {
  it('1. SYSTEM_DEFAULTS web_reading has all booleans false', () => {
    expect(SYSTEM_DEFAULTS.web_reading).toEqual({
      allowHeadDown: false,
      allowTabSwitch: false,
      allowWindowBlur: false,
    })
  })

  it('2. SYSTEM_DEFAULTS study_notes has all booleans true', () => {
    expect(SYSTEM_DEFAULTS.study_notes).toEqual({
      allowHeadDown: true,
      allowTabSwitch: true,
      allowWindowBlur: true,
    })
  })

  it('3. loadRulesOrDefault returns system defaults when nothing is saved', () => {
    expect(loadRulesOrDefault('web_reading')).toEqual(SYSTEM_DEFAULTS.web_reading)
    expect(loadRulesOrDefault('study_notes')).toEqual(SYSTEM_DEFAULTS.study_notes)
  })

  it('4. saveTaskPreferences + loadTaskPreferences round-trip correctly', () => {
    const rules: TaskRules = { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: true }
    const err = saveTaskPreferences('web_reading', rules)
    expect(err).toBeNull()
    const result = loadTaskPreferences('web_reading')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.rules).toEqual(rules)
  })

  it('5. loadRulesOrDefault returns saved preference when one exists', () => {
    const rules: TaskRules = { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: false }
    saveTaskPreferences('web_reading', rules)
    expect(loadRulesOrDefault('web_reading')).toEqual(rules)
  })

  it('6. saving web_reading does not affect study_notes (independent keys)', () => {
    saveTaskPreferences('web_reading', { allowHeadDown: true, allowTabSwitch: true, allowWindowBlur: true })
    const result = loadTaskPreferences('study_notes')
    expect(result.ok).toBe(false)
    expect('empty' in result).toBe(true)
  })

  it('7. clearTaskPreferences removes the saved preference', () => {
    saveTaskPreferences('web_reading', { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: false })
    const clearErr = clearTaskPreferences('web_reading')
    expect(clearErr).toBeNull()
    const result = loadTaskPreferences('web_reading')
    expect(result.ok).toBe(false)
    expect('empty' in result).toBe(true)
  })

  it('8. after clearTaskPreferences, loadRulesOrDefault returns system default', () => {
    saveTaskPreferences('web_reading', { allowHeadDown: true, allowTabSwitch: true, allowWindowBlur: true })
    clearTaskPreferences('web_reading')
    expect(loadRulesOrDefault('web_reading')).toEqual(SYSTEM_DEFAULTS.web_reading)
  })

  it('9. loadTaskPreferences returns parse_error for corrupt JSON', () => {
    localStorage.setItem('flowfinder_task_pref_v1_web_reading', 'not{valid}json')
    const result = loadTaskPreferences('web_reading')
    expect(result.ok).toBe(false)
    if (!result.ok && 'error' in result) expect(result.error.kind).toBe('parse_error')
  })

  it('10. loadTaskPreferences returns version_mismatch for unsupported rulesVersion', () => {
    localStorage.setItem(
      'flowfinder_task_pref_v1_web_reading',
      JSON.stringify({ rulesVersion: 999, rules: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false } }),
    )
    const result = loadTaskPreferences('web_reading')
    expect(result.ok).toBe(false)
    if (!result.ok && 'error' in result) expect(result.error.kind).toBe('version_mismatch')
  })

  it('11. loadTaskPreferences returns invalid_structure when rules contains non-boolean', () => {
    localStorage.setItem(
      'flowfinder_task_pref_v1_web_reading',
      JSON.stringify({ rulesVersion: TASK_RULES_VERSION, rules: { allowHeadDown: 'yes', allowTabSwitch: false, allowWindowBlur: false } }),
    )
    const result = loadTaskPreferences('web_reading')
    expect(result.ok).toBe(false)
    if (!result.ok && 'error' in result) expect(result.error.kind).toBe('invalid_structure')
  })

  it('12. two categories are stored and loaded independently', () => {
    const webRules: TaskRules = { allowHeadDown: true, allowTabSwitch: false, allowWindowBlur: false }
    const studyRules: TaskRules = { allowHeadDown: false, allowTabSwitch: true, allowWindowBlur: true }
    saveTaskPreferences('web_reading', webRules)
    saveTaskPreferences('study_notes', studyRules)
    expect(loadRulesOrDefault('web_reading')).toEqual(webRules)
    expect(loadRulesOrDefault('study_notes')).toEqual(studyRules)
  })

  it('13. saveTaskPreferences returns write_error when localStorage.setItem throws', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota exceeded') })
    const err = saveTaskPreferences('web_reading', getDefaultRules('web_reading'))
    expect(err).not.toBeNull()
    expect(err?.kind).toBe('write_error')
  })
})
