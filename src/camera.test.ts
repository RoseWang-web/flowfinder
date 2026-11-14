import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCamera } from './useCamera'
import type { CameraAdapter, FaceDetectorAdapter } from './camera'
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
