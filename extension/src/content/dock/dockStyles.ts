/** Dock styles (from the concept mockup), scoped inside the dock's shadow root. */
export const DOCK_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root {
  --ink:#1F2E3F; --muted:#5E5A52; --navy:#2F4D6B; --navy2:#E4E9EF; --olive:#6E7B5E; --mustard:#F5CD5A;
  --red:#D34C42; --cream:#FFFCF6; --cta:#F2B23E; --gray:#B8B2A7; --line:#E3D8C4;
  --grain:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .55 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  --sans:'FF Work Sans','Work Sans','Noto Sans TC',system-ui,sans-serif;
  --serif:'FF Young Serif','Young Serif',Georgia,serif;
  color: var(--ink); font-family: var(--sans); font-weight: 500; font-size: 14px; line-height: 1.3;
  font-variant-numeric: lining-nums tabular-nums;
}
button { font: inherit; color: inherit; cursor: pointer; }
.hidden { display: none !important; }

.dock { position: fixed; z-index: 2147483646; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; transition: top .25s, left .25s, right .25s, bottom .25s; }
.dock.br { right: 22px; bottom: 22px; }
.dock.bl { left: 22px; bottom: 22px; align-items: flex-start; }
.dock.tr { right: 22px; top: 22px; flex-direction: column-reverse; }
.dock.tl { left: 22px; top: 22px; align-items: flex-start; flex-direction: column-reverse; }

.logo { width: 24px; height: 24px; border-radius: 50%; background: var(--navy); display: grid; place-items: center; flex: none; }
.logo i { width: 9px; height: 9px; border-radius: 50%; background: var(--cta); }

