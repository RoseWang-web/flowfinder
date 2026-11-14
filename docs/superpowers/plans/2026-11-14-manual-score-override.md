# Manual Score Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users manually override a session's focus score in Dashboard, see the change reflected immediately in all views, and restore the system-computed score at any time.

**Architecture:** Add a `ManualOverride` optional field to `HistoryEntry`; derive a single `getEffectiveScore()` function that all score displays and aggregations call; add `updateManualOverride` / `clearManualOverride` to storage; wire an inline edit form into `SessionDetail`; keep system `analysis` data untouched.

**Tech Stack:** TypeScript, React 19, Vite, Vitest, localStorage.

**Spec:** This file — plus the user's prompt captured in the session context.

## Global Constraints

- 0 is a valid score; never use truthy checks on score values.
- `analysis` and `analysis.totalScore` must never be mutated by override operations.
- Eligibility for weighted average: endReason `time_up | manual`, activeReadingMs > 0, valid effective score (removes the old `analysis.status === 'ready'` gate for entries that have a valid manual override).
- Demo mode: "示範資料不可修改" — no write operations touch real history.
- Score integers only (0–100); reject decimals, negatives, >100, empty, NaN, Infinity.
- Optional reason: max 300 characters.
- `upsertHistoryEntry` must preserve an existing `manualOverride` when re-saving a session (spec §5: "新系統分析結果不覆蓋手動修改").
- Commit after every task passes tests.
- Do NOT commit or push on behalf of the user.

## Review Focus

1. **score = 0 manual override** — `getEffectiveScore` returns 0, not null; eligible for average.
2. **invalid manualOverride in localStorage** — `validateEntry` silently drops bad override fields; entry still loads; effective score falls back to system score.
3. **upsert preserves override** — when `App.tsx` re-saves a completed session (analysis update), existing `manualOverride` is NOT clobbered.
4. **save failure** — `updateManualOverride` returns a `HistoryStorageError`; Dashboard keeps edit form open and shows the error; visible score doesn't change.
5. **demo isolation** — clicking "修改評分" in demo mode shows "示範資料不可修改"; no write path is called.

---

## Task 1 — Data model: ManualOverride type + storage operations

### Files
- Modify: `src/analysisTypes.ts`
- Modify: `src/historyStorage.ts`
- Modify: `src/historyStorage.test.ts`

### Interfaces
- Produces:
  - `ManualOverride { score: number; reason?: string; overriddenAt: number }` (in `analysisTypes.ts`)
  - `HistoryEntry.manualOverride?: ManualOverride`
  - `updateManualOverride(sessionId: string, override: ManualOverride): HistoryStorageError | null`
  - `clearManualOverride(sessionId: string): HistoryStorageError | null`
  - Behaviour: `upsertHistoryEntry` preserves existing `manualOverride`

---

- [ ] **Step 1: Write failing tests** in `src/historyStorage.test.ts`

