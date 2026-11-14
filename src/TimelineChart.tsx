import { useState, useId } from 'react'
import type { TimelineData, TimeSegment, AttentionPoint } from './timeline'
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
const BASE_SVG_H = trackY(2) + TRACK_H + 10

// Attention band (eye-tracking mode only), drawn below the 2 tracks
const ATT_Y = trackY(2)
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
  trend: '#2F4D6B',
  window: '#9FB2C6',
  warming_up: '#C9D3DE',
  low_quality: '#B8B2A7',
}

const ATT_STATUS_LABEL: Record<AttentionPoint['status'], string> = {
  ok: 'Valid estimate',
  warming_up: 'Warming up',
  low_quality: 'Low gaze signal',
}

// ── Colour maps ───────────────────────────────────────────────────────────

const SESSION_COLOUR: Record<string, string> = {
  reading:     '#2F4D6B',
  paused:      '#F6D37C',  // actual fill overridden to stripe pattern in render
  checking_in: '#8b5cf6',
  unknown:     '#e5e7eb',
}

const VISIBILITY_COLOUR: Record<string, string> = {
  visible: '#9FB2C6',
  hidden:  '#ffffff',      // actual fill/stroke handled specially in render
  unknown: '#e5e7eb',
}


// ── Labels ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  reading:     'Reading',
  paused:      'Paused',
  checking_in: 'Check-in',
  unknown:     'Unknown',
  visible:     'Visible',
  hidden:      'Hidden',
}

// ── Selection types ───────────────────────────────────────────────────────

type Selection =
  | { kind: 'segment'; track: string; seg: TimeSegment }
  | { kind: 'attention'; point: AttentionPoint }

// ── Legend ────────────────────────────────────────────────────────────────

type LegendShape = 'line' | 'diamond' | 'dot' | 'diag-stripe' | 'v-stripe' | 'border-box'

const LEGEND: Array<{ label: string; colour: string; bg?: string; shape?: LegendShape }> = [
  { label: 'Reading',      colour: '#2F4D6B' },
  { label: 'Paused',       colour: '#F6D37C', bg: '#FBEBC4', shape: 'diag-stripe' },
  { label: 'Page visible', colour: '#9FB2C6' },
  { label: 'Page hidden',  colour: '#9FB2C6', shape: 'border-box' },
]

const GAZE_LEGEND: Array<{ label: string; colour: string; bg?: string; shape?: LegendShape }> = [
  { label: 'Focus trend',      colour: '#2F4D6B', shape: 'line' },
  { label: 'Single window',    colour: '#9FB2C6', shape: 'dot' },
  { label: 'Warming up',       colour: '#C9D3DE', bg: '#E4E9EF', shape: 'v-stripe' },
  { label: 'Low gaze signal',  colour: '#B8B2A7', bg: '#E4DFD6', shape: 'diag-stripe' },
]

// ── Component ─────────────────────────────────────────────────────────────

interface Props {
  data: TimelineData
}

