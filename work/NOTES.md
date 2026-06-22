# NOTES — architecture, math, decisions

Read this first. It is how each spawn talks to the next.

## The core idea (perturbation theory)

Mandelbrot iteration: z_{n+1} = z_n^2 + c, escapes when |z|>2.

Naive double precision dies around zoom 2^50 (53-bit mantissa). To reach 2^400 we
use **perturbation theory**:

- Pick a reference point C (the view center) and compute its orbit Z_n in HIGH
  precision (BigInt fixed-point). Z_n values are O(1) magnitude.
- For a nearby pixel c = C + dc (dc tiny), write its orbit as z_n = Z_n + dz_n.
  Subtracting the reference iteration gives the **delta iteration**:

      dz_{n+1} = 2 * Z_n * dz_n + dz_n^2 + dc

- This delta iteration runs in DOUBLE precision. Why doubles suffice for 2^400:
  double's *exponent* reaches 2^-1022, so dc ~ 2^-400 and dz ~ 2^-400 are stored
  with full 53-bit *relative* precision. We only lose precision near 2^-1000 zoom.
  So **doubles are correct to ~2^1000 zoom; 2^400 is comfortably inside.**
  Only the *reference center coordinate* needs high precision (it has ~400
  significant bits); every per-pixel quantity (dc, dz) is a normal double.

## Glitch handling — Zhuoran rebasing (primary)

Single-reference perturbation glitches when the true orbit point z_n = Z_n + dz_n
is much smaller than the reference Z_n (catastrophic cancellation: dz loses
meaning). The robust modern fix is **rebasing** (Zhuoran, fractalforums 2021):

  track reference index m and dz; the true value is z = Z_m + dz.
  each step: dz = 2*Z_m*dz + dz^2 + dc;  m += 1
  let z = Z_m + dz  (true orbit value)
  REBASE: if |z| < |dz|  (equivalently |Z_m + dz| < |dz|), then
      dz = z;  m = 0
  escape test uses |z| (the TRUE value), not |dz|.

Rebasing with Z_0 = 0 means "restart the delta against the beginning of the
reference orbit" using the true value as the new delta — glitch-free with ONE
reference. We also keep a Pauldelbrot-style check (|z|^2 < 1e-6 * |Z_m|^2) as an
independent diagnostic / test assertion, but rebasing is what we render with.

Reference must be long enough: if a pixel needs iteration k but the reference
escaped/ended at m<k, extend the reference or, after rebasing, m wraps to 0 and we
keep going up to that pixel's maxIter. We compute the reference to maxIter and, if
it escapes early, we still keep Z_n for n up to escape (Z stays defined; for the
classic "Z_0=0" reference of the center, if the *center* escapes the location is
outside the set anyway).

## Validation strategy (against ground truth)

`naive.js` is the ORACLE: plain-double escape-time Mandelbrot. At shallow zoom
(<= ~2^40) it is exact. Every higher layer is validated against it:

1. bignum complex mul/sqr vs known products & vs JS Number at low precision.
2. reference orbit (high precision) vs naive double orbit at shallow zoom -> equal.
3. **perturbation per-pixel escape counts == naive per-pixel counts** over a grid
   at shallow zoom. This is the make-or-break test (M4). If perturbation matches
   the oracle exactly where the oracle is valid, the engine is correct; we then
   trust it where the oracle can't reach (deep zoom).
4. Deep-zoom smoke tests assert "no glitch pixels" via the Pauldelbrot diagnostic
   and visual/structural checks.

## High precision: fixed-point BigInt

A real value v is stored as a BigInt `m` with v = m / 2^PREC (two's-complement
sign via BigInt sign). PREC ~ zoomBits + 64 guard bits.
- add/sub: BigInt +/- .
- mul: (a*b) then arithmetic shift right by PREC (with round-to-nearest).
- We only need: complex add, complex sqr (for z^2), complex mul, magnitude
  compare vs 4 (escape), and toDouble for export.
Reference orbit needs ~maxIter such iterations; done in a Web Worker with
progress. PREC chosen from view radius: PREC = ceil(-log2(radius)) + 64.

## Why CPU-first, GPU-later

- CPU double perturbation in Web Workers is *correct* to 2^400 and easy to
  validate against the oracle. It is the foundation.
- GPU float32 CANNOT represent 2^-400 deltas (min normal ~2^-126). Deep-zoom GPU
  needs scaled deltas + per-pixel rescale ("floatexp") or double-emulation — more
  complex and harder to validate. So GPU is M6, an accelerator, not the base.
- Mobile: progressive low-res-first + tiling + workers keeps it interactive even
  on CPU. GPU added later for shallow/medium zoom speed.

