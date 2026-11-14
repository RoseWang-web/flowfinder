import { vi } from 'vitest'
import { summarizeRates } from './metrics'
import { IDLE_READING, type PanelController, type PanelState } from './controller'

export function initialState(patch: Partial<PanelState> = {}): PanelState {
  return {
    message: '',
    camera: 'off',
    cameraError: '',
    faceMeshPath: 'chrome-extension://test/face_mesh',
    previewOn: false,
    dotOn: false,
    calibrating: false,
    calibClicks: 0,
    calibTotal: 27,
    validation: null,
    pageInfo: null,
    zoom: null,
    lastSecond: { total: 0, valid: 0, bucket: null },
    model: null,
    rates: { panel: summarizeRates([]), page: summarizeRates([]), other: summarizeRates([]) },
    externalRequests: [],
    webApp: null,
    manual: { zoomAligned: false, crossTabAligned: false },
    reading: IDLE_READING,
    history: [],
    ...patch,
  }
}

/** In-memory PanelController: actions are spies, `publish()` pushes a new state. */
export function createFakeController(state = initialState()) {
  const listeners = new Set<() => void>()
  let current = state
  const controller = {
    getState: () => current,
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    openPermissionPage: vi.fn(),
    start: vi.fn(async () => {}),
    calibrate: vi.fn(async () => {}),
    setPreview: vi.fn(),
    setGazeDot: vi.fn(),
    setWebApp: vi.fn(),
    setManual: vi.fn(),
    startReading: vi.fn(async () => {}),
    endReading: vi.fn(async () => {}),
    buildReport: vi.fn(() => ({ kind: 'test-report' })),
  } satisfies PanelController
  return {
    controller,
    publish(patch: Partial<PanelState>) {
      current = { ...current, ...patch }
      listeners.forEach(l => l())
    },
  }
}