```typescript
// import updateManualOverride, clearManualOverride from './historyStorage'

describe('updateManualOverride', () => {
  it('saves override score and preserves analysis and session', () => {
    upsertHistoryEntry(makeEntry('s1', 70))
    const err = updateManualOverride('s1', { score: 85, overriddenAt: 1000 })
    expect(err).toBeNull()
    const result = loadHistory()
    assert(result.ok)
    const e = result.data.entries.find(e => e.session.sessionId === 's1')!
    expect(e.manualOverride?.score).toBe(85)
    expect(e.analysis.totalScore).toBe(70)  // untouched
  })

  it('no-ops silently for unknown sessionId', () => {
    const err = updateManualOverride('missing', { score: 50, overriddenAt: 1000 })
    expect(err).toBeNull()
  })

  it('returns write error when localStorage.setItem throws', () => {
    upsertHistoryEntry(makeEntry('s1', 70))
    vi.spyOn(localStorageMock, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    const err = updateManualOverride('s1', { score: 85, overriddenAt: 1000 })
    expect(err).not.toBeNull()
    expect(err!.kind).toBe('write_error')
  })
})

describe('clearManualOverride', () => {
  it('removes override, leaves analysis intact', () => {
    upsertHistoryEntry(makeEntry('s1', 70))
    updateManualOverride('s1', { score: 90, overriddenAt: 1000 })
    clearManualOverride('s1')
    const result = loadHistory()
    assert(result.ok)
    const e = result.data.entries.find(e => e.session.sessionId === 's1')!
    expect(e.manualOverride).toBeUndefined()
    expect(e.analysis.totalScore).toBe(70)
  })
})

describe('upsertHistoryEntry preserves manualOverride', () => {
  it('re-upserting a session does not wipe an existing override', () => {
    upsertHistoryEntry(makeEntry('s1', 70))
    updateManualOverride('s1', { score: 90, overriddenAt: 1000 })
    // simulate analysis update arriving
    upsertHistoryEntry(makeEntry('s1', 80))
    const result = loadHistory()
    assert(result.ok)
    const e = result.data.entries.find(e => e.session.sessionId === 's1')!
    expect(e.manualOverride?.score).toBe(90)   // preserved
    expect(e.analysis.totalScore).toBe(80)      // updated
  })
})

describe('validateEntry with manualOverride', () => {
  it('parses valid manualOverride from raw JSON', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      entries: [rawEntryWith({ manualOverride: { score: 55, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    assert(result.ok)
    expect(result.data.entries[0].manualOverride?.score).toBe(55)
  })

  it('ignores manualOverride with invalid score (e.g. 150)', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      entries: [rawEntryWith({ manualOverride: { score: 150, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    assert(result.ok)
    expect(result.data.entries[0].manualOverride).toBeUndefined()
  })

  it('ignores non-integer manualOverride score', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      entries: [rawEntryWith({ manualOverride: { score: 75.5, overriddenAt: 999 } })],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    assert(result.ok)
    expect(result.data.entries[0].manualOverride).toBeUndefined()
  })

  it('backward-compat: entry without manualOverride field loads fine', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      entries: [rawEntryWith({})],
      deletedIds: [],
    })
    localStorageMock.setItem('flowfinder_history_v1', raw)
    const result = loadHistory()
    assert(result.ok)
    expect(result.data.entries[0].manualOverride).toBeUndefined()
  })
})
```

Where `rawEntryWith(extra)` builds a minimal valid raw entry object merged with `extra`, and `makeEntry(id, score)` returns a full `HistoryEntry`.

- [ ] **Step 2: Run failing tests**

```
npm test -- --run src/historyStorage.test.ts
```
Expected: FAIL — `updateManualOverride`, `clearManualOverride` not defined.

- [ ] **Step 3: Add `ManualOverride` to `src/analysisTypes.ts`**

```typescript
export interface ManualOverride {
  score: number        // 0–100 integer
  reason?: string      // optional, ≤ 300 chars
  overriddenAt: number // Unix ms
}
```

- [ ] **Step 4: Extend `HistoryEntry` in `src/historyStorage.ts`**

```typescript
export interface HistoryEntry {
  session: Session
  analysis: AnalysisResult
  entryVersion: 1
  manualOverride?: ManualOverride
}
```

- [ ] **Step 5: Update `validateEntry` in `src/historyStorage.ts`**

After building `session` and `analysis`, parse `obj.manualOverride`:
- Treat it as valid only when it is an object with `score` that is a finite integer in [0, 100] and `overriddenAt` is a number.
- Otherwise set `manualOverride` to `undefined`.
- Return `{ session, analysis, entryVersion: 1, manualOverride }`.

- [ ] **Step 6: Update `upsertHistoryEntry` in `src/historyStorage.ts`**

When an entry with the same `sessionId` already exists, preserve its `manualOverride`:
```typescript
if (idx >= 0) {
  data.entries[idx] = { ...entry, manualOverride: data.entries[idx].manualOverride }
} else {
  data.entries.push(entry)
}
```

