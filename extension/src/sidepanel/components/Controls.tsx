import type { PanelController, PanelState } from '../controller'

export function Controls({ state, controller }: { state: PanelState; controller: PanelController }) {
  const on = state.camera === 'on'
  return (
    <div className="controls">
      <button type="button" onClick={() => controller.openPermissionPage()}>① 授權攝影機</button>
      <button
        type="button"
        className="primary"
        disabled={on || state.camera === 'starting'}
        onClick={() => void controller.start()}
      >
        ② 啟動追蹤
      </button>
      <button
        type="button"
        disabled={!on || state.calibrating || state.reading.status === 'running'}
        onClick={() => void controller.calibrate()}
      >
        ③ 校準＋驗證
      </button>
      <button type="button" disabled={!on} onClick={() => controller.setPreview(!state.previewOn)}>
        {state.previewOn ? '隱藏臉部預覽' : '臉部預覽'}
      </button>
      <button type="button" disabled={!on} onClick={() => controller.setGazeDot(!state.dotOn)}>
        {state.dotOn ? '隱藏紅點' : '顯示紅點'}
      </button>
    </div>
  )
}
