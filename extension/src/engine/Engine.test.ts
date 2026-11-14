import { describe, it, expect, vi } from 'vitest'
import { Engine, PAGE_STALE_MS } from './Engine'
import { createMockTracker } from '@core/gazeTestUtils'
import { memoryKV, loadExtensionHistory, CURRENT_KEY } from '../session/historyStore'
import { DEFAULT_SETUP, type EngineState, type PageState, type SessionSetup } from '../protocol'

const PAGE: PageState = { host: 'en.wikipedia.org', visible: true, hasFocus: true, columnWidthPx: 700 }

function setup(opts: { failBegin?: Error } = {}) {
  let now = 1_000_000
  let perf = 0
  const mock = createMockTracker(opts)
  const kv = memoryKV()
  const states: EngineState[] = []
  const baseline = { load: vi.fn(() => null), save: vi.fn() }
  const engine = new Engine({
    tracker: mock.tracker, kv, publish: s => states.push(s),
    now: () => now, perfNow: () => perf, modelCvRocAuc: 0.637, baseline,
  })
  const last = () => states[states.length - 1]
  let lastPage: { page: PageState; tabId: number } | null = null
  let heartbeat = true
  let seed = 7
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  let elapsedS = 0
  /** Advance both clocks; emit 30 Hz samples (with or without a face) and run tick/step. */
  const run = (seconds: number, face = true, x = (t: number) => 100 + ((t / 10) % 600), noisePx: (s: number) => number = () => 0) => {
    for (let s = 0; s < seconds; s++, elapsedS++) {
      const sd = noisePx(elapsedS)
      for (let k = 0; k < 30; k++) {
        perf += 1000 / 30
        mock.emit({ t: perf, x: face ? x(perf) + gauss() * sd : null, y: face ? 300 + gauss() * sd : null })
      }
      now += 1000
      // keep the page report fresh, as the content script's heartbeat does
      if (heartbeat && lastPage) void engine.handle({ to: 'engine', type: 'page_state', page: lastPage.page }, lastPage.tabId)
      engine.tick()
      if (s % 2 === 1) engine.step()
    }
  }
  const page = (p: Partial<PageState> = {}, tabId = 1) => {
    lastPage = { page: { ...PAGE, ...p }, tabId }
    return engine.handle({ to: 'engine', type: 'page_state', page: lastPage.page }, tabId)
  }
  const msg = (m: object) => engine.handle({ to: 'engine', ...m } as never)
  return { engine, mock, kv, states, last, run, page, msg, baseline, stopHeartbeat: () => { heartbeat = false } }
}

const GOOD_VALIDATION = async (h: ReturnType<typeof setup>) => {
  // Calibration: all validation samples sit exactly on the targets → good quality
  await h.msg({ type: 'calib_reset' })
  for (let i = 0; i < 5; i++) {
    await h.msg({ type: 'validation_point', index: i, screenX: 100 + i * 50, screenY: 300 })
    h.run(3, true, () => 100 + i * 50)
  }
  return h.msg({ type: 'validation_finish', viewport: { width: 1280, height: 800 } })
}

const NO_GAZE: SessionSetup = { ...DEFAULT_SETUP, task: 'Chapter 4', screenAttention: false }

describe('Engine — start', () => {
  it('Screen attention on: camera → calibrating', async () => {
    const h = setup()
    const r = await h.msg({ type: 'start', setup: { ...DEFAULT_SETUP, task: '  Biology  ' } })
    expect(r).toEqual({ phase: 'calibrating', message: '' })
    expect(h.mock.tracker.begin).toHaveBeenCalled()
    expect(h.mock.tracker.clearCalibration).toHaveBeenCalled()
    expect(h.last().setup?.task).toBe('Biology')
  })

  it('camera permission denied → needs_permission, can start again', async () => {
    const h = setup({ failBegin: Object.assign(new Error('x'), { name: 'NotAllowedError' }) })
    expect((await h.msg({ type: 'start', setup: DEFAULT_SETUP }) as { phase: string }).phase).toBe('needs_permission')
    expect(h.engine.getState().phase).toBe('needs_permission')
  })

  it('no camera needed when Stay in frame and Screen attention are both off', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: { ...NO_GAZE, stayInFrame: false } })
    expect(h.mock.tracker.begin).not.toHaveBeenCalled()
    expect(h.last().phase).toBe('running')
    expect(h.last().face).toBe('off')
  })

  it('begin_reading is refused until calibration is good enough', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: DEFAULT_SETUP })
    expect((await h.msg({ type: 'begin_reading' }) as { phase: string }).phase).toBe('calibrating')
    const summary = await GOOD_VALIDATION(h) as { quality: string }
    expect(summary.quality).toBe('good')
    expect((await h.msg({ type: 'begin_reading' }) as { phase: string }).phase).toBe('running')
  })

  it('calibration clicks reach the tracker only while calibrating', async () => {
    const h = setup()
    await h.msg({ type: 'calib_click', screenX: 1, screenY: 2 })
    expect(h.mock.tracker.recordCalibrationPoint).not.toHaveBeenCalled()
    await h.msg({ type: 'start', setup: DEFAULT_SETUP })
    await h.msg({ type: 'calib_click', screenX: 1, screenY: 2 })
    expect(h.mock.tracker.recordCalibrationPoint).toHaveBeenCalledWith(1, 2)
  })
})

