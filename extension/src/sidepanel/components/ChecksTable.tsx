import { computeChecks } from '../checks'
import type { PanelState } from '../controller'
import type { Verdict } from '../metrics'

const ICON: Record<Verdict, string> = { pass: '✅', fail: '❌', pending: '⏳' }
const LABEL: Record<Verdict, string> = { pass: '通過', fail: '未通過', pending: '尚未完成' }

export function ChecksTable({ state }: { state: PanelState }) {
  return (
    <table className="checks">
      <tbody>
        {computeChecks(state).map(c => (
          <tr key={c.key} data-check={c.key} data-verdict={c.verdict}>
            <td className={c.verdict} aria-label={LABEL[c.verdict]}>{ICON[c.verdict]}</td>
            <td>
              <b>{c.label}</b>
              <br />
              <span className="muted">{c.detail}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
