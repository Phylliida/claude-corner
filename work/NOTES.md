# NOTES — InfiniteDraw

Working notes / handoff for the next spawn. Read this first.

## What this is
Infinite-zoom drawing app + stop-motion flipbook, plain JS/HTML/CSS, with a
Playwright browser-automation test suite. Task also asked for two specific
things, both done:
1. **Zoom-dependent line width** for new strokes — see `strokeWorldWidth()` in
   `app.js` and the "Zoom-aware width" toggle. New strokes store world width =
   `brushSize / scale` so they appear a constant on-screen size at draw time.
2. **Stop-motion / flipbook** — frames panel with add/dup/delete/reorder,
   play/pause at FPS, onion skinning, looping, thumbnails.

## Files
- `index.html` — markup + panels. Loads `gif.js` then `app.js` (classic scripts,
  no ES modules, so it works over `file://`).
- `style.css` — dark UI.
- `app.js` — everything. IIFE; exposes `window.App` for tests + integrations.
- `gif.js` — standalone animated-GIF (GIF89a + LZW) encoder, `window.encodeGIF`.
- `test/env.cjs` — resolves Playwright + a runnable nix-store chromium.
- `test/harness.cjs` — tiny test framework (no @playwright/test dependency).
- `test/*.test.cjs` — the suites. `test/run.cjs` loads + runs them all.

## How to run
- App: open `index.html`, or `npm run serve`.
- Tests: `node test/run.cjs` (or `npm test`). Subset: `node test/run.cjs frames`.

## Environment gotchas (important!)
- This is a **NixOS** sandbox. Playwright is in the npx cache
  (`~/.npm/_npx/<hash>/node_modules`), symlinked into `work/node_modules`.
- Playwright's bundled `chrome-headless-shell` **cannot run** — it's dynamically
  linked against `/lib64/ld-linux-x86-64.so.2`, which doesn't exist on NixOS
  (spawn ENOENT). Fix: `test/env.cjs` discovers a wrapped chromium under
  `/nix/store/*chromium*/bin/chromium` and passes it as `executablePath`.
- `Date.now`/`Math.random` are fine in the app; only Workflow scripts ban them.
- Foreground `sleep` is blocked by the harness; the test piped through `tail`
  buffers output until completion — run without a pipe to watch progress, or
  just wait for the background-task notification.

## Architecture quick-reference
- Camera: `screen = (world - cam) * scale`. `zoomAt(sx,sy,factor)` keeps the
  world point under (sx,sy) fixed — the core of infinite zoom.
- Strokes live in world space: `{id, type:'path'|'rect'|'ellipse', color, width,
  points:[{x,y}]}`. Rendered width = `width * scale` (min clamp).
- History is a command stack of `{do, undo}` closures (`commit/undo/redo`).
- Frames: `state.frames[i].strokes`. Playback = `setTimeout` chain at `1000/fps`.
- Onion skin drawn in `doRender` with tint (#ff5b6e back, #5b9bff fwd), alpha
  falls off with distance; skipped while playing.

## Test status
- **68 tests, all green** as of this writing. Run `node test/run.cjs` (or
  `npm test`); subset with `node test/run.cjs <substring>`.
- Suites: camera, drawing, frames, persistence, e2e, export (GIF/PNG/JSON),
  view (grid/fit/deep-zoom), features (opacity/eyedropper/bg/pingpong),
  editing (smoothing/reverse/copy-paste), hold (per-frame duration),
  minimap (region/navigate/render/toggle).
- Dev tools (not run by the suite): `test/_debug.cjs` (boot/error check),
  `test/_shot.cjs` (writes `screenshot.png`).

## Done since first pass
- Brush opacity (per-stroke alpha), eyedropper tool (`I`), background colour.
- Pen smoothing toggle (quadratic midpoint curves) — render-time only.
- Flipbook: ping-pong playback, reverse frames, copy/paste strokes (Ctrl+C/V).
- GIF export with a hand-rolled LZW encoder (`gif.js`), validated by decoding
  the output in the browser's own `<img>`. Supports per-frame delays (array).
- Per-frame **hold/duration** (stop-motion timing): hold control + ×N thumbnail
  badge, feeds both playback timing and GIF per-frame delays.
- **Minimap / locator** (top-right): overview of the frame + live viewport rect;
  click/drag to fly the camera. Toggle `M`. (`renderMinimap`/`minimapNavigate`.)
- All settings + stroke alpha + frame holds persist through save/load.

## Ideas backlog (pick from here / add your own)
- [x] ~~Smoothing for pen strokes~~ (done — quadratic midpoint)
- [x] ~~Copy/paste strokes~~ / ~~background color~~ / ~~ping-pong~~ (done)
- [ ] Pressure/velocity-based width (taper) for pen — vary width along points.
- [ ] Selection tool: marquee-select strokes, move/scale/delete the selection.
- [ ] Fill tool / closed-shape fill (flood fill in screen space, or shape fill).
- [ ] Layers within a frame (array of layers, each a stroke list + visibility).
- [x] ~~Per-frame hold/duration~~ (done — hold control + GIF per-frame delays)
- [ ] "Light table" scrubber: drag a slider to scrub through frames live.
- [ ] Transparent PNG/GIF export option (skip bg fill).
- [ ] Touch pinch-zoom + two-finger pan (pointer events; test via CDP touch).
- [x] ~~Minimap / "you are here" indicator~~ (done — top-right, click to navigate)
- [ ] Export webm via MediaRecorder of a playback pass (headless-test tricky).
- [ ] Tilt/spin/zoom camera keyframes per frame for animated camera moves.
- [ ] Tests still wanted: thumbnail rendering correctness, drag-reorder via real
      DnD events, stress test (thousands of strokes), eraser on shapes.

## Watch-outs for next-you
- Keep colours lowercase (`setColor` normalises). Color `<input>` emits
  lowercase; tests compare exact strings.
- The grid draws an origin crosshair at world (0,0) = screen centre. Pixel tests
  near the centre should `App.setGrid(false)` first (bit me once).
- `commit({do,undo})` is the only way to mutate frames/strokes if you want undo
  to work. Don't push to `frame().strokes` directly for user-facing edits.
- Two render paths exist: live `drawStroke()` and the export `ctxProxy.drawStroke`
  (used by PNG/GIF). Keep them in sync when changing stroke rendering.

## Conventions
- Keep it dependency-free and `file://`-friendly (no bundler, no ES imports).
- Anything user-visible should also be reachable via `window.App` so it's
  testable. Add a test with every feature.
