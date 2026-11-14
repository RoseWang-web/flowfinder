import { useState } from 'react'
import type { PanelController } from '../controller'

const parse = (v: string): number | null => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}

export function WebAppCompare({ controller }: { controller: PanelController }) {
  const [accuracy, setAccuracy] = useState('')
  const [precision, setPrecision] = useState('')

  const update = (a: string, p: string) => {
    setAccuracy(a)
    setPrecision(p)
    controller.setWebApp(parse(a), parse(p))
  }

  return (
    <div className="compare">
      <label>
        accuracy{' '}
        <input type="number" min="0" step="1" value={accuracy} onChange={e => update(e.target.value, precision)} /> px
      </label>
      <label>
        precision{' '}
        <input type="number" min="0" step="1" value={precision} onChange={e => update(accuracy, e.target.value)} /> px
      </label>
    </div>
  )
}
