/**
 * mockFixtures.ts — Deterministic demonstration data for the Dashboard.
 *
 * Generated ONCE at module load from a fixed base date (today at midnight UTC).
 * No Math.random(), no Date.now() inside entries — stable across renders.
 *
 * Coverage:
 *  - Four score grades (green/yellow/orange/red)
 *  - score = 0 (valid), score = null (no analysis)
 *  - Zero activeReadingMs (not eligible for average)
 *  - Cross-midnight session
 *  - Interrupted session
 *  - Multiple sessions on same day
 *  - Different categories + uncategorized
 *  - Sessions from today, past week, past month, previous month
 */

import type { Session } from './types'
import type { AnalysisResult } from './analysisTypes'
import type { HistoryEntry } from './historyStorage'
import { HISTORY_SCHEMA_VERSION } from './historyStorage'
import type { HistoryData } from './historyStorage'

// ── Deterministic base date ───────────────────────────────────────────────────

function todayMidnightUTC(): number {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

function daysAgoMs(n: number): number {
  return todayMidnightUTC() - n * 86_400_000
}

let _mockData: HistoryData | null = null

// ── Entry builder ─────────────────────────────────────────────────────────────

let _idCounter = 0
function mockId(tag: string): string {
  _idCounter++
  return `mock-${tag}-${_idCounter}`
}

type MakeSessionOpts = {
  startOffsetMs: number   // ms after midnight of daysAgo
  daysAgo: number
  activeReadingMs: number
  durationMs: number
  endReason: Session['endReason']
  categoryId?: Session['taskSettings'] extends undefined ? undefined : NonNullable<Session['taskSettings']>['categoryId']
  cameraEnabled?: boolean
  skipTaskSettings?: boolean
}

function makeSession(opts: MakeSessionOpts): Session {
  const dayBase = daysAgoMs(opts.daysAgo)
  const startedAt = dayBase + opts.startOffsetMs
  const endedAt = startedAt + opts.durationMs
  const sessionId = mockId('sess')

  return {
    schemaVersion: 2,
    sessionId,
    articleId: 'reading-article-v1',
    startedAt,
    status: 'completed',
    durationMs: opts.durationMs,
    activeReadingMs: opts.activeReadingMs,
    lastSavedAt: endedAt,
    endedAt,
    endReason: opts.endReason,
    checkIn: null,
    cameraEnabled: opts.cameraEnabled ?? false,
    taskSettings: opts.skipTaskSettings ? undefined : {
      categoryId: (opts.categoryId ?? 'web_reading') as 'web_reading' | 'study_notes',
      rulesVersion: 1,
      rules: { allowHeadDown: false, allowTabSwitch: false, allowWindowBlur: false },
    },
    events: [
      { id: mockId('ev'), sessionId, eventType: 'session_start', elapsedMs: 0, activeReadingMs: 0 },
      { id: mockId('ev'), sessionId, eventType: 'session_end', elapsedMs: opts.durationMs, activeReadingMs: opts.activeReadingMs },
    ],
  }
}

function makeAnalysis(sessionId: string, totalScore: number | null, summary: string | null = null): AnalysisResult {
  return {
    sessionId,
    status: totalScore !== null ? 'ready' : 'unavailable',
    totalScore,
    summary,
    scoringVersion: '0.1.0-mock',
    source: 'mock',
    analyzedAt: Date.now(),
  }
}

function entry(session: Session, totalScore: number | null, summary: string | null = null): HistoryEntry {
  return { session, analysis: makeAnalysis(session.sessionId, totalScore, summary), entryVersion: 1 }
}

// ── Build fixture set ─────────────────────────────────────────────────────────

function buildMockEntries(): HistoryEntry[] {
  _idCounter = 0 // reset for reproducibility

  return [
    // ── Today: 2 sessions ──
    entry(
      makeSession({ daysAgo: 0, startOffsetMs: 9 * 3600_000, activeReadingMs: 35 * 60_000, durationMs: 36 * 60_000, endReason: 'manual', categoryId: 'web_reading', cameraEnabled: true }),
      85,
      '閱讀期間大多保持正視螢幕，頭部偏轉次數少。',
    ),
    entry(
      makeSession({ daysAgo: 0, startOffsetMs: 14 * 3600_000, activeReadingMs: 20 * 60_000, durationMs: 21 * 60_000, endReason: 'manual', categoryId: 'study_notes' }),
      null, // no analysis
    ),

    // ── Yesterday ──
    entry(
      makeSession({ daysAgo: 1, startOffsetMs: 10 * 3600_000, activeReadingMs: 30 * 60_000, durationMs: 32 * 60_000, endReason: 'time_up', categoryId: 'web_reading', cameraEnabled: true }),
      72,
      '中途有數次抬頭，整體仍在目標範圍。',
    ),

    // ── 2 days ago ──
    entry(
      makeSession({ daysAgo: 2, startOffsetMs: 9 * 3600_000, activeReadingMs: 15 * 60_000, durationMs: 16 * 60_000, endReason: 'manual', categoryId: 'web_reading' }),
      55,
      '視線離開螢幕的頻率偏高。',
    ),

    // ── 3 days ago: score = 0 (valid) ──
    entry(
      makeSession({ daysAgo: 3, startOffsetMs: 20 * 3600_000 + 30 * 60_000, activeReadingMs: 10 * 60_000, durationMs: 11 * 60_000, endReason: 'manual', categoryId: 'study_notes' }),
      0,
      '本次分析結果接近下限，建議確認環境光線與攝影機角度。',
    ),

    // ── 4 days ago: zero activeReadingMs (not eligible for average) ──
    entry(
      makeSession({ daysAgo: 4, startOffsetMs: 11 * 3600_000, activeReadingMs: 0, durationMs: 60_000, endReason: 'manual', categoryId: 'web_reading' }),
      null,
    ),

    // ── 5 days ago: green score ──
    entry(
      makeSession({ daysAgo: 5, startOffsetMs: 8 * 3600_000 + 45 * 60_000, activeReadingMs: 18 * 60_000, durationMs: 20 * 60_000, endReason: 'time_up', categoryId: 'web_reading', cameraEnabled: true }),
      92,
      '本次專注度優秀，幾乎無分心行為偵測。',
    ),

    // ── 5 days ago (cross-midnight): starts 23:00, ends 00:30 next calendar day ──
    entry(
      makeSession({ daysAgo: 5, startOffsetMs: 23 * 3600_000, activeReadingMs: 60 * 60_000, durationMs: 90 * 60_000, endReason: 'manual', categoryId: 'study_notes', cameraEnabled: true }),
      68,
      '跨夜閱讀，後段因光線不足偵測品質下降。',
    ),

    // ── 7 days ago: interrupted session (not eligible for average) ──
    entry(
      makeSession({ daysAgo: 7, startOffsetMs: 15 * 3600_000, activeReadingMs: 5 * 60_000, durationMs: 6 * 60_000, endReason: 'interrupted', categoryId: 'web_reading' }),
      null,
    ),

    // ── 10 days ago: uncategorized (old session, no taskSettings) ──
    entry(
      makeSession({ daysAgo: 10, startOffsetMs: 9 * 3600_000, activeReadingMs: 25 * 60_000, durationMs: 26 * 60_000, endReason: 'manual', skipTaskSettings: true }),
      45,
      '無類別標記，分析結果僅供參考。',
    ),

    // ── 14 days ago ──
    entry(
      makeSession({ daysAgo: 14, startOffsetMs: 10 * 3600_000, activeReadingMs: 25 * 60_000, durationMs: 27 * 60_000, endReason: 'manual', categoryId: 'web_reading', cameraEnabled: true }),
      38,
      '本次結果偏低，可能受到背景雜訊影響。',
    ),

    // ── 28 days ago (last month) ──
    entry(
      makeSession({ daysAgo: 28, startOffsetMs: 14 * 3600_000, activeReadingMs: 40 * 60_000, durationMs: 42 * 60_000, endReason: 'time_up', categoryId: 'study_notes', cameraEnabled: true }),
      78,
      '學習筆記場次，表現穩定。',
    ),

    // ── 35 days ago (previous month) ──
    entry(
      makeSession({ daysAgo: 35, startOffsetMs: 10 * 3600_000, activeReadingMs: 20 * 60_000, durationMs: 22 * 60_000, endReason: 'manual', categoryId: 'web_reading', cameraEnabled: true }),
      15,
      '環境偵測異常，分數僅供參考。',
    ),
  ]
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns the demo HistoryData. Generated once and cached. */
export function getMockHistoryData(): HistoryData {
  if (!_mockData) {
    _mockData = {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      entries: buildMockEntries(),
      deletedIds: [],
    }
  }
  return _mockData
}

/** Reset cached mock data (for tests only). */
export function _resetMockCache(): void {
  _mockData = null
  _idCounter = 0
}
