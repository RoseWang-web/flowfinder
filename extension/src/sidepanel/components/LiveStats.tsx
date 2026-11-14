import type { PanelState } from '../controller'

function focusText(bucket: PanelState['lastSecond']['bucket']): string {
  if (bucket === 'page') return '網頁 ✔（這才是要量的情況）'
  if (bucket === 'panel') return '側邊欄（點一下網頁）'
  if (bucket === 'other') return '其他視窗'
  return '—'
}

export function LiveStats({ state }: { state: PanelState }) {
  const p = state.pageInfo
  const rows: [string, string][] = [
    ['目前焦點', state.camera === 'on' ? focusText(state.lastSecond.bucket) : '—'],
    ['上一秒', `${state.lastSecond.valid} 有效 / ${state.lastSecond.total} 筆`],
    ['模型狀態', state.model ? `${state.model.status}，缺失 ${(state.model.missingRatio * 100).toFixed(0)}%` : '—'],
    ['分頁', p ? `${p.host}（${p.innerWidth}×${p.innerHeight}）` : '未連線'],
    ['縮放', state.zoom === null ? '—' : `${Math.round(state.zoom * 100)}%`],
    ['座標對應', p?.map ? `${p.mapSource}，scale ${p.map.x.scale.toFixed(3)}` : '—'],
  ]
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div key={k} className="kv-row">
          <dt className="muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
