# flowfinder

**A focus observation tool for reading.** Run a focus session while you read; flowfinder records what it can actually observe (whether your face is in frame, whether the page is in front, how your eyes move across the text) and shows it back to you on a timeline.

It does not diagnose attention or claim to read your mind. The goal is to help you notice, over many sessions, when and how you read best.

> Hackathon prototype. Everything runs locally in your browser; no account or server is needed.

## What it does

flowfinder comes in two forms that share the same data format and dashboard.

### Web app

- **Set up** a session: name what you're reading, choose what counts as leaving the reading (looking down, switching tabs, leaving the window), and pick a duration (15 / 30 / 45 min, custom up to 240 min, or open-ended).
- **Read** the built-in article, *The Art of Deep Reading*, with a timer. Optional **eye tracking** starts with a short calibration.
- **Quick check-in** panel beside the article ("Just before this question, was your attention on your task?"). Answers are shown on screen but are not yet saved with the session.
- **Overtime**: when time is up, keep going or finish.
- **Review** a timeline of the session's events.
- **Dashboard**: day, week, and month views. Sessions are colored by their focus estimate. You can print or save as PDF, correct a score by hand, and delete sessions.

### Browser extension (Chrome)

Reading happens everywhere, not just on our page, so the extension brings sessions to **any website**.

- **Setup popup** from the toolbar icon. The task name is suggested from the tab title. Choose what to notice: *Stay in frame*, *Tab activity*, and *Screen attention* (eye-tracking estimate, beta).
- **Floating timer** in a corner of the page: a small pill or an expanded card. Drag it to any corner. The toolbar badge shows minutes left.
- **Popup during a session**: live timer, pause and finish, and a switch to show or hide the floating timer.
- **Summary** at the end, with `.json` and `.csv` downloads.
- **History** syncs into the web app's dashboard. When the web app isn't running, the extension shows its own history page.

See [`extension/README.md`](extension/README.md) for the extension's architecture.

## How the focus estimate works

### Why eye movements

We first tried smartwatch signals, but heart rate and movement change with exercise, stress, and posture, not just attention. Eye movements during reading are much more directly tied to it.

### Data

We trained on **ReMind**, a public dataset in which people read while a lab eye tracker recorded their gaze and they reported moments of mind-wandering. We used 19 readers, split into 10-second windows (16,912 windows, 3.1 % labelled mind-wandering).

A webcam dataset with mind-wandering labels exists, but access requires manual approval, which wasn't possible during the hackathon weekend. Instead, we **simulated webcam noise** on the lab data: 30 Hz sampling plus jitter and drift, at four levels from ideal to poor.

### Features and model

Under webcam-level noise, fine-grained measures such as individual fixations fall apart. Two reading patterns survive:

| Feature | Meaning |
|---|---|
| **Line returns** | How often the eyes jump back to start a new line (a leftward jump longer than half the text column) |
| **Horizontal progress** | How fast the eyes move rightward across the text |

These two alone keep almost all the signal: AUC 0.637, versus 0.648 for six gaze features. The model is an **L2-regularized logistic regression**, chosen because:

- 19 readers is too little data for a deep model to generalize; it would memorize people.
- It runs in the browser in real time: two weights and an intercept (`src/model.json`).
- It's explainable: we can say exactly what moves the score.

### Accuracy

Evaluated **leave-one-participant-out** (the test reader is never in training) under typical simulated webcam noise: **AUC ≈ 0.64**, where 0.5 is chance and 1.0 is perfect. That's useful for trends across a session, not for judging a single moment. **It has not yet been validated with real webcam data.**

### At runtime

1. **WebGazer** turns webcam frames into gaze points (ridge regression on eye patches, trained by the calibration clicks).
2. Every 2 seconds, the last 10 seconds of gaze become the two features.
3. Each reader is compared with **their own usual reading** (an online z-score, saved between sessions), not with other people. The first ~20 seconds are a warm-up.
4. The logistic score is smoothed over the last 30 seconds. Because training balanced the classes, the score is a ranking, not a true probability, so it is shown relative to your own reading.
5. A session's focus percentage is mapped to bands:

| | Focus | Meaning |
|---|---|---|
| 🟢 | 70–100 % | On task |
| 🟡 | 40–69 % | Mixed |
| 🔴 | 0–39 % | Mostly elsewhere |
| ◌ | — | No score (eye tracking off, or not enough reliable data) |

**Quality guard (extension).** Webcam jitter inflates horizontal progress, which the model reads as "more focused". In a simulation of the same steady reading with noise rising from 40 to 160 px, the estimate climbed from 59 % to 71 %. The extension estimates jitter in each window and compares it with the level right after calibration. Windows much noisier than that are not scored and never reach the personal baseline. If tracking stays noisy, it offers a mid-session recalibration.

## Getting started

Requires Node.js 18 or newer and Chrome (for eye tracking and the extension).

```bash
npm install
npm run dev          # web app at http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Start the web app with hot reload |
| `npm test` | Run all unit tests (web app and extension) |
| `npm run build` | Type-check and build the web app to `dist/` |
| `npm run preview` | Serve the built web app at http://localhost:4173 |
| `npm run build:ext` | Build the extension to `extension/dist/` |

**Load the extension:** run `npm run build:ext`, open `chrome://extensions`, turn on *Developer mode*, choose *Load unpacked*, and select `extension/dist`. After rebuilding, press ↻ on its card.

**Useful URLs:** `/#dashboard` opens the dashboard directly; `/#session/<id>` opens one session.

## Project structure

```
src/                      Web app (React + TypeScript + Vite)
  App.tsx                 Setup, reading page, routing
  SessionResultPage.tsx   Timeline and results after a session
  Dashboard.tsx           Day / week / month history
  useSession.ts           Session timer, pauses, check-in, overtime
  useGaze.ts, gaze.ts     Eye-tracking lifecycle (WebGazer)
  GazeCalibration.tsx     Calibration + validation UI
  calibration.ts          Calibration points and quality grading
  attentionModel.ts       Feature extraction, per-user z-score, scoring
  model.json              Trained model weights
  historyStorage.ts       Multi-session history (localStorage)
  sessionAnalysis.ts      Session focus score from attention events
  dashboardStats.ts       Score bands and period summaries
  article.ts              The built-in article
extension/                Chrome extension (Manifest V3); see extension/README.md
  src/engine/             Offscreen engine: camera, model, timer, quality guard
  src/popup/              Toolbar popup
  src/calibrate/          Calibration tab
  src/content/            Floating timer + history sync on web pages
  src/history/            Built-in history page
```

## Data and privacy

- **Video never leaves your device.** All gaze estimation and scoring run locally.
- The web app stores sessions in your browser's `localStorage` (`flowfinder_history_v1`, `flowfinder_session_v2`, plus preferences and the eye-tracking baseline).
- The extension stores sessions in `chrome.storage.local` and records **site names only**, never page content or full URLs.
- The extension writes history only into the web app at allowlisted origins (`extension/src/config.ts`) that also carry the app's marker.

## Limitations and next steps

- Not yet validated on real webcam data. Next step: test on the webcam mind-wandering dataset once access is approved, and collect real sessions with self-reports.
- Webcam noise can still look like focus; the quality guard skips such windows but does not make the model more accurate.
- If the eyes keep moving across lines while the mind is elsewhere, eye movements alone can't catch it.
- Self-reports are not yet saved with sessions, so the estimate can't be compared with how the reader felt.
- Reading only. Studying, coding, or writing involve different eye and body patterns and need their own signals.
- The model training notebook is not in this repository yet.

## Tech stack

React 19, TypeScript, Vite, Vitest · WebGazer.js and MediaPipe Face Mesh for gaze · scikit-learn (training) · Chrome Extension Manifest V3.

## Credits and licenses

- **ReMind** dataset for training data.
- **[WebGazer.js](https://webgazer.cs.brown.edu/)**, licensed GPL-3.0-or-later. Any distribution that includes it must comply with the GPL; a closed-source version would need to replace it.
- **MediaPipe Face Mesh**, Apache-2.0. Bundled in the extension; three eval-based glue functions are rewritten at build time for Chrome's security policy, and the model files are unchanged.
- **Work Sans** and **Young Serif** fonts, SIL Open Font License (`extension/public/fonts`).

This repository does not include a license file yet.
