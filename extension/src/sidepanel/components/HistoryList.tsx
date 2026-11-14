import type { PanelState } from '../controller'
import { mmss } from './ReadingSession'

const END_REASON: Record<string, string> = { manual: '手動結束', time_up: '時間到', interrupted: '中斷' }

function when(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function HistoryList({ state }: { state: PanelState }) {
  if (state.history.length === 0) return <p className="muted">還沒有紀錄。</p>
  return (
    <ul className="history">
      {state.history.map(h => (
        <li key={h.sessionId} data-session={h.sessionId}>
          <div>
            <b>{when(h.startedAt)}</b>　閱讀 {mmss(h.activeReadingMs)}
            {h.score === null ? <span className="muted">無分數</span> : <>專注度 {h.score}%</>}
            {h.endReason && h.endReason !== 'manual' && <span className="muted">（{END_REASON[h.endReason] ?? h.endReason}）</span>}
          </div>
          {h.hosts.length > 0 && <div className="muted">{h.hosts.join('、')}</div>}
          <div className={h.syncedTo.length ? 'pass' : 'muted'}>
            {h.syncedTo.length ? '✓ 已同步到網頁版' : '尚未同步：打開 FlowFinder 網頁版就會自動同步'}
          </div>
        </li>
      ))}
    </ul>
  )
}
