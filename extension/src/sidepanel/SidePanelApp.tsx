import type { PanelController } from './controller'
import { usePanelState } from './usePanelState'
import { Controls } from './components/Controls'
import { PreviewSlot } from './components/PreviewSlot'
import { ChecksTable } from './components/ChecksTable'
import { LiveStats } from './components/LiveStats'
import { WebAppCompare } from './components/WebAppCompare'
import { ManualChecks } from './components/ManualChecks'
import { ReportPanel } from './components/ReportPanel'
import { ReadingSession } from './components/ReadingSession'
import { HistoryList } from './components/HistoryList'

export function SidePanelApp({ controller }: { controller: PanelController }) {
  const state = usePanelState(controller)
  return (
    <main className="panel">
      <h1>FlowFinder Gaze — Phase 0</h1>
      <p className="message" role="status">{state.message}</p>
      <PreviewSlot visible={state.previewOn} />
      <Controls state={state} controller={controller} />

      <h2>閱讀</h2>
      <ReadingSession state={state} controller={controller} />

      <h2>最近的紀錄</h2>
      <HistoryList state={state} />

      <h2>檢查項目</h2>
      <ChecksTable state={state} />

      <h2>即時數據</h2>
      <LiveStats state={state} />

      <h2>跟網頁版比較（填入網頁版校準結果）</h2>
      <WebAppCompare controller={controller} />

      <h2>手動確認</h2>
      <ManualChecks state={state} controller={controller} />

      <h2>報告</h2>
      <ReportPanel controller={controller} />
    </main>
  )
}
