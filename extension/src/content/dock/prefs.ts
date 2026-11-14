/** Floating-timer preferences (shared by the dock and the popup). */
export type Corner = 'br' | 'bl' | 'tr' | 'tl'
export interface DockPrefs {
  corner: Corner
  expanded: boolean
  quiet: boolean
  /** Floating timer hidden from the popup ("Show timer on page" off). Time's-up and summary cards still appear. */
  hidden: boolean
}
export const DEFAULT_PREFS: DockPrefs = { corner: 'br', expanded: false, quiet: true, hidden: false }
export const DOCK_PREFS_KEY = 'flowfinder_dock_prefs_v1'
