/**
 * Data contract between Dashboard and the scoring/analysis module (teammate).
 *
 * ⚠️  PENDING teammate confirmation — these are assumed interface details:
 *   - Score range: 0–100 (higher = model estimates more focused)
 *   - 0 is a VALID score; do not treat as falsy. Use null for "no score".
 *   - status 'ready' means totalScore is available
 *   - scoringVersion: semver string e.g. "1.0.0"
 *   - source: 'real' for actual camera analysis, 'mock' for demonstration
 *
 * The integration boundary is in historyStorage.ts (upsertHistoryEntry).
 * Replace the analysis.source === 'real' stub once teammate delivers the adapter.
 */

export type AnalysisStatus = 'pending' | 'ready' | 'unavailable' | 'error'

export interface AnalysisResult {
  sessionId: string
  /** Current status of the analysis computation. */
  status: AnalysisStatus
  /**
   * Estimated focus score 0–100 (inclusive). Higher = more focused per model.
   * null = no score (pending / error / unavailable).
   * 0 is a VALID score — never coerce to falsy.
   */
  totalScore: number | null
  /** Human-readable summary. null when not available. */
  summary: string | null
  /** Scoring algorithm version, e.g. "1.0.0". null when not available. */
  scoringVersion: string | null
  /** 'mock' for demo data; 'real' for actual camera analysis. */
  source: 'mock' | 'real'
  /** Unix ms when analysis was finalised. null if not complete. */
  analyzedAt: number | null
}

/**
 * User-supplied score correction stored alongside the system analysis.
 * Does NOT overwrite AnalysisResult; always separate.
 */
export interface ManualOverride {
  /** Integer in [0, 100]. */
  score: number
  /** Optional explanation, ≤ 300 chars. */
  reason?: string
  /** Unix ms when the override was saved. */
  overriddenAt: number
}

/** Attach to new real sessions that have not been analysed yet. */
export function makePendingAnalysis(sessionId: string): AnalysisResult {
  return {
    sessionId,
    status: 'pending',
    totalScore: null,
    summary: null,
    scoringVersion: null,
    source: 'real',
    analyzedAt: null,
  }
}
