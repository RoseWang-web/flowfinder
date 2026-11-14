import { useState, useId } from 'react'
import type { TimelineData, TimeSegment, TimeMarker, AttentionPoint } from './timeline'
import { fmtMs } from './timeline'

// ── Layout constants ──────────────────────────────────────────────────────

const LABEL_W = 92        // px for left track-label column
const SVG_W   = 760
const PAD_R   = 8
const TL_W    = SVG_W - LABEL_W - PAD_R  // 660 px for the timeline area
const Y0      = 6         // top padding
const AXIS_H  = 20        // x-axis ticks row
const TRACK_H = 26        // height of each track band
const GAP     = 10        // vertical gap between tracks
const TICK_STEP_S = 30    // axis ticks every 30 s

function trackY(i: number) { return Y0 + AXIS_H + 6 + i * (TRACK_H + GAP) }
const BASE_SVG_H = trackY(3) + TRACK_H + 10

// Attention band (eye-tracking mode only), drawn below the 4 tracks
const ATT_Y = trackY(4)
const ATT_H = 72
const GAZE_SVG_H = ATT_Y + ATT_H + 10
/**
 * The score is a ranking, so we plot "focus" = 1 − score on a fixed range
 * around the model's typical output instead of 0–1 (which would look flat).
 */
const FOCUS_MIN = 0.25
const FOCUS_MAX = 0.75
/** Break the line when consecutive scores are further apart than this (pause, check-in) */
const MAX_LINE_GAP_MS = 5_000

const ATT_COLOUR = {
  trend: '#2563eb',
  window: '#93c5fd',
  warming_up: '#d1d5db',
  low_quality: '#fca5a5',
}

const ATT_STATUS_LABEL: Record<AttentionPoint['status'], string> = {
  ok: '有效估計',
  warming_up: '暖機中',
  low_quality: '視線訊號不足',
}

// ── Colour maps ───────────────────────────────────────────────────────────

const SESSION_COLOUR: Record<string, string> = {
  reading:     '#3b82f6',
  paused:      '#f59e0b',
  checking_in: '#8b5cf6',
  unknown:     '#e5e7eb',
}

const VISIBILITY_COLOUR: Record<string, string> = {
  visible: '#93c5fd',
  hidden:  '#6b7280',
  unknown: '#e5e7eb',
}

const FACE_COLOUR: Record<string, string> = {
  detected:     '#6ee7b7',
  not_detected: '#94a3b8',
  unavailable:  '#e5e7eb',
  no_camera:    '#f3f4f6',
}

const MARKER_COLOUR: Record<string, string> = {
  check_in_shown:    '#f59e0b',
  check_in_answered: '#3b82f6',
  check_in_skipped:  '#9ca3af',
  scroll:            '#cbd5e1',
}

// ── Labels ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  reading:     '閱讀中',
  paused:      '暫停',
  checking_in: '回報中',
  unknown:     '未知',
  visible:     '可見',
  hidden:      '隱藏',
  detected:    '偵測到臉',
  not_detected:'未偵測到臉',
  unavailable: '觀察不可用',
  no_camera:   '未使用攝影機',
}

const MARKER_LABEL: Record<string, string> = {
  check_in_shown:    '回報提示',
  check_in_answered: '回答回報',
  check_in_skipped:  '略過回報',
  scroll:            '捲動',
}

// ── Selection types ───────────────────────────────────────────────────────

type Selection =
  | { kind: 'segment'; track: string; seg: TimeSegment }
  | { kind: 'marker'; marker: TimeMarker }
  | { kind: 'attention'; point: AttentionPoint }

// ── Legend ────────────────────────────────────────────────────────────────

