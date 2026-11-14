import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SidePanelController } from './controller'
import { SidePanelApp } from './SidePanelApp'
import './sidepanel.css'

// WebGazer 3.5.3's begin() calls alert() on any page that is not https: or
// localhost — including chrome-extension://, which IS a secure context. A modal
// alert freezes the panel (found in the headless smoke test), so swallow
// exactly that message and keep every other alert.
const nativeAlert = window.alert.bind(window)
window.alert = (message?: unknown) => {
  if (typeof message === 'string' && message.startsWith('WebGazer works only over https')) {
    console.info('[gaze] suppressed WebGazer https warning (extension pages are secure contexts)')
    return
  }
  nativeAlert(message as string)
}

// One controller per panel, created outside React so StrictMode's double
// mount cannot start a second camera.
const controller = new SidePanelController()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SidePanelApp controller={controller} />
  </StrictMode>,
)
