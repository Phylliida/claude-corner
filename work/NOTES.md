# Infinizoom — build notes

An infinite-zoom vector drawing app (JS + HTML + CSS) with a Playwright
browser-automation test suite. No frameworks, no build step — plain ES modules
served by a tiny static server.

## Run it
- `npm run serve` → http://127.0.0.1:8231  (open index.html)
- `npm test`       → Playwright suite (auto-starts the server)
- `node tests/smoke.mjs` → quick standalone check (needs server running)
- `node tests/demo.js`   → generates showcase screenshots in `screenshots/`

## Environment gotchas (IMPORTANT — read before debugging "browser won't launch")
- This is **NixOS**. Playwright's prebuilt Chromium CANNOT run (missing
  `/lib64/ld-linux-x86-64.so.2`). We launch a **Nix-store chromium** instead,
  resolved at runtime by `tests/_helpers.js → resolveChromium()` (globs
  `/nix/store/*-chromium-*/bin/chromium`, picks newest). Override with
  `IZ_CHROMIUM=/path/to/chromium`.
- Port **8080 is permanently occupied** by some other-namespace process we
  can't kill, so we use **8231** (`IZ_PORT` to override).

## Architecture (src/)
- `util.js`     — geometry, RDP simplify, formatting, debounce, color helpers
- `camera.js`   — world<->screen transform, zoom-at-cursor, pan, fit. Infinite
                  zoom = scale clamped to [1e-12, 1e12]; f64 world coords.
- `scene.js`    — document model (items array), bbox, hit-test, pick, JSON I/O.
                  Item types: stroke, line, rect, ellipse, text.
- `history.js`  — undo/redo command stack (add/remove/move/modify commands).
- `renderer.js` — canvas painting: adaptive infinite grid, items (culled),
                  draft, selection chrome, marquee, eraser cursor. Handles DPR.
- `minimap.js`  — overview + viewport rect; click to recenter.
- `storage.js`  — localStorage autosave + JSON/PNG file export, import.
- `app.js`      — wiring: input (pointer/wheel/keys), tools, UI, HUD, render
                  loop, and the **test API** on `window.__INFINIZOOM__`.

## Test API (window.__INFINIZOOM__)
Drives the app for tests: setTool/getTool, setStyle/getStyle, itemCount,
getItems, undo/redo/canUndo/canRedo, clear, selectAll, deleteSelection,
getCamera/setCamera, zoomBy, resetView, fitAll, worldToScreen/screenToWorld,
bounds, toJSON/loadJSON, addStroke/addRect/addEllipse/addText, pick, select,
selectedCount, render, dataURL, stats. `window.app` is the full instance.

## Tests (tests/*.spec.js) — 49 passing
- core         — load/no-errors, DOM present, mouse drawing, HUD
- camera       — wheel zoom, zoom-at-cursor, deep 1e9x precision, clamping,
                 pan, fit, reset
- tools        — pen/line/rect/ellipse/text/eraser/select/marquee/style
- history      — undo/redo, redo-clear, move reversal, z-order restore
- persistence  — reload survival, camera persist, JSON round-trip, corrupt LS
- keyboard     — all tool keys, undo/redo, select-all, delete, dup, zoom, fit

## Status: WORKING. All 110 tests green (15 spec files), stable across 2 back-to-back
## full runs. README.md written. ~2500 LOC across src/. Suite runs ~1.2min.
## Next-you: pick a feature from the TODO below, implement + test, keep the suite green.

## Added since v1 (all tested)
- **5 procedural generators** (src/generators.js): tree, spiral, droste,
  sierpinski, flowers. UI ✨ buttons + `__INFINIZOOM__.generate(name,opts,{clear,fit})`.
- **z-order**: bring-to-front/back, raise/lower. Keys `]` `[` (Ctrl = one step).
- **LOD / zoom-dependent visibility**: items carry minScale/maxScale; `setLOD`
  ('near'|'far'|'all') on selection. Renderer + pick respect it. (companion idea)
- **Recursive stamp**: `stamp({factor,depth})` drops nested shrinking copies of
  the selection → manual fractals. (companion idea)
- **Bookmarks + animated flyTo**: save camera views (persisted), fly between
  them with log-space eased zoom. Top-center bookmark bar. (companion idea)
- `tests/demo.js` gallery + deep-zoom sequence (167,000× stays crisp).
- `tests/_helpers.js → countInk()` pixel-sampling for visual assertions.

## Added in this session (batch 2, all tested)
- arrow + star/polygon item types (tools `a`/`s`, sides 3-12, star toggle) — tests/shapes.spec.js
- performance/stress test (5k items ~11ms, culling draws 1/5000) — tests/perf.spec.js
- SVG vector export (src/svg.js) — tests/svg.spec.js
- copy/cut/paste (Ctrl+C/X/V, paste centers on view) — tests/clipboard.spec.js
- demo.js: shapes frame + recursive-stamp fractal deep-zoom (self-similar at 580×)
- README.md for humans

## Added in this session (batch 3, all tested)
- per-item opacity (slider, applies to selection, JSON-safe) — tests/opacity.spec.js
- multi-touch pinch zoom test (synthetic PointerEvents) — tests/touch.spec.js
- eyedropper: Alt+click samples colour under cursor — tests/misc.spec.js
- rendering determinism tests (tolerant pixel diff) — tests/misc.spec.js
- grid styles: lines / dots / off (renderer.gridStyle + #gridStyle select) — tests/misc.spec.js

## Gotchas fixed
- Text editor: a spurious `blur` fired right as the editor opened, committing the
  empty box closed before it was usable (flaky text test). Fixed in app.js with a
  250ms open-time guard in the blur handler that re-grabs focus instead of closing.
- Determinism: exact PNG byte-equality flaked under full-suite GPU load; switched
  to a tolerant pixel-diff (<0.2%). Real renders measure ~0.0001% diff.

## Ideas / TODO (pick up here)
- [ ] dotted-grid background option / grid style toggle
- [ ] group/ungroup; rotate/scale handles on selection
- [ ] image item type (paste/drop an image, zoomable)
- [ ] connectors that stay attached to shapes
- [ ] layers panel; lock/hide items
- [ ] freehand pressure/taper (variable stroke width)
- [ ] mobile/touch toolbar layout polish

## Companion
gemma at http://127.0.0.1:8051 — chat for a second opinion if stuck (give it
4000 max_tokens; it thinks in reasoning_content first).
