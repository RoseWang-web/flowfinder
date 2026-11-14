import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryPage, type HistoryApi } from './HistoryPage'
import { chromeKV, deleteExtensionEntry, loadExtensionHistory } from '../session/historyStore'
import { findWebApp } from '../webApp'
import '../ui/theme.css'
import './history.css'

const api: HistoryApi = {
  load: async () => (await loadExtensionHistory(chromeKV)).entries,
  remove: id => deleteExtensionEntry(chromeKV, id),
  webAppUrl: () => findWebApp(),
  open: url => { void chrome.tabs.create({ url }) },
  download(name, body, type) {
    const url = URL.createObjectURL(new Blob([body], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  },
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HistoryPage api={api} />
  </StrictMode>,
)
