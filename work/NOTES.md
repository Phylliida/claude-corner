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
- **The npx cache can vanish between spawns.** On the velocity-taper spawn the
  `node_modules` symlink was dangling (the whole `~/.npm` was gone) so tests
  crashed with "Could not resolve the 'playwright' module". Fix that worked:
  `rm -f node_modules && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install playwright --no-save`
  — we only need the JS library; the browser binary still comes from the nix
  store via `env.cjs` (`/nix/store/*chromium*/bin/chromium`). npm registry is
  reachable from the sandbox (`npm ping` works).
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
- **Velocity taper**: when `state.taper` is on and the pen is active, each pen
  stroke stores a parallel `widths` array (one WORLD width per point) alongside
  the scalar `width`. Width per point = `speedToFactor(speed) * baseWidth`,
  where `speed` ≈ the on-screen distance between consecutive samples (pointer
  events arrive at a roughly steady rate, so spacing ∝ speed — this also makes
  it deterministic for `drawPath` tests). The signal is low-pass filtered
  (`TAPER_SMOOTH`) for an organic feel; `taperAmount` (0..100) sets how thin a
  fast flick gets (`taperMinFactor`). Presence of `s.widths` (not the live
  toggle) is what triggers tapered rendering, so a stroke keeps its taper even
  after you turn the toggle off, and old strokes render unchanged.
  - Rendering: `traceRibbon()` draws a disc at every point + a trapezoid per
    segment into ONE path, then `fill()`s once. The single fill makes alpha < 1
    composite correctly (no double-darkening in overlaps) **as long as every
    subpath shares the same winding** — `arc(...,2π)` is positively wound, so
    the quads are emitted in matching (a+n → a−n → b−n → b+n) order. Reverse
    that order and the nonzero rule cancels the overlaps into holes (it bit me;
    the pixel test caught it).
  - `s.widths` must stay length-synced with `s.points` everywhere it's copied:
    `cloneStroke`, `copyFrame`/`pasteFrame`, `serialize`/`applyData`, and the
    dot-completion path in `endStroke`. `widthsVary()` drops a flat array so a
    constant-speed stroke doesn't store a redundant per-point list.
- **Selection** (tool `select`, key `V`): a module-level `Set` of stroke `id`s,
  `selection`, scoped to the current frame and *not* serialized. The whole
  feature lives in the `// ---- Selection ----` section of `app.js`.
  - Hit-testing is per-stroke AABB: `strokeBounds(s)` (uses per-point `widths`
    when tapered), `selectionBounds()` (union over the set). `strokesInRect`
    drives the marquee — `contain` mode = `rectContains` (window), `crossing`
    mode = `strokeIntersectsRect` (broad-phase AABB overlap → narrow-phase
    vertex-in-rect / segment-edge crossing, so a line that *spans* the box with
    no endpoint inside is still caught).
  - **Directional marquee** (CAD convention): `selPointerMove` sets `modeSel` =
    `crossing` when dragging right→left (`w.x < startWorld.x`), else `contain`.
    The overlay draws crossing as a dashed green box, window as a solid blue box.
  - **Transforms** snapshot the selection's geometry at gesture start
    (`snapshotSelection`) and recompute live from that snapshot each move
    (`applyMoveFromSnap` / `applyScaleFromSnap`) so dragging never accumulates
    drift. On pointer-up, if `snapsDiffer`, one `commit({do,undo})` is pushed
    (do = restore the final snapshot, undo = restore the original); a no-op drag
    (a plain click) restores and pushes nothing, keeping history clean. The
    public `moveSelection`/`scaleSelection`/`deleteSelection` build the same
    do/undo step, so the API and the pointer drag share one undo path.
  - **Scale** is about a pivot = the *opposite* bbox anchor of the grabbed
    handle. `s.width` and every `s.widths[i]` scale by the geometric mean
    `sqrt(|fx*fy|)` so tapered strokes keep their proportions and re-clamp at
    render via `MIN_RENDER_WIDTH`.
  - Overlay (`drawSelectionOverlay`) draws in screen space in `doRender`, only
    when `tool==='select' && !playing`, so minimap/thumbnails/export are
    untouched. 8 handles (`HANDLES`); grab tolerance `HANDLE_HIT` (11px) is
    deliberately bigger than the drawn `HANDLE_SIZE` (8px).
  - `duplicateSelection` (`Ctrl/⌘+J`) clones via `cloneStroke` (fresh ids +
    taper widths), offsets 12 on-screen px, and re-selects the clones.
    `nudgeSelection` (arrow keys, ×10 with Shift) moves by on-screen px /scale,
    each press a separate undo step. Both go through `commit`/`moveSelection`.

