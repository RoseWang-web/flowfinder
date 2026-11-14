/**
 * camera.ts — Camera + MediaPipe adapter layer.
 *
 * CameraAdapter is the boundary that tests mock.
 * Two engine types: FaceLandmarker (primary) → FaceDetector (fallback).
 * Real implementations load @mediapipe/tasks-vision dynamically from CDN.
 * Singletons survive across sessions to avoid re-downloading WASM + model.
 */

export type CameraErrorKind =
  | 'permission_denied'
  | 'no_camera'
  | 'device_error'
  | 'model_load_failed'
  | 'stream_lost'
  | 'not_secure'
  | 'unknown'

export interface CameraError {
  kind: CameraErrorKind
  message: string
}

// ── FaceDetector adapter (Phase 1–4 baseline) ─────────────────────────────

/** Thin wrapper around FaceDetector — injectable for tests */
export interface FaceDetectorAdapter {
  /**
   * Returns true if ≥1 face detected.
   * Returns null if the frame could not be processed (bad state, stale timestamp).
   * timestampMs must be strictly increasing; use performance.now().
   */
  detect(video: HTMLVideoElement, timestampMs: number): boolean | null
  close(): void
}

// ── FaceLandmarker adapter ────────────────────────────────────────────────

export interface NormalizedLandmark {
  x: number  // [0, 1], normalized to video width
  y: number  // [0, 1], normalized to video height
  z: number  // relative depth
}

export interface FaceLandmarkResult {
  faceDetected: boolean
  /** All 478 landmarks of the first detected face; empty array if no face. */
  landmarks: NormalizedLandmark[]
  /** Blendshape coefficients, null if not output by the model or missing. */
  blendshapes: Array<{ categoryName: string; score: number }> | null
  /** 4×4 facial transformation matrix (row-major), null if not available. */
  transformationMatrix: Float32Array | null
}

export interface FaceLandmarkerAdapter {
  detectWithLandmarks(video: HTMLVideoElement, timestampMs: number): FaceLandmarkResult | null
  close(): void
}

// ── Connection constants (from FaceLandmarker static properties @ 0.10.14) ──
// Values verified with: node -e "... console.log(JSON.stringify(FaceLandmarker.FACE_LANDMARKS_*))"
// These are connections (pairs of indices) for drawing canonical eye / iris outlines.

export interface LandmarkConnection { start: number; end: number }

export const LANDMARK_CONNECTIONS = {
  // Person's right eye (appears on LEFT of mirrored preview):
  RIGHT_EYE: [
    {start:33,end:7},{start:7,end:163},{start:163,end:144},{start:144,end:145},
    {start:145,end:153},{start:153,end:154},{start:154,end:155},{start:155,end:133},
    {start:33,end:246},{start:246,end:161},{start:161,end:160},{start:160,end:159},
    {start:159,end:158},{start:158,end:157},{start:157,end:173},{start:173,end:133},
  ] as LandmarkConnection[],
  // Person's left eye (appears on RIGHT of mirrored preview):
  LEFT_EYE: [
    {start:263,end:249},{start:249,end:390},{start:390,end:373},{start:373,end:374},
    {start:374,end:380},{start:380,end:381},{start:381,end:382},{start:382,end:362},
    {start:263,end:466},{start:466,end:388},{start:388,end:387},{start:387,end:386},
    {start:386,end:385},{start:385,end:384},{start:384,end:398},{start:398,end:362},
  ] as LandmarkConnection[],
  // Iris connections (the 4 surrounding points):
  RIGHT_IRIS: [{start:469,end:470},{start:470,end:471},{start:471,end:472},{start:472,end:469}] as LandmarkConnection[],
  LEFT_IRIS:  [{start:474,end:475},{start:475,end:476},{start:476,end:477},{start:477,end:474}] as LandmarkConnection[],
  // Iris center point indices (not connections, just indices):
  RIGHT_IRIS_CENTER: 468,
  LEFT_IRIS_CENTER:  473,
} as const

// ── CameraAdapter interface ───────────────────────────────────────────────

/** Injectable camera adapter — real or mock */
export interface CameraAdapter {
  /** True if the environment supports getUserMedia on a secure context */
  isSupported(): boolean
  getUserMedia(): Promise<MediaStream>
  /** Fallback face presence detector (Phase 1–4 baseline) */
  loadFaceDetector(): Promise<FaceDetectorAdapter>
  /**
   * Primary face landmarker (Phase 5+). Optional — if absent, skip to loadFaceDetector.
   * Failure triggers fallback to loadFaceDetector.
   */
  loadFaceLandmarker?(): Promise<FaceLandmarkerAdapter>
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function parseCameraError(err: unknown): CameraError {
  if (!(err instanceof Error)) {
    return { kind: 'unknown', message: '未知攝影機錯誤' }
  }
  const { name, message } = err
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return { kind: 'permission_denied', message: '攝影機權限遭拒。請在瀏覽器設定中允許後重試。' }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return { kind: 'no_camera', message: '未偵測到攝影機裝置。' }
  }
  if (
    name === 'NotReadableError' ||
    name === 'TrackStartError' ||
    message.toLowerCase().includes('in use')
  ) {
    return { kind: 'device_error', message: '攝影機無法讀取，可能正被其他應用程式使用。' }
  }
  if (name === 'OverconstrainedError') {
    return { kind: 'device_error', message: '攝影機不符合要求設定。' }
  }
  return { kind: 'unknown', message: `攝影機初始化失敗：${message}` }
}