describe('Engine — timer and reading', () => {
  it('counts down, pauses, and raises the time-up card', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: { ...NO_GAZE, durationMin: 1 } })
    await h.page()
    h.run(20)
    expect(h.last().elapsedMs).toBe(20_000)
    await h.msg({ type: 'pause' })
    h.run(10) // paused: timer frozen
    expect(h.last()).toMatchObject({ elapsedMs: 20_000, paused: true, reading: false, inactiveReason: 'paused' })
    await h.msg({ type: 'resume' })
    h.run(40)
    expect(h.last()).toMatchObject({ elapsedMs: 60_000, timeUp: true, timeUpPending: true })
    await h.msg({ type: 'keep_going' })
    h.run(5)
    expect(h.last()).toMatchObject({ elapsedMs: 65_000, timeUp: true, timeUpPending: false })
  })

  it('reading only counts while a page is visible and focused (Tab activity on)', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: NO_GAZE })
    h.run(1)
    expect(h.last()).toMatchObject({ reading: false, inactiveReason: 'no_page' })
    await h.page()
    h.run(1)
    expect(h.last().reading).toBe(true)
    await h.page({ hasFocus: false })
    h.run(1)
    expect(h.last()).toMatchObject({ reading: false, inactiveReason: 'page_blur' })
    await h.page({ visible: false, hasFocus: false })
    h.run(1)
    expect(h.last().inactiveReason).toBe('tab_hidden')
  })

  it('a page that stops reporting goes stale', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: NO_GAZE })
    await h.page()
    h.run(1)
    expect(h.last().reading).toBe(true)
    h.stopHeartbeat() // the tab was closed / the content script went away
    h.run(Math.ceil(PAGE_STALE_MS / 1000) + 1)
    expect(h.last().reading).toBe(false)
  })

  it('Tab activity off: always counting unless paused', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: { ...NO_GAZE, tabActivity: false } })
    h.run(1)
    expect(h.last().reading).toBe(true)
  })

  it('face status follows the share of samples with a prediction', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: NO_GAZE })
    h.run(1, true)
    expect(h.last().face).toBe('ok')
    expect(await h.msg({ type: 'face_status' })).toEqual({ face: 'ok', validRatio: 1, samplesPerSecond: 30 })
    h.run(1, false)
    expect(h.last().face).toBe('none')
  })
})

describe('Engine — finishing', () => {
  it('saves a web-app history entry with task, sites, pauses and face events', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: { ...NO_GAZE, durationMin: 0 } })
    await h.page()
    h.run(5)
    await h.page({ host: 'medium.com' }, 2)
    h.run(3, false) // face left the frame
    h.run(2, true)
    await h.msg({ type: 'pause' })
    await h.msg({ type: 'resume' })
    h.run(2)
    await h.msg({ type: 'finish' })

    expect(h.mock.tracker.end).toHaveBeenCalled()
    const s = h.last()
    expect(s.phase).toBe('finished')
    expect(s.summary).toMatchObject({ task: 'Chapter 4', sessionMs: 12_000, endReason: 'manual', focusPercent: null })

    const hist = await loadExtensionHistory(h.kv)
    const sess = hist.entries[0].session
    expect(sess).toMatchObject({ source: 'extension', gazeEnabled: false, endReason: 'manual', plannedDurationMs: 0 })
    expect(sess.taskSettings?.taskTitle).toBe('Chapter 4')
    expect(sess.pages?.map(p => p.host)).toEqual(['en.wikipedia.org', 'medium.com'])
    const types = sess.events.map(e => e.eventType)
    expect(types).toContain('session_pause')
    expect(types).toContain('session_resume')
    expect(sess.events.filter(e => e.eventType === 'face_detection_changed').map(e => e.data)).toEqual([{ detected: false }, { detected: true }])
    expect(h.kv.data[CURRENT_KEY]).toBeUndefined()
    expect(await h.msg({ type: 'get_export' })).toMatchObject({ session: { sessionId: sess.sessionId } })
  })

  it('finishing after time is up records endReason time_up and the planned length', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: { ...NO_GAZE, durationMin: 1 } })
    await h.page()
    h.run(61)
    await h.msg({ type: 'finish' })
    expect(h.last().summary?.endReason).toBe('time_up')
    expect((await loadExtensionHistory(h.kv)).entries[0].session.plannedDurationMs).toBe(60_000)
  })

  it('gaze session: attention scores, focus %, baseline saved', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: { ...DEFAULT_SETUP, task: 'Read' } })
    await GOOD_VALIDATION(h)
    await h.msg({ type: 'begin_reading' })
    await h.page()
    h.run(40) // past the 10-window warm-up
    expect(h.last().focusPercent).not.toBeNull()
    await h.msg({ type: 'finish' })
    const entry = (await loadExtensionHistory(h.kv)).entries[0]
    expect(entry.session.gazeEnabled).toBe(true)
    expect(entry.session.gaze?.modelCvRocAuc).toBe(0.637)
    expect(entry.session.events.filter(e => e.eventType === 'attention_score').length).toBeGreaterThan(10)
    expect(entry.analysis.status).toBe('ready')
    expect(h.last().summary?.focusPercent).toBe(entry.analysis.totalScore)
    expect(h.baseline.save).toHaveBeenCalled()
  })

  it('dismiss returns to idle; a new session can start', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: NO_GAZE })
    await h.msg({ type: 'finish' })
    await h.msg({ type: 'dismiss' })
    expect(h.last().phase).toBe('idle')
    expect((await h.msg({ type: 'start', setup: NO_GAZE }) as { phase: string }).phase).toBe('running')
  })

  it('init() stores a session left running as interrupted', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: NO_GAZE })
    await h.page()
    h.run(12) // persisted at least once
    expect(h.kv.data[CURRENT_KEY]).toBeDefined()
    // a new engine (offscreen document recreated) on the same storage
    const h2 = setup()
    Object.assign(h2.kv.data, h.kv.data)
    await h2.engine.init()
    const entry = (await loadExtensionHistory(h2.kv)).entries[0]
    expect(entry.session.endReason).toBe('interrupted')
  })

  it('cancel during calibration releases the camera', async () => {
    const h = setup()
    await h.msg({ type: 'start', setup: DEFAULT_SETUP })
    await h.msg({ type: 'cancel' })
    expect(h.mock.tracker.end).toHaveBeenCalled()
    expect(h.last().phase).toBe('idle')
  })
})

