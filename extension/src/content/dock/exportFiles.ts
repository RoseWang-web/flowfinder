/** Session downloads from the summary card: .json (the full history entry) and .csv (one row per event). */
import type { HistoryEntry } from '@core/historyStorage'

const CSV_COLUMNS = ['elapsed_s', 'reading_s', 'event', 'status', 'focus_percent', 'line_returns', 'x_progress', 'missing_ratio', 'detail'] as const

function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(entry: HistoryEntry): string {
  const rows = entry.session.events.map(e => {
    const d = (e.data ?? {}) as Record<string, unknown>
    const isScore = e.eventType === 'attention_score'
    const focus = isScore && typeof d.trend === 'number' ? Math.round((1 - d.trend) * 1000) / 10 : null
    const detail = isScore ? '' : Object.keys(d).length ? JSON.stringify(d) : ''
    return [
      Math.round(e.elapsedMs / 100) / 10,
      Math.round(e.activeReadingMs / 100) / 10,
      e.eventType,
      isScore ? d.status : '',
      focus,
      isScore ? d.nLineReturns : '',
      isScore ? d.xProgress : '',
      isScore ? d.missingRatio : '',
      detail,
    ].map(cell).join(',')
  })
  return [CSV_COLUMNS.join(','), ...rows].join('\n') + '\n'
}

export function exportFileName(entry: HistoryEntry, ext: 'json' | 'csv'): string {
  const d = new Date(entry.session.startedAt)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `flowfinder-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.${ext}`
}
