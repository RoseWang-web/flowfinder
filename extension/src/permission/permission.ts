import type { ToBackground } from '../protocol'

const status = document.getElementById('status')!
// Opened by the background when a session could not start without camera access
const continueSession = new URLSearchParams(location.search).get('then') === 'start'

document.getElementById('grant')!.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    stream.getTracks().forEach(t => t.stop())
    if (continueSession) {
      status.textContent = '✅ Camera allowed. Starting your session…'
      await chrome.runtime.sendMessage({ to: 'background', type: 'permission_granted' } satisfies ToBackground)
    } else {
      status.textContent = '✅ 已允許。可以關掉這個分頁。'
    }
  } catch (err) {
    status.textContent = '❌ 沒有取得權限：' + (err instanceof Error ? `${err.name} ${err.message}` : String(err))
  }
})
