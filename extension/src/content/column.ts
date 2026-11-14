/**
 * column.ts — Width of the page's main text column (CSS px).
 *
 * The line-return feature counts leftward jumps longer than half the column
 * width, so the width should match the text the user reads, not the window.
 *   1. <article> / <main> / [role=main] that holds real paragraphs
 *   2. otherwise the element whose direct <p> children hold the most text
 *   3. otherwise min(window width, 700)
 */
const MIN_PARAGRAPH_CHARS = 80

function paragraphText(el: Element): number {
  let n = 0
  for (const p of el.querySelectorAll(':scope > p')) n += p.textContent?.trim().length ?? 0
  return n
}

function width(el: Element): number {
  return Math.round(el.getBoundingClientRect().width)
}

export function detectColumnWidth(doc: Document = document, viewportWidth = window.innerWidth): number {
  for (const sel of ['article', 'main', '[role="main"]']) {
    for (const el of doc.querySelectorAll(sel)) {
      const paras = [...el.querySelectorAll('p')].filter(p => (p.textContent?.trim().length ?? 0) >= MIN_PARAGRAPH_CHARS)
      if (paras.length >= 2) {
        // Use the paragraphs' own width: articles often include wide hero images
        const w = Math.max(...paras.map(width))
        if (w > 0) return w
      }
    }
  }
  let best: Element | null = null
  let bestChars = 0
  for (const p of doc.querySelectorAll('p')) {
    const parent = p.parentElement
    if (!parent) continue
    const chars = paragraphText(parent)
    if (chars > bestChars) { best = parent; bestChars = chars }
  }
  if (best && bestChars >= MIN_PARAGRAPH_CHARS * 2) {
    const w = width(best)
    if (w > 0) return w
  }
  return Math.min(viewportWidth, 700)
}
