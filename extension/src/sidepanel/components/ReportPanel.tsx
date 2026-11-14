import { useState } from 'react'
import type { PanelController } from '../controller'

export function ReportPanel({ controller }: { controller: PanelController }) {
  const [text, setText] = useState('')
  const [note, setNote] = useState('')

  const copy = async () => {
    const json = JSON.stringify(controller.buildReport(), null, 2)
    setText(json)
    try {
      await navigator.clipboard.writeText(json)
      setNote('報告已複製')
    } catch {
      setNote('無法自動複製，請手動選取下面的文字')
    }
  }

  return (
    <div className="report">
      <button type="button" onClick={() => void copy()}>複製報告 JSON</button>
      {note && <span className="muted"> {note}</span>}
      {text && <pre>{text}</pre>}
    </div>
  )
}
