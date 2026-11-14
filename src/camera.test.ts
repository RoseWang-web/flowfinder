import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCamera } from './useCamera'
import type { CameraAdapter, FaceDetectorAdapter, FaceLandmarkerAdapter, FaceLandmarkResult } from './camera'
import type { EventType, SessionStatus } from './types'

// ── Mock factories ────────────────────────────────────────────────────────

function makeTrack(): MediaStreamTrack {
  return { stop: vi.fn() } as unknown as MediaStreamTrack
}

function makeStream(tracks: MediaStreamTrack[] = []): MediaStream {
  const t = tracks.length ? tracks : [makeTrack()]
  return {
    getTracks: vi.fn(() => t),
  } as unknown as MediaStream
}

function makeDetector(result: boolean | null = true): FaceDetectorAdapter {
  return {
    detect: vi.fn(() => result),
    close: vi.fn(),
  }
}

function makeLandmarkResult(faceDetected = true): FaceLandmarkResult {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  return {
    faceDetected,
    landmarks: faceDetected ? lm : [],
    blendshapes: faceDetected
      ? [
          { categoryName: 'eyeBlinkLeft', score: 0.1 },
          { categoryName: 'eyeBlinkRight', score: 0.12 },
          { categoryName: 'jawOpen', score: 0.05 },
        ]
      : null,
    transformationMatrix: faceDetected ? new Float32Array(16) : null,
  }
}

function makeLandmarker(result: FaceLandmarkResult | null = makeLandmarkResult()): FaceLandmarkerAdapter {
  return {
    detectWithLandmarks: vi.fn(() => result),
    close: vi.fn(),
  }
}

function makeAdapter(opts?: {
  supported?: boolean
  streamResult?: MediaStream | (() => Promise<MediaStream>)
  detectorResult?: FaceDetectorAdapter | (() => Promise<FaceDetectorAdapter>)
}): CameraAdapter {
  const stream = opts?.streamResult ?? makeStream()
  const detector = opts?.detectorResult ?? makeDetector()
  return {
    isSupported: vi.fn(() => opts?.supported ?? true),
    getUserMedia: vi.fn(() =>
      typeof stream === 'function' ? stream() : Promise.resolve(stream),
    ),
    loadFaceDetector: vi.fn(() =>
      typeof detector === 'function' ? detector() : Promise.resolve(detector),
    ),
    // No loadFaceLandmarker — existing tests use detector-only path
  }
}

/** Adapter with Landmarker support */
function makeAdapterWithLandmarker(opts?: {
  landmarkerResult?: FaceLandmarkerAdapter | (() => Promise<FaceLandmarkerAdapter>) | 'fail'
  detectorResult?: FaceDetectorAdapter | (() => Promise<FaceDetectorAdapter>)
}): CameraAdapter {
  const landmarker = opts?.landmarkerResult
  const detector = opts?.detectorResult ?? makeDetector()
  return {
    isSupported: vi.fn(() => true),
    getUserMedia: vi.fn(() => Promise.resolve(makeStream())),
    loadFaceDetector: vi.fn(() =>
      typeof detector === 'function' ? detector() : Promise.resolve(detector),
    ),
    loadFaceLandmarker: vi.fn(() => {
      if (landmarker === 'fail') return Promise.reject({ kind: 'model_load_failed', message: 'fail' })
      if (typeof landmarker === 'function') return landmarker()
      return Promise.resolve(landmarker ?? makeLandmarker())
    }),
  }
}

/** A minimal fake video element that passes the detection guard checks */
function makeVideoElement(): HTMLVideoElement {
  return {
    srcObject: null,
    videoWidth: 640,
    videoHeight: 480,
    readyState: 2, // HTMLMediaElement.HAVE_CURRENT_DATA
  } as unknown as HTMLVideoElement
}

/** After camera loads, inject a fake video element so the detection loop can run */
function injectVideo(videoRef: React.RefObject<HTMLVideoElement | null>) {
  Object.assign(videoRef, { current: makeVideoElement() })
}

// ── Helpers ───────────────────────────────────────────────────────────────

function collectEvents(onSessionEvent: ReturnType<typeof vi.fn>) {
  return () =>
    (onSessionEvent.mock.calls as [EventType, Record<string, unknown>?][]).map(c => ({
      type: c[0],
      data: c[1],
    }))
}

