/**
 * sessionAnalysis.ts — Derives an AnalysisResult from a completed Session.
 *
 * Integration point for the scoring teammate.
 *
 * Gaze sessions (gazeEnabled === true):
 *   attention_score events carry a `trend` field (0–1, higher = more mind-wandering).
 *   focusPercent = (1 − meanTrend) × 100  →  stored as totalScore 0–100.
 *   Requires at least MIN_WINDOWS valid windows; returns pending if fewer.
 *
 * Camera-only / no-camera sessions:
 *   Return a pending stub. Replace with teammate's scoring logic once available.
 */

import type { Session } from './types'
import type { AnalysisResult } from './analysisTypes'
import { makePendingAnalysis } from './analysisTypes'

export const SCORING_VERSION = '0.1.0'

/** Minimum number of scored windows to count as a valid session analysis. */
const MIN_WINDOWS = 3

/**
 * Compute a session-level focus percentage from gaze attention_score events.
 * Returns null when there is not enough data.
 */
export function computeGazeFocusPercent(session: Session): number | null {
  if (!session.gazeEnabled) return null

  const trends = session.events
    .filter(e => e.eventType === 'attention_score' && typeof e.data?.trend === 'number')
    .map(e => e.data!.trend as number)

  if (trends.length < MIN_WINDOWS) return null

  const meanTrend = trends.reduce((a, b) => a + b, 0) / trends.length
  // Clamp to [0, 100] to guard against edge-case logistic outputs outside (0,1)
  return Math.min(100, Math.max(0, Math.round((1 - meanTrend) * 100)))
}

/**
 * Derive the AnalysisResult for a completed session.
 * Called once when the session is saved to history.
 *
 * To add camera-based scoring: replace the camera branch below.
 */
export function computeSessionAnalysis(session: Session): AnalysisResult {
  if (session.gazeEnabled) {
    const focusPercent = computeGazeFocusPercent(session)
    if (focusPercent !== null) {
      return {
        sessionId: session.sessionId,
        status: 'ready',
        totalScore: focusPercent,
        summary: null,
        scoringVersion: SCORING_VERSION,
        source: 'real',
        analyzedAt: Date.now(),
      }
    }
  }

  // Camera-only or no-camera: pending until teammate wires in scoring
  return makePendingAnalysis(session.sessionId)
}
