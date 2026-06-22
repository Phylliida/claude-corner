// viewer.js — canvas + high-precision view state + gestures + progressive render.
//
// View state:
//   cx, cy : BigInt fixed-point center at precision `prec`
//   radius : double, half-height of the view in the complex plane
//   maxIter
// Gestures manipulate a preview transform of the last stable image (instant
// feedback); on gesture end the transform is folded into the view state and a
// real render is kicked off in the worker.

import {
  fromDecimalString, toDecimalString, fromDouble, toDouble, precForRadius,
} from './math/bignum.js';
import { engineForRadius, autoMaxIter } from './math/render.js';
import { colorizeBlocks, colorizeRegion } from './palette.js';

const GUARD_BITS = 80;
const MAX_BACKING = 1100;     // cap render resolution for mobile perf

export class Viewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.stable = document.createElement('canvas'); // last completed render
    this.sctx = this.stable.getContext('2d', { alpha: false });

    // view state
    this.prec = precForRadius(1.5, GUARD_BITS);
    this.cx = fromDecimalString('-0.5', this.prec);
    this.cy = fromDecimalString('0', this.prec);
    this.radius = 1.5;
    this.maxIter = autoMaxIter(this.radius);
    this.autoIter = true;

    // coloring
    this.paletteOpts = { paletteId: 'ultra', cycle: 48, shift: 0, interior: [0, 0, 0] };

    // render plumbing (worker pool)
    this._pool = [];
    this.poolSize = Math.max(1, Math.min(opts.poolSize || (navigator.hardwareConcurrency || 4), 12));
    this.bandRows = 16;
    this.gen = 0;
    this.img = null;          // ImageData of current render
    this.dpr = 1;
    this.backingW = 0; this.backingH = 0;
    this.rendering = false;
    this._tilesLeft = 0;
    this._glitchAcc = 0;
    this._refMeta = null;
    this.onStatus = opts.onStatus || (() => {});
    this.onView = opts.onView || (() => {});

    // gesture transform (backing-pixel space): displayed = a*orig + (e,f)
    this.T = null;
    this._pointers = new Map();
    this._pinch = null;
    this._lastTap = 0;

    this._installGestures();
  }

  // ---- sizing ----
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(rect.width * dpr);
    let h = Math.round(rect.height * dpr);
    // cap backing resolution
    const scale = Math.min(1, MAX_BACKING / Math.max(w, h));
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    this.dpr = dpr * scale;
    this.backingW = w; this.backingH = h;
    this.canvas.width = w; this.canvas.height = h;
    this.stable.width = w; this.stable.height = h;
    this.cssW = rect.width; this.cssH = rect.height;
    this.render();
  }

  // CSS pointer coords -> backing pixel coords
  _toBacking(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width * this.backingW,
      y: (clientY - rect.top) / rect.height * this.backingH,
    };
  }

  // complex offset (double) of a backing pixel from the view center
  _pixelDelta(px, py) {
    const aspect = this.backingW / this.backingH;
    const scale = (2 * this.radius) / this.backingH;
    return { dx: -this.radius * aspect + px * scale, dy: -this.radius + py * scale };
  }

  _setPrec(newPrec) {
    if (newPrec === this.prec) return;
    if (newPrec > this.prec) {
      const s = BigInt(newPrec - this.prec);
      this.cx <<= s; this.cy <<= s;
    } else {
      const s = BigInt(this.prec - newPrec);
      this.cx >>= s; this.cy >>= s;
    }
    this.prec = newPrec;
  }

  // ---- view operations ----
  zoomAt(px, py, factor) {
    // keep the complex point under (px,py) fixed while radius *= factor
    const { dx, dy } = this._pixelDelta(px, py);
    this.cx += fromDouble(dx * (1 - factor), this.prec);
    this.cy += fromDouble(dy * (1 - factor), this.prec);
    this.radius *= factor;
    this._afterRadiusChange();
  }

  panBacking(dxPix, dyPix) {
    const scale = (2 * this.radius) / this.backingH;
    this.cx -= fromDouble(dxPix * scale, this.prec);
    this.cy -= fromDouble(dyPix * scale, this.prec);
  }

  _afterRadiusChange() {
    const want = precForRadius(this.radius, GUARD_BITS);
    if (want > this.prec) this._setPrec(want);
    if (this.autoIter) this.maxIter = autoMaxIter(this.radius);
  }

  zoomLevel() { return Math.log2(1.5 / this.radius); }

  getState() {
    return {
      cx: toDecimalString(this.cx, this.prec, Math.ceil(this.prec / 3.32) + 5),
      cy: toDecimalString(this.cy, this.prec, Math.ceil(this.prec / 3.32) + 5),
      radius: this.radius,
      maxIter: this.maxIter,
      zoom: this.zoomLevel(),
    };
  }

  setState(s) {
    if (s.radius) this.radius = +s.radius;
    this.prec = precForRadius(this.radius, GUARD_BITS);
    if (s.cx != null) this.cx = fromDecimalString(String(s.cx), this.prec);
    if (s.cy != null) this.cy = fromDecimalString(String(s.cy), this.prec);
    if (s.maxIter) { this.maxIter = +s.maxIter; this.autoIter = false; }
    else if (this.autoIter) this.maxIter = autoMaxIter(this.radius);
    this.render();
  }

  setMaxIter(v) { this.maxIter = v; this.autoIter = false; this.render(); }
  setAutoIter(on) { this.autoIter = on; if (on) { this.maxIter = autoMaxIter(this.radius); this.render(); } }
  setPalette(opts) {
    Object.assign(this.paletteOpts, opts);
    // recolor instantly from existing sn data if available
    if (this.img && this._sn) this._recolor();
    else this.render();
  }

  // ---- rendering (worker pool) ----
  _terminatePool() {
    for (const w of this._pool) { try { w.terminate(); } catch { /* noop */ } }
    this._pool = [];
  }

  _spawnPool() {
    this._terminatePool();
    for (let i = 0; i < this.poolSize; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      const gen = this.gen;
      w.onmessage = (e) => this._onWorker(e.data, gen);
      w.onerror = (err) => this.onStatus({ error: String(err.message || err) });
      this._pool.push(w);
    }
  }

  render() {
    if (!this.backingW) return;
    this.gen++;
    this.T = null; // clear preview transform; we render fresh
    this.img = this.ctx.createImageData(this.backingW, this.backingH);
    this._sn = new Float64Array(this.backingW * this.backingH); // full-res sn cache
    this._sn.fill(-2); // -2 = not yet computed
    this.rendering = true;
    this._glitchAcc = 0;
    this._refMeta = null;

    const engine = engineForRadius(this.radius);
    this._spawnPool();
    // worker[0] computes the reference (or naive params) + a coarse pass
    this._pool[0].postMessage({
      type: 'computeRef', gen: this.gen,
      cxRaw: this.cx.toString(), cyRaw: this.cy.toString(), prec: this.prec,
      radius: this.radius, width: this.backingW, height: this.backingH,
      maxIter: this.maxIter, engine,
    });
    this.onView(this.getState());
    this.onStatus({ phase: 'start', engine, maxIter: this.maxIter, zoom: this.zoomLevel() });
  }

  _distributeBands(params) {
    // round-robin row-bands across the pool for load balance (interleaved so
    // each worker gets a spread of cheap + expensive rows)
    const H = this.backingH, P = this._pool.length, B = this.bandRows;
    const starts = [];
    for (let y = 0; y < H; y += B) starts.push(y);
    this._tilesLeft = this._pool.length;
    for (let w = 0; w < P; w++) {
      const bands = [];
      for (let k = w; k < starts.length; k += P) bands.push(starts[k]);
      // postMessage structured-clones `params` (incl. the ref arrays) per send,
      // so each worker gets its own copy — no manual cloning, no transfer.
      this._pool[w].postMessage({
        type: 'render', gen: this.gen, params, bands, bandRows: B,
        width: this.backingW, height: this.backingH,
      });
    }
  }

  _onWorker(m, gen) {
    if (gen !== this.gen) return; // stale message from a superseded render
    if (m.type === 'progress') {
      this.onStatus({ phase: m.phase, i: m.i, total: m.total });
    } else if (m.type === 'refReady') {
      this._refMeta = { engine: m.engine, refLen: m.refLen, relocations: m.relocations };
      const c = m.coarse;
      colorizeBlocks(this.img.data, c.sn, this.backingW, this.backingH, c.snW, c.snH, c.step, this.paletteOpts);
      this.ctx.putImageData(this.img, 0, 0);
      this._distributeBands(m.params); // params keeps the (transferred-back) arrays
    } else if (m.type === 'band') {
      const sn = m.sn;
      for (let j = 0; j < m.h; j++) {
        const dst = (m.y0 + j) * this.backingW;
        const src = j * m.w;
        for (let i = 0; i < m.w; i++) this._sn[dst + i] = sn[src + i];
      }
      colorizeRegion(this.img.data, sn, this.backingW, { x0: m.x0, y0: m.y0, w: m.w, h: m.h }, this.paletteOpts);
      this.ctx.putImageData(this.img, 0, 0, m.x0, m.y0, m.w, m.h);
    } else if (m.type === 'tilesDone') {
      this._glitchAcc += m.glitches;
      this._tilesLeft--;
      if (this._tilesLeft <= 0) {
        this.rendering = false;
        this.sctx.drawImage(this.canvas, 0, 0); // snapshot for gesture previews
        const meta = this._refMeta || {};
        this.onStatus({ phase: 'done', glitches: this._glitchAcc, refLen: meta.refLen || 0, relocations: meta.relocations || 0, engine: meta.engine, zoom: this.zoomLevel() });
      }
    } else if (m.type === 'error') {
      this.rendering = false;
      this.onStatus({ error: m.message });
    }
  }

  _recolor() {
    // recolor whole image from cached sn (instant palette change)
    colorizeRegion(this.img.data, this._sn, this.backingW,
      { x0: 0, y0: 0, w: this.backingW, h: this.backingH }, this.paletteOpts);
    this.ctx.putImageData(this.img, 0, 0);
    this.sctx.drawImage(this.canvas, 0, 0);
  }

  // ---- gesture preview ----
  _applyPreview() {
    const t = this.T;
    this.ctx.save();
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.backingW, this.backingH);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.setTransform(t.a, 0, 0, t.a, t.e, t.f);
    this.ctx.drawImage(this.stable, 0, 0);
    this.ctx.restore();
  }

  _beginGesture() {
    if (!this.T) this.T = { a: 1, e: 0, f: 0 };
    this._terminatePool(); this.rendering = false; // stop any in-flight render
  }

  _endGesture() {
    if (!this.T) return;
    const t = this.T;
    const W = this.backingW, H = this.backingH;
    // complex point now shown at screen center, from the OLD stable image
    const ox = (W / 2 - t.e) / t.a;
    const oy = (H / 2 - t.f) / t.a;
    const { dx, dy } = this._pixelDelta(ox, oy);
    this.cx += fromDouble(dx, this.prec);
    this.cy += fromDouble(dy, this.prec);
    this.radius = this.radius / t.a;
    this._afterRadiusChange();
    this.T = null;
    this.render();
  }

  _installGestures() {
    const c = this.canvas;
    c.style.touchAction = 'none';

    const down = (ev) => {
      c.setPointerCapture?.(ev.pointerId);
      this._pointers.set(ev.pointerId, this._toBacking(ev.clientX, ev.clientY));
      if (this._pointers.size === 1) {
        // possible double-tap
        const now = Date.now();
        if (now - this._lastTap < 300) { this._doubleTap(ev); this._lastTap = 0; }
        else this._lastTap = now;
        this._beginGesture();
      } else if (this._pointers.size === 2) {
        const pts = [...this._pointers.values()];
        this._pinch = {
          startDist: dist(pts[0], pts[1]),
          startMid: mid(pts[0], pts[1]),
        };
        this._beginGesture();
      }
    };
    const move = (ev) => {
      if (!this._pointers.has(ev.pointerId)) return;
      const prev = this._pointers.get(ev.pointerId);
      const cur = this._toBacking(ev.clientX, ev.clientY);
      this._pointers.set(ev.pointerId, cur);
      if (!this.T) return;
      if (this._pointers.size === 1) {
        // pan
        this.T.e += cur.x - prev.x;
        this.T.f += cur.y - prev.y;
        this._applyPreview();
      } else if (this._pointers.size === 2 && this._pinch) {
        const pts = [...this._pointers.values()];
        const d = dist(pts[0], pts[1]);
        const mp = mid(pts[0], pts[1]);
        const k = d / (this._pinch._lastDist || this._pinch.startDist);
        // scale around current midpoint
        this.T.a *= k;
        this.T.e = mp.x + (this.T.e - mp.x) * k;
        this.T.f = mp.y + (this.T.f - mp.y) * k;
        // translate by midpoint movement
        if (this._pinch._lastMid) {
          this.T.e += mp.x - this._pinch._lastMid.x;
          this.T.f += mp.y - this._pinch._lastMid.y;
        }
        this._pinch._lastDist = d;
        this._pinch._lastMid = mp;
        this._applyPreview();
      }
    };
    const up = (ev) => {
      if (!this._pointers.has(ev.pointerId)) return;
      this._pointers.delete(ev.pointerId);
      if (this._pointers.size === 0) {
        this._pinch = null;
        this._endGesture();
      } else if (this._pointers.size === 1) {
        // transition pinch -> pan; reset pinch refs
        this._pinch = null;
      }
    };
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);

    // wheel zoom (desktop)
    c.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = this._toBacking(ev.clientX, ev.clientY);
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
      this.zoomAt(p.x, p.y, factor);
      this.render();
    }, { passive: false });
  }

  _doubleTap(ev) {
    const p = this._toBacking(ev.clientX, ev.clientY);
    this._pointers.clear();
    this.T = null;
    this.zoomAt(p.x, p.y, 0.5);
    this.render();
  }
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
