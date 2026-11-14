import { useState, useEffect, useRef, useCallback } from 'react'
import {
  CameraAdapter,
  FaceDetectorAdapter,
  FaceLandmarkerAdapter,
  FaceLandmarkResult,
  CameraError,
  parseCameraError,
  createRealCameraAdapter,
  resetDetectorError,
  resetLandmarkerError,
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

/** Which engine is currently driving inference. */
export type DetectorKind = 'landmarker' | 'detector' | null

export interface CameraState {
  cameraStatus: CameraStatus
  faceStatus: FaceStatus
  cameraError: CameraError | null
  videoRef: React.RefObject<HTMLVideoElement | null>
  enableCamera: () => void
  disableCamera: () => void
  // ── Dev panel extras ──────────────────────────────────────────────────
  /** Which engine is active. null when camera is idle/error. */
  detectorKind: DetectorKind
  /** Set if Landmarker failed and we fell back to Detector. */
  landmarkerFallbackMsg: string | null
  /**
   * Ref to the latest landmarker frame result.
   * Updated in-memory on every detection tick; not persisted anywhere.
   * null when using Detector fallback, camera is off, or no face is detected.
   */
  latestLandmarkFrameRef: React.RefObject<FaceLandmarkResult | null>
  /**
   * Monotonically increasing counter updated on every successful landmarker frame.
   * Components can depend on this to know when latestLandmarkFrameRef changed.
   */
  landmarkFrameSeq: number
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

  const adapterRef = useRef<CameraAdapter>(injectedAdapter ?? createRealCameraAdapter())
  adapterRef.current = injectedAdapter ?? adapterRef.current

  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle')
  const [faceStatus, setFaceStatus] = useState<FaceStatus>('unavailable')
  const [cameraError, setCameraError] = useState<CameraError | null>(null)
  const [detectorKind, setDetectorKind] = useState<DetectorKind>(null)
  const [landmarkerFallbackMsg, setLandmarkerFallbackMsg] = useState<string | null>(null)
  const [landmarkFrameSeq, setLandmarkFrameSeq] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<FaceDetectorAdapter | null>(null)
  const landmarkerRef = useRef<FaceLandmarkerAdapter | null>(null)
  const latestLandmarkFrameRef = useRef<FaceLandmarkResult | null>(null)
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  const cameraStatusRef = useRef<CameraStatus>('idle')
  const sessionStatusRef = useRef(sessionStatus)
  sessionStatusRef.current = sessionStatus

  const lastFaceStatusRef = useRef<FaceStatus>('unavailable')
  const cameraEnabledRef = useRef(false)

  const onSessionEventRef = useRef(onSessionEvent)
  onSessionEventRef.current = onSessionEvent

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

  const clearEngines = useCallback(() => {
    detectorRef.current = null
    landmarkerRef.current = null
    latestLandmarkFrameRef.current = null
    setDetectorKind(null)
  }, [])

  // ── Detection loop ────────────────────────────────────────────────────

  const startLoop = useCallback(() => {
    stopLoop()
    resetStaleTimer()

    loopRef.current = setInterval(() => {
      if (!mountedRef.current) return
      const video = videoRef.current
      if (!video || sessionStatusRef.current !== 'running') return

      const timestampMs = performance.now()

      if (landmarkerRef.current) {
        const result = landmarkerRef.current.detectWithLandmarks(video, timestampMs)
        if (result === null) return // stale / not ready
        resetStaleTimer()
        latestLandmarkFrameRef.current = result
        setLandmarkFrameSeq(s => s + 1)
        emitFaceStatus(result.faceDetected ? 'detected' : 'not_detected')
      } else if (detectorRef.current) {
        const result = detectorRef.current.detect(video, timestampMs)
        if (result === null) return
        resetStaleTimer()
        emitFaceStatus(result ? 'detected' : 'not_detected')
      }
    }, DETECT_INTERVAL_MS)
  }, [stopLoop, resetStaleTimer, emitFaceStatus])

  // ── Open camera + model ───────────────────────────────────────────────

  const openCamera = useCallback(async () => {
    if (!mountedRef.current) return
    const adapter = adapterRef.current

    if (!adapter.isSupported()) {
      const err: CameraError = {
        kind: 'not_secure',
        message: 'Camera requires a secure context (HTTPS or localhost).',
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
      if (!mountedRef.current) return
      const camErr = parseCameraError(err)
      setCameraError(camErr)
      setAndSyncCameraStatus('error')
      onSessionEventRef.current('camera_error', { kind: camErr.kind })
      return
    }

    if (!mountedRef.current || !cameraEnabledRef.current) {
      stream.getTracks().forEach(t => t.stop())
      return
    }

    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
    }

    setAndSyncCameraStatus('loading')

    // 2. Try Landmarker first (if adapter supports it)
    let engineReady = false

    if (adapter.loadFaceLandmarker) {
      try {
        const landmarker = await adapter.loadFaceLandmarker()
        if (!mountedRef.current || !cameraEnabledRef.current) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        landmarkerRef.current = landmarker
        detectorRef.current = null
        setDetectorKind('landmarker')
        engineReady = true
      } catch {
        // Landmarker failed — clean up partial state and fall through to Detector
        landmarkerRef.current = null
        if (!mountedRef.current || !cameraEnabledRef.current) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        setLandmarkerFallbackMsg('Advanced face observation unavailable — using basic face detection.')
      }
    }

    // 3. Fall back to Detector if Landmarker not available or failed
    if (!engineReady) {
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
      landmarkerRef.current = null
      setDetectorKind('detector')
    }

    setAndSyncCameraStatus('ready')
    lastFaceStatusRef.current = 'unavailable'
    onSessionEventRef.current('camera_started')

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
    setLandmarkerFallbackMsg(null)
    resetDetectorError()
    resetLandmarkerError()
    openCamera()
  }, [openCamera])

  const disableCamera = useCallback(() => {
    if (cameraEnabledRef.current && cameraStatusRef.current !== 'idle') {
      onSessionEventRef.current('camera_stopped', { reason: 'disabled' })
    }
    cameraEnabledRef.current = false
    stopStream()
    clearEngines()
    latestLandmarkFrameRef.current = null
    setAndSyncCameraStatus('idle')
    setFaceStatus('unavailable')
    lastFaceStatusRef.current = 'unavailable'
  }, [stopStream, clearEngines, setAndSyncCameraStatus])

  // ── React to session status changes ──────────────────────────────────

  useEffect(() => {
    if (!cameraEnabledRef.current) return

    if (sessionStatus === 'running') {
      const cs = cameraStatusRef.current
      if (cs === 'ready') {
        emitFaceStatus('unavailable', 'resuming')
        onSessionEventRef.current('camera_started')
        startLoop()
      } else if (cs === 'off' || cs === 'idle') {
        openCamera()
      }
    } else if (sessionStatus === 'paused' || sessionStatus === 'checking_in') {
      const cs = cameraStatusRef.current
      if (cs === 'ready') {
        stopLoop()
        stopStream()
        clearEngines()
        latestLandmarkFrameRef.current = null
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
      clearEngines()
      latestLandmarkFrameRef.current = null
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
        latestLandmarkFrameRef.current = null
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
      clearEngines()
    }
  }, [stopLoop, stopStream, clearEngines])

  return {
    cameraStatus,
    faceStatus,
    cameraError,
    videoRef,
    enableCamera,
    disableCamera,
    detectorKind,
    landmarkerFallbackMsg,
    latestLandmarkFrameRef,
    landmarkFrameSeq,
  }
}
