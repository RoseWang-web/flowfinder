import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Session,
  SessionEvent,
  SessionStatus,
  EndReason,
  CheckInAnswer,
  EventType,
  SCHEMA_VERSION,
} from './types'
import { loadSession, saveSession, clearSession, StorageError } from './storage'

export const READING_DURATION_MS = 120_000
export const CHECK_IN_THRESHOLD_MS = 60_000
const ARTICLE_ID = 'reading-article-v1'
const SAVE_INTERVAL_MS = 1_000

function formatTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds)
  const m = Math.floor(clamped / 60)
  const s = clamped % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
export { formatTime }

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeEvent(
  session: Session,
  eventType: SessionEvent['eventType'],
  now: number,
  data?: Record<string, unknown>,
): SessionEvent {
  return {
    id: makeId(),
    sessionId: session.sessionId,
    eventType,
    elapsedMs: now - session.startedAt,
    activeReadingMs: session.activeReadingMs,
    data,
  }
}

export interface SessionUIState {
  status: SessionStatus
  remainingMs: number
  session: Session | null
  storageError: StorageError | null
  checkInPending: boolean
  hasStoredData: boolean
}

export interface SessionActions {
  start: (opts?: { cameraEnabled?: boolean }) => void
  pause: () => void
  resume: () => void
  finish: () => void
  resetToIdle: () => void
  answerCheckIn: (answer: CheckInAnswer) => void
  skipCheckIn: () => void
  deleteData: () => void
  recordEvent: (type: EventType, data?: Record<string, unknown>) => void
  getActiveReadingMs: () => number
  articleRef: React.RefObject<HTMLDivElement | null>
}