- [ ] **Step 7: Add `updateManualOverride` and `clearManualOverride` to `src/historyStorage.ts`**

```typescript
export function updateManualOverride(
  sessionId: string,
  override: ManualOverride,
): HistoryStorageError | null

export function clearManualOverride(sessionId: string): HistoryStorageError | null
```

Both load, mutate entries array, write back. Unknown sessionId is a no-op returning null.
`clearManualOverride` removes the `manualOverride` key using destructuring or `delete`.

- [ ] **Step 8: Run tests — expect pass**

```
npm test -- --run src/historyStorage.test.ts
```

- [ ] **Step 9: Commit**

```
git add src/analysisTypes.ts src/historyStorage.ts src/historyStorage.test.ts
git commit -m "feat: add ManualOverride type and storage operations"
```

---

## Task 2 — Score resolution: getEffectiveScore + updated eligibility

### Files
- Modify: `src/dashboardStats.ts`
- Modify: `src/dashboardStats.test.ts`

### Interfaces
- Consumes: `ManualOverride`, `HistoryEntry.manualOverride` (from Task 1)
- Produces:
  - `getEffectiveScore(entry: HistoryEntry): number | null`
  - Updated `isEligibleForAverage`: uses `getEffectiveScore` instead of `analysis.status === 'ready'`

---

- [ ] **Step 1: Write failing tests** in `src/dashboardStats.test.ts`

```typescript
// import getEffectiveScore from './dashboardStats'

describe('getEffectiveScore', () => {
  it('returns system score when no override', () => {
    expect(getEffectiveScore(makeEntry({}, { totalScore: 70 }))).toBe(70)
  })
  it('returns manual override score when present', () => {
    const e = { ...makeEntry({}, { totalScore: 70, status: 'pending' as const }),
                 manualOverride: { score: 85, overriddenAt: 1 } }
    expect(getEffectiveScore(e)).toBe(85)
  })
  it('manual score = 0 returns 0, not null', () => {
    const e = { ...makeEntry({}, { totalScore: 70 }),
                 manualOverride: { score: 0, overriddenAt: 1 } }
    expect(getEffectiveScore(e)).toBe(0)
  })
  it('falls back to system score when manualOverride has invalid score', () => {
    // invalid score (e.g. 150) should not be in a validated entry, but test
    // that getEffectiveScore is defensive:
    const e = { ...makeEntry({}, { totalScore: 60 }),
                 manualOverride: { score: 150, overriddenAt: 1 } }
    expect(getEffectiveScore(e)).toBe(60)
  })
  it('returns null when both are absent', () => {
    expect(getEffectiveScore(makeEntry({}, { totalScore: null, status: 'pending' as const }))).toBeNull()
  })
})

describe('isEligibleForAverage with manual override', () => {
  it('manual score on pending analysis counts as eligible', () => {
    const e = { ...makeEntry({ endReason: 'manual' as const, activeReadingMs: 10_000 },
                               { status: 'pending' as const, totalScore: null }),
                 manualOverride: { score: 75, overriddenAt: 1 } }
    expect(isEligibleForAverage(e)).toBe(true)
  })
  it('manual score = 0 is eligible', () => {
    const e = { ...makeEntry({ activeReadingMs: 1000 }, { totalScore: null }),
                 manualOverride: { score: 0, overriddenAt: 1 } }
    expect(isEligibleForAverage(e)).toBe(true)
  })
  it('manual override does not override session eligibility rules (interrupted)', () => {
    const e = { ...makeEntry({ endReason: 'interrupted' as const, activeReadingMs: 10_000 }, {}),
                 manualOverride: { score: 75, overriddenAt: 1 } }
    expect(isEligibleForAverage(e)).toBe(false)
  })
  it('manual override does not override session eligibility rules (zero activeMs)', () => {
    const e = { ...makeEntry({ activeReadingMs: 0 }, {}),
                 manualOverride: { score: 75, overriddenAt: 1 } }
    expect(isEligibleForAverage(e)).toBe(false)
  })
})

describe('computeWeightedAverage scenario: modify then restore', () => {
  it('10min@90 + 30min@50 = 60', () => {
    const a = makeEntry({ sessionId: 'a', activeReadingMs: 10 * 60_000 }, { sessionId: 'a', totalScore: 90 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 30 * 60_000 }, { sessionId: 'b', totalScore: 50 })
    expect(computeWeightedAverage([a, b])).toBeCloseTo(60, 5)
  })
  it('after overriding second entry to 70, avg becomes 75', () => {
    const a = makeEntry({ sessionId: 'a', activeReadingMs: 10 * 60_000 }, { sessionId: 'a', totalScore: 90 })
    const b = {
      ...makeEntry({ sessionId: 'b', activeReadingMs: 30 * 60_000 }, { sessionId: 'b', totalScore: 50 }),
      manualOverride: { score: 70, overriddenAt: 1 },
    }
    // (90*10 + 70*30) / 40 = (900+2100)/40 = 3000/40 = 75
    expect(computeWeightedAverage([a, b])).toBeCloseTo(75, 5)
  })
  it('after clearing override, avg returns to 60', () => {
    const a = makeEntry({ sessionId: 'a', activeReadingMs: 10 * 60_000 }, { sessionId: 'a', totalScore: 90 })
    const b = makeEntry({ sessionId: 'b', activeReadingMs: 30 * 60_000 }, { sessionId: 'b', totalScore: 50 })
    expect(computeWeightedAverage([a, b])).toBeCloseTo(60, 5)
  })
})
```

