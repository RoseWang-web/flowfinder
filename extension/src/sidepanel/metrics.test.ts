import { describe, it, expect } from 'vitest'
import { bucketFor, calibrationVerdict, externalUrls, quantile, rateVerdict, summarizeRates } from './metrics'

describe('metrics', () => {
  it('buckets seconds by which document has focus', () => {
    expect(bucketFor(true, false)).toBe('panel')
    expect(bucketFor(false, true)).toBe('page')
    expect(bucketFor(false, false)).toBe('other')
  })

  it('quantile interpolates', () => {
    expect(quantile([], 0.5)).toBeNull()
    expect(quantile([30, 10, 20], 0.5)).toBe(20)
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1)
  })

  it('rate verdict needs 30 s of data, then median ≥ 25 Hz', () => {
    expect(rateVerdict(summarizeRates(Array(10).fill(30)))).toBe('pending')
    expect(rateVerdict(summarizeRates(Array(40).fill(30)))).toBe('pass')
    expect(rateVerdict(summarizeRates(Array(40).fill(12)))).toBe('fail')
  })

  it('calibration verdict allows the extension to be at most 20% worse', () => {
    const web = { accuracyPx: 100, precisionPx: 50 }
    expect(calibrationVerdict({ accuracyPx: 115, precisionPx: 55 }, web)).toBe('pass')
    expect(calibrationVerdict({ accuracyPx: 80, precisionPx: 40 }, web)).toBe('pass') // better is fine
    expect(calibrationVerdict({ accuracyPx: 130, precisionPx: 50 }, web)).toBe('fail')
    expect(calibrationVerdict({ accuracyPx: 100, precisionPx: 50 }, null)).toBe('pending')
  })

  it('externalUrls ignores extension, data and blob URLs', () => {
    expect(externalUrls([
      'chrome-extension://abc/face_mesh/face_mesh.js',
      'data:application/wasm;base64,AAA',
      'blob:chrome-extension://abc/1',
      'https://cdn.jsdelivr.net/x.js',
      'https://cdn.jsdelivr.net/x.js',
    ])).toEqual(['https://cdn.jsdelivr.net/x.js'])
  })
})