## Module layout
- src/math/naive.js      — oracle escape-time (doubles)         [pure, Node+browser]
- src/math/bignum.js     — fixed-point BigInt real/complex      [pure]
- src/math/reference.js  — high-precision reference orbit        [pure]
- src/math/perturb.js    — delta iteration + rebasing            [pure]
- src/math/palette.js    — smooth coloring                       [pure]
- src/worker.js          — pool worker: 'computeRef' (once) + 'render' bands
- src/math/render.js     — reference auto-selection + renderImage + dispatch
- src/viewer.js          — canvas, view state, touch/zoom, render orchestration
- src/main.js            — UI wiring (sliders, readouts, URL hash)
- index.html, styles.css
- test/unit/*.mjs        — Node test runner (node --test)
- test/e2e/*.spec.mjs    — Playwright
- tools/serve.mjs        — static server for dev + e2e

Pure math modules must import-cleanly in BOTH Node (tests) and the browser
(workers), so: no DOM, no top-level await, plain ESM exports.

## View-state representation
- center: {x: BigInt, y: BigInt, prec: PREC}  (high precision)
- radius (half-height of view in complex plane): a Number (double) — fine since
  >= ~2^-1000. zoom "level" displayed as log2(baseRadius/radius).
- maxIter: Number, auto-scaled with depth.
- For shallow zoom the high-precision center still works (PREC just small).

## Decisions / dead-ends log

### Engine dispatch by depth (IMPORTANT, validated empirically)
Double-precision perturbation stores the reference orbit as doubles (Z_n ~ O(1),
53-bit). At SHALLOW zoom (radius ~0.02) dc is large, so the per-pixel delta dz
grows to O(1) within a few iterations and the whole computation is only ~53-bit —
i.e. NO better than naive there. On ultra-sensitive boundary pixels (near
Misiurewicz points, high escape counts) double perturbation is then off by tens
of iterations and can even misclassify inside/outside. Measured at radius 0.02,
maxIter 1500: ~5/6400 pixels wrong, one inside-point reported as escaped.

At DEEP zoom dc ~ 2^-N is tiny, dz stays tiny far longer, so effective precision
is much higher and perturbation matches the BigInt-exact oracle to +/-1 (verified
by tests B/C/E at 2^45, 2^120, and a rebasing case). This is the regime
perturbation exists for.

DECISION: render NAIVE doubles for radius >= ~2^-40 (fast, GPU-able, standard,
as accurate as any double method there) and PERTURBATION for radius < ~2^-40.
They are NOT required to agree bit-for-bit on ill-conditioned shallow boundary
pixels — the BigInt orbit is the only true oracle there, and any 53-bit method
(naive OR perturbation) is noisy on that measure-zero set. See render.js
engineForRadius().

### BigInt reference precision / guard bits
precForRadius(radius, guard=64) sets prec = zoomBits + guard. For the EXACT
single-point BigInt oracle near sensitive boundary points, guard=64 was not
always enough (a point at radius 0.02 needed prec ~150 to converge its exact
count). For the perturbation *reference* (stored as double anyway) guard=64 is
fine in the deep regime (B/C/E pass). The exact-oracle tests use a generous prec.

### Validate against BigInt, not naive
naive is only an oracle where double is reliable (low/medium escape counts, not
ultra-sensitive boundary). The authoritative oracle is escapeBigInt (full BigInt,
high prec). All strict correctness assertions compare perturbation to BigInt.

## Running a browser in THIS sandbox (NixOS) — load-bearing, read before e2e
The Playwright-downloaded chromium (build 1228 in ~/.cache/ms-playwright) CANNOT
run here: it's a generic ELF whose interpreter /lib64/ld-linux-x86-64.so.2 does
not exist on NixOS -> spawn ENOENT. Fix: use a nix-store chromium instead.
- playwright.config.mjs resolves /nix/store/*-chromium-*/bin/chromium at load.
- Use the NEWEST build (148): older ones (143) crash with SIGTRAP because this
  sandbox has NO /sys/devices/system/cpu (Chromium reads it at startup). 148
  tolerates it; 143 does not.
- Must use NEW headless: pass '--headless=new' (appended after Playwright's own
  '--headless', last-wins). Old headless crashes. Also: --no-sandbox,
  --disable-dev-shm-usage, --disable-gpu, --enable-unsafe-swiftshader.
- Port 8080 is often busy on this host; default is now 8137. Override with PORT=.
- Verify a browser manually:  /nix/store/<...>-chromium-148*/bin/chromium \
    --headless=new --no-sandbox --remote-debugging-port=9333 about:blank &
  then curl http://127.0.0.1:9333/json/version
- Playwright 1.61.0 is pinned (its bundled build == cached 1228). Using nix
  chromium 148 over CDP 1.3 works fine despite the version skew.

## How to run
- `npm install`            (installs Playwright 1.61.0)
- `npm test`               (26 Node unit tests — the correctness oracle suite)
- `npm run serve`          (static server on :8137, COOP/COEP set)
- `npm run e2e`            (18 Playwright tests, mobile + desktop projects)
- `node tools/shoot.mjs`   (capture screenshots/ — needs server running)

## Performance / scaling reality (single worker today)
~300M iteration-steps/sec single thread. A full-screen deep view (e.g. 2^100 at
~60k iters over ~500k px) is ~tens of seconds single-threaded. Progressive passes
make it usable (coarse image fast), but the NEXT big win is multi-worker tiling
(fan tiles across cores; share the one reference orbit via SharedArrayBuffer —
COOP/COEP already enabled). Then GPU for shallow/medium. Deep zoom correctness is
done and validated; this is purely about speed.