.pill { display: flex; align-items: center; gap: 10px; background: #fff; border: 1.5px solid var(--navy); border-radius: 40px; padding: 6px 8px 6px 6px; box-shadow: 0 6px 20px rgba(31,46,63,.16); cursor: grab; user-select: none; transition: opacity .3s; }
.pill:active { cursor: grabbing; }
.pill.quiet { opacity: .62; }
.pill.quiet:hover, .pill.quiet:focus-within { opacity: 1; }
.pill.up { border-color: var(--cta); box-shadow: 0 0 0 3px rgba(242,178,62,.35), 0 6px 20px rgba(31,46,63,.16); }
.mring { width: 40px; height: 40px; transform: rotate(-90deg); flex: none; }
.mring .bg, .bring .bg { fill: none; stroke: var(--navy2); }
.mring .bg, .mring .fg { stroke-width: 5; }
.mring .fg, .bring .fg { fill: none; stroke: var(--navy); stroke-linecap: round; transition: stroke-dashoffset .5s; }
.paused .mring .fg, .paused .bring .fg { stroke: var(--gray); }
.up .mring .fg, .up .bring .fg { stroke: var(--cta); }
.ptime { font-family: var(--serif); font-size: 19px; min-width: 58px; display: block; }
.psub { font-size: 10px; font-weight: 700; letter-spacing: .06em; color: var(--muted); display: block; margin-top: -2px; }
.timebox { cursor: pointer; }
.camdot { width: 8px; height: 8px; border-radius: 50%; background: var(--olive); flex: none; }
.camdot.warn { background: var(--mustard); }
.camdot.off { background: transparent; border: 1.5px dashed var(--gray); }
.ib { width: 32px; height: 32px; border-radius: 50%; border: 0; display: grid; place-items: center; background: var(--navy2); color: var(--navy); padding: 0; }
.ib:hover { background: #D4DDE7; }
.ib.solid { background: var(--navy); color: #fff; }

.mini { width: 300px; background: var(--cream); border: 1.5px solid var(--navy); border-radius: 14px; box-shadow: 0 14px 34px rgba(31,46,63,.2); overflow: hidden; }
.minihead { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background-color: var(--navy); background-image: var(--grain); background-blend-mode: soft-light; background-size: 180px; color: #fff; cursor: grab; user-select: none; }
.minihead .t { flex: 1; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.minihead .ib { width: 26px; height: 26px; background: rgba(255,255,255,.14); color: #fff; }
.minibody { padding: 14px 16px 16px; }
.ringrow { display: flex; align-items: center; gap: 16px; }
.bring { width: 104px; height: 104px; transform: rotate(-90deg); flex: none; }
.bring .bg, .bring .fg { stroke-width: 9; }
.ringwrap { position: relative; }
.ringwrap .rt { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; }
.ringwrap .rt b { font-family: var(--serif); font-weight: 400; font-size: 24px; }
.ringwrap .rt small { font-size: 10px; color: var(--muted); font-weight: 600; }
.rcs { display: flex; flex-direction: column; gap: 8px; }
.rc { display: flex; align-items: center; gap: 9px; background: none; border: 0; padding: 0; font-size: 13px; font-weight: 600; color: var(--navy); }
.rc .c { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; }
.rc.pz .c { background: var(--navy); color: #fff; }
.rc.st .c { border: 1.5px solid var(--navy); background: #fff; }
.camline { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; margin-top: 14px; padding: 9px 10px; background: #fff; border: 1px solid var(--line); border-radius: 8px; }
.statusline { font-size: 12px; font-weight: 600; color: var(--navy); margin-top: 10px; padding: 0 2px; }
.degraded { margin-top: 10px; padding: 10px 12px; background: #FFF6E0; border: 1.5px solid var(--cta); border-radius: 8px; font-size: 12px; line-height: 1.45; display: flex; flex-direction: column; gap: 8px; }
.degraded button { align-self: flex-start; border-radius: 8px; padding: 7px 12px; font-size: 13px; font-weight: 700; border: 1.5px solid var(--navy); }
.minifoot { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 12px; }
.minifoot label { display: flex; gap: 6px; align-items: center; font-weight: 600; color: var(--muted); cursor: pointer; }
.minifoot input { accent-color: var(--navy); margin: 0; }
.linkbtn { background: none; border: 0; padding: 0; color: var(--navy); font-weight: 700; font-size: 12px; }

.card { width: 300px; background: #fff; border: 1.5px solid var(--navy); border-radius: 12px; padding: 14px 16px; box-shadow: 0 12px 30px rgba(31,46,63,.18); }
.card h4 { font-family: var(--serif); font-weight: 400; font-size: 19px; margin: 0 0 4px; }
.card p { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; line-height: 1.45; }
.card .row2 { display: flex; gap: 8px; }
.card .row2 button { flex: 1; border-radius: 8px; padding: 9px; font-size: 13px; font-weight: 700; border: 1.5px solid var(--navy); }
.b-solid { background: var(--navy); color: #fff; }
.b-ghost { background: #fff; color: var(--navy); }
.card.up { border-color: var(--cta); box-shadow: 0 0 0 3px rgba(242,178,62,.3), 0 12px 30px rgba(31,46,63,.18); }
.sumstats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0 12px; }
.sumstats div { background: var(--cream); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.sumstats small { display: block; font-size: 10px; font-weight: 700; letter-spacing: .08em; color: var(--muted); }
.sumstats b { font-family: var(--serif); font-weight: 400; font-size: 20px; }
.card p.note { font-size: 11.5px; margin: -4px 0 12px; color: var(--muted); }
.dl { display: flex; gap: 12px; font-size: 12px; margin-top: 10px; align-items: center; }
.dl button { background: none; border: 0; padding: 0; color: var(--navy); font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.dl span { color: var(--muted); font-weight: 600; }
`

/* Larger sizes (≈ +25 %), requested after testing: easier to read and hit while reading */
export const DOCK_SIZE_CSS = `
.root { font-size: 15px; }
.pill { gap: 12px; padding: 8px 12px 8px 8px; }
.mring { width: 52px; height: 52px; }
.ptime { font-size: 25px; min-width: 76px; }
.psub { font-size: 11px; }
.camdot { width: 10px; height: 10px; }
.ib { width: 40px; height: 40px; }
.ib svg { width: 18px; height: 18px; }
.mini { width: 368px; border-radius: 16px; }
.minihead { padding: 12px 14px; gap: 10px; }
.minihead .t { font-size: 15px; }
.minihead .ib { width: 30px; height: 30px; }
.minibody { padding: 18px 20px 20px; }
.ringrow { gap: 22px; }
.bring { width: 132px; height: 132px; }
.ringwrap .rt b { font-size: 31px; }
.ringwrap .rt small { font-size: 12px; }
.rcs { gap: 12px; }
.rc { font-size: 15px; gap: 11px; }
.rc .c { width: 50px; height: 50px; }
.rc .c svg { width: 18px; height: 18px; }
.camline { font-size: 13.5px; padding: 11px 12px; margin-top: 16px; }
.statusline { font-size: 13.5px; margin-top: 12px; }
.minifoot { font-size: 13px; padding: 12px 20px; }
.linkbtn { font-size: 13px; }
.card { width: 368px; padding: 18px 20px; border-radius: 14px; }
.card h4 { font-size: 23px; }
.card p { font-size: 14px; }
.card p.note { font-size: 12.5px; }
.card .row2 button { font-size: 14.5px; padding: 11px; }
.sumstats b { font-size: 25px; }
.sumstats small { font-size: 11px; }
.dl { font-size: 13px; }
`

/** @font-face rules must live in the page (Chrome ignores them inside shadow roots). */
export function fontFaceCss(url: (path: string) => string): string {
  return `
@font-face { font-family: 'FF Work Sans'; src: url('${url('fonts/WorkSans-latin.woff2')}') format('woff2'); font-weight: 400 700; font-display: swap; }
@font-face { font-family: 'FF Young Serif'; src: url('${url('fonts/YoungSerif-latin.woff2')}') format('woff2'); font-weight: 400; font-display: swap; }
`
}
