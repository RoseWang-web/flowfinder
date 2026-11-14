# flowfinder — browser extension

Focus sessions for reading on any site: a setup popup, a small floating timer
on the page, tab activity, and an experimental webcam attention estimate
("Screen attention"). Built from the team's concept mockup.

## Build and load

```bash
npm run build:ext          # → extension/dist
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → choose `extension/dist`.
3. Pin the extension. After rebuilding, press ↻ on its card and reload open pages.

## Using it

1. On the page you want to read, click the toolbar icon → setup popup
   (task name is suggested from the tab title).
2. **Start session**.
   - First time with a camera option on: a tab asks for camera access, then the session continues.
   - **Screen attention** on: a calibration tab opens (face position → 9 dots × 3 clicks → 5 dots
     to look at). Good / usable calibration → **Start reading**; poor → calibrate again.
3. The timer floats in a corner of every page. Drag it to any corner; the toolbar
   icon (or ⌃ / –) expands and minimizes it; the badge shows minutes left.
4. **Finish** (or *Time's up* → Keep going / Finish) → summary card:
   Full review opens the web app Dashboard; .json / .csv downloads.

## Architecture

```
popup ──start──▶ background (service worker) ──creates──▶ offscreen ENGINE
calibration tab ──clicks / validation──▶ engine        camera + WebGazer + model + timer + session
content script on every page ──page state / dock buttons──▶ engine
engine ──state 1/s──▶ background ──▶ active tab's dock + toolbar badge
engine ──storage──▶ background (offscreen documents only get chrome.runtime)
```

| Path | What |
|---|---|
| `src/engine/Engine.ts` | Session state machine, timer, model scoring, history (unit-tested with a mock tracker) |
| `src/engine/offscreen.ts` | Engine host; installs timer-driven `requestAnimationFrame` first |
| `src/engine/timerFrames.ts` | rAF for a hidden document (native rAF never fires there) |
| `src/background.ts` | Creates/closes the engine, opens calibration/permission tabs, badge, routing |
| `src/popup/` | Setup popup (React) |
| `src/calibrate/` | Calibration tab (React); grading from `src/calibration.ts` (web app) |
| `src/content/dock/` | Floating timer in a shadow root (no framework, ~28 kB content script) |
| `src/content/historySync.ts` | Writes finished sessions into the web app's history |
| `src/session/` | Web-app-compatible `Session` recorder and the extension's history store |
| `src/sidepanel/` | Developer tool (Chrome's side panel menu): Phase 0 measurements |

## Why the engine works in a hidden document

Measured in Chrome with a fake camera while the user is on another tab:

| per second | native rAF | timer-driven rAF |
|---|---|---|
| requestAnimationFrame | 0 | — |
| new camera frames | 20 (all) | 20 (all) |
| WebGazer predictions | **0** | **29** |

Camera frames keep arriving in an offscreen document, but rAF never fires, so
WebGazer's loop stops. `timerFrames.ts` drives rAF on a fixed 30 Hz cadence
(work time is not added to the interval). The calibration tab shows the live
rate ("Tracking N / s"); the model needs ≈ 30.

## History sync

- Sessions use the web app's `Session` / `HistoryEntry` format (`source: 'extension'`,
  `taskName`, sites as hostnames only) and the web app's `computeSessionAnalysis()`.
- Reading time counts only while a page is visible and focused (when *Tab activity*
  is on); model windows never span a page switch or a focus change.
- Progress is saved every 10 s; a session left running is stored as `interrupted`.
- Open FlowFinder (`npm run dev`) in any tab: pending sessions are written with
  `upsertHistoryEntry()` (sessions deleted in the Dashboard stay deleted) and an
  open Dashboard reloads. Only origins in `src/config.ts` **and** serving
  `<meta name="flowfinder-app">` receive history — add the production origin there.

## Notes

- `build/embindPatch.ts` rewrites three eval-based helpers in face_mesh's Emscripten
  glue so they run under the MV3 CSP; `.wasm` and model data are copied unchanged
  (`build/embindPatch.test.ts` checks the patched helpers behave identically).
- WebGazer 3.5.3 `alert()`s on non-https pages; the engine suppresses that alert.
- Fonts (Work Sans, Young Serif; SIL OFL) are bundled in `public/fonts`.
- Not yet: PDF export, per-site host permissions (currently `<all_urls>`),
  zoom-aware column width, Chinese UI strings.