const LEGEND: Array<{ label: string; colour: string; shape?: 'line' | 'diamond' }> = [
  { label: '閱讀中',       colour: '#3b82f6' },
  { label: '暫停',         colour: '#f59e0b' },
  { label: '回報中',       colour: '#8b5cf6' },
  { label: '頁面可見',     colour: '#93c5fd' },
  { label: '頁面隱藏',     colour: '#6b7280' },
  { label: '偵測到臉',     colour: '#6ee7b7' },
  { label: '未偵測到臉',   colour: '#94a3b8' },
  { label: '觀察不可用',   colour: '#e5e7eb' },
  { label: '回報提示',     colour: '#f59e0b', shape: 'diamond' },
  { label: '回答回報',     colour: '#3b82f6', shape: 'diamond' },
  { label: '略過回報',     colour: '#9ca3af', shape: 'diamond' },
  { label: '捲動',         colour: '#cbd5e1', shape: 'line' },
]

const GAZE_LEGEND: Array<{ label: string; colour: string; shape?: 'line' | 'diamond' | 'dot' }> = [
  { label: '專注度趨勢',   colour: ATT_COLOUR.trend, shape: 'line' },
  { label: '單一窗口',     colour: ATT_COLOUR.window, shape: 'dot' },
  { label: '暖機中',       colour: ATT_COLOUR.warming_up },
  { label: '視線訊號不足', colour: ATT_COLOUR.low_quality },
]

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  data: TimelineData
}