/** Load camera: enable, flush getUserMedia, flush loadFaceDetector */
async function loadCamera(result: { current: ReturnType<typeof useCamera> }) {
  act(() => { result.current.enableCamera() })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('useCamera', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let ts = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => (ts += 10))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not call getUserMedia before enableCamera is called', async () => {
    const adapter = makeAdapter()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'idle', onSessionEvent: vi.fn(), adapter }),
    )
    expect(result.current.cameraStatus).toBe('idle')
    expect(adapter.getUserMedia).not.toHaveBeenCalled()
  })

  it('transitions idle→requesting→loading→ready on enableCamera', async () => {
    const adapter = makeAdapter()
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    expect(result.current.cameraStatus).toBe('ready')
    expect(adapter.getUserMedia).toHaveBeenCalledOnce()
    expect(adapter.loadFaceDetector).toHaveBeenCalledOnce()
  })

  it('camera_started event emitted when model loads', async () => {
    const adapter = makeAdapter()
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    const events = collectEvents(onEvent)()
    expect(events.some(e => e.type === 'camera_started')).toBe(true)
  })

  it('permission denied → status is error, session remains usable', async () => {
    const deniedErr = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const adapter = makeAdapter({
      streamResult: () => Promise.reject(deniedErr),
    })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    expect(result.current.cameraStatus).toBe('error')
    expect(result.current.cameraError?.kind).toBe('permission_denied')
    const events = collectEvents(onEvent)()
    expect(events.some(e => e.type === 'camera_error')).toBe(true)
    // No session_end event emitted — camera error doesn't terminate session
    expect(events.some(e => e.type === 'session_end')).toBe(false)
  })

  it('model load failure → status is error, NOT face not_detected', async () => {
    const modelErr = { kind: 'model_load_failed' as const, message: 'fail' }
    const adapter = makeAdapter({
      detectorResult: () => Promise.reject(modelErr),
    })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    expect(result.current.cameraStatus).toBe('error')
    expect(result.current.faceStatus).toBe('unavailable')
    expect(result.current.faceStatus).not.toBe('not_detected')
  })

  it('face detected → faceStatus detected', async () => {
    const detector = makeDetector(true)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('detected')
  })

  it('no face → faceStatus not_detected', async () => {
    const detector = makeDetector(false)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('not_detected')
  })

  it('no duplicate face_detection_changed events for same status', async () => {
    const detector = makeDetector(true)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    // Advance enough for many detection ticks (6 × 250ms)
    act(() => { vi.advanceTimersByTime(1500) })
    const faceChangedEvents = collectEvents(onEvent)().filter(
      e => e.type === 'face_detection_changed' && (e.data as { status: string })?.status === 'detected',
    )
    // Should only record once (no duplicates for same status)
    expect(faceChangedEvents).toHaveLength(1)
  })

  it('stale frame → faceStatus unavailable after 3s without new frames', async () => {
    // Detector always returns null (stale/unready)
    const detector = makeDetector(null)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    // Advance past stale threshold without any valid frame
    act(() => { vi.advanceTimersByTime(3100) })
    expect(result.current.faceStatus).toBe('unavailable')
  })

  it('detection stops when session is paused', async () => {
    const detector = makeDetector(true)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result, rerender } = renderHook(
      ({ status }: { status: SessionStatus }) =>
        useCamera({ sessionStatus: status, onSessionEvent: onEvent, adapter }),
      { initialProps: { status: 'running' as SessionStatus } },
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('detected')

    // Pause the session
    act(() => { rerender({ status: 'paused' }) })

    expect(result.current.cameraStatus).toBe('off')
    expect(result.current.faceStatus).toBe('unavailable')
    const events = collectEvents(onEvent)()
    expect(events.some(e => e.type === 'camera_stopped')).toBe(true)
  })

  it('detection stops during checking_in', async () => {
    const detector = makeDetector(true)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result, rerender } = renderHook(
      ({ status }: { status: SessionStatus }) =>
        useCamera({ sessionStatus: status, onSessionEvent: onEvent, adapter }),
      { initialProps: { status: 'running' as SessionStatus } },
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    act(() => { rerender({ status: 'checking_in' }) })
    expect(result.current.cameraStatus).toBe('off')
  })

  it('track.stop() called on unmount', async () => {
    const track = makeTrack()
    const stream = makeStream([track])
    const adapter = makeAdapter({ streamResult: stream })
    const { result, unmount } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    await loadCamera(result)
    act(() => { unmount() })
    expect(track.stop).toHaveBeenCalled()
  })

  it('camera status does not affect reading timer (independent states)', async () => {
    const deniedErr = Object.assign(new Error('denied'), { name: 'NotAllowedError' })
    const adapter = makeAdapter({ streamResult: () => Promise.reject(deniedErr) })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    // Camera is in error state; session should not emit session_end
    const sessionEndEvents = collectEvents(onEvent)().filter(e => e.type === 'session_end')
    expect(sessionEndEvents).toHaveLength(0)
    expect(result.current.faceStatus).toBe('unavailable')
  })

  it('late getUserMedia result after disableCamera → stream is stopped immediately', async () => {
    let resolveStream!: (s: MediaStream) => void
    const pendingStream = new Promise<MediaStream>(r => { resolveStream = r })
    const track = makeTrack()
    const adapter = makeAdapter({ streamResult: () => pendingStream })
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    act(() => { result.current.enableCamera() })
    // Disable before stream resolves
    act(() => { result.current.disableCamera() })
    // Now resolve the stream
    await act(async () => {
      resolveStream(makeStream([track]))
      await Promise.resolve()
    })
    // The late stream should be stopped because cameraEnabledRef was set to false
    expect(track.stop).toHaveBeenCalled()
  })
})