- [ ] **Step 2: Run failing tests**

```
npm test -- --run src/dashboardStats.test.ts
```
Expected: FAIL — `getEffectiveScore` not defined.

- [ ] **Step 3: Add `getEffectiveScore` to `src/dashboardStats.ts`**

```typescript
export function getEffectiveScore(entry: HistoryEntry): number | null {
  const mo = entry.manualOverride
  if (mo !== undefined && isValidScore(mo.score)) return mo.score
  return isValidScore(entry.analysis.totalScore) ? entry.analysis.totalScore : null
}
```

- [ ] **Step 4: Update `isEligibleForAverage` in `src/dashboardStats.ts`**

Replace the `analysis.status` and `analysis.totalScore` checks with:
```typescript
if (!isValidScore(getEffectiveScore(entry))) return false
```
Keep endReason and activeReadingMs checks unchanged.

- [ ] **Step 5: Update `computeWeightedAverage` in `src/dashboardStats.ts`**

Replace `e.analysis.totalScore as number` with `getEffectiveScore(e) as number`.

- [ ] **Step 6: Run tests — expect pass**

```
npm test -- --run src/dashboardStats.test.ts
```

- [ ] **Step 7: Run full suite to check regressions**

```
npm test -- --run
```
Expected: all existing tests still pass.

- [ ] **Step 8: Commit**

```
git add src/dashboardStats.ts src/dashboardStats.test.ts
git commit -m "feat: add getEffectiveScore and update eligibility for manual overrides"
```

---

## Task 3 — Dashboard UI: score wiring + edit form

### Files
- Modify: `src/Dashboard.tsx`
- Modify: `src/Dashboard.css`

### Interfaces
- Consumes: `getEffectiveScore` (Task 2), `updateManualOverride`, `clearManualOverride` (Task 1), `ManualOverride` (Task 1)

---

- [ ] **Step 1: Replace `analysis.totalScore` with `getEffectiveScore(entry)` throughout `Dashboard.tsx`**

Locations that need updating (read file for exact lines):
- `ScoreBadge` call in `SessionDetail` (score hero)
- `scoreToColor(analysis.totalScore)` in `SessionDetail`
- `ScoreBadge` and color in `DayView`
- aria-label in `DayView`
- `computeWeightedAverage` calls in `WeekView` and `MonthView` already use entries, which now use `getEffectiveScore` internally — no change needed there
- `formatScore(analysis.totalScore)` aria-label in `DayView`

