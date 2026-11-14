/**
 * camera.ts — Camera + MediaPipe adapter layer.
 *
 * The CameraAdapter interface is the boundary that tests mock.
 * The real implementation loads @mediapipe/tasks-vision dynamically from CDN
 * and keeps a singleton detector to avoid re-downloading across sessions.
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

/** Injectable camera adapter — real or mock */
export interface CameraAdapter {
  /** True if the environment supports getUserMedia on a secure context */
  isSupported(): boolean
  getUserMedia(): Promise<MediaStream>
  loadFaceDetector(): Promise<FaceDetectorAdapter>
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

// ── Singleton real detector ───────────────────────────────────────────────
// Kept alive across sessions to avoid re-downloading WASM + model.
// Timestamps use performance.now() so they're always monotonically increasing.

let _sharedDetector: FaceDetectorAdapter | null = null
let _loadingPromise: Promise<FaceDetectorAdapter> | null = null
let _loadError: CameraError | null = null

export function resetDetectorError(): void {
  _loadError = null
  _loadingPromise = null
}

async function loadSharedDetector(): Promise<FaceDetectorAdapter> {
  if (_loadError) throw _loadError
  if (_sharedDetector) return _sharedDetector
  if (_loadingPromise) return _loadingPromise

  _loadingPromise = (async () => {
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
          if (timestampMs <= lastTimestamp) return null // stale frame
          if (!video.videoWidth || !video.videoHeight) return null // not ready
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null
          lastTimestamp = timestampMs
          const result = detector.detectForVideo(video, timestampMs)
          return result.detections.length > 0
        },
        close() {
          // Shared — do not actually close; reused across sessions
        },
      }

      _sharedDetector = adapter
      return adapter
    } catch (err) {
      _loadingPromise = null
      const camErr: CameraError = {
        kind: 'model_load_failed',
        message: `AI 模型載入失敗：${err instanceof Error ? err.message : '未知錯誤'}`,
      }
      _loadError = camErr
      throw camErr
    }
  })()

  return _loadingPromise
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
  }
}
