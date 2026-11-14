/**
 * Origins of the FlowFinder web app that may receive reading history.
 *
 * This list is the security boundary: history is only ever written into the
 * localStorage of these origins. A page marker alone is not enough — any site
 * could add the same <meta> tag to collect a user's reading history.
 * Add the production origin here when the web app is deployed.
 */
export const FLOWFINDER_ORIGINS: readonly string[] = [
  'http://localhost:5173', // npm run dev
  'http://127.0.0.1:5173',
  'http://localhost:4173', // npm run preview
  'http://127.0.0.1:4173',
]

/** <meta name="flowfinder-app"> in the web app's index.html (second check, catches other apps on the same port) */
export const FLOWFINDER_APP_META = 'flowfinder-app'

/** Fired on the web app's window after new sessions were written, so the Dashboard can reload. */
export { HISTORY_UPDATED_EVENT } from '@core/historyStorage'