describe('Engine — quality guard (noise must not read as focus)', () => {
  // Steady reading: left → right over 3 s, then back, for the whole session
  const reading = (t: number) => 30 + ((t % 3000) / 3000) * 600

  async function gazeSession(h: ReturnType<typeof setup>) {
    await h.msg({ type: 'start', setup: { ...DEFAULT_SETUP, task: 'Read' } })
    await GOOD_VALIDATION(h)
    await h.msg({ type: 'begin_reading' })
    await h.page()
  }
  const windows = async (h: ReturnType<typeof setup>) => {
    await h.msg({ type: 'finish' })
    return (await loadExtensionHistory(h.kv)).entries[0].session.events.filter(e => e.eventType === 'attention_score')
  }

  it('constant noise: nothing is rejected', async () => {
    const h = setup()
    await gazeSession(h)
    h.run(300, true, reading, () => 40)
    expect(h.last().trackingDegraded).toBe(false)
    const w = await windows(h)
    expect(w.filter(e => e.data?.reason === 'noisy')).toHaveLength(0)
    expect(w.filter(e => typeof e.data?.jitterPx === 'number').length).toBeGreaterThan(100)
  })

  it('growing noise: noisy windows are not scored, focus is not inflated, recalibration is offered', async () => {
    const h = setup()
    await gazeSession(h)
    h.run(120, true, reading, () => 40)                // 2 min steady, guard learns ~40 px
    const before = h.last().focusPercent
    h.run(300, true, reading, s => 40 + (s - 120) * 0.4) // noise climbs to ~160 px
    const st = h.last()
    expect(st.trackingDegraded).toBe(true)
    expect(st.focusPercent).not.toBeNull()
    expect(st.focusPercent! - before!).toBeLessThanOrEqual(3)   // was +12 points without the guard
    const w = await windows(h)
    const noisy = w.filter(e => e.data?.reason === 'noisy')
    expect(noisy.length).toBeGreaterThan(50)
    expect(noisy.every(e => e.data?.status === 'low_quality' && e.data?.trend === undefined)).toBe(true)
  })

  it('recalibration pauses, accepts calibration clicks, and resumes with a fresh noise level', async () => {
    const h = setup()
    await gazeSession(h)
    h.run(60, true, reading, () => 40)
    h.run(120, true, reading, () => 90) // 2.25× the post-calibration level
    expect(h.last().trackingDegraded).toBe(true)

    expect(await h.msg({ type: 'recalibrate' })).toEqual({ phase: 'calibrating', message: '' })
    expect(h.last()).toMatchObject({ recalibrating: true, paused: true, reading: false })
    await h.msg({ type: 'calib_click', screenX: 5, screenY: 6 })
    expect(h.mock.tracker.recordCalibrationPoint).toHaveBeenLastCalledWith(5, 6)
    await GOOD_VALIDATION(h)
    expect(await h.msg({ type: 'begin_reading' })).toEqual({ phase: 'running', message: '' })
    expect(h.last()).toMatchObject({ recalibrating: false, paused: false, trackingDegraded: false, phase: 'running' })

    h.run(60, true, reading, () => 90) // recalibrated at this level: it is the new normal
    expect(h.last().trackingDegraded).toBe(false)
  })

  it('cancelling a recalibration resumes the session', async () => {
    const h = setup()
    await gazeSession(h)
    h.run(30, true, reading, () => 40)
    await h.msg({ type: 'recalibrate' })
    await h.msg({ type: 'cancel' })
    expect(h.last()).toMatchObject({ recalibrating: false, paused: false, phase: 'running' })
  })
})