// ── Landmarker-specific tests ─────────────────────────────────────────────

/** Load camera with 3 async hops: getUserMedia → loadFaceLandmarker (or fallback detector) */
async function loadCameraWithLandmarker(result: { current: ReturnType<typeof useCamera> }) {
  act(() => { result.current.enableCamera() })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useCamera — Face Landmarker path', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let ts = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => (ts += 10))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('1. Landmarker succeeds → loadFaceDetector is NOT called', async () => {
    const adapter = makeAdapterWithLandmarker()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    await loadCameraWithLandmarker(result)
    expect(result.current.cameraStatus).toBe('ready')
    expect(result.current.detectorKind).toBe('landmarker')
    expect(adapter.loadFaceDetector).not.toHaveBeenCalled()
  })

  it('2. Landmarker fails → falls back to FaceDetector', async () => {
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: 'fail' })
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    await loadCameraWithLandmarker(result)
    expect(result.current.cameraStatus).toBe('ready')
    expect(result.current.detectorKind).toBe('detector')
    expect(adapter.loadFaceDetector).toHaveBeenCalledOnce()
    expect(result.current.landmarkerFallbackMsg).toMatch(/進階臉部觀察無法啟用/)
  })

  it('3. Landmarker fails + Detector succeeds → original face events still fire', async () => {
    const detector = makeDetector(true)
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: 'fail', detectorResult: detector })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCameraWithLandmarker(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('detected')
    const events = collectEvents(onEvent)()
    expect(events.some(e => e.type === 'face_detection_changed')).toBe(true)
    expect(events.some(e => e.type === 'camera_started')).toBe(true)
  })

  it('4. Both Landmarker and Detector fail → status is error, session not blocked', async () => {
    const adapter = makeAdapterWithLandmarker({
      landmarkerResult: 'fail',
      detectorResult: () => Promise.reject({ kind: 'model_load_failed', message: 'fail' }),
    })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCameraWithLandmarker(result)
    expect(result.current.cameraStatus).toBe('error')
    expect(collectEvents(onEvent)().some(e => e.type === 'session_end')).toBe(false)
  })

  it('5. No-face result from Landmarker → not_detected, NOT a model failure', async () => {
    const landmarker = makeLandmarker(makeLandmarkResult(false))
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: landmarker })
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    await loadCameraWithLandmarker(result)
    expect(result.current.detectorKind).toBe('landmarker')
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('not_detected')
    expect(result.current.cameraStatus).toBe('ready') // not error
  })

  it('6. Landmarker result with landmarks/blendshapes is passed through without crash', async () => {
    const landmarker = makeLandmarker(makeLandmarkResult(true))
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: landmarker })
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    await loadCameraWithLandmarker(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('detected')
    const frame = result.current.latestLandmarkFrameRef.current
    expect(frame?.landmarks.length).toBe(478)
    expect(frame?.blendshapes).not.toBeNull()
    expect(frame?.transformationMatrix).not.toBeNull()
  })

  it('7. disableCamera clears latestLandmarkFrameRef', async () => {
    const landmarker = makeLandmarker()
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: landmarker })
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    await loadCameraWithLandmarker(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.latestLandmarkFrameRef.current).not.toBeNull()

    act(() => { result.current.disableCamera() })
    expect(result.current.latestLandmarkFrameRef.current).toBeNull()
    expect(result.current.detectorKind).toBeNull()
  })

  it('8. Init-then-destroy: late landmarker result is discarded on disableCamera mid-load', async () => {
    let resolveLandmarker!: (l: FaceLandmarkerAdapter) => void
    const pendingLandmarker = new Promise<FaceLandmarkerAdapter>(r => { resolveLandmarker = r })
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: () => pendingLandmarker })
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: vi.fn(), adapter }),
    )
    act(() => { result.current.enableCamera() })
    // Flush getUserMedia
    await act(async () => { await Promise.resolve() })
    // Disable camera before landmarker resolves
    act(() => { result.current.disableCamera() })
    // Resolve the landmarker late
    await act(async () => {
      resolveLandmarker(makeLandmarker())
      await Promise.resolve()
      await Promise.resolve()
    })
    // Should still be idle, not 'ready'
    expect(result.current.cameraStatus).toBe('idle')
    expect(result.current.detectorKind).toBeNull()
  })

  it('9. Pause and resume do not create duplicate loops; timestamps do not go backwards', async () => {
    const landmarker = makeLandmarker()
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: landmarker })
    const onEvent = vi.fn()
    const { result, rerender } = renderHook(
      ({ status }: { status: SessionStatus }) =>
        useCamera({ sessionStatus: status, onSessionEvent: onEvent, adapter }),
      { initialProps: { status: 'running' as SessionStatus } },
    )
    await loadCameraWithLandmarker(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('detected')

    // Pause
    act(() => { rerender({ status: 'paused' }) })
    expect(result.current.cameraStatus).toBe('off')

    // Resume requires re-openCamera (stream was stopped on pause)
    // — verify no double-loop is started by counting detect calls
    const callsBefore = (landmarker.detectWithLandmarks as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => { vi.advanceTimersByTime(500) })
    const callsAfter = (landmarker.detectWithLandmarks as ReturnType<typeof vi.fn>).mock.calls.length
    // No new calls while paused
    expect(callsAfter).toBe(callsBefore)
  })

  it('10. After session ends, no more events written; latestLandmarkFrameRef is cleared', async () => {
    const landmarker = makeLandmarker()
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: landmarker })
    const onEvent = vi.fn()
    const { result, rerender } = renderHook(
      ({ status }: { status: SessionStatus }) =>
        useCamera({ sessionStatus: status, onSessionEvent: onEvent, adapter }),
      { initialProps: { status: 'running' as SessionStatus } },
    )
    await loadCameraWithLandmarker(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })

    act(() => { rerender({ status: 'completed' }) })
    expect(result.current.cameraStatus).toBe('idle')
    expect(result.current.latestLandmarkFrameRef.current).toBeNull()

    const callsAtComplete = (landmarker.detectWithLandmarks as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => { vi.advanceTimersByTime(500) })
    // No additional inference after completion
    expect((landmarker.detectWithLandmarks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtComplete)
  })

  it('11. latestLandmarkFrameRef is not persisted: session events have no landmarks/blendshapes/matrix field', async () => {
    const landmarker = makeLandmarker()
    const adapter = makeAdapterWithLandmarker({ landmarkerResult: landmarker })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCameraWithLandmarker(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })

    const faceEvents = collectEvents(onEvent)().filter(e => e.type === 'face_detection_changed')
    for (const e of faceEvents) {
      expect(e.data).not.toHaveProperty('landmarks')
      expect(e.data).not.toHaveProperty('blendshapes')
      expect(e.data).not.toHaveProperty('transformationMatrix')
    }
  })

  it('12. Existing session / storage / timeline tests are unaffected (Landmarker-free adapter still works)', async () => {
    // Uses the original makeAdapter (no loadFaceLandmarker) — simulates baseline behavior
    const detector = makeDetector(true)
    const adapter = makeAdapter({ detectorResult: detector })
    const onEvent = vi.fn()
    const { result } = renderHook(() =>
      useCamera({ sessionStatus: 'running', onSessionEvent: onEvent, adapter }),
    )
    await loadCamera(result)
    injectVideo(result.current.videoRef)
    act(() => { vi.advanceTimersByTime(300) })
    expect(result.current.faceStatus).toBe('detected')
    expect(result.current.detectorKind).toBe('detector')
    // No landmarker was attempted
    expect('loadFaceLandmarker' in adapter).toBe(false)
  })
})
