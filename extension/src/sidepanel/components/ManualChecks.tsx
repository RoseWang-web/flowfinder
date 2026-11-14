import type { PanelController, PanelState } from '../controller'

export function ManualChecks({ state, controller }: { state: PanelState; controller: PanelController }) {
  return (
    <div className="manual">
      <label>
        <input
          type="checkbox"
          checked={state.manual.zoomAligned}
          onChange={e => controller.setManual({ zoomAligned: e.target.checked })}
        />{' '}
        紅點在網頁縮放 90% / 100% / 125% 都對準我看的地方
      </label>
      <label>
        <input
          type="checkbox"
          checked={state.manual.crossTabAligned}
          onChange={e => controller.setManual({ crossTabAligned: e.target.checked })}
        />{' '}
        換到另一個分頁，紅點仍然對準（不重新校準）
      </label>
    </div>
  )
}
