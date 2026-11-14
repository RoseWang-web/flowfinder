import { describe, it, expect } from 'vitest'
import { computeChecks, fmt } from './checks'
import { summarizeRates } from './metrics'
import { initialState } from './testController'

const verdicts = (s = initialState()) => Object.fromEntries(computeChecks(s).map(c => [c.key, c.verdict]))

describe('computeChecks', () => {
  it('everything is pending before the camera starts', () => {
    expect(verdicts()).toEqual({ camera: 'pending', network: 'pending', rate: 'pending', calibration: 'pending', alignment: 'pending' })
  })

  it('camera error fails check ①', () => {
    const c = computeChecks(initialState({ camera: 'error', cameraError: 'permission_denied: x' }))[0]
    expect(c.verdict).toBe('fail')
    expect(c.detail).toContain('permission_denied')
  })

  it('network passes with zero external requests once the camera runs, fails otherwise', () => {
    expect(verdicts(initialState({ camera: 'on' })).network).toBe('pass')
    expect(verdicts(initialState({ camera: 'on', externalRequests: ['https://cdn.example/x.js'] })).network).toBe('fail')
  })

  it('rate uses only page-focused seconds', () => {
    const fast = summarizeRates(Array(40).fill(30))
    expect(verdicts(initialState({ rates: { panel: fast, page: summarizeRates([]), other: summarizeRates([]) } })).rate).toBe('pending')
    expect(verdicts(initialState({ rates: { panel: summarizeRates([]), page: fast, other: summarizeRates([]) } })).rate).toBe('pass')
  })

  it('calibration compares with the web app numbers', () => {
    const validation = {
      quality: 'good' as const, accuracyPx: 90, precisionPx: 40, validRatio: 1,
      viewport: { width: 1, height: 1 }, points: [], calibratedAt: 0,
    }
    expect(verdicts(initialState({ validation })).calibration).toBe('pending')
    expect(verdicts(initialState({ validation, webApp: { accuracyPx: 80, precisionPx: 40 } })).calibration).toBe('pass')
    expect(verdicts(initialState({ validation, webApp: { accuracyPx: 60, precisionPx: 40 } })).calibration).toBe('fail')
  })

  it('alignment needs both manual boxes', () => {
    expect(verdicts(initialState({ manual: { zoomAligned: true, crossTabAligned: false } })).alignment).toBe('pending')
    expect(verdicts(initialState({ manual: { zoomAligned: true, crossTabAligned: true } })).alignment).toBe('pass')
  })

  it('fmt', () => {
    expect(fmt(null)).toBe('—')
    expect(fmt(NaN)).toBe('—')
    expect(fmt(12.6)).toBe('13')
  })
})
