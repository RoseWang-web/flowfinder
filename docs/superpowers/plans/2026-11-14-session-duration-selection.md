# Session Duration Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick a session duration (presets 15/30/45 min + custom 1–240 min + unlimited ∞) before starting, replacing the hardcoded 2-minute limit.

**Architecture:** Add `plannedDurationMs?: number` to the `Session` type (optional for backward compat; 0 = unlimited). `StartOptions` gains a `plannedDurationMs` field that flows into the session. The `useSession` tick loop reads `session.plannedDurationMs` instead of the module-level constant; unlimited sessions never auto-complete. A new `DurationPicker` component handles the selection UI. Old stored sessions without this field default to 120,000 ms on load.

**Tech Stack:** React 19, TypeScript, Vitest

**Spec:** N/A (design reference: `flowfinder_v3.html` — duration picker section)

## Global Constraints

- `npm install` must use `--registry https://registry.npmjs.org`
- All commits must pass pre-commit hook (`npm test` — currently 318 tests)
- Do NOT touch: `src/attentionModel.ts`, `src/gaze.ts`, `src/calibration.ts`, `src/sessionAnalysis.ts` — gaze scoring is out of scope for this plan
- English copy for all new user-facing strings (UI is English-only; main users are US-based)
- Duration in `Session`/`StartOptions` is in **milliseconds**; `DurationPicker` works in minutes and converts internally
- The `READING_DURATION_MS` and `CHECK_IN_THRESHOLD_MS` module-level exports in `useSession.ts` must be kept (other code imports them); new dynamic logic runs alongside them
- `0` is the sentinel for unlimited (∞); `plannedDurationMs === 0` means no auto-complete
- Default duration when user picks nothing: **30 minutes** (1,800,000 ms)

## Review Focus

1. **Unlimited mode (plannedDurationMs = 0):** tick loop must never call `complete('time_up', …)` and `remaining` computation must not go negative or trigger a spurious end.
2. **Old sessions without `plannedDurationMs`:** load-from-storage path must not NaN-out the timer or miscompute `remainingMs`.
3. **Check-in threshold for unlimited sessions:** threshold must be a finite positive number so check-in fires; test case: unlimited session at 10+ minutes.
4. **Custom input boundary bypass:** user pressing Enter in the custom field must not submit values outside 1–240.
5. **Unlimited sessions in dashboard average:** sessions with `plannedDurationMs === 0` and `endReason === 'manual'` must be eligible for `isEligibleForAverage` — verify no regression from the existing `'manual'` inclusion.

---

### Task 1: Add `plannedDurationMs` to Session type + storage backward compat

**Files:**
- Modify: `src/types.ts` (Session interface)
- Modify: `src/historyStorage.ts:52-87` (validateEntry function)
- Test: `src/historyStorage.test.ts`

**Interfaces:**
- Produces: `Session.plannedDurationMs?: number` — consumed by Tasks 2 and 4

- [ ] **Step 1: Write three failing tests in `src/historyStorage.test.ts`**

```typescript
// Test 1: old entry without plannedDurationMs defaults to 120_000
it('defaults plannedDurationMs to 120_000 when field is absent from stored data', () => {
  const raw = {
    session: {
      schemaVersion: 2,
      sessionId: 'abc123',
      startedAt: 1_000_000,
      status: 'completed',
      durationMs: 120_000,
      activeReadingMs: 120_000,
      lastSavedAt: 1_120_000,
      endedAt: 1_120_000,
      endReason: 'time_up',
      checkIn: null,
      events: [],
      articleId: 'reading-article-v1',
      // No plannedDurationMs field
    },
    analysis: { status: 'pending', sessionId: 'abc123' },
    entryVersion: 1,
  }
  const entry = validateEntryForTest(raw)
  expect(entry).not.toBeNull()
  expect(entry!.session.plannedDurationMs).toBe(120_000)
})

// Test 2: stored plannedDurationMs is preserved
it('preserves plannedDurationMs when present in stored data', () => {
  const raw = buildRawEntry({ plannedDurationMs: 1_800_000 })
  const entry = validateEntryForTest(raw)
  expect(entry!.session.plannedDurationMs).toBe(1_800_000)
})

// Test 3: unlimited (0) is preserved
it('preserves plannedDurationMs of 0 (unlimited) from stored data', () => {
  const raw = buildRawEntry({ plannedDurationMs: 0 })
  const entry = validateEntryForTest(raw)
  expect(entry!.session.plannedDurationMs).toBe(0)
})
```

