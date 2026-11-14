/**
 * coords.ts — Map between a page's client (viewport) coordinates and the
 * shared "screen" space that WebGazer is calibrated in.
 *
 * WebGazer is trained with the click's MouseEvent.screenX/screenY, so its
 * predictions come back in that same space. Each page maps them back with
 *   screen = scale * client + offset        (per axis)
 *
 * We do not assume how Chrome reports screenX under page zoom: the scale is
 * fitted from the calibration clicks (9 points spread over the viewport), and
 * the offset is re-anchored on mouse moves (window moved, side panel resized).
 * The fitted scale is part of the spike report, so the zoom behaviour is
 * measured rather than guessed.
 */

export interface AxisMap { scale: number; offset: number }
export interface ScreenMap { x: AxisMap; y: AxisMap }

export interface MouseLike { screenX: number; screenY: number; clientX: number; clientY: number }

/** Scale 1, offset from a single event (before any calibration). */
export function mapFromEvent(e: MouseLike): ScreenMap {
  return {
    x: { scale: 1, offset: e.screenX - e.clientX },
    y: { scale: 1, offset: e.screenY - e.clientY },
  }
}

/** Keep the scales, move the offsets so this event maps exactly. */
export function reanchor(m: ScreenMap, e: MouseLike): ScreenMap {
  return {
    x: { scale: m.x.scale, offset: e.screenX - m.x.scale * e.clientX },
    y: { scale: m.y.scale, offset: e.screenY - m.y.scale * e.clientY },
  }
}

/** Least-squares line screen = scale * client + offset; null if the clients don't vary. */
export function fitAxis(pairs: readonly { client: number; screen: number }[]): AxisMap | null {
  const n = pairs.length
  if (n < 2) return null
  const mc = pairs.reduce((a, p) => a + p.client, 0) / n
  const ms = pairs.reduce((a, p) => a + p.screen, 0) / n
  let sxx = 0
  let sxy = 0
  for (const p of pairs) {
    sxx += (p.client - mc) ** 2
    sxy += (p.client - mc) * (p.screen - ms)
  }
  if (sxx < 1e-9) return null
  const scale = sxy / sxx
  return { scale, offset: ms - scale * mc }
}

export function fitMap(events: readonly MouseLike[]): ScreenMap | null {
  const x = fitAxis(events.map(e => ({ client: e.clientX, screen: e.screenX })))
  const y = fitAxis(events.map(e => ({ client: e.clientY, screen: e.screenY })))
  return x && y ? { x, y } : null
}

export function toScreen(m: ScreenMap, cx: number, cy: number): { x: number; y: number } {
  return { x: m.x.scale * cx + m.x.offset, y: m.y.scale * cy + m.y.offset }
}

export function toClient(m: ScreenMap, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - m.x.offset) / m.x.scale, y: (sy - m.y.offset) / m.y.scale }
}
