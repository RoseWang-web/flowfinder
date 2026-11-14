/**
 * Calibrate.tsx — One-time calibration tab for "Screen attention".
 *
 * Same procedure and grading as the web app (calibration.ts): 9 points × 3
 * clicks train WebGazer in the engine, then 5 different points measure
 * accuracy / precision. Clicks are sent as screen coordinates, so the
 * calibration keeps working on every tab of this window.
 */
import { useEffect, useRef, useState } from 'react'
import {
  CALIBRATION_POINTS,
  CLICKS_PER_POINT,
  VALIDATION_COLLECT_MS,
  VALIDATION_POINTS,
  VALIDATION_SETTLE_MS,
  type ScreenFraction,
} from '@core/calibration'
import type { CalibrationSummary } from '@core/types'
import { fitMap, mapFromEvent, toScreen, type MouseLike, type ScreenMap } from '../coords'
import type { FaceReply, StartReply } from '../protocol'

export interface CalibrateApi {
  faceStatus(): Promise<FaceReply>
  reset(): Promise<void>
  click(screenX: number, screenY: number): void
  validationPoint(index: number, screenX: number, screenY: number): Promise<void>
  finishValidation(viewport: { width: number; height: number }): Promise<CalibrationSummary>
  beginReading(): Promise<StartReply>
  done(): void
  cancel(): void
  /** Show the camera in this video element; returns a stop function */
  startPreview(video: HTMLVideoElement): Promise<() => void>
  sleep(ms: number): Promise<void>
}

type Step = 'position' | 'dots' | 'validating' | 'result'

const FACE_TEXT: Record<FaceReply['face'], string> = {
  ok: 'Face detected — you are good to go',
  weak: 'Face partly visible — move into the light or closer',
  none: 'No face detected yet',
  off: 'Camera is starting…',
}