Export `validateEntry` as `validateEntryForTest` (or use the existing test export pattern).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/historyStorage.test.ts`
Expected: 3 new tests fail because `plannedDurationMs` does not exist on `Session`.

- [ ] **Step 3: Add `plannedDurationMs?: number` to `Session` in `src/types.ts`**

After line 118 (`taskSettings?: SessionTaskSettings`), add:
```typescript
/** Planned session duration in ms. 0 = unlimited. Absent in old sessions — treat as 120_000. */
plannedDurationMs?: number
```

- [ ] **Step 4: Update `validateEntry` in `src/historyStorage.ts` to populate the field**

In the `validateEntry` function, after building `session = sess as Session`, add:
```typescript
// Backward compat: old sessions don't have plannedDurationMs; default to the original fixed limit
const rawPlanned = s.plannedDurationMs
session = {
  ...session,
  plannedDurationMs:
    typeof rawPlanned === 'number' && isFinite(rawPlanned) && rawPlanned >= 0
      ? rawPlanned
      : 120_000,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/historyStorage.test.ts`
Expected: 3 new tests pass; full suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/historyStorage.ts src/historyStorage.test.ts
git commit -m "feat: add plannedDurationMs to Session type with storage backward compat"
```

---

### Task 2: `useSession` dynamic duration logic

**Files:**
- Modify: `src/useSession.ts`
- Test: `src/useSession.test.ts`

**Interfaces:**
- Consumes: `Session.plannedDurationMs?: number` from Task 1
- Produces:
  - `StartOptions.plannedDurationMs?: number` — consumed by Task 4 (App.tsx)
  - `SessionUIState.plannedDurationMs: number` — consumed by Task 4 (timer display)

- [ ] **Step 1: Export a pure helper and write failing tests**

Add a new exported pure function `getCheckInThreshold(plannedDurationMs: number): number` to `useSession.ts`:

```typescript
/** Returns the ms at which check-in should fire.
 *  Unlimited sessions (0): 10 minutes.
 *  Timed: half the planned duration, minimum 60 s. */
export function getCheckInThreshold(plannedDurationMs: number): number {
  // implementation in Step 3
}
```

Write tests in `src/useSession.test.ts`:
```typescript
import { getCheckInThreshold } from './useSession'

describe('getCheckInThreshold', () => {
  it('returns 600_000 for unlimited sessions (plannedDurationMs = 0)', () => {
    expect(getCheckInThreshold(0)).toBe(600_000)
  })
  it('returns half of planned duration for timed sessions', () => {
    expect(getCheckInThreshold(1_800_000)).toBe(900_000)
  })
  it('returns minimum 60_000 when half would be less than 60 s', () => {
    expect(getCheckInThreshold(60_000)).toBe(60_000)
    expect(getCheckInThreshold(30_000)).toBe(60_000)
  })
  it('returns exact half for 2-minute legacy duration', () => {
    expect(getCheckInThreshold(120_000)).toBe(60_000)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/useSession.test.ts`
Expected: 4 new `getCheckInThreshold` tests fail.

- [ ] **Step 3: Implement `getCheckInThreshold` in `useSession.ts`**

```typescript
export function getCheckInThreshold(plannedDurationMs: number): number {
  if (plannedDurationMs === 0) return 600_000
  return Math.max(plannedDurationMs / 2, 60_000)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/useSession.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Add `plannedDurationMs` to `StartOptions` and `SessionUIState`**

In `StartOptions` (line 48):
```typescript
export interface StartOptions {
  cameraEnabled?: boolean
  gazeEnabled?: boolean
  gaze?: GazeSessionInfo
  taskSettings?: SessionTaskSettings
  /** Duration in ms. 0 = unlimited. Default: 1_800_000 (30 min). */
  plannedDurationMs?: number
}
```

In `SessionUIState` (line 55):
```typescript
export interface SessionUIState {
  status: SessionStatus
  remainingMs: number
  /** 0 = unlimited (∞ mode). Consumers check this to switch between countdown and elapsed display. */
  plannedDurationMs: number
  session: Session | null
  storageError: StorageError | null
  checkInPending: boolean
  hasStoredData: boolean
}
```

- [ ] **Step 6: Update `start()` to accept and store duration**

In `start()` (line 442), read `plannedDurationMs` from opts and default to 1,800,000:
```typescript
const plannedMs = opts?.plannedDurationMs ?? 1_800_000
```

In `newSession` construction, add the field:
```typescript
plannedDurationMs: plannedMs,
```

Replace `setRemainingMs(READING_DURATION_MS)` with:
```typescript
setRemainingMs(plannedMs === 0 ? 0 : plannedMs)
```

- [ ] **Step 7: Update `startTicking()` to use session-aware duration**

At the top of the `setInterval` callback (line 194), replace:
```typescript
const remaining = READING_DURATION_MS - activeMs
```
with:
```typescript
const planned = sessionRef.current?.plannedDurationMs ?? READING_DURATION_MS
const isUnlimited = planned === 0
const checkInAt = getCheckInThreshold(planned)
const remaining = isUnlimited ? Infinity : planned - activeMs
```

Replace the check-in condition (`remaining > 0` guard):
```typescript
if (
  !checkInShownRef.current &&
  !deferredCheckInRef.current &&
  activeMs >= checkInAt &&
  (isUnlimited || remaining > 0)
) {
```

Replace `time_up` trigger:
```typescript
if (!isUnlimited && remaining <= 0) {
  complete('time_up', planned)
} else if (!isUnlimited) {
  setRemainingMs(remaining)
} else {
  setRemainingMs(activeMs)   // unlimited: expose elapsed as remainingMs
}
```

Replace `complete('time_up', READING_DURATION_MS)` → `complete('time_up', planned)`.

- [ ] **Step 8: Update load-from-storage path to use session's planned duration**

In the `useEffect` load handler (lines 417, 426), replace both `READING_DURATION_MS - loaded.activeReadingMs` with:
```typescript
const loadedPlanned = loaded.plannedDurationMs ?? READING_DURATION_MS
// for interrupted:
setRemainingMs(loadedPlanned === 0 ? loaded.activeReadingMs : loadedPlanned - loaded.activeReadingMs)
// for completed:
setRemainingMs(0)
// for in-progress (should not normally occur):
setRemainingMs(loadedPlanned === 0 ? loaded.activeReadingMs : loadedPlanned - loaded.activeReadingMs)
```

Also add `plannedDurationMs` to the hook return value:
```typescript
plannedDurationMs: session?.plannedDurationMs ?? 1_800_000,
```

- [ ] **Step 9: Run full test suite**

Run: `npx vitest run`
Expected: all 318 + 4 new tests pass; no regressions.

- [ ] **Step 10: Commit**

```bash
git add src/useSession.ts src/useSession.test.ts
git commit -m "feat: make session duration dynamic — accept plannedDurationMs, support unlimited mode"
```

---

### Task 3: `DurationPicker` component + input validation

**Files:**
- Create: `src/DurationPicker.tsx`
- Create: `src/DurationPicker.test.ts`

**Interfaces:**
- Produces: `DurationPicker` component with props `{ value: number; onChange: (ms: number) => void }`
- Produces: `validateDurationInput(raw: string): number | string` (exported pure fn, returns validated minutes or Chinese error string)

- [ ] **Step 1: Write failing tests for `validateDurationInput`**

Create `src/DurationPicker.test.ts`:
```typescript
import { validateDurationInput } from './DurationPicker'

describe('validateDurationInput', () => {
  it('rejects empty string', () => {
    expect(validateDurationInput('')).toBe('Please enter a duration')
  })
  it('rejects whitespace only', () => {
    expect(typeof validateDurationInput('   ')).toBe('string')
  })
  it('rejects non-numeric input', () => {
    expect(typeof validateDurationInput('abc')).toBe('string')
  })
  it('rejects decimal values', () => {
    expect(typeof validateDurationInput('1.5')).toBe('string')
  })
  it('rejects 0 (use the unlimited button instead)', () => {
    expect(typeof validateDurationInput('0')).toBe('string')
  })
  it('rejects negative values', () => {
    expect(typeof validateDurationInput('-1')).toBe('string')
  })
  it('rejects values above 240', () => {
    expect(typeof validateDurationInput('241')).toBe('string')
  })
  it('accepts 1 minute and returns 1', () => {
    expect(validateDurationInput('1')).toBe(1)
  })
  it('accepts 30 minutes', () => {
    expect(validateDurationInput('30')).toBe(30)
  })
  it('accepts 240 minutes (maximum)', () => {
    expect(validateDurationInput('240')).toBe(240)
  })
  it('trims whitespace before validating', () => {
    expect(validateDurationInput('  45  ')).toBe(45)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/DurationPicker.test.ts`
Expected: all 11 tests fail (module not found).

- [ ] **Step 3: Implement `validateDurationInput` in `src/DurationPicker.tsx`**

```typescript
export function validateDurationInput(raw: string): number | string {
  const trimmed = raw.trim()
  if (trimmed === '') return 'Please enter a duration'
  const n = Number(trimmed)
  if (!isFinite(n) || isNaN(n)) return 'Please enter a valid number'
  if (!Number.isInteger(n)) return 'Duration must be a whole number of minutes'
  if (n < 1) return 'Duration must be at least 1 minute'
  if (n > 240) return 'Duration cannot exceed 240 minutes'
  return n
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/DurationPicker.test.ts`
Expected: all 11 pass.

- [ ] **Step 5: Implement `DurationPicker` React component**

The component renders:
- A row of preset buttons: `15 min`, `30 min`, `45 min` (selected one highlighted)
- An `∞` unlimited button
- A "Custom" section with a number input (1–240) + "min" label
- Pressing Enter in the custom input or clicking "Set" triggers `onChange` with `minutes * 60_000`
- Pressing the ∞ button calls `onChange(0)`

Signature:
```typescript
interface DurationPickerProps {
  value: number          // current selection in ms (0 = unlimited)
  onChange: (ms: number) => void
}
export function DurationPicker({ value, onChange }: DurationPickerProps): JSX.Element
```

Presets in ms: `[900_000, 1_800_000, 2_700_000]` → "15 分", "30 分", "45 分"

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: all previous tests + 11 new pass.

- [ ] **Step 7: Commit**

```bash
git add src/DurationPicker.tsx src/DurationPicker.test.ts
git commit -m "feat: add DurationPicker component with validateDurationInput (TDD)"
```

---

### Task 4: App.tsx wiring + timer display for unlimited mode

**Files:**
- Modify: `src/App.tsx` (or the setup-screen component file, wherever `start()` is called)
- Modify: relevant session-screen component (wherever `remainingMs` is displayed as MM:SS)

**Interfaces:**
- Consumes: `DurationPicker` from Task 3
- Consumes: `StartOptions.plannedDurationMs` and `SessionUIState.plannedDurationMs` from Task 2

No new pure functions — this task is UI wiring only. No unit tests required; verify manually that:
1. Duration picker renders on the setup screen
2. The selected duration flows into `start()`
3. Limited mode counts down from selected time
4. Unlimited mode shows "已進行 MM:SS" counting up

- [ ] **Step 1: Add `DurationPicker` to the setup screen in `App.tsx`**

Add local state: `const [plannedDurationMs, setPlannedDurationMs] = useState(1_800_000)`

Render `<DurationPicker value={plannedDurationMs} onChange={setPlannedDurationMs} />` on the setup screen, above the start button.

- [ ] **Step 2: Pass `plannedDurationMs` to `start()`**

Change the existing `start(opts)` call to include:
```typescript
start({ ...existingOpts, plannedDurationMs })
```

- [ ] **Step 3: Update the timer display in the session screen**

Where `remainingMs` is formatted and displayed, use `plannedDurationMs` from the hook return to decide display mode:

```tsx
const { remainingMs, plannedDurationMs, ... } = useSession()

// In JSX:
{plannedDurationMs === 0
  ? <span>Elapsed {formatTime(Math.floor(remainingMs / 1000))}</span>
  : <span>{formatTime(Math.floor(remainingMs / 1000))}</span>
}
```

- [ ] **Step 4: Update `SessionDetail` in `Dashboard.tsx` to show planned duration**

In the stats rows section, add a row showing planned duration:
```tsx
<div className="detail-stat-row">
  <span className="detail-stat-label">Planned Duration</span>
  <span className="detail-stat-value">
    {entry.session.plannedDurationMs === 0
      ? '∞ Unlimited'
      : msToHHMM(entry.session.plannedDurationMs ?? 120_000)}
  </span>
</div>
```

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass (this task adds no new unit tests).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/Dashboard.tsx  # and any other touched files
git commit -m "feat: wire DurationPicker into setup screen, update timer display for unlimited mode"
```

---

## Implementation summary

| Task | Key change | Test count added |
|------|-----------|-----------------|
| 1 | `Session.plannedDurationMs` + storage backward compat | 3 |
| 2 | `useSession` dynamic duration + `getCheckInThreshold` | 4 |
| 3 | `DurationPicker` + `validateDurationInput` | 11 |
| 4 | App.tsx wiring + timer display | 0 (UI only) |
| **Total** | | **+18** |