// ── FaceDetector singleton ────────────────────────────────────────────────

let _sharedDetector: FaceDetectorAdapter | null = null
let _detectorLoadingPromise: Promise<FaceDetectorAdapter> | null = null
let _detectorLoadError: CameraError | null = null

export function resetDetectorError(): void {
  _detectorLoadError = null
  _detectorLoadingPromise = null
}

async function loadSharedDetector(): Promise<FaceDetectorAdapter> {
  if (_detectorLoadError) throw _detectorLoadError
  if (_sharedDetector) return _sharedDetector
  if (_detectorLoadingPromise) return _detectorLoadingPromise

  _detectorLoadingPromise = (async () => {
    try {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
      )
      const detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
        minSuppressionThreshold: 0.3,
      })

      let lastTimestamp = -Infinity
      const adapter: FaceDetectorAdapter = {
        detect(video, timestampMs) {
          if (timestampMs <= lastTimestamp) return null
          if (!video.videoWidth || !video.videoHeight) return null
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
          lastTimestamp = timestampMs
          const result = detector.detectForVideo(video, timestampMs)
          return result.detections.length > 0
        },
        close() {
          // Shared — do not actually close
        },
      }

      _sharedDetector = adapter
      return adapter
    } catch (err) {
      _detectorLoadingPromise = null
      const camErr: CameraError = {
        kind: 'model_load_failed',
        message: `AI 模型載入失敗：${err instanceof Error ? err.message : '未知錯誤'}`,
      }
      _detectorLoadError = camErr
      throw camErr
    }
  })()

  return _detectorLoadingPromise
}

// ── FaceLandmarker singleton ──────────────────────────────────────────────

let _sharedLandmarker: FaceLandmarkerAdapter | null = null
let _landmarkerLoadingPromise: Promise<FaceLandmarkerAdapter> | null = null
let _landmarkerLoadError: CameraError | null = null

export function resetLandmarkerError(): void {
  _landmarkerLoadError = null
  _landmarkerLoadingPromise = null
}

async function loadSharedLandmarker(): Promise<FaceLandmarkerAdapter> {
  if (_landmarkerLoadError) throw _landmarkerLoadError
  if (_sharedLandmarker) return _sharedLandmarker
  if (_landmarkerLoadingPromise) return _landmarkerLoadingPromise

  _landmarkerLoadingPromise = (async () => {
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
      )
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      })

      let lastTimestamp = -Infinity
      const adapter: FaceLandmarkerAdapter = {
        detectWithLandmarks(video, timestampMs) {
          if (timestampMs <= lastTimestamp) return null // stale frame
          if (!video.videoWidth || !video.videoHeight) return null
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
          lastTimestamp = timestampMs
          const result = landmarker.detectForVideo(video, timestampMs)
          const faceDetected = result.faceLandmarks.length > 0
          const lms = result.faceLandmarks[0] ?? []
          const bs = result.faceBlendshapes?.[0]?.categories ?? null
          const mx = result.facialTransformationMatrixes?.[0]?.data ?? null
          return {
            faceDetected,
            landmarks: lms,
            blendshapes: bs,
            transformationMatrix: mx ? new Float32Array(mx) : null,
          }
        },
        close() {
          // Shared — do not actually close
        },
      }

      _sharedLandmarker = adapter
      return adapter
    } catch (err) {
      _landmarkerLoadingPromise = null
      const camErr: CameraError = {
        kind: 'model_load_failed',
        message: `Face Landmarker 載入失敗：${err instanceof Error ? err.message : '未知錯誤'}`,
      }
      _landmarkerLoadError = camErr
      throw camErr
    }
  })()

  return _landmarkerLoadingPromise
}

// ── Real adapter ──────────────────────────────────────────────────────────

export function createRealCameraAdapter(): CameraAdapter {
  return {
    isSupported() {
      if (typeof window === 'undefined') return false
      if (!window.isSecureContext && location.hostname !== 'localhost') return false
      return !!navigator.mediaDevices?.getUserMedia
    },
    async getUserMedia() {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    },
    loadFaceDetector: loadSharedDetector,
    loadFaceLandmarker: loadSharedLandmarker,
  }
}
