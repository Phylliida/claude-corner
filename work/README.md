# Mandelbrot Deep Zoom

A mobile-first Mandelbrot viewer that zooms past the limits of double precision
using **perturbation theory** with **Zhuoran rebasing** for glitch-free deep
zoom. Pure JS + HTML + CSS, no build step. The perturbation engine is validated
against a BigInt-exact oracle to **2^400**.

![home](screenshots/home.png)

## Try it

```bash
npm install        # Playwright 1.61.0 (for the e2e tests)
npm run serve      # http://127.0.0.1:8137
```

Open the URL on a phone or in a browser. Pinch / drag to zoom and pan, double-tap
to zoom in, scroll-wheel on desktop. The ☰ button opens controls: iteration
count, palettes, a precise coordinate box, and shareable deep-zoom links.

## How it works

- **Shallow zoom** (radius ≥ ~2⁻⁴⁰): plain double-precision escape-time
  (`src/math/naive.js`) — fast and exact at that scale.
- **Deep zoom**: a high-precision **reference orbit** is computed once in BigInt
  fixed-point (`src/math/bignum.js`, `reference.js`), then every pixel is solved
  by the double-precision **delta iteration** `δ' = 2·Z·δ + δ² + δc`
  (`perturb.js`). **Zhuoran rebasing** restarts the delta whenever it would lose
  precision, giving glitch-free images from a single reference.
- The reference is **auto-relocated** to the deepest pixel so it always lasts
  long enough (`render.js`).
- A **Web Worker** renders progressively (coarse → fine) and streams smooth
  iteration counts back; the main thread colors them (`palette.js`), so palette
  changes are instant.

See `NOTES.md` for the math, precision analysis, and design decisions, and
`AGENDA.md` for status and what's next (multi-worker, GPU).

## Correctness & tests

- `npm test` — 26 Node unit tests. The key ones compare the perturbation engine
  against a **BigInt-exact oracle** (`escapeBigInt`) pixel-for-pixel at
  2⁴⁵, 2¹²⁰, 2¹⁰⁰ and **2⁴⁰⁰** (±1 iteration, the floating-point boundary limit).
- `npm run e2e` — 18 Playwright tests across a mobile and a desktop profile:
  loads, renders, pans, zooms, deep-zoom-by-coordinate, palette recolor,
  URL-hash round-trip, deterministic golden fingerprint, and a glitch-free
  perturbation render check.

> NixOS note: the Playwright-bundled Chromium can't run here; the config uses a
> nix-store Chromium with `--headless=new`. Details in `NOTES.md`.

## Project layout

```
index.html, styles.css      mobile-first UI
src/main.js                 UI wiring, status, URL-hash bookmarks
src/viewer.js               canvas, HP view state, gestures, render orchestration
src/worker.js               progressive render worker
src/palette.js              smooth-count -> RGB
src/math/naive.js           double-precision oracle
src/math/bignum.js          fixed-point BigInt reals (decimal/double IO)
src/math/reference.js       high-precision reference orbit + BigInt-exact oracle
src/math/perturb.js         perturbation delta iteration + rebasing
src/math/render.js          reference auto-selection + full render + engine dispatch
test/unit/*.test.mjs        node --test correctness suite
test/e2e/*.spec.mjs         Playwright integration tests
tools/serve.mjs             static dev server (COOP/COEP)
tools/shoot.mjs             screenshot capture
```
