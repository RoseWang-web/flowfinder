/**
 * timerFrames.ts — requestAnimationFrame for a hidden (offscreen) document.
 *
 * Offscreen documents never render, so native rAF never fires and WebGazer's
 * frame loop stops (measured: 0 callbacks/s). Camera frames still arrive, so
 * we drive rAF from a timer instead.
 *
 * Like real rAF, all callbacks requested before a frame run together in that
 * frame, and frames follow a fixed cadence: the next frame is due one interval
 * after the previous one STARTED, so the time WebGazer spends predicting does
 * not lower the frame rate (a plain setTimeout(cb, 33) per call did: ~21/s).
 */
export function createTimerFrames(fps = 30, clock: () => number = () => performance.now()) {
  const interval = 1000 / fps
  let queue = new Map<number, FrameRequestCallback>()
  let nextId = 1
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastFrameAt = -Infinity

  const flush = () => {
    timer = null
    lastFrameAt = clock()
    const callbacks = queue
    queue = new Map()
    callbacks.forEach(cb => {
      try { cb(lastFrameAt) } catch (err) { setTimeout(() => { throw err }) }
    })
  }

  const request = (cb: FrameRequestCallback): number => {
    const id = nextId++
    queue.set(id, cb)
    if (timer === null) {
      const due = Math.max(lastFrameAt + interval, clock())
      timer = setTimeout(flush, Math.max(0, due - clock()))
    }
    return id
  }

  const cancel = (id: number): void => { queue.delete(id) }

  return { request, cancel }
}

/** Replace window.requestAnimationFrame — must run before WebGazer / TF.js are imported. */
export function installTimerFrames(fps = 30): void {
  const f = createTimerFrames(fps)
  window.requestAnimationFrame = f.request
  window.cancelAnimationFrame = f.cancel
}
