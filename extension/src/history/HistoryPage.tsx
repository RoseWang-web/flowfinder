/**
 * HistoryPage.tsx — The extension's own history (works without the web app).
 *
 * "History ↗" / "Full review" open the web app's Dashboard when it is running,
 * and this page otherwise. Data: the extension's history store (chrome.storage).
 * Deliberately independent of the web app's Dashboard component, so changes
 * there never break the extension.
 */
import { useEffect, useState } from 'react'
import type { HistoryEntry } from '@core/historyStorage'
import { fmtClock } from '../content/dock/view'
import { exportFileName, toCsv } from '../content/dock/exportFiles'
import { FOCUS_NOTE_TEXT, focusNote } from '../session/focusNote'

export interface HistoryApi {
  load(): Promise<HistoryEntry[]>
  remove(sessionId: string): Promise<void>
  /** Web app origin if its Dashboard is reachable right now, else null */
  webAppUrl(): Promise<string | null>
  open(url: string): void
  download(name: string, body: string, type: string): void
}

const END: Record<string, string> = { manual: 'Finished', time_up: "Time's up", interrupted: 'Interrupted' }

export function focusSeries(entry: HistoryEntry): { t: number; focus: number }[] {
  return entry.session.events
    .filter(e => e.eventType === 'attention_score' && typeof e.data?.trend === 'number')
    .map(e => ({ t: e.elapsedMs, focus: 1 - (e.data!.trend as number) }))
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function HistoryPage({ api }: { api: HistoryApi }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [webApp, setWebApp] = useState<string | null>(null)

  useEffect(() => {
    void api.load().then(e => setEntries([...e].sort((a, b) => b.session.startedAt - a.session.startedAt)))
    void api.webAppUrl().then(setWebApp)
  }, [api])

  const remove = async (id: string) => {
    await api.remove(id)
    setEntries(es => (es ?? []).filter(e => e.session.sessionId !== id))
  }

  return (
    <main className="history">
      <header className="hhead">
        <span className="brand">flowfinder<em>.</em></span>
        <span className="muted">Reading history</span>
      </header>

      <p className="banner">
        {webApp ? (
          <>The FlowFinder web app is running. <button type="button" className="link" onClick={() => api.open(`${webApp}/#dashboard`)}>Open the full Dashboard ↗</button></>
        ) : (
          <>Sessions are also copied into the FlowFinder web app's Dashboard whenever it is open (<code>npm run dev</code>).</>
        )}
      </p>

      {entries === null ? null : entries.length === 0 ? (
        <p className="muted empty">No sessions yet. Start one from the toolbar icon.</p>
      ) : (
        <ul className="sessions">
          {entries.map(e => {
            const s = e.session
            const id = s.sessionId
            const hosts = [...new Set((s.pages ?? []).map(p => p.host))]
            const score = e.analysis.totalScore
            return (
              <li key={id} className={open === id ? 'session open' : 'session'}>
                <button type="button" className="row" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
                  <span className="when">{when(s.startedAt)}</span>
                  <span className="task">{s.taskSettings?.taskTitle || 'Untitled session'}</span>
                  <span className="num" title="Session time">{fmtClock(s.durationMs)}</span>
                  <span className="num focus" title="Focus">{score === null ? '—' : `${score}%`}</span>
                </button>
                {open === id && <Detail entry={e} hosts={hosts} onRemove={() => void remove(id)} api={api} />}
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}

function Detail({ entry, hosts, onRemove, api }: { entry: HistoryEntry; hosts: string[]; onRemove: () => void; api: HistoryApi }) {
  const s = entry.session
  const series = focusSeries(entry)
  return (
    <div className="detail">
      <div className="stats">
        <div><small>READING TIME</small><b>{fmtClock(s.activeReadingMs)}</b></div>
        <div><small>PLANNED</small><b>{s.plannedDurationMs ? fmtClock(s.plannedDurationMs) : '∞'}</b></div>
        <div><small>ENDED</small><b className="small">{END[s.endReason ?? ''] ?? '—'}</b></div>
      </div>
      {hosts.length > 0 && <p className="muted sites">Sites: {hosts.join(', ')}</p>}
      {(() => {
        const note = focusNote(s, entry.analysis.totalScore)
        return note ? <p className="muted small">{FOCUS_NOTE_TEXT[note]}</p> : null
      })()}
      {series.length >= 2 && <FocusChart series={series} durationMs={s.durationMs} />}
      <div className="actions">
        <button type="button" className="link" onClick={() => api.download(exportFileName(entry, 'json'), JSON.stringify(entry, null, 2), 'application/json')}>.json</button>
        <button type="button" className="link" onClick={() => api.download(exportFileName(entry, 'csv'), toCsv(entry), 'text/csv')}>.csv</button>
        <button type="button" className="link danger" onClick={onRemove}>Delete</button>
      </div>
    </div>
  )
}

/** Focus (1 − trend) over the session; the model's score is a ranking, so this shows the shape, not absolutes. */
function FocusChart({ series, durationMs }: { series: { t: number; focus: number }[]; durationMs: number }) {
  const W = 560, H = 90, pad = 4
  const x = (t: number) => pad + (t / Math.max(durationMs, 1)) * (W - 2 * pad)
  const y = (f: number) => H - pad - Math.min(1, Math.max(0, (f - 0.25) / 0.5)) * (H - 2 * pad)
  const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.focus).toFixed(1)}`).join(' ')
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Focus over the session">
        <line x1={pad} x2={W - pad} y1={y(0.5)} y2={y(0.5)} className="mid" />
        <path d={d} className="line" />
      </svg>
      <figcaption className="muted small">Focus over the session (higher = more focused; relative to your usual reading)</figcaption>
    </figure>
  )
}