export function useSession(): SessionUIState & SessionActions {
  // ── Persistent session in state ──────────────────────────────────────
  const [session, setSession] = useState<Session | null>(null)
  const [storageError, setStorageError] = useState<StorageError | null>(null)
  const [remainingMs, setRemainingMs] = useState(READING_DURATION_MS)
  const [checkInPending, setCheckInPending] = useState(false)
  // True when localStorage holds a completed session (survives resetToIdle)
  const [hasStoredData, setHasStoredData] = useState(false)

  // ── Timing refs ──────────────────────────────────────────────────────
  // Timestamp when current running segment started (null when paused/idle)
  const segmentStartRef = useRef<number | null>(null)
  // Accumulated ms BEFORE current segment
  const accumulatedMsRef = useRef<number>(0)
  // For check-in: accumulated ms when check-in started
  const checkInAccumulatedMsRef = useRef<number>(0)

  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const saveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const completedRef = useRef(false)
  const checkInShownRef = useRef(false)
  // Ref mirror of checkInPending — lets answerCheckIn/skipCheckIn guard without stale closure
  const checkInPendingRef = useRef(false)
  // pending visibility change to show check-in after returning to visible
  const deferredCheckInRef = useRef(false)

  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session

  const articleRef = useRef<HTMLDivElement | null>(null)

  // ── Helpers ──────────────────────────────────────────────────────────

  const clearTick = useCallback(() => {
    if (tickIntervalRef.current !== null) {
      clearInterval(tickIntervalRef.current)
      tickIntervalRef.current = null
    }
  }, [])

  const clearSaveInterval = useCallback(() => {
    if (saveIntervalRef.current !== null) {
      clearInterval(saveIntervalRef.current)
      saveIntervalRef.current = null
    }
  }, [])

  const persistSession = useCallback((s: Session) => {
    const err = saveSession(s)
    if (err) setStorageError(err)
    else setStorageError(null)
  }, [])

  /** Current effective reading ms (snapshot) */
  const getActiveReadingMs = useCallback((): number => {
    if (segmentStartRef.current === null) return accumulatedMsRef.current
    return accumulatedMsRef.current + (Date.now() - segmentStartRef.current)
  }, [])

  const updateSession = useCallback(
    (updater: (prev: Session) => Session, persist = true) => {
      setSession(prev => {
        if (!prev) return prev
        const next = updater(prev)
        sessionRef.current = next
        if (persist) persistSession(next)
        return next
      })
    },
    [persistSession],
  )

  // ── Complete ──────────────────────────────────────────────────────────
  const complete = useCallback(
    (reason: EndReason, activeMs: number, now = Date.now()) => {
      if (completedRef.current) return
      completedRef.current = true
      clearTick()
      clearSaveInterval()
      checkInPendingRef.current = false
      setCheckInPending(false)
      setRemainingMs(0)
      setSession(prev => {
        if (!prev) return prev
        const event = makeEvent(
          { ...prev, activeReadingMs: activeMs },
          'session_end',
          now,
          { reason },
        )
        const next: Session = {
          ...prev,
          status: 'completed',
          activeReadingMs: activeMs,
          durationMs: now - prev.startedAt,
          endedAt: now,
          endReason: reason,
          lastSavedAt: now,
          events: [...prev.events, event],
        }
        sessionRef.current = next
        persistSession(next)
        return next
      })
      setHasStoredData(true)
    },
    [clearTick, clearSaveInterval, persistSession],
  )

  // ── Tick ──────────────────────────────────────────────────────────────
  const startTicking = useCallback(() => {
    clearTick()
    segmentStartRef.current = Date.now()

    tickIntervalRef.current = setInterval(() => {
      if (segmentStartRef.current === null) return
      const activeMs = accumulatedMsRef.current + (Date.now() - segmentStartRef.current)
      const remaining = READING_DURATION_MS - activeMs

      // Check if check-in should be shown
      if (
        !checkInShownRef.current &&
        !deferredCheckInRef.current &&
        activeMs >= CHECK_IN_THRESHOLD_MS &&
        remaining > 0
      ) {
        checkInShownRef.current = true
        // snapshot accumulated ms at the moment check-in fires
        const now = Date.now()
        checkInAccumulatedMsRef.current = accumulatedMsRef.current + (now - (segmentStartRef.current ?? now))
        accumulatedMsRef.current = checkInAccumulatedMsRef.current
        segmentStartRef.current = null
        clearTick()
        clearSaveInterval()

        setSession(prev => {
          if (!prev) return prev
          const checkInRecord = {
            shownAt: now,
            shownElapsedMs: now - prev.startedAt,
            shownActiveReadingMs: checkInAccumulatedMsRef.current,
            answeredAt: null,
            answer: null,
            skipped: false,
          }
          const event = makeEvent(
            { ...prev, activeReadingMs: checkInAccumulatedMsRef.current },
            'check_in_shown',
            now,
          )
          const next: Session = {
            ...prev,
            status: 'checking_in',
            activeReadingMs: checkInAccumulatedMsRef.current,
            checkIn: checkInRecord,
            events: [...prev.events, event],
          }
          sessionRef.current = next
          persistSession(next)
          return next
        })
        checkInPendingRef.current = true
        setCheckInPending(true)
        return
      }

      if (remaining <= 0) {
        complete('time_up', READING_DURATION_MS)
      } else {
        setRemainingMs(remaining)
      }
    }, 250)
  }, [clearTick, clearSaveInterval, complete, persistSession])

  // ── Auto-save interval ────────────────────────────────────────────────
  const startSaveInterval = useCallback(() => {
    clearSaveInterval()
    saveIntervalRef.current = setInterval(() => {
      // Use updater function so we never overwrite status set by other paths
      setSession(prev => {
        if (!prev || prev.status === 'completed' || prev.status === 'checking_in') return prev
        const activeMs = getActiveReadingMs()
        const now = Date.now()
        const updated: Session = {
          ...prev,
          activeReadingMs: activeMs,
          durationMs: now - prev.startedAt,
          lastSavedAt: now,
        }
        sessionRef.current = updated
        persistSession(updated)
        return updated
      })
    }, SAVE_INTERVAL_MS)
  }, [clearSaveInterval, getActiveReadingMs, persistSession])

  // ── Page Visibility ───────────────────────────────────────────────────
  useEffect(() => {
    const handler = () => {
      const s = sessionRef.current
      if (!s || s.status === 'completed' || s.status === 'idle') return
      const visible = document.visibilityState === 'visible'
      const now = Date.now()
      const activeMs = getActiveReadingMs()

      setSession(prev => {
        if (!prev || prev.status === 'completed' || prev.status === 'idle') return prev
        const event = makeEvent(
          { ...prev, activeReadingMs: activeMs },
          'page_visibility',
          now,
          { visible },
        )
        const next = { ...prev, activeReadingMs: activeMs, events: [...prev.events, event] }
        persistSession(next)
        sessionRef.current = next
        return next
      })

      // If returning to visible and check-in was deferred, show it now
      if (visible && deferredCheckInRef.current && s.status === 'running') {
        deferredCheckInRef.current = false
        // Trigger the check-in display
        checkInShownRef.current = true
        const checkInNow = Date.now()
        const currentActiveMs = accumulatedMsRef.current + (segmentStartRef.current !== null ? checkInNow - segmentStartRef.current : 0)
        checkInAccumulatedMsRef.current = currentActiveMs
        accumulatedMsRef.current = currentActiveMs
        segmentStartRef.current = null
        clearTick()
        clearSaveInterval()

        setSession(prev => {
          if (!prev) return prev
          const checkInRecord = {
            shownAt: checkInNow,
            shownElapsedMs: checkInNow - prev.startedAt,
            shownActiveReadingMs: currentActiveMs,
            answeredAt: null,
            answer: null,
            skipped: false,
          }
          const event = makeEvent(
            { ...prev, activeReadingMs: currentActiveMs },
            'check_in_shown',
            checkInNow,
          )
          const next: Session = {
            ...prev,
            status: 'checking_in',
            activeReadingMs: currentActiveMs,
            checkIn: checkInRecord,
            events: [...prev.events, event],
          }
          sessionRef.current = next
          persistSession(next)
          return next
        })
        checkInPendingRef.current = true
        setCheckInPending(true)
      }
    }

    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [clearTick, getActiveReadingMs, persistSession])

  // ── Scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    let lastScrollTime = 0
    const handler = () => {
      const s = sessionRef.current
      if (!s || s.status !== 'running') return
      const now = Date.now()
      if (now - lastScrollTime < 1000) return
      lastScrollTime = now
      const el = articleRef.current
      const scrollY = el ? el.scrollTop : window.scrollY
      const activeMs = getActiveReadingMs()
      setSession(prev => {
        if (!prev || prev.status !== 'running') return prev
        const event = makeEvent(
          { ...prev, activeReadingMs: activeMs },
          'scroll',
          now,
          { scrollY },
        )
        const next = { ...prev, events: [...prev.events, event] }
        sessionRef.current = next
        return next
      })
    }

    const el = articleRef.current
    const target = el ?? window
    target.addEventListener('scroll', handler, { passive: true })
    return () => target.removeEventListener('scroll', handler)
  }, [getActiveReadingMs])

  // ── Load from localStorage on mount ──────────────────────────────────
  useEffect(() => {
    const result = loadSession()
    if ('empty' in result) return
    if (!result.ok) {
      setStorageError(result.error)
      return
    }
    const loaded = result.session
    // Mark incomplete sessions as interrupted
    if (
      loaded.status !== 'completed' &&
      loaded.status !== 'idle'
    ) {
      const now = Date.now()
      // Don't add another interrupted event if one already exists at the end
      const lastEvent = loaded.events[loaded.events.length - 1]
      const alreadyInterrupted = lastEvent?.eventType === 'session_interrupted'
      const events = alreadyInterrupted
        ? loaded.events
        : [
            ...loaded.events,
            {
              id: makeId(),
              sessionId: loaded.sessionId,
              eventType: 'session_interrupted' as const,
              elapsedMs: now - loaded.startedAt,
              activeReadingMs: loaded.activeReadingMs,
              data: { restoredAt: now },
            },
          ]
      const interrupted: Session = {
        ...loaded,
        status: 'completed',
        endReason: 'interrupted',
        endedAt: loaded.lastSavedAt,
        events,
        lastSavedAt: now,
      }
      setSession(interrupted)
      setRemainingMs(READING_DURATION_MS - loaded.activeReadingMs)
      setHasStoredData(true)
      persistSession(interrupted)
    } else {
      setSession(loaded)
      setHasStoredData(true)
      if (loaded.status === 'completed') {
        setRemainingMs(0)
      } else {
        setRemainingMs(READING_DURATION_MS - loaded.activeReadingMs)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      clearTick()
      clearSaveInterval()
    }
  }, [clearTick, clearSaveInterval])

  // ── Actions ───────────────────────────────────────────────────────────

  const start = useCallback((opts?: { cameraEnabled?: boolean }) => {
    // Only allowed from idle with no active session, OR after deleting data
    const s = sessionRef.current
    if (s && s.status !== 'idle') return

    const now = Date.now()
    completedRef.current = false
    checkInShownRef.current = false
    checkInPendingRef.current = false
    deferredCheckInRef.current = false
    accumulatedMsRef.current = 0
    segmentStartRef.current = null

    const newSession: Session = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: makeId(),
      articleId: ARTICLE_ID,
      startedAt: now,
      status: 'running',
      durationMs: 0,
      activeReadingMs: 0,
      lastSavedAt: now,
      endedAt: null,
      endReason: null,
      checkIn: null,
      cameraEnabled: opts?.cameraEnabled === true,
      events: [
        {
          id: makeId(),
          sessionId: '',  // filled below
          eventType: 'session_start',
          elapsedMs: 0,
          activeReadingMs: 0,
          data: { visible: document.visibilityState === 'visible' },
        },
      ],
    }
    // Fix sessionId in the event
    newSession.events[0].sessionId = newSession.sessionId

    sessionRef.current = newSession
    setSession(newSession)
    setRemainingMs(READING_DURATION_MS)
    setCheckInPending(false)
    persistSession(newSession)
    startTicking()
    startSaveInterval()
  }, [persistSession, startTicking, startSaveInterval])

  const pause = useCallback(() => {
    const s = sessionRef.current
    if (!s || s.status !== 'running') return
    clearTick()
    const now = Date.now()
    const segMs = segmentStartRef.current !== null ? now - segmentStartRef.current : 0
    accumulatedMsRef.current += segMs
    segmentStartRef.current = null
    const activeMs = accumulatedMsRef.current

    updateSession(prev => {
      const event = makeEvent({ ...prev, activeReadingMs: activeMs }, 'session_pause', now)
      return {
        ...prev,
        status: 'paused',
        activeReadingMs: activeMs,
        durationMs: now - prev.startedAt,
        events: [...prev.events, event],
      }
    })
  }, [clearTick, updateSession])

  const resume = useCallback(() => {
    const s = sessionRef.current
    if (!s || s.status !== 'paused') return
    const now = Date.now()
    updateSession(prev => {
      const event = makeEvent(prev, 'session_resume', now)
      return { ...prev, status: 'running', events: [...prev.events, event] }
    })
    startTicking()
  }, [updateSession, startTicking])

  const finish = useCallback(() => {
    const s = sessionRef.current
    if (!s || (s.status !== 'running' && s.status !== 'paused')) return
    const activeMs = getActiveReadingMs()
    complete('manual', activeMs)
  }, [getActiveReadingMs, complete])

  const answerCheckIn = useCallback(
    (answer: CheckInAnswer) => {
      if (!checkInPendingRef.current) return
      checkInPendingRef.current = false
      const now = Date.now()
      setCheckInPending(false)
      setSession(prev => {
        if (!prev) return prev
        const event = makeEvent(prev, 'check_in_answered', now, { answer })
        const next: Session = {
          ...prev,
          status: 'running',
          checkIn: prev.checkIn
            ? { ...prev.checkIn, answeredAt: now, answer }
            : prev.checkIn,
          events: [...prev.events, event],
        }
        sessionRef.current = next
        persistSession(next)
        return next
      })
      startTicking()
      startSaveInterval()
    },
    [persistSession, startTicking, startSaveInterval],
  )

  const skipCheckIn = useCallback(() => {
    if (!checkInPendingRef.current) return
    checkInPendingRef.current = false
    const now = Date.now()
    setCheckInPending(false)
    setSession(prev => {
      if (!prev) return prev
      const event = makeEvent(prev, 'check_in_skipped', now)
      const next: Session = {
        ...prev,
        status: 'running',
        checkIn: prev.checkIn ? { ...prev.checkIn, skipped: true } : prev.checkIn,
        events: [...prev.events, event],
      }
      sessionRef.current = next
      persistSession(next)
      return next
    })
    startTicking()
    startSaveInterval()
  }, [persistSession, startTicking, startSaveInterval])

  const resetToIdle = useCallback(() => {
    clearTick()
    clearSaveInterval()
    completedRef.current = false
    checkInShownRef.current = false
    checkInPendingRef.current = false
    deferredCheckInRef.current = false
    accumulatedMsRef.current = 0
    segmentStartRef.current = null
    // Clear React state so UI returns to idle; localStorage is kept so
    // refreshing the page while idle still recovers the previous result.
    sessionRef.current = null
    setSession(null)
    setRemainingMs(READING_DURATION_MS)
    setCheckInPending(false)
  }, [clearTick, clearSaveInterval])

  const recordEvent = useCallback(
    (type: EventType, data?: Record<string, unknown>) => {
      const now = Date.now()
      const activeMs = getActiveReadingMs()
      setSession(prev => {
        if (!prev) return prev
        const event = makeEvent({ ...prev, activeReadingMs: activeMs }, type, now, data)
        const next = { ...prev, events: [...prev.events, event] }
        sessionRef.current = next
        return next
      })
    },
    [getActiveReadingMs],
  )

  const deleteData = useCallback(() => {
    clearTick()
    clearSaveInterval()
    const clearErr = clearSession()
    completedRef.current = false
    checkInShownRef.current = false
    checkInPendingRef.current = false
    deferredCheckInRef.current = false
    accumulatedMsRef.current = 0
    segmentStartRef.current = null
    sessionRef.current = null
    setSession(null)
    setHasStoredData(false)
    setRemainingMs(READING_DURATION_MS)
    setCheckInPending(false)
    // Show error if localStorage delete failed; clear previous errors otherwise
    setStorageError(clearErr ?? null)
  }, [clearTick, clearSaveInterval])

  const status: SessionStatus = session?.status ?? 'idle'

  return {
    status,
    remainingMs,
    session,
    storageError,
    checkInPending,
    hasStoredData,
    start,
    pause,
    resume,
    finish,
    resetToIdle,
    answerCheckIn,
    skipCheckIn,
    deleteData,
    recordEvent,
    getActiveReadingMs,
    articleRef,
  }
}
