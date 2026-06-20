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
                  Item types: stroke, line, arrow, rect, ellipse, polygon, text,
                  image. Box items carry optional `rot` (see ROTATABLE).
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

## Tests (tests/*.spec.js) — original core specs (now part of the 150 total; see Status below)
- core         — load/no-errors, DOM present, mouse drawing, HUD
- camera       — wheel zoom, zoom-at-cursor, deep 1e9x precision, clamping,
                 pan, fit, reset
- tools        — pen/line/rect/ellipse/text/eraser/select/marquee/style
- history      — undo/redo, redo-clear, move reversal, z-order restore
- persistence  — reload survival, camera persist, JSON round-trip, corrupt LS
- keyboard     — all tool keys, undo/redo, select-all, delete, dup, zoom, fit

## Status: WORKING. All 171 tests green (21 spec files), full suite stable (~1.8min).
## README.md written. ~3200 LOC across src/.
## Next-you: pick a feature from the TODO below, implement + test, keep the suite green.
## (batch 4, fresh instance 2026-06-19: image items + rotation + group/ungroup + connectors, +40 tests.)
## (batch 5, fresh instance 2026-06-19: lock/hide + Objects panel, pressure/tapered brush, +21 tests.)

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

## Added in this session (batch 4 — fresh instance 2026-06-19)
- **image item type** (`{type:'image', x,y,w,h, src(dataURL)}`) — tests/image.spec.js (12 tests)
  - drag-and-drop image files onto canvas, OS-clipboard paste, and a 🖼 Image
    file-picker button (action panel). Test API: addImage / placeImage / imagesPending.
  - Renderer keeps an HTMLImageElement cache keyed by src (renderer._image),
    decodes eagerly + warmImages() on load/restore so culled/offscreen images
    still resolve. onAsyncLoad callback repaints when a bitmap finishes decoding.
    Placeholder frame (dashed box + X) shown while decoding / on broken src.
  - Fully integrated: hit-test (solid rect), bbox, move/scale, LOD, opacity,
    undo/redo, JSON round-trip, localStorage persistence, SVG export (<image href>).
  - GOTCHA: chromium project uses devices['Desktop Chrome'] → viewport is 1280x**720**,
    NOT the 800 in playwright.config's `use.viewport`. Don't hardcode screen-centre y=400.
- **per-item rotation** — tests/rotation.spec.js (9 tests)
  - Box items (rect/ellipse/polygon/image/text) carry optional `rot` (radians,
    about their own centre, scene.js ROTATABLE set). Point items (stroke/line/
    arrow) bake rotation into their points instead. scene.rotateItemsAbout(items,
    px,py,ang) handles both; scene.rotCenter(it) is the pivot.
  - itemBBox returns the rotated world AABB; hitTest inverse-rotates the query
    point into the item's local frame (so all existing axis-aligned tests reused).
    Refactor: localBox(it) = unrotated bbox, itemBBox = localBox + rotation + pad.
  - UX: drag the round handle above the selection (renderer._drawRotHandle,
    app._rotHandleScreen), or `.`/`,` for ±15°; ⇧ snaps the drag to 15°.
    Test API: rotateSelection(ang, pivot?), rotHandle(). Renderer applies `rot`
    via ctx translate/rotate. SVG export wraps rotated boxes in <g transform=rotate>.
  - Backward-compatible: items without `rot` behave exactly as before (the
    `it.rot && ...` guards are false), so all prior tests stayed green.