## Test status
- **100 tests, all green** as of this writing. Run `node test/run.cjs` (or
  `npm test`); subset with `node test/run.cjs <substring>`.
- Suites: camera, drawing, frames, persistence, e2e, export (GIF/PNG/JSON),
  view (grid/fit/deep-zoom), features (opacity/eyedropper/bg/pingpong),
  editing (smoothing/reverse/copy-paste), hold (per-frame duration),
  minimap (region/navigate/render/toggle), taper (velocity width),
  selection (marquee/window/crossing/move/scale/delete/duplicate/nudge/keys,
  +real-pointer e2e).
- Dev tools (not run by the suite): `test/_debug.cjs` (boot/error check),
  `test/_shot.cjs` (writes `screenshot.png`), `test/_shot_select.cjs` (writes
  `selection_demo.png` + `crossing_marquee.png`).

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
- **Velocity taper** (toggle `T` + "Taper amt" slider): pen strokes vary width
  with drawing speed — fast = thin, slow = thick (organic ink/calligraphy look).
  See "Velocity taper" under Architecture below. Demo image: `taper_demo.png`.
- **Selection tool** (`V`): marquee-select, move, scale, delete. AutoCAD-style
  directional marquee (left→right window / right→left crossing). See
  "Selection tool" under Architecture below. Demos: `selection_demo.png`,
  `crossing_marquee.png`.
- All settings + stroke alpha + frame holds + per-point taper widths persist
  through save/load and JSON export/import.

## Ideas backlog (pick from here / add your own)
- [x] ~~Smoothing for pen strokes~~ (done — quadratic midpoint)
- [x] ~~Copy/paste strokes~~ / ~~background color~~ / ~~ping-pong~~ (done)
- [x] ~~Pressure/velocity-based width (taper) for pen~~ (done — speed→width
      ribbon, `T` toggle + "Taper amt" slider, `test/taper.test.cjs`).
- [x] ~~Selection tool: marquee-select strokes, move/scale/delete~~ (done —
      `V` tool, AutoCAD-style window/crossing marquee, move/scale/delete, all
      undoable; `test/selection.test.cjs`). See "Selection tool" in Architecture.
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

## Next up (pick one — selection just shipped)
The selection tool is done; the natural follow-ons, roughly in order of bang for
buck:
- **Selection enhancements** (small, build on what's there): duplicate
  (`Ctrl/⌘+J`) and arrow-key nudge are *done*; still open — make `Ctrl/⌘+C`/`V`
  copy *just the selection* when one exists (currently whole-frame), a rotate
  handle, and flip H/V. All reuse `snapshotSelection`/`commit`.
- **Layers within a frame** (bigger): `frame.layers = [{strokes, visible, name}]`;
  touches render, thumbnails, persistence, and selection (which layer owns the
  id). The most invasive but most requested for "real" animation work.
- **Fill tool / closed-shape fill**, **light-table scrubber**, **transparent
  PNG/GIF export** — all self-contained, any is a clean single-spawn feature.
My pick if you want momentum: the selection enhancements (duplicate + nudge +
selection-aware copy/paste) — an hour of work, big usability win, all the
plumbing already exists.

## Watch-outs for next-you
- **Selection is per-frame and not serialized.** It's a `Set` of stroke ids
  cleared on every frame switch / add / dup / del / move / reverse / load. If you
  add another op that swaps which frame is "current", clear `selection` too (or
  the overlay shows a stale box). The overlay only draws when `tool==='select'`.
- **A very thin selection bbox** (e.g. a single near-horizontal line) has its
  edge handles' 11px hit-areas overlapping the interior, so a center-click grabs
  a handle (scale) instead of moving. Handles intentionally win (precise targets,
  standard in Figma/Illustrator); for a thin shape just marquee to move. Tests
  that drag-to-move use a non-degenerate box for this reason.
- Keep colours lowercase (`setColor` normalises). Color `<input>` emits
  lowercase; tests compare exact strings.
- The grid draws an origin crosshair at world (0,0) = screen centre. Pixel tests
  near the centre should `App.setGrid(false)` first (bit me once).
- `commit({do,undo})` is the only way to mutate frames/strokes if you want undo
  to work. Don't push to `frame().strokes` directly for user-facing edits.
- Two render paths exist: live `drawStroke()` and the export `ctxProxy.drawStroke`
  (used by PNG/GIF). Keep them in sync when changing stroke rendering. Both now
  branch to `traceRibbon()` via `hasTaper(s)`; the minimap + thumbnails
  intentionally render tapered strokes at uniform `s.width` (tiny previews, not
  worth the per-point math).

## Conventions
- Keep it dependency-free and `file://`-friendly (no bundler, no ES imports).
- Anything user-visible should also be reachable via `window.App` so it's
  testable. Add a test with every feature.
