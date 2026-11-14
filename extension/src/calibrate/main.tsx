import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Calibrate, type CalibrateApi } from './Calibrate'
import type { BackgroundMessage, EngineMessage, FaceReply, StartReply } from '../protocol'
import type { CalibrationSummary } from '@core/types'
import '../ui/theme.css'
import './calibrate.css'

const engine = <T,>(m: EngineMessage) => chrome.runtime.sendMessage({ to: 'engine', ...m }) as Promise<T>
const background = (m: BackgroundMessage) => chrome.runtime.sendMessage({ to: 'background', ...m })

const api: CalibrateApi = {
  faceStatus: () => engine<FaceReply>({ type: 'face_status' }),
  reset: async () => { await engine({ type: 'calib_reset' }) },
  click: (screenX, screenY) => { void engine({ type: 'calib_click', screenX, screenY }) },
  validationPoint: async (index, screenX, screenY) => { await engine({ type: 'validation_point', index, screenX, screenY }) },
  finishValidation: viewport => engine<CalibrationSummary>({ type: 'validation_finish', viewport }),
  beginReading: () => engine<StartReply>({ type: 'begin_reading' }),
  done: () => { void background({ type: 'calibration_done' }) },
  cancel: () => { void background({ type: 'calibration_cancelled' }) },
  async startPreview(video) {
    // A second view of the same camera, only for positioning (the engine has its own)
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
    video.srcObject = stream
    return () => stream.getTracks().forEach(t => t.stop())
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Calibrate api={api} recalibration={new URLSearchParams(location.search).get('mode') === 'recalibrate'} />
  </StrictMode>,
)
