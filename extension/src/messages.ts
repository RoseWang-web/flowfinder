/** Messages between the side panel and the content script (over a runtime Port). */
import type { ScreenFraction } from '@core/calibration'
import type { ScreenMap } from './coords'

export const PORT_NAME = 'flowfinder-gaze'

export interface PageInfo {
  host: string
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number
  windowScreenX: number
  windowScreenY: number
  outerWidth: number
  outerHeight: number
  map: ScreenMap | null
  mapSource: 'none' | 'mouse' | 'calibration'
  hasFocus: boolean
  visible: boolean
}

export type PanelToContent =
  | { type: 'calib_start'; points: readonly ScreenFraction[]; clicksPerPoint: number }
  | { type: 'validation_point'; index: number; point: ScreenFraction }
  | { type: 'overlay_clear' }
  | { type: 'gaze'; x: number | null; y: number | null }
  | { type: 'gaze_dot'; visible: boolean }
  | { type: 'info_request' }

export type ContentToPanel =
  | { type: 'calib_click'; pointIndex: number; clickIndex: number; screenX: number; screenY: number; clientX: number; clientY: number }
  | { type: 'calib_done'; map: ScreenMap | null }
  | { type: 'calib_cancelled' }
  | { type: 'validation_target'; index: number; screenX: number; screenY: number } // -1/-1 when unknown
  | { type: 'info'; info: PageInfo }

/** One-off message used to check whether the content script is already injected. */
export const PING = 'flowfinder-ping'