export function Calibrate({ api, recalibration = false }: { api: CalibrateApi; recalibration?: boolean }) {
  const [step, setStep] = useState<Step>('position')
  const [face, setFace] = useState<FaceReply>({ face: 'off', validRatio: 0, samplesPerSecond: 0 })
  const [point, setPoint] = useState(0)
  const [clicks, setClicks] = useState(0)
  const [validationIndex, setValidationIndex] = useState(-1)
  const [summary, setSummary] = useState<CalibrationSummary | null>(null)
  const [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const clickEvents = useRef<MouseLike[]>([])
  const map = useRef<ScreenMap | null>(null)
  const dotRefs = useRef<(HTMLDivElement | null)[]>([])

  // Camera preview + face status while positioning
  useEffect(() => {
    if (step !== 'position') return
    let stop: (() => void) | null = null
    let alive = true
    if (video.current) api.startPreview(video.current).then(s => { if (alive) stop = s; else s() }, () => {})
    const timer = setInterval(() => { api.faceStatus().then(f => alive && setFace(f), () => {}) }, 500)
    return () => { alive = false; clearInterval(timer); stop?.() }
  }, [step, api])

  const beginDots = async () => {
    await api.reset()
    clickEvents.current = []
    map.current = null
    setPoint(0)
    setClicks(0)
    setSummary(null)
    setError('')
    setStep('dots')
  }

  const onDot = (e: React.MouseEvent) => {
    const ev = { screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY }
    clickEvents.current.push(ev)
    api.click(ev.screenX, ev.screenY)
    if (clicks + 1 < CLICKS_PER_POINT) { setClicks(clicks + 1); return }
    setClicks(0)
    if (point + 1 < CALIBRATION_POINTS.length) { setPoint(point + 1); return }
    map.current = fitMap(clickEvents.current) ?? mapFromEvent(ev)
    void runValidation()
  }

  const runValidation = async () => {
    setStep('validating')
    for (let i = 0; i < VALIDATION_POINTS.length; i++) {
      setValidationIndex(i)
      await api.sleep(50) // let the dot render
      const el = dotRefs.current[i]
      const r = el?.getBoundingClientRect()
      const m = map.current
      if (r && m) {
        const s = toScreen(m, r.left + r.width / 2, r.top + r.height / 2)
        await api.validationPoint(i, s.x, s.y)
      }
      await api.sleep(VALIDATION_SETTLE_MS + VALIDATION_COLLECT_MS)
    }
    setValidationIndex(-1)
    try {
      setSummary(await api.finishValidation({ width: window.innerWidth, height: window.innerHeight }))
    } catch (err) {
      setError(String(err))
    }
    setStep('result')
  }

  const startReading = async () => {
    const r = await api.beginReading()
    if (r.phase === 'running') api.done()
    else setError(r.message || 'Could not start the session.')
  }

  const dot = (p: ScreenFraction) => ({ left: `${p.fx * 100}%`, top: `${p.fy * 100}%` })

  return (
    <div className="calib">
      <button type="button" className="link cancel" onClick={() => api.cancel()}>Cancel</button>

      {step === 'position' && (
        <section className="card center">
          <span className="brand">flowfinder<em>.</em></span>
          <h1 className="serif">{recalibration ? 'Recalibrate' : 'Quick calibration'}</h1>
          <p className="muted">
            {recalibration
              ? 'Your session is paused. Sit the way you are reading now and keep your face inside the oval.'
              : 'Sit the way you usually read. Keep your face inside the oval.'}
          </p>
          <div className="preview">
            <video ref={video} muted playsInline autoPlay />
            <div className="oval" />
          </div>
          <p className={`facestate ${face.face}`} role="status"><span className="camdot" />{FACE_TEXT[face.face]}</p>
          <p className="muted small rate" title="The attention model needs about 30 per second">
            Tracking {face.samplesPerSecond} / s{face.samplesPerSecond > 0 && face.samplesPerSecond < 25 ? ' · lower than ideal (30)' : ''}
          </p>
          <p className="muted small">Next: look at each red dot and click it {CLICKS_PER_POINT} times. Then follow 5 blue dots with your eyes. About a minute.</p>
          <button type="button" className="btn-solid" onClick={() => void beginDots()}>Begin</button>
        </section>
      )}

      {step === 'dots' && (
        <>
          <p className="hint">Look at the red dot and click it {CLICKS_PER_POINT} times · {point + 1} / {CALIBRATION_POINTS.length}</p>
          <button
            type="button"
            className="dot red"
            style={dot(CALIBRATION_POINTS[point])}
            aria-label={`Calibration point ${point + 1}`}
            onClick={onDot}
          >
            {CLICKS_PER_POINT - clicks}
          </button>
        </>
      )}

      {step === 'validating' && (
        <>
          <p className="hint">Just look at the blue dot — no clicking</p>
          {VALIDATION_POINTS.map((p, i) => (
            <div key={i} ref={el => { dotRefs.current[i] = el }} className={i === validationIndex ? 'dot blue' : 'dot blue hidden'} style={dot(p)} />
          ))}
        </>
      )}

      {step === 'result' && (
        <section className="card center">
          <h1 className="serif">{summary ? QUALITY_TITLE[summary.quality] : 'Calibration failed'}</h1>
          {summary && (
            <div className="sumstats">
              <div><small>ACCURACY</small><b>{fmt(summary.accuracyPx)} px</b></div>
              <div><small>PRECISION</small><b>{fmt(summary.precisionPx)} px</b></div>
            </div>
          )}
          <p className="muted">{summary ? QUALITY_TEXT[summary.quality] : error}</p>
          {error && summary && <p className="error">{error}</p>}
          <div className="row2">
            {summary && summary.quality !== 'poor' && (
              <button type="button" className="btn-solid" onClick={() => void startReading()}>{recalibration ? 'Back to reading' : 'Start reading'}</button>
            )}
            <button type="button" className="btn-ghost" onClick={() => setStep('position')}>Calibrate again</button>
          </div>
        </section>
      )}
    </div>
  )
}

const QUALITY_TITLE = { good: 'Calibration looks good.', usable: 'Calibration is usable.', poor: 'Calibration is too rough.' } as const
const QUALITY_TEXT = {
  good: 'Your gaze estimate is about as precise as a webcam gets.',
  usable: 'Scores will be noisier. Better light or sitting a little closer helps.',
  poor: 'Screen attention would be mostly noise. Try better light, keep your head still, and calibrate again.',
} as const

function fmt(v: number | null): string {
  return v === null || Number.isNaN(v) ? '—' : String(Math.round(v))
}
