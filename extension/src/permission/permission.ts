import type { ToBackground } from '../protocol'
import '../ui/theme.css'
import './permission.css'

const status = document.getElementById('status')!
const button = document.getElementById('grant') as HTMLButtonElement
// Opened by the background when a session could not start without camera access
const continueSession = new URLSearchParams(location.search).get('then') === 'start'

function show(text: string, kind: 'ok' | 'error') {
  status.textContent = text
  status.className = kind
}

button.addEventListener('click', async () => {
  button.disabled = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    stream.getTracks().forEach(t => t.stop())
    if (continueSession) {
      show('Camera allowed. Starting your session…', 'ok')
      await chrome.runtime.sendMessage({ to: 'background', type: 'permission_granted' } satisfies ToBackground)
    } else {
      show('Camera allowed. You can close this tab.', 'ok')
    }
  } catch (err) {
    button.disabled = false
    const name = err instanceof Error ? err.name : ''
    show(
      name === 'NotAllowedError'
        ? 'Camera access was blocked. Click the camera icon in the address bar to allow it, then try again.'
        : name === 'NotFoundError'
          ? 'No camera was found. Connect a webcam and try again.'
          : `Could not open the camera: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  }
})