export function TimelineChart({ data }: Props) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const hatchId = useId()

  const { totalMs } = data
  if (totalMs < 1) return null

  // Convert elapsedMs to SVG x coordinate
  const tx = (ms: number) => LABEL_W + (Math.min(Math.max(ms, 0), totalMs) / totalMs) * TL_W

  // ── Tick marks ──────────────────────────────────────────────────────────
  const tickStepMs = TICK_STEP_S * 1000
  const ticks: number[] = []
  for (let ms = 0; ms <= totalMs; ms += tickStepMs) ticks.push(ms)
  if (ticks[ticks.length - 1] < totalMs) ticks.push(totalMs)

  // ── Segment click ──────────────────────────────────────────────────────
  const selectSeg = (track: string, seg: TimeSegment) =>
    setSelection(prev =>
      prev?.kind === 'segment' && prev.track === track && prev.seg === seg
        ? null
        : { kind: 'segment', track, seg },
    )

  const selectAttention = (point: AttentionPoint) =>
    setSelection(prev =>
      prev?.kind === 'attention' && prev.point === point ? null : { kind: 'attention', point },
    )

  // ── Attention band geometry ────────────────────────────────────────────
  const hasGaze = data.hasGazeData
  const svgH = hasGaze ? GAZE_SVG_H : BASE_SVG_H
  const focusY = (score: number) => {
    const f = Math.min(Math.max(1 - score, FOCUS_MIN), FOCUS_MAX)
    return ATT_Y + ATT_H - ((f - FOCUS_MIN) / (FOCUS_MAX - FOCUS_MIN)) * ATT_H
  }
  // Split the trend into runs of consecutive valid scores
  const trendRuns: AttentionPoint[][] = []
  let prevOk: AttentionPoint | null = null
  for (const p of data.attentionTrack) {
    if (p.status !== 'ok' || p.trend === null) { prevOk = null; continue }
    if (!prevOk || p.ms - prevOk.ms > MAX_LINE_GAP_MS) trendRuns.push([])
    trendRuns[trendRuns.length - 1].push(p)
    prevOk = p
  }
  const checkInShownMs = data.actionMarkers.find(m => m.kind === 'check_in_shown')?.ms ?? null
  const legend = hasGaze ? [...LEGEND, ...GAZE_LEGEND] : LEGEND

  const selectMarker = (marker: TimeMarker) =>
    setSelection(prev =>
      prev?.kind === 'marker' && prev.marker === marker ? null : { kind: 'marker', marker },
    )

  // ── Track rows ─────────────────────────────────────────────────────────
  const tracks: Array<{ label: string; id: string; segs: TimeSegment[]; colorMap: Record<string, string> }> = [
    { label: '閱讀狀態', id: 'session',    segs: data.sessionStatusTrack,   colorMap: SESSION_COLOUR },
    { label: '頁面可見', id: 'visibility', segs: data.pageVisibilityTrack,  colorMap: VISIBILITY_COLOUR },
    { label: '臉部偵測', id: 'face',       segs: data.faceObservationTrack, colorMap: FACE_COLOUR },
    { label: '操作',     id: 'actions',    segs: [],                         colorMap: {} },
  ]

  return (
    <div className="timeline-wrap">
      {/* ── SVG Chart ── */}
      <div className="timeline-scroll">
        <svg
          width={SVG_W}
          height={svgH}
          role="img"
          aria-label="閱讀 session 時間軸"
          style={{ display: 'block', userSelect: 'none' }}
        >
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="#d1d5db" strokeWidth="2" />
            </pattern>
          </defs>

          {/* ── X Axis ── */}
          <line x1={LABEL_W} y1={Y0 + AXIS_H} x2={SVG_W - PAD_R} y2={Y0 + AXIS_H} stroke="#e5e7eb" strokeWidth={1} />
          {ticks.map(ms => {
            const x = tx(ms)
            return (
              <g key={ms}>
                <line x1={x} y1={Y0 + AXIS_H - 4} x2={x} y2={Y0 + AXIS_H} stroke="#9ca3af" strokeWidth={1} />
                <text x={x} y={Y0 + AXIS_H - 6} textAnchor="middle" fontSize={10} fill="#9ca3af">
                  {fmtMs(ms)}
                </text>
              </g>
            )
          })}

          {/* ── Track rows ── */}
          {tracks.map((track, ti) => {
            const y = trackY(ti)
            const isActions = track.id === 'actions'

            return (
              <g key={track.id}>
                {/* Track label */}
                <text
                  x={LABEL_W - 6}
                  y={y + TRACK_H / 2 + 4}
                  textAnchor="end"
                  fontSize={11}
                  fill="#6b7280"
                  fontWeight="600"
                >
                  {track.label}
                </text>

                {/* Track background */}
                <rect x={LABEL_W} y={y} width={TL_W} height={TRACK_H} fill="#f9fafb" rx={3} />

                {/* Track grid lines from ticks */}
                {ticks.map(ms => (
                  <line
                    key={ms}
                    x1={tx(ms)} y1={y} x2={tx(ms)} y2={y + TRACK_H}
                    stroke="#e5e7eb" strokeWidth={1}
                  />
                ))}

                {/* Segments (not for actions track) */}
                {!isActions && track.segs.map((seg, si) => {
                  const x1 = tx(seg.startMs)
                  const x2 = tx(seg.endMs)
                  const w = Math.max(x2 - x1, 1)
                  const fill = seg.kind === 'unknown' || seg.kind === 'unavailable'
                    ? `url(#${hatchId})`
                    : (track.colorMap[seg.kind] ?? '#e5e7eb')
                  const isSelected =
                    selection?.kind === 'segment' &&
                    selection.track === track.id &&
                    selection.seg === seg

                  return (
                    <rect
                      key={si}
                      x={x1} y={y + 1} width={w} height={TRACK_H - 2}
                      fill={fill}
                      rx={2}
                      stroke={isSelected ? '#1d4ed8' : 'none'}
                      strokeWidth={isSelected ? 2 : 0}
                      style={{ cursor: 'pointer', outline: 'none' }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${track.label}：${KIND_LABEL[seg.kind] ?? seg.kind}，${fmtMs(seg.startMs)}–${fmtMs(seg.endMs)}`}
                      aria-pressed={isSelected}
                      onClick={() => selectSeg(track.id, seg)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSeg(track.id, seg) } }}
                    />
                  )
                })}

                {/* Action markers */}
                {isActions && data.actionMarkers.map((m, mi) => {
                  const x = tx(m.ms)
                  const colour = MARKER_COLOUR[m.kind] ?? '#94a3b8'
                  const isSelected = selection?.kind === 'marker' && selection.marker === m
                  return (
                    <g
                      key={mi}
                      style={{ cursor: 'pointer', outline: 'none' }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${MARKER_LABEL[m.kind] ?? m.kind}，${fmtMs(m.ms)}${m.detail ? '，' + m.detail : ''}`}
                      aria-pressed={isSelected}
                      onClick={() => selectMarker(m)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectMarker(m) } }}
                    >
                      <line
                        x1={x} y1={y + 1} x2={x} y2={y + TRACK_H - 1}
                        stroke={isSelected ? '#1d4ed8' : colour}
                        strokeWidth={isSelected ? 3 : 2}
                      />
                      {/* Diamond top */}
                      <polygon
                        points={`${x},${y + 1} ${x - 4},${y + 7} ${x},${y + 13} ${x + 4},${y + 7}`}
                        fill={isSelected ? '#1d4ed8' : colour}
                      />
                      {/* Count badge */}
                      {m.detail && m.kind === 'scroll' && (
                        <text x={x + 5} y={y + 11} fontSize={8} fill="#9ca3af">{m.detail}</text>
                      )}
                    </g>
                  )
                })}
              </g>
            )
          })}

          {/* ── Attention band (eye-tracking mode) ── */}
          {hasGaze && (
            <g aria-label="專注度">
              <text x={LABEL_W - 6} y={ATT_Y + ATT_H / 2 + 4} textAnchor="end" fontSize={11} fill="#6b7280" fontWeight="600">
                專注度
              </text>
              <text x={LABEL_W - 6} y={ATT_Y + 10} textAnchor="end" fontSize={9} fill="#9ca3af">高</text>
              <text x={LABEL_W - 6} y={ATT_Y + ATT_H - 2} textAnchor="end" fontSize={9} fill="#9ca3af">低</text>
              <rect x={LABEL_W} y={ATT_Y} width={TL_W} height={ATT_H} fill="#f9fafb" rx={3} />
              {ticks.map(ms => (
                <line key={ms} x1={tx(ms)} y1={ATT_Y} x2={tx(ms)} y2={ATT_Y + ATT_H} stroke="#e5e7eb" strokeWidth={1} />
              ))}
              {/* Middle reference line */}
              <line
                x1={LABEL_W} y1={focusY(0.5)} x2={LABEL_W + TL_W} y2={focusY(0.5)}
                stroke="#e5e7eb" strokeWidth={1} strokeDasharray="4 3"
              />
              {/* Check-in prompt, to compare with what the model saw just before */}
              {checkInShownMs !== null && (
                <line
                  x1={tx(checkInShownMs)} y1={ATT_Y} x2={tx(checkInShownMs)} y2={ATT_Y + ATT_H}
                  stroke={MARKER_COLOUR.check_in_shown} strokeWidth={1.5} strokeDasharray="3 3"
                />
              )}
              {/* Windows without a score: small bars at the bottom */}
              {data.attentionTrack.filter(p => p.status !== 'ok').map((p, i) => (
                <rect
                  key={`na-${i}`}
                  x={tx(p.ms) - 2} y={ATT_Y + ATT_H - 5} width={4} height={4}
                  fill={ATT_COLOUR[p.status as 'warming_up' | 'low_quality']}
                  style={{ cursor: 'pointer' }}
                  tabIndex={0}
                  role="button"
                  aria-label={`專注度：${ATT_STATUS_LABEL[p.status]}，${fmtMs(p.ms)}`}
                  onClick={() => selectAttention(p)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAttention(p) } }}
                />
              ))}
              {/* Trend line */}
              {trendRuns.map((run, ri) => (
                <polyline
                  key={`run-${ri}`}
                  points={run.map(p => `${tx(p.ms)},${focusY(p.trend as number)}`).join(' ')}
                  fill="none" stroke={ATT_COLOUR.trend} strokeWidth={2} strokeLinejoin="round"
                />
              ))}
              {/* Single-window scores (noisy) */}
              {data.attentionTrack.filter(p => p.status === 'ok' && p.score !== null).map((p, i) => {
                const isSelected = selection?.kind === 'attention' && selection.point === p
                return (
                  <circle
                    key={`pt-${i}`}
                    cx={tx(p.ms)} cy={focusY(p.score as number)} r={isSelected ? 4 : 2.5}
                    fill={isSelected ? '#1d4ed8' : ATT_COLOUR.window}
                    style={{ cursor: 'pointer', outline: 'none' }}
                    tabIndex={0}
                    role="button"
                    aria-label={`專注度，${fmtMs(p.ms)}，分數 ${(p.score as number).toFixed(3)}`}
                    aria-pressed={isSelected}
                    onClick={() => selectAttention(p)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAttention(p) } }}
                  />
                )
              })}
            </g>
          )}
        </svg>
      </div>

      {/* ── Selection detail ── */}
      {selection && (
        <div className="timeline-detail" role="status" aria-live="polite">
          {selection.kind === 'segment' && (() => {
            const trackLabel = tracks.find(t => t.id === selection.track)?.label ?? selection.track
            const seg = selection.seg
            return (
              <>
                <span className="tl-detail-track">{trackLabel}</span>
                <span className="tl-detail-kind">{KIND_LABEL[seg.kind] ?? seg.kind}</span>
                <span className="tl-detail-time">{fmtMs(seg.startMs)} → {fmtMs(seg.endMs)}</span>
                <span className="tl-detail-dur">持續 {fmtMs(seg.endMs - seg.startMs)}</span>
              </>
            )
          })()}
          {selection.kind === 'marker' && (() => {
            const m = selection.marker
            return (
              <>
                <span className="tl-detail-track">{MARKER_LABEL[m.kind] ?? m.kind}</span>
                <span className="tl-detail-time">{fmtMs(m.ms)}</span>
                {m.detail && <span className="tl-detail-kind">{m.detail}</span>}
              </>
            )
          })()}
          {selection.kind === 'attention' && (() => {
            const p = selection.point
            return (
              <>
                <span className="tl-detail-track">專注度</span>
                <span className="tl-detail-time">{fmtMs(Math.max(p.ms - 10_000, 0))} → {fmtMs(p.ms)}</span>
                <span className="tl-detail-kind">
                  {p.status === 'ok' && p.score !== null && p.trend !== null
                    ? `分數 ${p.score.toFixed(3)}（趨勢 ${p.trend.toFixed(3)}）`
                    : ATT_STATUS_LABEL[p.status]}
                </span>
                {p.nLineReturns !== null && p.xProgress !== null && (
                  <span className="tl-detail-dur">換行 {p.nLineReturns} 次・往右 {Math.round(p.xProgress)} px/s</span>
                )}
              </>
            )
          })()}
          <button
            className="tl-detail-close"
            onClick={() => setSelection(null)}
            aria-label="關閉詳情"
          >✕</button>
        </div>
      )}

      {/* ── Legend ── */}
      <div className="timeline-legend" aria-label="圖例">
        {legend.map(item => (
          <span key={item.label} className="tl-legend-item">
            {item.shape === 'dot' ? (
              <span className="tl-legend-swatch" style={{ background: item.colour, borderRadius: '50%' }} />
            ) : item.shape === 'line' ? (
              <span className="tl-legend-line" style={{ background: item.colour }} />
            ) : item.shape === 'diamond' ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
                <polygon points="6,1 11,6 6,11 1,6" fill={item.colour} stroke="rgba(0,0,0,0.12)" strokeWidth="0.8" />
              </svg>
            ) : (
              <span className="tl-legend-swatch" style={{ background: item.colour }} />
            )}
            {item.label}
          </span>
        ))}
      </div>

      {/* ── Stat summary ── */}
      <div className="timeline-stats">
        <div className="tl-stat">
          <span className="tl-stat-label">閱讀計時</span>
          <span className="tl-stat-note">（不含暫停及回報時間）</span>
          <span className="tl-stat-value">{fmtMs(data.activeReadingMs)}</span>
        </div>
        <div className="tl-stat">
          <span className="tl-stat-label">本次經過時間</span>
          <span className="tl-stat-note">（從開始到結束的掛鐘時間）</span>
          <span className="tl-stat-value">{fmtMs(data.totalMs)}</span>
        </div>
      </div>
    </div>
  )
}
