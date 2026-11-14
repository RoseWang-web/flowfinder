/** The five Phase 0 checks, derived from the panel state (pure). */
import { calibrationVerdict, PASS, rateVerdict, type Verdict } from './metrics'
import type { PanelState } from './controller'

export interface CheckItem {
  key: 'camera' | 'network' | 'rate' | 'calibration' | 'alignment'
  label: string
  verdict: Verdict
  detail: string
}

export function fmt(v: number | null | undefined): string {
  return v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(0)
}

type ChecksInput = Pick<PanelState, 'camera' | 'cameraError' | 'externalRequests' | 'faceMeshPath' | 'rates' | 'validation' | 'webApp' | 'manual'>

export function computeChecks(s: ChecksInput): CheckItem[] {
  const page = s.rates.page
  return [
    {
      key: 'camera',
      label: '① 側邊欄可以使用攝影機',
      verdict: s.camera === 'on' ? 'pass' : s.camera === 'error' ? 'fail' : 'pending',
      detail: s.cameraError || s.camera,
    },
    {
      key: 'network',
      label: '② 沒有任何外部網路請求',
      verdict: s.camera !== 'on' ? 'pending' : s.externalRequests.length === 0 ? 'pass' : 'fail',
      detail: s.externalRequests.length ? s.externalRequests.join(', ') : `face_mesh 從 ${s.faceMeshPath} 載入`,
    },
    {
      key: 'rate',
      label: `③ 焦點在網頁時，每秒 ≥ ${PASS.minPageFocusedMedianHz} 筆有效預測`,
      verdict: rateVerdict(page),
      detail: `中位數 ${fmt(page.medianHz)} Hz、P10 ${fmt(page.p10Hz)} Hz，已量 ${page.seconds}/${PASS.minSecondsMeasured} 秒（請點一下網頁後閱讀）`,
    },
    {
      key: 'calibration',
      label: '④ 校準品質跟網頁版差距 ≤ 20%',
      verdict: calibrationVerdict(s.validation, s.webApp),
      detail: s.validation
        ? `擴充功能 ${s.validation.quality}：${fmt(s.validation.accuracyPx)} / ${fmt(s.validation.precisionPx)} px` +
          (s.webApp ? `；網頁版 ${fmt(s.webApp.accuracyPx)} / ${fmt(s.webApp.precisionPx)} px` : '（請在下方填入網頁版數字）')
        : '尚未校準',
    },
    {
      key: 'alignment',
      label: '⑤ 不同縮放、不同分頁都對得準（手動）',
      verdict: s.manual.zoomAligned && s.manual.crossTabAligned ? 'pass' : 'pending',
      detail: '打開紅點，看網頁上的字，確認紅點跟著你的視線',
    },
  ]
}
