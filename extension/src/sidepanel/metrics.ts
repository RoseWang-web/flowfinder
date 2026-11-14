/**
 * metrics.ts — Phase 0 pass/fail measurements (pure, unit-tested).
 *
 * The attention model resamples gaze to 30 Hz and treats gaps > 100 ms as
 * missing, so what matters is how many *valid* predictions arrive per second
 * while the user is reading the page (side panel NOT focused).
 */

export type FocusBucket = 'panel' | 'page' | 'other'

export function bucketFor(panelHasFocus: boolean, pageHasFocus: boolean): FocusBucket {
  if (panelHasFocus) return 'panel'
  return pageHasFocus ? 'page' : 'other'
}

export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export interface RateSummary { seconds: number; medianHz: number | null; p10Hz: number | null }

export function summarizeRates(perSecond: readonly number[]): RateSummary {
  return { seconds: perSecond.length, medianHz: quantile(perSecond, 0.5), p10Hz: quantile(perSecond, 0.1) }
}

/** Relative difference of the extension's value vs the web app's (positive = extension worse). */
export function relativeDiff(extension: number, webApp: number): number | null {
  if (!(webApp > 0)) return null
  return (extension - webApp) / webApp
}

export const PASS = {
  minPageFocusedMedianHz: 25,
  minSecondsMeasured: 30,
  maxCalibrationRelDiff: 0.2,
} as const

export type Verdict = 'pass' | 'fail' | 'pending'

export function rateVerdict(r: RateSummary): Verdict {
  if (r.seconds < PASS.minSecondsMeasured || r.medianHz === null) return 'pending'
  return r.medianHz >= PASS.minPageFocusedMedianHz ? 'pass' : 'fail'
}

export function calibrationVerdict(
  ext: { accuracyPx: number | null; precisionPx: number | null } | null,
  web: { accuracyPx: number; precisionPx: number } | null,
): Verdict {
  if (!ext || !web || ext.accuracyPx === null || ext.precisionPx === null) return 'pending'
  const a = relativeDiff(ext.accuracyPx, web.accuracyPx)
  const p = relativeDiff(ext.precisionPx, web.precisionPx)
  if (a === null || p === null) return 'pending'
  return a <= PASS.maxCalibrationRelDiff && p <= PASS.maxCalibrationRelDiff ? 'pass' : 'fail'
}

/** Resource URLs that left the extension (MV3 requires zero for code; we want zero overall). */
export function externalUrls(urls: readonly string[]): string[] {
  return [...new Set(urls.filter(u => !/^(chrome-extension|data|blob):/.test(u)))]
}
