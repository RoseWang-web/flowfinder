import { vi } from 'vitest'
import type { GazeSample } from './attentionModel'
import type { GazeTracker } from './gaze'

/** In-memory GazeTracker for tests: call emit() to simulate predictions. */
export function createMockTracker(opts: { failBegin?: Error } = {}) {
  const listeners = new Set<(s: GazeSample) => void>()
  const tracker = {
    begin: vi.fn(async () => {
      if (opts.failBegin) throw opts.failBegin
    }),
    addListener: vi.fn((fn: (s: GazeSample) => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }),
    recordCalibrationPoint: vi.fn(),
    clearCalibration: vi.fn(async () => {}),
    showPreview: vi.fn(),
    showGazeDot: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
  } satisfies GazeTracker
  return {
    tracker,
    emit: (s: GazeSample) => listeners.forEach(fn => fn(s)),
    listenerCount: () => listeners.size,
  }
}
