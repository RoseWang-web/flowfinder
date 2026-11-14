import { useState, useEffect, useRef, useCallback } from 'react'
import {
  CameraAdapter,
  FaceDetectorAdapter,
  CameraError,
  parseCameraError,
  createRealCameraAdapter,
  resetDetectorError,
} from './camera'
import type { EventType, SessionStatus } from './types'

// ── Public types ──────────────────────────────────────────────────────────

export type CameraStatus =
  | 'idle'         // not requested yet
  | 'requesting'   // getUserMedia pending
  | 'loading'      // model loading
  | 'ready'        // stream active, detecting
  | 'off'          // paused / checking_in / page hidden
  | 'error'        // failed

export type FaceStatus =
  | 'detected'
  | 'not_detected'
  | 'unavailable'  // no valid observation (loading, paused, stale, etc.)

export interface CameraState {
  cameraStatus: CameraStatus
  faceStatus: FaceStatus
  cameraError: CameraError | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  enableCamera: () => void
  disableCamera: () => void
}

// ── Constants ─────────────────────────────────────────────────────────────

const DETECT_INTERVAL_MS = 250        // 4 fps
const STALE_THRESHOLD_MS = 3_000      // mark unavailable if no frame for 3s

// ── Hook ──────────────────────────────────────────────────────────────────

export interface UseCameraOptions {
  sessionStatus: SessionStatus
  /** Callback to record an event into the session */
  onSessionEvent: (type: EventType, data?: Record<string, unknown>) => void
  /** Injectable adapter — defaults to real camera; override in tests */
  adapter?: CameraAdapter
}

