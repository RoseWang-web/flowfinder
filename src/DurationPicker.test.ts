import { describe, it, expect } from 'vitest'
import { validateDurationInput } from './DurationPicker'

describe('validateDurationInput', () => {
  it('rejects empty string', () => {
    expect(validateDurationInput('')).toBe('Please enter a duration')
  })
  it('rejects whitespace only', () => {
    expect(typeof validateDurationInput('   ')).toBe('string')
  })
  it('rejects non-numeric input', () => {
    expect(typeof validateDurationInput('abc')).toBe('string')
  })
  it('rejects decimal values', () => {
    expect(typeof validateDurationInput('1.5')).toBe('string')
  })
  it('rejects 0 (use the unlimited button instead)', () => {
    expect(typeof validateDurationInput('0')).toBe('string')
  })
  it('rejects negative values', () => {
    expect(typeof validateDurationInput('-1')).toBe('string')
  })
  it('rejects values above 240', () => {
    expect(typeof validateDurationInput('241')).toBe('string')
  })
  it('accepts 1 minute and returns 1', () => {
    expect(validateDurationInput('1')).toBe(1)
  })
  it('accepts 30 minutes', () => {
    expect(validateDurationInput('30')).toBe(30)
  })
  it('accepts 240 minutes (maximum)', () => {
    expect(validateDurationInput('240')).toBe(240)
  })
  it('trims whitespace before validating', () => {
    expect(validateDurationInput('  45  ')).toBe(45)
  })
})