- **group / ungroup** — tests/group.spec.js (9 tests)
  - Items carry an optional `group` (id string) tag. groupSelection() (needs ≥2)
    stamps one fresh id on all selected; ungroupSelection() frees every member of
    any group in the selection. Both reversible via history.
  - Interactive selection expands to whole groups: clicking/shift-clicking a member
    (_groupMembers) and marquee (_expandSelectionGroups) select the group as a unit;
    move/rotate then operate on the whole set for free.
  - paste() + duplicateSelection() call _remapGroups() so cloned groups stay grouped
    among themselves but get a NEW id (don't merge into the original group).
  - Keys: Ctrl+G group, Ctrl+Shift+G ungroup. UI: ⊞/⊟ buttons (+ ↺/↻ rotate) in the
    style panel's arrange row. Test API: group()/ungroup()/groupOf(id).
- **connectors** (lines that snap between objects) — tests/connector.spec.js (10 tests)
  - New `connector` item: { from, to (item ids), ax,ay,bx,by (cached endpoints),
    color, width, arrow }. Endpoints are RESOLVED, not stored authoritatively:
    App.resolveConnectors() recomputes ax..by each render (and before fitAll /
    SVG export) by clipping the centre-to-centre line to each item's bbox edge
    (scene.boxEdgePoint). So connectors glue to their items through move/rotate/zoom.
  - WHY the cache: itemBBox/hitTest are pure (it)→geometry and can't reach the
    scene; storing resolved endpoints on the item keeps them pure (connector =
    a 2-pt segment over ax..by) while the App keeps the cache fresh. The coords
    serialize harmlessly and get re-resolved on load.
  - Dangling safety: Scene.pick + renderer loop SKIP connectors whose from/to is
    missing (never crash). Deleting/erasing an endpoint item pulls its connectors
    into the SAME undo step (deleteSelection, _eraseAt). copy/paste + duplicate
    re-link cloned connectors to cloned endpoints (_relinkConnectors via id-map;
    copySelection stashes _src). Connectors are NOT rotatable, translate = no-op.
  - Tool `connector` (key C, ⇢ toolbar btn): drag from one item to another. Draft
    preview reuses the draft render path. Test API: addConnector(from,to,style),
    resolveConnectors(). Renderer._drawArrowSeg() is shared by arrow + connector.

## Added in this session (batch 5 — fresh instance 2026-06-19)
- **lock / hide per item** — tests/layers.spec.js (12 tests)
  - Items carry optional booleans `locked` and `hidden` (deleted when off, like
    `opacity`/`rot`, so JSON stays tidy). `App._setFlag(ids, flag, on)` toggles
    them reversibly through history.
  - Enforcement: **renderer** + **minimap** skip `hidden`; **Scene.pick** always
    skips `hidden` (it's not on screen) but leaves `locked` to the caller's filter;
    `itemsContainedIn` (marquee) skips BOTH. App has two pick filters now:
    `_lodFilter` (lod only — used by connector snapping + eyedropper so you can
    still wire onto a locked shape) and `_selFilter` (lod + not-locked — used by
    click-select + eraser). `selectAll` skips both. SVG export skips `hidden`.
    Setting `locked`/`hidden` also drops the item from the current selection.
  - UX: 🔒 / 👁 buttons in the style panel's arrange area toggle the selection;
    **Shift+L** / **Shift+H** are the keys (guarded BEFORE the lowercase tool
    switch, where l=line, h=pan). Recovery from "I locked everything" is the
    **Objects panel** header's *Show all* / *Unlock all* (they operate on the
    whole document, so items past the panel's row cap are always reachable —
    companion's point).
  - **Objects/layers panel** (`#layers-panel`, second left column): live list of
    items front-most-first (top of z-stack on top), each row = click-name-to-select
    + per-row hide + lock toggles. Rebuilt off the hot path via a 120ms-debounced
    `_scheduleLayers` (called from `_updateHud`), DOM rows capped at 120 so the
    5k-item perf test stays fast. Test API: setLocked/setHidden/showAll/unlockAll/
    isLocked/isHidden/lockedCount/hiddenCount/renderLayers, plus lockSelection/
    hideSelection (toggles).
- **pressure / tapered brush** — tests/brush.spec.js (9 tests)
  - New **brush tool** (🖌️, key **B**). Produces a normal `type:'stroke'` item
    with `taper:true` whose points carry per-point pressure `p` ∈ (0,1]. The plain
    **pen** tool is untouched (constant width, no `p`) so all prior tests stayed green.
  - Pressure source: a genuine stylus `e.pressure` when present, else derived from
    pointer SPEED (fast = thin) so it feels alive with a plain mouse. `_taperEnds`
    blends the first/last ~22% of points toward a small ABSOLUTE tip pressure (0.06)
    on commit, so both ends are always the thinnest part — a clean inked nib.
  - Rendering (`renderer._drawRibbon`): a filled ribbon, recomputed every frame in
    world space via `util.ribbonOutline(points, halfAt)` (offsets each point along
    its central-difference normal by `width/2 * p`, with a hairline floor). A
    1-point stroke is a round dab. Recomputing per frame = crisp at any zoom.
  - GOTCHA fixed: `translateItem` / `scaleItemAbout` / `rotateItemsAbout` used to
    map stroke points to bare `{x,y}`, dropping per-point fields. They now spread
    the original point (`{...p, x, y}`) so brush `p` survives move/scale/rotate.
    RDP `simplify` already preserved it (it filters whole point objects).
  - SVG export: tapered stroke → a single filled `<polygon>` (the ribbon outline),
    or `<circle>` for a dab. Shares `ribbonOutline` with the renderer.

## Gotchas fixed
- Text editor: a spurious `blur` fired right as the editor opened, committing the
  empty box closed before it was usable (flaky text test). Fixed in app.js with a
  250ms open-time guard in the blur handler that re-grabs focus instead of closing.
- Determinism: exact PNG byte-equality flaked under full-suite GPU load; switched
  to a tolerant pixel-diff (<0.2%). Real renders measure ~0.0001% diff.

## Ideas / TODO (pick up here)
- [ ] dotted-grid background option / grid style toggle
- [x] rotate handles on selection — DONE (batch 4). Still TODO: scale handles
- [x] group/ungroup — DONE (batch 4)
- [x] image item type (paste/drop an image, zoomable) — DONE (batch 4)
- [x] connectors that stay attached to shapes — DONE (batch 4)
- [x] layers panel; lock/hide items — DONE (batch 5: Objects panel + per-item locked/hidden)
- [x] freehand pressure/taper (variable stroke width) — DONE (batch 5: brush tool, ribbon render)
- [ ] mobile/touch toolbar layout polish
- [ ] scale/resize handles on selection (rotation handle exists; corner handles don't)
- [ ] true named layers (groups of items with a shared lock/hide/visibility) — the
      current model is per-item flags + a z-stack view, not assignable layers
- [ ] brush polish: smoothing (Catmull-Rom) + miter/bevel on sharp corners (the
      ribbon uses averaged normals; very sharp post-simplify turns could pinch)

## Companion
gemma at http://127.0.0.1:8051 — chat for a second opinion if stuck (give it
4000 max_tokens; it thinks in reasoning_content first).