export function useCamera(options: UseCameraOptions): CameraState {
  const {
    sessionStatus,
    onSessionEvent,
    adapter: injectedAdapter,
  } = options

  // Keep adapter in a ref so openCamera always reads the latest (useful in tests)
  const adapterRef = useRef<CameraAdapter>(injectedAdapter ?? createRealCameraAdapter())
  adapterRef.current = injectedAdapter ?? adapterRef.current

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle')
  const [faceStatus, setFaceStatus] = useState<FaceStatus>('unavailable')
  const [cameraError, setCameraError] = useState<CameraError | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<FaceDetectorAdapter | null>(null)
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  // Ref-based status for use inside async callbacks/intervals
  const cameraStatusRef = useRef<CameraStatus>('idle')
  const sessionStatusRef = useRef(sessionStatus)
  sessionStatusRef.current = sessionStatus

  // Avoid duplicate face_detection_changed events
  const lastFaceStatusRef = useRef<FaceStatus>('unavailable')

  // Whether the user explicitly chose camera mode
  const cameraEnabledRef = useRef(false)

  const onSessionEventRef = useRef(onSessionEvent)
  onSessionEventRef.current = onSessionEvent

  // Keep cameraStatusRef in sync whenever state updates
  const setAndSyncCameraStatus = useCallback((s: CameraStatus) => {
    cameraStatusRef.current = s
    setCameraStatus(s)
  }, [])

  // ── Helpers ───────────────────────────────────────────────────────────

  const stopLoop = useCallback(() => {
    if (loopRef.current !== null) {
      clearInterval(loopRef.current)
      loopRef.current = null
    }
    if (staleTimerRef.current !== null) {
      clearTimeout(staleTimerRef.current)
      staleTimerRef.current = null
    }
  }, [])

  const stopStream = useCallback(() => {
    stopLoop()
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [stopLoop])

  const emitFaceStatus = useCallback((next: FaceStatus, reason?: string) => {
    if (!mountedRef.current) return
    if (next === lastFaceStatusRef.current) return
    lastFaceStatusRef.current = next
    setFaceStatus(next)
    onSessionEventRef.current('face_detection_changed', { status: next, reason })
  }, [])

  const resetStaleTimer = useCallback(() => {
    if (staleTimerRef.current !== null) clearTimeout(staleTimerRef.current)
    staleTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return
      if (sessionStatusRef.current !== 'running') return
      emitFaceStatus('unavailable', 'no_new_frames')
    }, STALE_THRESHOLD_MS)
  }, [emitFaceStatus])

  // ── Detection loop ────────────────────────────────────────────────────

  const startLoop = useCallback(() => {
    stopLoop()
    resetStaleTimer()

    loopRef.current = setInterval(() => {
      if (!mountedRef.current) return
      const video = videoRef.current
      const detector = detectorRef.current
      if (!video || !detector || sessionStatusRef.current !== 'running') return

      const timestampMs = performance.now()
      const result = detector.detect(video, timestampMs)
      if (result === null) return // frame not ready

      resetStaleTimer()
      emitFaceStatus(result ? 'detected' : 'not_detected')
    }, DETECT_INTERVAL_MS)
  }, [stopLoop, resetStaleTimer, emitFaceStatus])

  // ── Open camera + model ───────────────────────────────────────────────

  const openCamera = useCallback(async () => {
    if (!mountedRef.current) return
    const adapter = adapterRef.current

    if (!adapter.isSupported()) {
      const err: CameraError = {
        kind: 'not_secure',
        message: '需要在 HTTPS 或 localhost 環境下才能使用攝影機。',
      }
      setAndSyncCameraStatus('error')
      setCameraError(err)
      return
    }

    // 1. Request stream
    setAndSyncCameraStatus('requesting')
    let stream: MediaStream
    try {
      stream = await adapter.getUserMedia()
    } catch (err) {
      if (!mountedRef.current) return // late arrival after session ended
      const camErr = parseCameraError(err)
      setCameraError(camErr)
      setAndSyncCameraStatus('error')
      onSessionEventRef.current('camera_error', { kind: camErr.kind })
      return
    }

    // Guard: session may have ended / user may have disabled camera while awaiting
    if (!mountedRef.current || !cameraEnabledRef.current) {
      stream.getTracks().forEach(t => t.stop())
      return
    }

    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
    }

    // 2. Load model
    setAndSyncCameraStatus('loading')
    let detector: FaceDetectorAdapter
    try {
      detector = await adapter.loadFaceDetector()
    } catch (err) {
      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop())
        return
      }
      const camErr = err as CameraError
      setCameraError(camErr)
      setAndSyncCameraStatus('error')
      stopStream()
      onSessionEventRef.current('camera_error', { kind: camErr.kind })
      return
    }

    if (!mountedRef.current || !cameraEnabledRef.current) {
      stream.getTracks().forEach(t => t.stop())
      return
    }

    detectorRef.current = detector
    setAndSyncCameraStatus('ready')
    lastFaceStatusRef.current = 'unavailable'
    onSessionEventRef.current('camera_started')

    // Start detecting only if session is currently running
    if (sessionStatusRef.current === 'running') {
      startLoop()
    } else {
      setFaceStatus('unavailable')
    }
  }, [startLoop, stopStream, setAndSyncCameraStatus])

  // ── Public actions ────────────────────────────────────────────────────

  const enableCamera = useCallback(() => {
    cameraEnabledRef.current = true
    setCameraError(null)
    resetDetectorError()
    openCamera()
  }, [openCamera])

  const disableCamera = useCallback(() => {
    if (cameraEnabledRef.current && cameraStatusRef.current !== 'idle') {
      onSessionEventRef.current('camera_stopped', { reason: 'disabled' })
    }
    cameraEnabledRef.current = false
    stopStream()
    detectorRef.current = null
    setAndSyncCameraStatus('idle')
    setFaceStatus('unavailable')
    lastFaceStatusRef.current = 'unavailable'
  }, [stopStream, setAndSyncCameraStatus])

  // ── React to session status changes ──────────────────────────────────

  useEffect(() => {
    if (!cameraEnabledRef.current) return

    if (sessionStatus === 'running') {
      const cs = cameraStatusRef.current
      if (cs === 'ready') {
        // Resume detection after pause/checking_in
        emitFaceStatus('unavailable', 'resuming')
        onSessionEventRef.current('camera_started')
        startLoop()
      } else if (cs === 'off' || cs === 'idle') {
        // Stream was explicitly closed on pause — reopen
        openCamera()
      }
      // cs === 'requesting' | 'loading' | 'error': no-op; openCamera is in-flight or failed
    } else if (sessionStatus === 'paused' || sessionStatus === 'checking_in') {
      const cs = cameraStatusRef.current
      if (cs === 'ready') {
        stopLoop()
        stopStream()
        detectorRef.current = null
        setAndSyncCameraStatus('off')
        emitFaceStatus('unavailable', sessionStatus)
        onSessionEventRef.current('camera_stopped', { reason: sessionStatus })
      }
    } else if (sessionStatus === 'completed' || sessionStatus === 'idle') {
      const cs = cameraStatusRef.current
      if (cs !== 'idle' && cs !== 'error') {
        onSessionEventRef.current('camera_stopped', { reason: sessionStatus })
      }
      stopLoop()
      stopStream()
      detectorRef.current = null
      setAndSyncCameraStatus('idle')
      setFaceStatus('unavailable')
      lastFaceStatusRef.current = 'unavailable'
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus])

  // ── Page visibility ───────────────────────────────────────────────────

  useEffect(() => {
    const handler = () => {
      if (!cameraEnabledRef.current) return
      const visible = document.visibilityState === 'visible'
      if (!visible) {
        stopLoop()
        emitFaceStatus('unavailable', 'page_hidden')
      } else if (sessionStatusRef.current === 'running') {
        const cs = cameraStatusRef.current
        if (cs === 'ready') {
          emitFaceStatus('unavailable', 'resuming')
          startLoop()
        } else {
          openCamera()
        }
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [stopLoop, startLoop, openCamera, emitFaceStatus])

  // ── Cleanup on unmount ────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopLoop()
      stopStream()
      detectorRef.current = null
    }
  }, [stopLoop, stopStream])

  return {
    cameraStatus,
    faceStatus,
    cameraError,
    videoRef,
    enableCamera,
    disableCamera,
  }
}
