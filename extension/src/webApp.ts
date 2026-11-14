/**
 * webApp.ts — Is the FlowFinder web app reachable right now?
 *
 * It only exists while `npm run dev` / `npm run preview` runs (no deployed URL
 * yet), so links must not assume it. Checks the allowlisted origins for the
 * app marker; extension pages and the background may fetch them directly
 * (host permissions), so CORS does not apply.
 */
import { FLOWFINDER_APP_META, FLOWFINDER_ORIGINS } from './config'

export async function findWebApp(
  origins: readonly string[] = FLOWFINDER_ORIGINS,
  fetcher: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<string | null> {
  const probe = async (origin: string) => {
    const res = await fetcher(`${origin}/`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(String(res.status))
    const html = await res.text()
    if (!html.includes(`name="${FLOWFINDER_APP_META}"`)) throw new Error('not FlowFinder')
    return origin
  }
  try {
    return await Promise.any(origins.map(probe))
  } catch {
    return null
  }
}