**Rule:** Any place that reads `analysis.totalScore` for display or color should become `getEffectiveScore(entry)`. Do not change any place that reads `analysis.totalScore` for showing the *system original* score (that comes in a later step).

- [ ] **Step 2: Update `SessionDetail` props and add `onUpdateOverride` / `onClearOverride` callbacks**

New props:
```typescript
onUpdateOverride: (sessionId: string, override: ManualOverride) => void
onClearOverride: (sessionId: string) => void
```

- [ ] **Step 3: Add edit form state to `SessionDetail`**

New local state:
- `editing: boolean` — whether the edit form is open
- `draftScore: string` — controlled input value (string, not number, to allow empty)
- `draftReason: string` — controlled textarea value
- `scoreError: string | null` — inline validation message
- `saveError: string | null` — storage write error message (shown in form, not globally)

- [ ] **Step 4: Add "修改評分" button and score annotation in `SessionDetail`**

In the score hero section:
- Show effective score (already done in Step 1).
- When `entry.manualOverride` is set, show inline text "已手動修改".
- When `entry.manualOverride` is set, show the system score: `entry.analysis.totalScore !== null ? formatScore(entry.analysis.totalScore) : '尚無系統評分'`.
- Show `overriddenAt` timestamp and `reason` if present.

Controls (only when `!isDemo`):
- If `entry.manualOverride` is set: "恢復系統評分" button + a note explaining what it does.
- "修改評分" button (opens edit form when clicked).

When `isDemo`:
- No edit button; show static text "示範資料不可修改".

- [ ] **Step 5: Implement the edit form in `SessionDetail`**

The form appears inline when `editing === true`:

```tsx
<form onSubmit={handleSave} noValidate>
  <p className="edit-form-desc">修改後將用於歷史紀錄與平均分，系統原始結果仍會保留。</p>
  <label htmlFor="edit-score-input">新分數（0–100 整數）</label>
  <input
    id="edit-score-input"
    type="number"
    min={0} max={100} step={1}
    value={draftScore}
    onChange={e => { setDraftScore(e.target.value); setScoreError(null) }}
    autoFocus
  />
  {scoreError && <p className="edit-score-error" role="alert">{scoreError}</p>}
  <label htmlFor="edit-reason-input">原因（選填）</label>
  <textarea
    id="edit-reason-input"
    maxLength={300}
    value={draftReason}
    onChange={e => setDraftReason(e.target.value)}
  />
  {saveError && <p className="edit-save-error" role="alert">{saveError}</p>}
  <div className="edit-form-buttons">
    <button type="submit">儲存</button>
    <button type="button" onClick={handleCancelEdit}>取消</button>
  </div>
</form>
```

- [ ] **Step 6: Implement `handleOpenEdit`, `handleSave`, `handleCancelEdit`, `handleRestore`**

`handleOpenEdit`:
- Populate `draftScore` with:
  - `entry.manualOverride?.score` if present (as string)
  - else `entry.analysis.totalScore` if valid (as string)
  - else `''`
- Populate `draftReason` with `entry.manualOverride?.reason ?? ''`
- Set `editing = true`

`handleSave(e: React.FormEvent)`:
- `e.preventDefault()`
- Validate: not empty; `Number(draftScore)` is a finite integer in [0, 100]
- If invalid: set `scoreError` with appropriate message; return
- Call `onUpdateOverride(session.sessionId, { score: Number(draftScore), reason: draftReason.trim() || undefined, overriddenAt: Date.now() })`
- If the callback returns/throws an error (see Step 7): show `saveError`; do NOT close form
- On success: set `editing = false`, clear errors

`handleCancelEdit`: set `editing = false`, clear all draft state and errors.

`handleRestore`: call `onClearOverride(session.sessionId)`.

- [ ] **Step 7: Add `handleUpdateOverride` and `handleClearOverride` in main `Dashboard` component**

