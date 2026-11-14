import { canStartReading, type PanelController, type PanelState } from '../controller'
import type { InactiveReason } from '../../session/recorder'

export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const INACTIVE: Record<InactiveReason, string> = {
  tab_hidden: '分頁不在前景',
  page_blur: '網頁沒有焦點（點一下網頁）',
  not_connected: '沒有連上網頁',
  no_page: '沒有正在閱讀的網頁',
  paused: '已暫停',
}

function startHint(s: PanelState): string {
  if (s.camera !== 'on') return '先啟動追蹤'
  if (s.calibrating) return '校準中…'
  if (!s.validation) return '先完成校準＋驗證'
  if (s.validation.quality === 'poor') return '校準品質太差，請重新校準'
  return ''
}

export function ReadingSession({ state, controller }: { state: PanelState; controller: PanelController }) {
  const r = state.reading

  if (r.status === 'idle') {
    const hint = startHint(state)
    return (
      <div className="reading">
        <button type="button" className="primary" disabled={!canStartReading(state)} onClick={() => void controller.startReading()}>
          開始閱讀
        </button>
        {hint && <span className="muted"> {hint}</span>}
      </div>
    )
  }

  return (
    <div className="reading running">
      <dl className="kv">
        <div className="kv-row"><dt className="muted">狀態</dt><dd>{r.active ? '閱讀中 ●' : `暫停：${r.inactiveReason ? INACTIVE[r.inactiveReason] : ''}`}</dd></div>
        <div className="kv-row"><dt className="muted">閱讀計時</dt><dd>{mmss(r.activeMs)}</dd></div>
        <div className="kv-row"><dt className="muted">本次經過</dt><dd>{mmss(r.elapsedMs)}</dd></div>
        <div className="kv-row">
          <dt className="muted">專注度</dt>
          <dd>{r.focusPercent === null ? '暖機中（前 20 秒不評分）' : `${r.focusPercent}%（${r.scoredWindows} 個視窗）`}</dd>
        </div>
      </dl>
      <button type="button" onClick={() => void controller.endReading()}>結束閱讀並儲存</button>
    </div>
  )
}
