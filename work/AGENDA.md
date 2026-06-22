# AGENDA — Mandelbrot Deep-Zoom Viewer (perturbation theory)

Goal: mobile-first Mandelbrot viewer reaching zoom ~2^400, JS+HTML+CSS, GPU where
it helps, extensive browser automation + integration tests, validated against
ground truth, with accurate glitch detection.

Status legend: [ ] todo · [~] in progress · [x] done & verified · [!] blocked

## M0 — Scaffold & test harness  ✅
- [x] package.json, ES-module layout, static dev server (tools/serve.mjs)
- [x] Playwright wired to a working chromium (see NOTES: NixOS browser saga)
- [x] e2e tests load the page and assert the canvas renders (18 tests, 2 projects)

## M1 — Ground-truth naive renderer (double precision)  ✅
- [x] naive.js: escape-time Mandelbrot in plain doubles (THE reference oracle)
- [x] canvas viewer with view state (center, radius, maxIter) — viewer.js
- [x] mobile touch: pinch-zoom + drag-pan + double-tap; wheel fallback
- [x] palette/coloring (smooth iteration count) — palette.js, 4 palettes
- [x] unit tests: known points (cardioid, period bulbs, escape counts)

## M2 — High-precision arithmetic
- [x] bignum.js: fixed-point BigInt real + complex (mul/cmp/toDouble/decimal IO)
- [x] unit tests vs known values, decimal round-trip, huge-prec no-overflow

## M3 — Reference orbit
- [x] reference.js: high-precision orbit Z_n at view center -> Float64 arrays
- [x] escape / maxIter handling; escapeBigInt exact single-point oracle
- [x] validate: reference orbit == naive double orbit (early iters) [test D]

## M4 — CPU perturbation engine (THE correctness core)  ✅ VALIDATED
- [x] perturb.js: delta iteration dz' = 2*Z*dz + dz^2 + dc (double precision)
- [x] Zhuoran rebasing for glitch-free single-reference rendering
- [x] Pauldelbrot glitch diagnostic exposed (rendering relies on rebasing)
- [x] render.js: reference auto-selection (relocate to deepest pixel)
- [x] VALIDATE vs BigInt-exact oracle: +/-1 at 2^45, 2^120, **2^400** [B,C,C2]
      KEY FINDING: validate vs BigInt, not naive. naive=perturb only use doubles;
      both noisy on ill-conditioned shallow boundary pixels. Dispatch naive
      (shallow) / perturb (deep) by radius. See NOTES.

## M5 — Workers + progressive deep zoom  ✅
- [x] worker.js: POOL of N module workers (navigator.hardwareConcurrency, cap 12).
      worker[0] computes the reference once + a coarse pass; row-bands are then
      fanned round-robin across the pool. ~8x faster deep render (15.7s -> 2.0s
      on the full-screen deep e2e).
- [x] progressive: instant coarse pass (step 8) then parallel full-res bands
- [x] cancellation on view change (terminate pool + generation guard)
- [x] deep-zoom: 2^41, 2^60 render glitch-free in-browser; 2^100/2^400 in Node
- [x] iteration auto-scaling with depth (autoMaxIter in render.js)

## M6 — GPU acceleration (WebGL2)  [enhancement — NOT done]
- [ ] naive GPU shader (shallow zoom, float32)
- [ ] perturbation shader: scaled deltas + rebasing; floatexp for deep
- [ ] validate GPU output vs CPU perturbation oracle (tolerance on boundary)
- [ ] auto-pick GPU/CPU by depth + device caps

## M7 — Mobile UX polish
- [~] responsive canvas/DPR (done, capped backing); tiled render + low-power TODO
- [x] palette options (4), iteration slider + auto toggle, coordinate readout
- [x] bookmarks / shareable deep-zoom coordinates (URL hash) + "Go" + presets
- [x] loading/progress UI (status line + reference-orbit progress)
- [ ] glitch overlay debug toggle (glitch count shown; visual overlay TODO)

## M8 — Extensive integration tests  ✅ (perf budgets TODO)
- [x] e2e: load, render, pan, zoom, deep-zoom-by-coordinate, palette (18 tests)
- [x] golden fingerprint determinism test (reproducible render hash)
- [x] perturbation-vs-BigInt equivalence (Node, to 2^400) + full-pipeline deep
- [ ] performance budget assertions (time-to-first-pixel, frame budget)

See NOTES.md for architecture, math, and decisions.

---
## NEXT (priority order for the next spawn)
1. GPU (M6): WebGL2 naive shader for shallow zoom first (easy, big speedup on
   the home/shallow views), then a perturbation shader (scaled deltas + rebasing,
   floatexp for very deep) reading the reference orbit as a texture. Validate GPU
   vs the CPU/BigInt oracle (allow boundary tolerance).
2. Perf: optional SharedArrayBuffer for the reference (avoid per-worker clone of
   the Z arrays — COOP/COEP already on). Marginal vs render cost; do if profiling
   shows the clone matters at huge maxIter.
3. UX: glitch visual overlay toggle; perf-budget e2e assertions (time-to-first-
   pixel, full-render budget); low-power mode (cap workers / resolution).
4. Optional: series approximation to skip initial iterations (diminishing returns
   given rebasing already works; only if deeper-than-2^400 speed is wanted).

## Progress log (newest first)
- Spawn 1: built + VALIDATED the whole correctness core and a working viewer.
  - Math: naive oracle, BigInt fixed-point, HP reference orbit, perturbation +
    Zhuoran rebasing, reference auto-selection. 26 unit tests; perturbation
    matches BigInt-exact oracle to ±1 at 2^45/2^120/2^400 and full-pipeline deep.
  - Viewer: canvas + HP view state + pinch/pan/wheel/double-tap, 4 palettes,
    iteration slider, URL-hash bookmarks, naive(shallow)/perturb(deep) dispatch.
  - Rendering: worker POOL (compute reference once, fan row-bands across cores) +
    progressive coarse-then-fine. Full-screen deep render ~8x faster than single.
  - Tests: 18 Playwright e2e (mobile+desktop) all green. Screenshots in
    screenshots/ confirm correct home + seahorse(2^41) + spiral(2^60) renders.
  - Key finding: validate vs BigInt not naive (both double-only methods are noisy
    on ill-conditioned shallow boundary pixels). See NOTES.
  - Env: NixOS has no runnable Playwright chromium; use nix-store chromium 148 +
    --headless=new (older builds crash: no /sys/devices/system/cpu). See NOTES.
