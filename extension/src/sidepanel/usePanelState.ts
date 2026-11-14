import { useSyncExternalStore } from 'react'
import type { PanelController, PanelState } from './controller'

/** Re-renders when the controller publishes a new state (≈ once per second). */
export function usePanelState(controller: PanelController): PanelState {
  return useSyncExternalStore(controller.subscribe, controller.getState)
}