```typescript
const handleUpdateOverride = useCallback((sessionId: string, override: ManualOverride) => {
  const err = updateManualOverride(sessionId, override)
  if (err) {
    // propagate error back to SessionDetail via updated selectedEntry
    // (see note below)
    setWriteError(err)
    return
  }
  setWriteError(null)
  const result = loadHistory()
  if (result.ok) {
    setHistoryData(result.data)
    // keep selectedEntry in sync with updated data
    const updated = result.data.entries.find(e => e.session.sessionId === sessionId)
    if (updated) setSelectedEntry(updated)
  }
}, [])

const handleClearOverride = useCallback((sessionId: string) => {
  const err = clearManualOverride(sessionId)
  if (err) { setWriteError(err); return }
  setWriteError(null)
  const result = loadHistory()
  if (result.ok) {
    setHistoryData(result.data)
    const updated = result.data.entries.find(e => e.session.sessionId === sessionId)
    if (updated) setSelectedEntry(updated)
  }
}, [])
```

**Note on save error propagation:** Because the callback in `Dashboard` can't directly set state inside `SessionDetail`, take the simpler approach: `onUpdateOverride` and `onClearOverride` **return** the error (or null) so `SessionDetail` can decide whether to close the form or show the error.

Revised signatures:
```typescript
onUpdateOverride: (sessionId: string, override: ManualOverride) => HistoryStorageError | null
onClearOverride: (sessionId: string) => HistoryStorageError | null
```

Then `handleSave` in `SessionDetail` checks the return value:
```typescript
const err = onUpdateOverride(session.sessionId, override)
if (err) { setSaveError('修改無法保存，請重試'); return }
setEditing(false)
```

- [ ] **Step 8: Pass the new callbacks to `SessionDetail`**

In the `Dashboard` JSX:
```tsx
<SessionDetail
  entry={selectedEntry}
  onClose={...}
  onDelete={handleDelete}
  onUpdateOverride={handleUpdateOverride}
  onClearOverride={handleClearOverride}
  isDemo={mode === 'demo'}
/>
```

- [ ] **Step 9: Add CSS for the edit form in `src/Dashboard.css`**

Minimal styles for:
- `.edit-form-desc` — small muted description text
- `.edit-score-error`, `.edit-save-error` — red inline error
- `.edit-form-buttons` — flex row, gap
- `.manual-modified-badge` — small inline indicator for "已手動修改"
- `.system-score-row` — shows original system score and override metadata

- [ ] **Step 10: Run full test suite**

```
npm test -- --run
```
Expected: all pass.

- [ ] **Step 11: Run TypeScript check**

```
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 12: Run Vite build**

```
npm run build
```
Expected: no errors.

- [ ] **Step 13: Commit**

```
git add src/Dashboard.tsx src/Dashboard.css
git commit -m "feat: add manual score override UI to Dashboard"
```

---

## Manual Acceptance Steps

After implementation, verify manually in the browser:

1. **Basic override** — open a real session, click "修改評分", enter a score from a different colour band (e.g. change 25 to 85), save. Confirm: score badge updates, day/week/month views update, weighted average updates.
2. **"已手動修改" annotation** — confirm system original score is shown, override time visible.
3. **Persist on refresh** — reload the page; modified score still shows.
4. **Restore** — click "恢復系統評分"; all views revert to original system score (or "—" if no system score).
5. **Score = 0 and 100** — enter 0, save. Confirm it shows as 0% red, not "—". Enter 100, confirm green.
6. **Invalid inputs** — test: empty, "-1", "101", "75.5", "abc". Each shows an inline error; form stays open; score doesn't change.
7. **Cancel** — open form, change value, cancel. Score unchanged.
8. **Delete** — delete a session that had a manual override. Reload. Session is gone, not resurrected.
9. **Demo mode** — switch to demo data, open a session. No "修改評分" button; sees "示範資料不可修改". Switching back to "我的紀錄" shows real data unchanged.
10. **Other sessions unaffected** — modify session A; session B's score is unchanged.