export function TimelineChart({ data }: Props) {
  const [selection, setSelection] = useState<Selection | null>(null)
  const baseId = useId()
  const hatchId        = `${baseId}h`
  const pausedHatchId  = `${baseId}p`
  const warmingStripeId = `${baseId}w`
  const lowQualHatchId = `${baseId}l`

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
  const legend = hasGaze ? [...LEGEND, ...GAZE_LEGEND] : LEGEND

  // ── Track rows ─────────────────────────────────────────────────────────
  const tracks: Array<{ label: string; id: string; segs: TimeSegment[]; colorMap: Record<string, string> }> = [
    { label: 'Status',     id: 'session',    segs: data.sessionStatusTrack,  colorMap: SESSION_COLOUR },
    { label: 'Visibility', id: 'visibility', segs: data.pageVisibilityTrack, colorMap: VISIBILITY_COLOUR },
  ]

  return (
    <div className="timeline-wrap">
      {/* ── SVG Chart ── */}
      <div className="timeline-scroll">
        <svg
          width={SVG_W}
          height={svgH}
          role="img"
          aria-label="Session timeline"
          style={{ display: 'block', userSelect: 'none' }}
        >
          <defs>
            {/* Unknown segments: grey diagonal hatch */}
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="#d1d5db" strokeWidth="2" />
            </pattern>
            {/* Paused: yellow diagonal stripes */}
            <pattern id={pausedHatchId} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="8" height="8" fill="#FBEBC4" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="#F6D37C" strokeWidth="3.5" />
            </pattern>
            {/* Warming up: vertical blue-grey stripes */}
            <pattern id={warmingStripeId} width="4" height="4" patternUnits="userSpaceOnUse">
              <rect width="4" height="4" fill="#E4E9EF" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="#C9D3DE" strokeWidth="1.5" />
            </pattern>
            {/* Low gaze signal: warm-grey diagonal stripes */}
            <pattern id={lowQualHatchId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="4" height="4" fill="#E4DFD6" />
              <line x1="0" y1="0" x2="0" y2="4" stroke="#B8B2A7" strokeWidth="1.5" />
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

                {/* Segments */}
                {track.segs.map((seg, si) => {
                  const x1 = tx(seg.startMs)
                  const x2 = tx(seg.endMs)
                  const w = Math.max(x2 - x1, 1)
                  const fill =
                    seg.kind === 'unknown' ? `url(#${hatchId})` :
                    seg.kind === 'paused'  ? `url(#${pausedHatchId})` :
                    seg.kind === 'hidden'  ? '#ffffff' :
                    (track.colorMap[seg.kind] ?? '#e5e7eb')
                  const isSelected =
                    selection?.kind === 'segment' &&
                    selection.track === track.id &&
                    selection.seg === seg
                  const segStroke    = isSelected ? '#1d4ed8' : seg.kind === 'hidden' ? '#9FB2C6' : 'none'
                  const segStrokeW   = isSelected ? 2 : seg.kind === 'hidden' ? 1.5 : 0

                  return (
                    <rect
                      key={si}
                      x={x1} y={y + 1} width={w} height={TRACK_H - 2}
                      fill={fill}
                      rx={2}
                      stroke={segStroke}
                      strokeWidth={segStrokeW}
                      style={{ cursor: 'pointer', outline: 'none' }}
                      tabIndex={0}
                      role="button"
                      aria-label={`${track.label}: ${KIND_LABEL[seg.kind] ?? seg.kind}, ${fmtMs(seg.startMs)}–${fmtMs(seg.endMs)}`}
                      aria-pressed={isSelected}
                      onClick={() => selectSeg(track.id, seg)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSeg(track.id, seg) } }}
                    />
                  )
                })}
              </g>
            )
          })}

          {/* ── Attention band (eye-tracking mode) ── */}
          {hasGaze && (
            <g aria-label="Focus score">
              <text x={LABEL_W - 6} y={ATT_Y + ATT_H / 2 + 4} textAnchor="end" fontSize={11} fill="#6b7280" fontWeight="600">
                Focus
              </text>
              <text x={LABEL_W - 6} y={ATT_Y + 10} textAnchor="end" fontSize={9} fill="#9ca3af">Hi</text>
              <text x={LABEL_W - 6} y={ATT_Y + ATT_H - 2} textAnchor="end" fontSize={9} fill="#9ca3af">Lo</text>
              <rect x={LABEL_W} y={ATT_Y} width={TL_W} height={ATT_H} fill="#f9fafb" rx={3} />
              {ticks.map(ms => (
                <line key={ms} x1={tx(ms)} y1={ATT_Y} x2={tx(ms)} y2={ATT_Y + ATT_H} stroke="#e5e7eb" strokeWidth={1} />
              ))}
              {/* Middle reference line */}
              <line
                x1={LABEL_W} y1={focusY(0.5)} x2={LABEL_W + TL_W} y2={focusY(0.5)}
                stroke="#e5e7eb" strokeWidth={1} strokeDasharray="4 3"
              />
              {/* Warming up: vertical-stripe bar at top of Focus area */}
              {data.attentionTrack.filter(p => p.status === 'warming_up').map((p, i) => (
                <rect
                  key={`wu-${i}`}
                  x={tx(p.ms) - 2.5} y={ATT_Y + 1} width={5} height={9}
                  fill={`url(#${warmingStripeId})`}
                  style={{ cursor: 'pointer' }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Focus: ${ATT_STATUS_LABEL['warming_up']}, ${fmtMs(p.ms)}`}
                  onClick={() => selectAttention(p)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAttention(p) } }}
                />
              ))}
              {/* Low gaze signal: diagonal-stripe bar at bottom of Focus area */}
              {data.attentionTrack.filter(p => p.status === 'low_quality').map((p, i) => (
                <rect
                  key={`lq-${i}`}
                  x={tx(p.ms) - 2.5} y={ATT_Y + ATT_H - 7} width={5} height={6}
                  fill={`url(#${lowQualHatchId})`}
                  style={{ cursor: 'pointer' }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Focus: ${ATT_STATUS_LABEL['low_quality']}, ${fmtMs(p.ms)}`}
                  onClick={() => selectAttention(p)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAttention(p) } }}
                />
              ))}
              {/* Area fill below trend (8% opacity) */}
              {trendRuns.map((run, ri) => {
                if (run.length < 2) return null
                const pts = run.map(p => `${tx(p.ms)},${focusY(p.trend as number)}`).join(' ')
                const br = `${tx(run[run.length - 1].ms)},${ATT_Y + ATT_H}`
                const bl = `${tx(run[0].ms)},${ATT_Y + ATT_H}`
                return (
                  <polygon key={`area-${ri}`} points={`${pts} ${br} ${bl}`}
                    fill={ATT_COLOUR.trend} fillOpacity={0.08} stroke="none" />
                )
              })}
              {/* Trend line */}
              {trendRuns.map((run, ri) => (
                <polyline
                  key={`run-${ri}`}
                  points={run.map(p => `${tx(p.ms)},${focusY(p.trend as number)}`).join(' ')}
                  fill="none" stroke={ATT_COLOUR.trend} strokeWidth={2.25} strokeLinejoin="round"
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
                    aria-label={`Focus, ${fmtMs(p.ms)}, score ${(p.score as number).toFixed(3)}`}
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
                <span className="tl-detail-dur">Duration {fmtMs(seg.endMs - seg.startMs)}</span>
              </>
            )
          })()}
          {selection.kind === 'attention' && (() => {
            const p = selection.point
            return (
              <>
                <span className="tl-detail-track">Focus</span>
                <span className="tl-detail-time">{fmtMs(Math.max(p.ms - 10_000, 0))} → {fmtMs(p.ms)}</span>
                <span className="tl-detail-kind">
                  {p.status === 'ok' && p.score !== null && p.trend !== null
                    ? `Score ${p.score.toFixed(3)} (trend ${p.trend.toFixed(3)})`
                    : ATT_STATUS_LABEL[p.status]}
                </span>
                {p.nLineReturns !== null && p.xProgress !== null && (
                  <span className="tl-detail-dur">Line returns {p.nLineReturns} · rightward {Math.round(p.xProgress)} px/s</span>
                )}
              </>
            )
          })()}
          <button
            className="tl-detail-close"
            onClick={() => setSelection(null)}
            aria-label="Close detail"
          >✕</button>
        </div>
      )}

      {/* ── Legend ── */}
      <div className="timeline-legend" aria-label="Legend">
        {legend.map((item, li) => {
          const legPatId = `${baseId}leg${li}`
          return (
            <span key={item.label} className="tl-legend-item">
              {item.shape === 'dot' ? (
                <span className="tl-legend-swatch" style={{ background: item.colour, borderRadius: '50%' }} />
              ) : item.shape === 'line' ? (
                <span className="tl-legend-line" style={{ background: item.colour }} />
              ) : item.shape === 'diamond' ? (
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <polygon points="6,1 11,6 6,11 1,6" fill={item.colour} stroke="rgba(0,0,0,0.12)" strokeWidth="0.8" />
                </svg>
              ) : item.shape === 'diag-stripe' ? (
                <svg width="12" height="12" aria-hidden="true" style={{ flexShrink: 0, borderRadius: 2, overflow: 'hidden' }}>
                  <defs>
                    <pattern id={legPatId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <rect width="5" height="5" fill={item.bg} />
                      <line x1="0" y1="0" x2="0" y2="5" stroke={item.colour} strokeWidth="2" />
                    </pattern>
                  </defs>
                  <rect width="12" height="12" fill={`url(#${legPatId})`} />
                </svg>
              ) : item.shape === 'v-stripe' ? (
                <svg width="12" height="12" aria-hidden="true" style={{ flexShrink: 0, borderRadius: 2, overflow: 'hidden' }}>
                  <defs>
                    <pattern id={legPatId} width="4" height="4" patternUnits="userSpaceOnUse">
                      <rect width="4" height="4" fill={item.bg} />
                      <line x1="0" y1="0" x2="0" y2="4" stroke={item.colour} strokeWidth="1.5" />
                    </pattern>
                  </defs>
                  <rect width="12" height="12" fill={`url(#${legPatId})`} />
                </svg>
              ) : item.shape === 'border-box' ? (
                <svg width="12" height="12" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <rect x="1" y="1" width="10" height="10" fill="white" stroke={item.colour} strokeWidth="1.5" rx="1" />
                </svg>
              ) : (
                <span className="tl-legend-swatch" style={{ background: item.colour }} />
              )}
              {item.label}
            </span>
          )
        })}
      </div>

      {/* ── Stat summary ── */}
      <div className="timeline-stats">
        <div className="tl-stat">
          <span className="tl-stat-label">Active Reading Time</span>
          <span className="tl-stat-note">(excludes pause &amp; check-in)</span>
          <span className="tl-stat-value">{fmtMs(data.activeReadingMs)}</span>
        </div>
        <div className="tl-stat">
          <span className="tl-stat-label">Total Elapsed</span>
          <span className="tl-stat-note">(wall clock from start to end)</span>
          <span className="tl-stat-value">{fmtMs(data.totalMs)}</span>
        </div>
      </div>
    </div>
  )
}
