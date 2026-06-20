import { Camera } from './camera.js';
import { Scene, makeStroke, makeLine, makeRect, makeEllipse, makeText, makeArrow, makePolygon,
         makeImage, makeConnector, boxEdgePoint, translateItem, scaleItemAbout, rotateItemsAbout,
         itemBBox, lodVisible } from './scene.js';
import { Renderer } from './renderer.js';
import { Minimap } from './minimap.js';
import { History, addItemsCmd, removeItemsCmd, moveItemsCmd, reorderCmd } from './history.js';
import { simplify, debounce, clamp, dist, formatZoom, formatCoord, pointInRect, catmullRom } from './util.js';
import { GENERATORS } from './generators.js';
import { sceneToSVG } from './svg.js';
import * as storage from './storage.js';

const PALETTE = [
  '#e8e8ef', '#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9',
  '#4dabf7', '#5b8cff', '#b197fc', '#f783ac', '#9c6644', '#0e0f13',
];

/** Move selected ids one step toward front (dir>0) or back (dir<0), keeping
 *  relative order and never letting selected items pass through each other. */
function shiftOrder(ids, sel, dir) {
  const arr = ids.slice();
  if (dir > 0) {
    for (let i = arr.length - 2; i >= 0; i--)
      if (sel.has(arr[i]) && !sel.has(arr[i + 1])) { const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t; }
  } else {
    for (let i = 1; i < arr.length; i++)
      if (sel.has(arr[i]) && !sel.has(arr[i - 1])) { const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t; }
  }
  return arr;
}

class App {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.camera = new Camera(window.innerWidth, window.innerHeight);
    this.scene = new Scene();
    this.renderer = new Renderer(this.canvas, this.camera);
    this.history = new History(this.scene);
    this.minimap = new Minimap(document.getElementById('minimap'), this.camera, this.scene);

    this.tool = 'pen';
    this.style = { color: '#e8e8ef', width: 3, fill: null, fillOn: false, fillColor: '#5b8cff',
                   textSize: 24, sides: 5, star: true, opacity: 1, widthMode: 'world' };
    this.snap = false;
    this.brushSmooth = true;     // Catmull-Rom smoothing for new brush strokes

    // Stop-motion flipbook ("sticky-note flipbook — draw each page"). OFF by
    // default, so the app is a normal infinite canvas until you turn it on.
    // Each item carries an optional `frame` (0-based page; absent = page 0).
    this.anim = { on: false, current: 0, count: 1, onion: 1, fps: 6,
                  tint: true, loop: true, playing: false };
    this._playTimer = null;

    // interaction state
    this.draft = null;
    this.selectedIds = new Set();
    this.marquee = null;
    this.eraserCursor = null;
    this.pointers = new Map();   // pointerId -> {x,y} screen
    this.active = null;          // current single-pointer gesture
    this.pinch = null;
    this.spaceDown = false;
    this.mouseWorld = { x: 0, y: 0 };

    this._dirty = true;
    this._stats = { frames: 0, lastRenderMs: 0 };

    this.autosave = debounce(() => storage.saveLocal(this.scene, this.camera), 400);
    // rebuild the Objects/layers list off the hot path (coalesces edit bursts)
    this._scheduleLayers = debounce(() => this._renderLayers(), 120);

    this.scene.onChange = () => { this.requestRender(); this.autosave(); this._updateHud(); };
    this.history.onChange = () => { this._updateUndoRedo(); };
    // repaint when a deferred image bitmap finishes decoding
    this.renderer.onAsyncLoad = () => this.requestRender();

    this._bindUI();
    this._bindInput();
    this._bindKeys();
    this._bindImageDrop();
    this._buildSwatches();

    this._restore();
    this._restoreAnim();
    this._loadBookmarks();
    this._renderBookmarks();
    this._renderLayers();
    this._updateAnimUI();
    this._startLoop();
    this._installTestApi();
    this._updateHud();
    this._updateUndoRedo();
    this.setTool('pen');
    this._toast('∞ Infinizoom ready — draw, scroll to zoom, drag to pan');
  }

  // ---------------- coordinate helpers ----------------
  evtScreen(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  toWorld(sx, sy) { return this.camera.screenToWorld(sx, sy); }

  /** Grid step in world units, matching the renderer's adaptive grid. */
  gridStep() {
    const targetPx = 78;
    const worldPerTarget = targetPx / this.camera.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(worldPerTarget)));
    let step = pow;
    for (const m of [1, 2, 5, 10]) {
      step = pow * m;
      if (pow * m * this.camera.scale >= targetPx) break;
    }
    return step;
  }
  maybeSnap(p) {
    if (!this.snap) return p;
    const s = this.gridStep();
    return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
  }

  // ---------------- tools / style ----------------
  setTool(name) {
    this.tool = name;
    this.commitText();
    if (name !== 'select') this.selectedIds.clear();
    document.querySelectorAll('.tool').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === name));
    this.canvas.className = '';
    this.canvas.classList.add('tool-' + name);
    this._updateHud();
    this.requestRender();
  }
  getTool() { return this.tool; }

  setStyle(partial) {
    Object.assign(this.style, partial);
    // mirror into UI
    if (partial.color !== undefined) document.getElementById('color').value = partial.color;
    if (partial.width !== undefined) {
      document.getElementById('width').value = partial.width;
      document.getElementById('widthVal').textContent = partial.width;
    }
    if (partial.sides !== undefined) {
      document.getElementById('sides').value = partial.sides;
      document.getElementById('sidesVal').textContent = partial.sides;
    }
    if (partial.star !== undefined) document.getElementById('starToggle').checked = partial.star;
    if (partial.opacity !== undefined) {
      document.getElementById('opacity').value = partial.opacity;
      document.getElementById('opacityVal').textContent = Math.round(partial.opacity * 100) + '%';
    }
    if (partial.widthMode !== undefined) {
      const sel = document.getElementById('widthMode');
      if (sel) sel.value = partial.widthMode;
    }
    // apply to current selection
    const fillable = new Set(['rect', 'ellipse', 'polygon']);
    const strokeable = new Set(['stroke', 'line', 'arrow', 'rect', 'ellipse', 'polygon', 'connector']);
    if (this.selectedIds.size && (partial.color || partial.width || partial.fill !== undefined ||
                                  partial.sides !== undefined || partial.star !== undefined ||
                                  partial.opacity !== undefined || partial.widthMode !== undefined)) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (!it) continue;
        if (partial.color) it.color = partial.color;
        if (partial.width) it.width = partial.width;
        if (partial.fill !== undefined && fillable.has(it.type)) it.fill = partial.fill;
        if (partial.sides !== undefined && it.type === 'polygon') it.sides = partial.sides;
        if (partial.star !== undefined && it.type === 'polygon') it.star = partial.star;
        if (partial.opacity !== undefined) {
          if (partial.opacity >= 1) delete it.opacity; else it.opacity = partial.opacity;
        }
        if (partial.widthMode !== undefined && strokeable.has(it.type)) {
          if (partial.widthMode === 'screen') it.widthMode = 'screen'; else delete it.widthMode;
        }
      }
      this.scene._touch();
    }
    this._highlightSwatch();
    this.requestRender();
  }
  getStyle() { return { ...this.style }; }
  get drawStyle() {
    return { color: this.style.color, width: this.style.width,
             fill: this.style.fillOn ? this.style.fillColor : null, size: this.style.textSize,
             sides: this.style.sides, star: this.style.star, opacity: this.style.opacity,
             widthMode: this.style.widthMode };
  }

  // ---------------- pointer input ----------------
  _bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._onDown(e));
    c.addEventListener('pointermove', e => this._onMove(e));
    c.addEventListener('pointerup', e => this._onUp(e));
    c.addEventListener('pointercancel', e => this._onUp(e));
    c.addEventListener('pointerleave', () => { this.eraserCursor = null; this.requestRender(); });
    c.addEventListener('wheel', e => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', () => { this.renderer.resize(); this.minimap._resize(); this.requestRender(); });

    const mini = document.getElementById('minimap');
    mini.addEventListener('pointerdown', e => {
      const r = mini.getBoundingClientRect();
      const w = this.minimap.clickToWorld(e.clientX - r.left, e.clientY - r.top);
      if (w) { this.camera.x = w.x; this.camera.y = w.y; this.requestRender(); }
    });
  }

  _onWheel(e) {
    e.preventDefault();
    const s = this.evtScreen(e);
    if (e.ctrlKey || e.metaKey) {
      // pinch-zoom on trackpads sends ctrl+wheel
      const factor = Math.exp(-e.deltaY * 0.01);
      this.camera.zoomBy(factor, s.x, s.y);
    } else if (e.shiftKey) {
      this.camera.panByScreen(-e.deltaY, 0);
    } else if (e.altKey) {
      this.camera.panByScreen(0, -e.deltaY);
    } else {
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.camera.zoomBy(factor, s.x, s.y);
    }
    this._updateHud();
    this.requestRender();
  }

  _onDown(e) {
    if (this.anim.playing) this.stop();   // interacting stops flipbook playback
    try { this.canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    const s = this.evtScreen(e);
    this.pointers.set(e.pointerId, s);

    if (this.pointers.size === 2) { this._beginPinch(); return; }
    if (this.pointers.size > 2) return;

    const panMode = this.tool === 'pan' || this.spaceDown || e.button === 1 || e.button === 2;
    const w = this.maybeSnap(this.toWorld(s.x, s.y));

    // Alt+click = eyedropper: sample the colour of the item under the cursor.
    if (e.altKey && e.button === 0) {
      const wp = this.toWorld(s.x, s.y);
      this.eyedrop(wp.x, wp.y);
      this.pointers.delete(e.pointerId);
      this.requestRender();
      return;
    }

    if (panMode) {
      this.active = { kind: 'pan', startScreen: s, last: s };
      this.canvas.classList.add('panning');
      return;
    }

    switch (this.tool) {
      case 'pen':
        this.draft = makeStroke([w], this.drawStyle);
        this.active = { kind: 'pen' };
        break;
      case 'brush':
        this.draft = makeStroke([{ x: w.x, y: w.y, p: this._brushPressure(e, s, null) }], this.drawStyle);
        this.draft.taper = true;
        this.active = { kind: 'brush', lastScreen: s, lastT: performance.now() };
        break;
      case 'line':
        this.draft = makeLine(w, w, this.drawStyle);
        this.active = { kind: 'shape', start: w };
        break;
      case 'rect':
        this.draft = makeRect(w.x, w.y, 0, 0, this.drawStyle);
        this.active = { kind: 'shape', start: w };
        break;
      case 'ellipse':
        this.draft = makeEllipse(w.x, w.y, 0, 0, this.drawStyle);
        this.active = { kind: 'shape', start: w };
        break;
      case 'arrow':
        this.draft = makeArrow(w, w, this.drawStyle);
        this.active = { kind: 'shape', start: w };
        break;
      case 'star':
        this.draft = makePolygon(w.x, w.y, 0, 0, this.drawStyle);
        this.active = { kind: 'shape', start: w };
        break;
      case 'eraser':
        this.active = { kind: 'erase', removed: [] };
        this._eraseAt(w, s);
        break;
      case 'text':
        this._startText(s, w);
        break;
      case 'select':
        this._beginSelect(s, w, e);
        break;
      case 'connector':
        this._beginConnector(s, w);
        break;
    }
    this.requestRender();
  }

  _onMove(e) {
    const s = this.evtScreen(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, s);
    this.mouseWorld = this.toWorld(s.x, s.y);
    this._updateHud();

    if (this.pinch && this.pointers.size >= 2) { this._updatePinch(); return; }

    if (this.tool === 'eraser' && !this.active) {
      this.eraserCursor = { x: s.x, y: s.y, r: this.camera.worldToScreenLen(this._eraseRadiusWorld()) };
      this.requestRender();
    }

    if (!this.active) return;
    const w = this.maybeSnap(this.toWorld(s.x, s.y));

    switch (this.active.kind) {
      case 'pan': {
        const dx = s.x - this.active.last.x, dy = s.y - this.active.last.y;
        this.camera.panByScreen(dx, dy);
        this.active.last = s;
        break;
      }
      case 'pen': {
        const last = this.draft.points[this.draft.points.length - 1];
        const minMove = this.camera.screenToWorldLen(1.2);
        if (dist(last.x, last.y, w.x, w.y) >= minMove) this.draft.points.push(w);
        break;
      }
      case 'brush': {
        const last = this.draft.points[this.draft.points.length - 1];
        const minMove = this.camera.screenToWorldLen(1.2);
        if (dist(last.x, last.y, w.x, w.y) >= minMove) {
          const pr = this._brushPressure(e, s, this.active);
          this.draft.points.push({ x: w.x, y: w.y, p: pr });
          this.active.lastScreen = s;
          this.active.lastT = performance.now();
        }
        break;
      }
      case 'shape': {
        this._updateShape(this.active.start, w, e);
        break;
      }
      case 'erase':
        this._eraseAt(w, s);
        this.eraserCursor = { x: s.x, y: s.y, r: this.camera.worldToScreenLen(this._eraseRadiusWorld()) };
        break;
      case 'move': {
        const dx = w.x - this.active.lastWorld.x, dy = w.y - this.active.lastWorld.y;
        for (const id of this.selectedIds) { const it = this.scene.byId(id); if (it) translateItem(it, dx, dy); }
        this.active.totalDx += dx; this.active.totalDy += dy;
        this.active.lastWorld = w;
        this.scene._touch();
        break;
      }
      case 'connect': {
        const wr = this.toWorld(s.x, s.y);
        if (this.draft) { this.draft.bx = wr.x; this.draft.by = wr.y; }
        break;
      }
      case 'rotate': {
        const pivot = this.active.pivot;
        const wr = this.toWorld(s.x, s.y); // raw (unsnapped) world point for the angle
        const cur = Math.atan2(wr.y - pivot.y, wr.x - pivot.x);
        let target = cur - this.active.startAngle;
        if (e && e.shiftKey) { const step = Math.PI / 12; target = Math.round(target / step) * step; }
        const d = target - this.active.applied;
        if (d) {
          const items = this.active.ids.map(id => this.scene.byId(id)).filter(Boolean);
          rotateItemsAbout(items, pivot.x, pivot.y, d);
          this.active.applied = target;
          this.scene._touch();
        }
        break;
      }
      case 'scale': {
        const a = this.active;
        const wr = this.toWorld(s.x, s.y); // raw (unsnapped) world point
        // project the pointer onto the corner→pivot diagonal to get a uniform factor
        const proj = (wr.x - a.pivot.x) * a.dirx + (wr.y - a.pivot.y) * a.diry;
        let target = proj / a.baseLen;
        if (e && e.shiftKey) target = Math.round(target / 0.25) * 0.25; // ⇧ snaps to ¼ steps
        const minS = 0.02;
        if (!(target > minS)) target = minS; // never flip/collapse the selection
        const factor = target / a.applied;
        if (factor > 0 && isFinite(factor) && Math.abs(factor - 1) > 1e-12) {
          const items = a.ids.map(id => this.scene.byId(id)).filter(Boolean);
          for (const it of items) scaleItemAbout(it, a.pivot.x, a.pivot.y, factor);
          a.applied = target;
          this.scene._touch();
        }
        break;
      }
      case 'marquee':
        this.marquee = { ...this.marquee, x1: s.x, y1: s.y };
        break;
    }
    this.requestRender();
  }

  _onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    this.canvas.classList.remove('panning');
    if (!this.active) { this.requestRender(); return; }

    const a = this.active;
    this.active = null;

    switch (a.kind) {
      case 'pen': this._commitStroke(); break;
      case 'brush': this._commitBrush(); break;
      case 'shape': this._commitShape(); break;
      case 'erase':
        if (a.removed.length) this.history.pushApplied(removeItemsCmd(this.scene, a.removed));
        this.eraserCursor = null;
        break;
      case 'move':
        if (Math.abs(a.totalDx) > 1e-9 || Math.abs(a.totalDy) > 1e-9) {
          // record reversible move (already applied)
          const ids = [...this.selectedIds];
          const dx = a.totalDx, dy = a.totalDy;
          this.history.pushApplied({
            label: `move ${ids.length}`,
            do() { for (const id of ids) { const it = app.scene.byId(id); if (it) translateItem(it, dx, dy); } app.scene._touch(); },
            undo() { for (const id of ids) { const it = app.scene.byId(id); if (it) translateItem(it, -dx, -dy); } app.scene._touch(); },
          });
        }
        break;
      case 'rotate':
        if (Math.abs(a.applied) > 1e-9) {
          const ids = a.ids, pivot = a.pivot, ang = a.applied, scene = this.scene;
          const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
          this.history.pushApplied({
            label: `rotate ${ids.length}`,
            do() { rotateItemsAbout(grab(), pivot.x, pivot.y, ang); scene._touch(); },
            undo() { rotateItemsAbout(grab(), pivot.x, pivot.y, -ang); scene._touch(); },
          });
        }
        break;
      case 'scale':
        if (Math.abs(a.applied - 1) > 1e-9) {
          const ids = a.ids, pivot = a.pivot, sc = a.applied, scene = this.scene;
          const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
          this.history.pushApplied({
            label: `scale ${ids.length}`,
            do() { for (const it of grab()) scaleItemAbout(it, pivot.x, pivot.y, sc); scene._touch(); },
            undo() { for (const it of grab()) scaleItemAbout(it, pivot.x, pivot.y, 1 / sc); scene._touch(); },
          });
        }
        break;
      case 'connect': this._endConnector(this.evtScreen(e), a); break;
      case 'marquee': this._commitMarquee(); break;
    }
    this.requestRender();
    storage.saveLocal(this.scene, this.camera);
  }

  // ---- pen / shapes ----
  _commitStroke() {
    if (!this.draft) return;
    const eps = this.camera.screenToWorldLen(0.6);
    let pts = simplify(this.draft.points, eps);
    if (pts.length === 0) { this.draft = null; return; }
    const it = makeStroke(pts, { color: this.draft.color, width: this.draft.width, widthMode: this.draft.widthMode });
    this.draft = null;
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
  }

  // ---- brush (pressure / tapered strokes) ----
  /** Per-point pressure in (0,1]. Uses a genuine stylus pressure signal when one
   *  is present; otherwise derives it from pointer SPEED (fast = thin), which
   *  gives a lively, calligraphic feel even with a plain mouse. */
  _brushPressure(e, s, active) {
    let pr = null;
    // a mouse reports a constant 0.5 — only trust pressure from a real pen/touch
    if (e && e.pointerType && e.pointerType !== 'mouse' && e.pressure > 0) pr = e.pressure;
    if (active && active.lastScreen) {
      const dt = Math.max(1, performance.now() - active.lastT);
      const speed = dist(s.x, s.y, active.lastScreen.x, active.lastScreen.y) / dt; // px/ms
      const speedFactor = clamp(1 - speed / 2.2, 0.28, 1);
      pr = pr == null ? speedFactor : pr * 0.6 + speedFactor * 0.4;
    } else if (pr == null) {
      pr = 0.8; // a confident starting dab
    }
    return clamp(pr, 0.05, 1);
  }

  /** Ramp the first/last ~20% of points down to a fine point so the stroke
   *  enters and leaves on a tapered nib. Blends toward a small ABSOLUTE tip
   *  pressure (not a fraction of the captured value) so the very ends are always
   *  the thinnest part of the stroke, whatever the pen speed was there. */
  _taperEnds(pts) {
    const n = pts.length;
    if (n < 3) return pts;
    const span = Math.max(1, Math.floor(n * 0.22));
    const TIP = 0.06;
    return pts.map((pt, i) => {
      const edge = Math.min(i, n - 1 - i);
      if (edge >= span) return pt;
      const u = edge / span;                        // 0 at the very tip → ~1 inside
      const base = pt.p == null ? 1 : pt.p;
      return { ...pt, p: TIP + (base - TIP) * u };
    });
  }

  _commitBrush() {
    if (!this.draft) return;
    const eps = this.camera.screenToWorldLen(0.6);
    let pts = simplify(this.draft.points, eps);       // RDP keeps whole point objects → `p` survives
    if (pts.length === 0) { this.draft = null; return; }
    pts = this._taperEnds(pts);
    const it = makeStroke(pts, { color: this.draft.color, width: this.draft.width,
                                 widthMode: this.draft.widthMode, opacity: this.draft.opacity });
    it.taper = true;
    if (this.brushSmooth) it.smooth = true;
    this.draft = null;
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
  }

  _updateShape(start, w, e) {
    const d = this.draft;
    if (d.type === 'line' || d.type === 'arrow') {
      let end = w;
      if (e && e.shiftKey) end = this._constrainAngle(start, w);
      d.points = [start, end];
    } else {
      let ww = w.x - start.x, hh = w.y - start.y;
      if (e && e.shiftKey) { const m = Math.max(Math.abs(ww), Math.abs(hh)); ww = Math.sign(ww || 1) * m; hh = Math.sign(hh || 1) * m; }
      d.x = start.x; d.y = start.y; d.w = ww; d.h = hh;
    }
  }
  _constrainAngle(a, b) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const step = Math.PI / 4;
    const snapped = Math.round(ang / step) * step;
    const len = dist(a.x, a.y, b.x, b.y);
    return { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len };
  }
  _commitShape() {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    if (d.type === 'line' || d.type === 'arrow') {
      const [a, b] = d.points;
      if (dist(a.x, a.y, b.x, b.y) < this.camera.screenToWorldLen(2)) return;
    } else if (Math.abs(d.w) < this.camera.screenToWorldLen(2) && Math.abs(d.h) < this.camera.screenToWorldLen(2)) {
      return;
    }
    this._assignFrame([d]);
    this.history.push(addItemsCmd(this.scene, [d]));
  }

  // ---- eraser ----
  _lodFilter() { const s = this.camera.scale; return it => lodVisible(it, s) && this._frameInteractive(it); }
  /** Pick filter for selection/erase: also excludes locked items (hidden ones
   *  are already skipped inside Scene.pick). Connectors keep the looser
   *  _lodFilter so they can still snap onto a locked object. */
  _selFilter() { const s = this.camera.scale; return it => lodVisible(it, s) && !it.locked && this._frameInteractive(it); }

  /** In flipbook mode only items on the current page can be picked/edited;
   *  off-page pages are onion-skin ghosts. With flipbook OFF, everything is live. */
  _frameInteractive(it) { return !this.anim.on || (it.frame || 0) === this.anim.current; }

  /** Sample the colour of the top-most item under a world point into the palette. */
  eyedrop(wx, wy) {
    const hit = this.scene.pick(wx, wy, this.camera.screenToWorldLen(6), this._lodFilter());
    if (hit && hit.color) { this.setStyle({ color: hit.color }); this._toast(`Picked ${hit.color}`); return hit.color; }
    return null;
  }

  _eraseRadiusWorld() { return this.camera.screenToWorldLen(10) + this.style.width / 2; }
  _eraseAt(w, _s) {
    const tol = this._eraseRadiusWorld();
    const hit = this.scene.pick(w.x, w.y, tol, this._selFilter()); // never erase locked/hidden
    if (hit && this.active && !this.active.removed.includes(hit)) {
      this.active.removed.push(hit);
      this.scene.remove(hit.id);
      // erasing an endpoint item takes its connectors with it
      if (hit.type !== 'connector') {
        for (const c of this._connectorsReferencing([hit.id])) {
          if (!this.active.removed.includes(c)) { this.active.removed.push(c); this.scene.remove(c.id); }
        }
      }
    }
  }

  // ---- selection ----
  _beginSelect(s, w, e) {
    // Grabbing the rotation handle starts a rotate gesture (highest priority).
    const handle = this._rotHandleScreen();
    if (handle && dist(s.x, s.y, handle.x, handle.y) <= handle.r + 6) {
      const pivot = this._selectionWorldCenter();
      if (pivot) {
        this.active = { kind: 'rotate', pivot, applied: 0,
                        startAngle: Math.atan2(w.y - pivot.y, w.x - pivot.x),
                        ids: [...this.selectedIds] };
        return;
      }
    }
    // Grabbing a corner handle starts a uniform resize about the opposite corner
    // (the diagonally-opposite corner stays pinned, like a standard vector editor).
    const handles = this._scaleHandlesScreen();
    if (handles) {
      for (const h of handles) {
        if (dist(s.x, s.y, h.x, h.y) <= 9) {
          const pivx = h.ox, pivy = h.oy;
          const dx = h.wx - pivx, dy = h.wy - pivy;
          const baseLen = Math.hypot(dx, dy);
          if (baseLen > 1e-12) {
            this.active = { kind: 'scale', pivot: { x: pivx, y: pivy },
                            dirx: dx / baseLen, diry: dy / baseLen, baseLen,
                            applied: 1, ids: [...this.selectedIds] };
            return;
          }
        }
      }
    }
    const tol = this.camera.screenToWorldLen(6);
    // If clicking inside the bbox of an already-selected item, drag the whole
    // selection — even over an unfilled interior. This matches vector editors.
    if (this.selectedIds.size && !e.shiftKey) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (it && !it.locked && pointInRect(w.x, w.y, itemBBox(it))) {
          this.active = { kind: 'move', lastWorld: w, totalDx: 0, totalDy: 0 };
          return;
        }
      }
    }
    const hit = this.scene.pick(w.x, w.y, tol, this._selFilter());
    if (hit) {
      const members = this._groupMembers(hit); // grouped items select as a unit
      if (e.shiftKey) {
        const allIn = members.every(id => this.selectedIds.has(id));
        for (const id of members) allIn ? this.selectedIds.delete(id) : this.selectedIds.add(id);
      } else if (!this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set(members);
      }
      if (this.selectedIds.size) {
        this.active = { kind: 'move', lastWorld: w, totalDx: 0, totalDy: 0 };
      }
    } else {
      if (!e.shiftKey) this.selectedIds.clear();
      this.marquee = { x0: s.x, y0: s.y, x1: s.x, y1: s.y };
      this.active = { kind: 'marquee' };
    }
    this._updateHud();
  }
  _commitMarquee() {
    if (!this.marquee) return;
    const a = this.toWorld(this.marquee.x0, this.marquee.y0);
    const b = this.toWorld(this.marquee.x1, this.marquee.y1);
    const rect = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
    if (Math.abs(this.marquee.x1 - this.marquee.x0) > 3 || Math.abs(this.marquee.y1 - this.marquee.y0) > 3) {
      const hits = this.scene.itemsContainedIn(rect);
      for (const it of hits) if (this._frameInteractive(it)) this.selectedIds.add(it.id);
      this._expandSelectionGroups(); // pull in the rest of any touched group
    }
    this.marquee = null;
    this._updateHud();
  }
  deleteSelection() {
    if (!this.selectedIds.size) return;
    const items = [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean);
    const ids = new Set(items.map(i => i.id));
    // also drop connectors that would be left dangling, in the same undo step
    const orphans = this._connectorsReferencing(ids).filter(c => !ids.has(c.id));
    this.history.push(removeItemsCmd(this.scene, [...items, ...orphans]));
    this.selectedIds.clear();
    this._updateHud();
  }
  selectAll() {
    this.selectedIds = new Set(this.scene.items.filter(i => !i.locked && !i.hidden && this._frameInteractive(i)).map(i => i.id));
    if (this.tool !== 'select') this.setTool('select');
    this._updateHud();
    this.requestRender();
  }

  /** Move the selection by a world-space delta as one undoable step (arrow keys). */
  nudgeSelection(dx, dy) {
    if (!this.selectedIds.size || (!dx && !dy)) return;
    const ids = [...this.selectedIds].filter(id => { const it = this.scene.byId(id); return it && !it.locked; });
    if (!ids.length) return;
    this.history.push(moveItemsCmd(this.scene, ids, dx, dy, translateItem));
    this._updateHud();
    this.requestRender();
  }

  // ---- rotation ----
  _selectionItems() { return [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean); }

  /** World-space centre of the current selection's combined bbox (rotation pivot). */
  _selectionWorldCenter() {
    const items = this._selectionItems();
    if (!items.length) return null;
    let b = { ...itemBBox(items[0]) };
    for (const it of items) {
      const ib = itemBBox(it);
      b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY);
      b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY);
    }
    return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  }

  /** Screen-space AABB enclosing the visible selection, or null. */
  _selectionAABBScreen() {
    if (!this.selectedIds.size) return null;
    let any = false, R = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const id of this.selectedIds) {
      const it = this.scene.byId(id);
      if (!it || !lodVisible(it, this.camera.scale)) continue;
      any = true;
      const b = itemBBox(it);
      const tl = this.camera.worldToScreen(b.minX, b.minY);
      const br = this.camera.worldToScreen(b.maxX, b.maxY);
      R.minX = Math.min(R.minX, tl.x); R.minY = Math.min(R.minY, tl.y);
      R.maxX = Math.max(R.maxX, br.x); R.maxY = Math.max(R.maxY, br.y);
    }
    return any ? R : null;
  }

  /** Screen position of the rotation grab handle above the selection, or null. */
  _rotHandleScreen() {
    if (this.tool !== 'select' || !this.selectedIds.size) return null;
    const R = this._selectionAABBScreen();
    if (!R) return null;
    return { x: (R.minX + R.maxX) / 2, y: R.minY - 22, r: 6 };
  }

  /** World-space AABB of the visible selection (union of item bboxes), or null. */
  _selectionWorldAABB() {
    const items = this._selectionItems().filter(it => lodVisible(it, this.camera.scale));
    if (!items.length) return null;
    let b = { ...itemBBox(items[0]) };
    for (const it of items) {
      const ib = itemBBox(it);
      b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY);
      b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY);
    }
    return b;
  }

  /** The four corner resize handles (screen px), each tagged with its own world
   *  corner (wx,wy) and the diagonally-opposite corner (ox,oy) used as the scale
   *  pivot. Null unless the select tool has a non-degenerate selection. */
  _scaleHandlesScreen() {
    if (this.tool !== 'select' || !this.selectedIds.size) return null;
    const b = this._selectionWorldAABB();
    if (!b) return null;
    if (b.maxX - b.minX < 1e-12 && b.maxY - b.minY < 1e-12) return null; // a point can't be resized
    const corners = [
      { wx: b.minX, wy: b.minY, ox: b.maxX, oy: b.maxY }, // nw, pivot se
      { wx: b.maxX, wy: b.minY, ox: b.minX, oy: b.maxY }, // ne, pivot sw
      { wx: b.maxX, wy: b.maxY, ox: b.minX, oy: b.minY }, // se, pivot nw
      { wx: b.minX, wy: b.maxY, ox: b.maxX, oy: b.minY }, // sw, pivot ne
    ];
    return corners.map(c => {
      const sc = this.camera.worldToScreen(c.wx, c.wy);
      return { x: sc.x, y: sc.y, wx: c.wx, wy: c.wy, ox: c.ox, oy: c.oy };
    });
  }

  /** Uniformly scale the selection by `factor` about a pivot (default: selection
   *  centre). Reversible. Used by the test API and the ⤢/⤡ buttons. */
  scaleSelection(factor, pivot = null) {
    if (!this.selectedIds.size || !(factor > 0) || Math.abs(factor - 1) < 1e-12) return;
    const b = this._selectionWorldAABB();
    const p = pivot || (b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null);
    if (!p) return;
    const ids = [...this.selectedIds], scene = this.scene;
    const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
    this.history.push({
      label: `scale ${ids.length}`,
      do() { for (const it of grab()) scaleItemAbout(it, p.x, p.y, factor); scene._touch(); },
      undo() { for (const it of grab()) scaleItemAbout(it, p.x, p.y, 1 / factor); scene._touch(); },
    });
    this.requestRender();
  }

  /** Rotate the selection by `ang` radians about a pivot (default: selection centre). */
  rotateSelection(ang, pivot = null) {
    if (!this.selectedIds.size || !ang) return;
    const p = pivot || this._selectionWorldCenter();
    if (!p) return;
    const ids = [...this.selectedIds];
    const scene = this.scene;
    const grab = () => ids.map(id => scene.byId(id)).filter(Boolean);
    this.history.push({
      label: `rotate ${ids.length}`,
      do() { rotateItemsAbout(grab(), p.x, p.y, ang); scene._touch(); },
      undo() { rotateItemsAbout(grab(), p.x, p.y, -ang); scene._touch(); },
    });
    this.requestRender();
  }

  // ---- grouping ----
  /** All item ids sharing a group with `it` (or just [it.id] if it is ungrouped). */
  _groupMembers(it) {
    if (!it) return [];
    if (!it.group) return [it.id];
    return this.scene.items.filter(o => o.group === it.group).map(o => o.id);
  }
  /** Grow the current selection so any touched group is selected whole. */
  _expandSelectionGroups() {
    const groups = new Set();
    for (const id of this.selectedIds) { const it = this.scene.byId(id); if (it && it.group) groups.add(it.group); }
    if (!groups.size) return;
    for (const it of this.scene.items) if (it.group && groups.has(it.group)) this.selectedIds.add(it.id);
  }

  /** Tag all selected items with one fresh group id (reversible). Needs ≥2 items. */
  groupSelection() {
    const ids = [...this.selectedIds];
    if (ids.length < 2) { this._toast('Select 2+ items to group'); return null; }
    const gid = 'grp_' + Math.random().toString(36).slice(2, 9);
    const scene = this.scene;
    const before = ids.map(id => ({ id, group: scene.byId(id)?.group ?? null }));
    this.history.push({
      label: `group ${ids.length}`,
      do() { for (const id of ids) { const it = scene.byId(id); if (it) it.group = gid; } scene._touch(); },
      undo() { for (const { id, group } of before) { const it = scene.byId(id); if (it) { if (group == null) delete it.group; else it.group = group; } } scene._touch(); },
    });
    this._toast(`Grouped ${ids.length} items`);
    this.requestRender();
    return gid;
  }

  /** Remove the group tag from every member of any group in the selection. */
  ungroupSelection() {
    const groups = new Set();
    for (const id of this.selectedIds) { const it = this.scene.byId(id); if (it && it.group) groups.add(it.group); }
    if (!groups.size) return 0;
    const before = this.scene.items.filter(it => it.group && groups.has(it.group)).map(it => ({ id: it.id, group: it.group }));
    const scene = this.scene;
    this.history.push({
      label: 'ungroup',
      do() { for (const { id } of before) { const it = scene.byId(id); if (it) delete it.group; } scene._touch(); },
      undo() { for (const { id, group } of before) { const it = scene.byId(id); if (it) it.group = group; } scene._touch(); },
    });
    this._toast(`Ungrouped ${before.length} items`);
    this.requestRender();
    return before.length;
  }

  /** Re-map group ids on a freshly-cloned item set so clones stay grouped among
   *  themselves but distinct from the originals. Mutates items in place. */
  _remapGroups(items) {
    const map = new Map();
    for (const c of items) {
      if (!c.group) continue;
      if (!map.has(c.group)) map.set(c.group, 'grp_' + Math.random().toString(36).slice(2, 9));
      c.group = map.get(c.group);
    }
  }

  // ---- connectors ----
  /** After cloning a subgraph, re-point cloned connectors at the cloned items
   *  (when both ends were copied), so the copy stays internally wired. */
  _relinkConnectors(items, idMap) {
    for (const it of items) {
      if (it.type !== 'connector') continue;
      if (idMap.has(it.from)) it.from = idMap.get(it.from);
      if (idMap.has(it.to)) it.to = idMap.get(it.to);
    }
  }

  _itemCenter(it) { const b = itemBBox(it); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; }

  /** Recompute one connector's endpoint cache (ax..by) from the items it links,
   *  clipping each end to the linked item's bbox edge. Leaves danglers untouched. */
  _resolveConnector(it) {
    const A = this.scene.byId(it.from), B = this.scene.byId(it.to);
    if (!A || !B) return false;
    const ba = itemBBox(A), bb = itemBBox(B);
    const ca = { x: (ba.minX + ba.maxX) / 2, y: (ba.minY + ba.maxY) / 2 };
    const cb = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
    const a = boxEdgePoint(ca.x, ca.y, cb.x, cb.y, ba);
    const b = boxEdgePoint(cb.x, cb.y, ca.x, ca.y, bb);
    it.ax = a.x; it.ay = a.y; it.bx = b.x; it.by = b.y;
    return true;
  }
  /** Refresh every connector's endpoint cache so they track their items. Cheap;
   *  run before any render or bounds query. Does not mutate the document model. */
  resolveConnectors() {
    for (const it of this.scene.items) if (it.type === 'connector') this._resolveConnector(it);
  }

  /** Connectors whose `from`/`to` falls in the given id set. */
  _connectorsReferencing(ids) {
    const set = ids instanceof Set ? ids : new Set(ids);
    return this.scene.items.filter(it => it.type === 'connector' && (set.has(it.from) || set.has(it.to)));
  }

  /** Create a connector linking two existing items. Returns its id (or null). */
  addConnector(fromId, toId, style = {}) {
    if (fromId === toId || !this.scene.byId(fromId) || !this.scene.byId(toId)) return null;
    const it = makeConnector(fromId, toId,
      { color: this.style.color, width: this.style.width, arrow: true, ...style });
    this._resolveConnector(it);
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
    this._toast('Connected');
    return it.id;
  }

  _beginConnector(s, w) {
    const from = this.scene.pick(w.x, w.y, this.camera.screenToWorldLen(6), this._lodFilter());
    if (!from || from.type === 'connector') { this.active = null; return; }
    const c = this._itemCenter(from);
    const wr = this.toWorld(s.x, s.y);
    this.draft = { type: 'connector', from: from.id, to: from.id,
                   ax: c.x, ay: c.y, bx: wr.x, by: wr.y,
                   color: this.style.color, width: this.style.width, arrow: true };
    this.active = { kind: 'connect', from: from.id };
  }
  _endConnector(s, a) {
    this.draft = null;
    if (!a) return;
    const w = this.toWorld(s.x, s.y);
    const target = this.scene.pick(w.x, w.y, this.camera.screenToWorldLen(6), this._lodFilter());
    if (target && target.id !== a.from && target.type !== 'connector') {
      this.addConnector(a.from, target.id);
    }
  }

  // ---- pinch ----
  _beginPinch() {
    const pts = [...this.pointers.values()];
    this.draft = null; this.active = null;
    this.pinch = {
      startDist: dist(pts[0].x, pts[0].y, pts[1].x, pts[1].y),
      startScale: this.camera.scale,
      lastMid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
    };
  }
  _updatePinch() {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const d = dist(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const targetScale = this.pinch.startScale * (d / Math.max(this.pinch.startDist, 1));
    this.camera.zoomTo(targetScale, mid.x, mid.y);
    this.camera.panByScreen(mid.x - this.pinch.lastMid.x, mid.y - this.pinch.lastMid.y);
    this.pinch.lastMid = mid;
    this._updateHud();
    this.requestRender();
  }

  // ---- text ----
  _startText(s, w) {
    this.commitText();
    const ed = document.getElementById('text-editor');
    this._textPos = w;
    ed.value = '';
    ed.classList.add('active');
    ed.style.left = s.x + 'px';
    ed.style.top = s.y + 'px';
    const px = Math.max(8, this.camera.worldToScreenLen(this.style.textSize));
    ed.style.fontSize = px + 'px';
    ed.style.color = this.style.color;
    ed.style.minWidth = '120px';
    ed.style.height = (px * 1.3) + 'px';
    this._textOpenAt = performance.now();
    ed.focus();                              // focus now (deterministic for tests)
    requestAnimationFrame(() => { if (ed.classList.contains('active')) ed.focus(); });
  }
  commitText() {
    const ed = document.getElementById('text-editor');
    if (!ed.classList.contains('active')) return;
    const text = ed.value;
    ed.classList.remove('active');
    if (text.trim() && this._textPos) {
      const it = makeText(this._textPos.x, this._textPos.y, text,
        { color: this.style.color, size: this.style.textSize });
      this._assignFrame([it]);
      this.history.push(addItemsCmd(this.scene, [it]));
    }
    this._textPos = null;
  }

  // ---------------- view ops ----------------
  zoomAtCenter(factor) { this.camera.zoomBy(factor); this._updateHud(); this.requestRender(); }
  resetView() { this.camera.x = 0; this.camera.y = 0; this.camera.scale = 1; this._updateHud(); this.requestRender(); }
  fitAll() {
    this.resolveConnectors(); // ensure connector bounds are current before fitting
    const b = this.scene.bounds();
    if (!b) { this.resetView(); return; }
    this.camera.fitToRect(b, 0.16);
    this._updateHud(); this.requestRender();
    this._toast('Zoomed to fit');
  }

  // ---------------- UI wiring ----------------
  _bindUI() {
    document.querySelectorAll('.tool').forEach(b =>
      b.addEventListener('click', () => this.setTool(b.dataset.tool)));

    document.getElementById('undo').onclick = () => this.undo();
    document.getElementById('redo').onclick = () => this.redo();
    document.getElementById('zoomIn').onclick = () => this.zoomAtCenter(1.25);
    document.getElementById('zoomOut').onclick = () => this.zoomAtCenter(1 / 1.25);
    document.getElementById('zoomFit').onclick = () => this.fitAll();
    document.getElementById('zoomReset').onclick = () => this.resetView();

    document.getElementById('color').oninput = e => this.setStyle({ color: e.target.value });
    document.getElementById('width').oninput = e => this.setStyle({ width: parseFloat(e.target.value) });
    document.getElementById('widthMode').onchange = e => this.setStyle({ widthMode: e.target.value });
    document.getElementById('sides').oninput = e => this.setStyle({ sides: parseInt(e.target.value, 10) });
    document.getElementById('opacity').oninput = e => this.setStyle({ opacity: parseFloat(e.target.value) });
    document.getElementById('starToggle').onchange = e => this.setStyle({ star: e.target.checked });
    document.getElementById('fillOn').onchange = e => { this.style.fillOn = e.target.checked; this._applyFillToSelection(); };
    document.getElementById('fillColor').oninput = e => { this.style.fillColor = e.target.value; if (this.style.fillOn) this._applyFillToSelection(); };

    document.getElementById('clearBtn').onclick = () => this.clearAll();
    document.getElementById('exportPng').onclick = () => { this.render(); storage.downloadPNG(this.canvas); this._toast('Exported PNG'); };
    document.getElementById('exportSvg').onclick = () => { this.resolveConnectors(); storage.downloadSVG(sceneToSVG(this.scene)); this._toast('Exported SVG'); };
    document.getElementById('exportJson').onclick = () => { storage.downloadJSON(this.scene); this._toast('Exported JSON'); };
    document.getElementById('importJson').onclick = () => document.getElementById('importFile').click();
    document.getElementById('importFile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try { const data = await storage.readFileAsJSON(f); this.loadDoc(data); this._toast('Imported drawing'); }
      catch { this._toast('Import failed — invalid JSON'); }
      e.target.value = '';
    };

    document.getElementById('addImageBtn').onclick = () => document.getElementById('imageFile').click();
    document.getElementById('imageFile').onchange = e => {
      const f = e.target.files[0];
      if (f) this.loadImageFile(f, { x: this.camera.width / 2, y: this.camera.height / 2 });
      e.target.value = '';
    };

    document.getElementById('gridToggle').onchange = e => { this.renderer.showGrid = e.target.checked; this.requestRender(); };
    document.getElementById('gridStyle').onchange = e => { this.renderer.gridStyle = e.target.value; this.requestRender(); };
    document.getElementById('minimapToggle').onchange = e => {
      this.minimap.enabled = e.target.checked;
      document.getElementById('minimap').classList.toggle('hidden', !e.target.checked);
      this.requestRender();
    };
    document.getElementById('snapToggle').onchange = e => { this.snap = e.target.checked; };
    document.getElementById('brushSmooth').onchange = e => { this.brushSmooth = e.target.checked; };

    // flipbook / stop-motion controls
    document.getElementById('flipToggle').onclick = () => this.toggleFlipbook();
    document.getElementById('flipPrev').onclick = () => this.prevFrame();
    document.getElementById('flipNext').onclick = () => this.nextFrame();
    document.getElementById('flipScrub').oninput = e => this.setFrame(parseInt(e.target.value, 10));
    document.getElementById('flipAdd').onclick = () => this.addFrame();
    document.getElementById('flipDup').onclick = () => this.duplicateFrame();
    document.getElementById('flipDel').onclick = () => this.deleteFrame();
    document.getElementById('flipPlay').onclick = () => this.togglePlay();
    document.getElementById('flipFps').onchange = e => this.setFps(parseInt(e.target.value, 10));
    document.getElementById('flipOnion').oninput = e => this.setOnion(parseInt(e.target.value, 10));
    document.getElementById('flipTint').onchange = e => this.setTint(e.target.checked);
    document.getElementById('flipLoop').onchange = e => this.setLoop(e.target.checked);

    document.querySelectorAll('.gen-row button').forEach(b =>
      b.addEventListener('click', () => this.generate(b.dataset.gen, {}, { clear: false, fit: true })));

    document.getElementById('toBack').onclick = () => this.sendToBack();
    document.getElementById('toFront').onclick = () => this.bringToFront();
    document.getElementById('raise').onclick = () => this.raiseSelection();
    document.getElementById('lower').onclick = () => this.lowerSelection();
    document.getElementById('rotL').onclick = () => this.rotateSelection(-Math.PI / 12);
    document.getElementById('rotR').onclick = () => this.rotateSelection(Math.PI / 12);
    document.getElementById('scaleDown').onclick = () => this.scaleSelection(1 / 1.1);
    document.getElementById('scaleUp').onclick = () => this.scaleSelection(1.1);
    document.getElementById('groupBtn').onclick = () => this.groupSelection();
    document.getElementById('ungroupBtn').onclick = () => this.ungroupSelection();
    document.getElementById('lockBtn').onclick = () => this.toggleLockSelection();
    document.getElementById('hideBtn').onclick = () => this.toggleHideSelection();
    document.getElementById('showAllBtn').onclick = () => this.showAll();
    document.getElementById('unlockAllBtn').onclick = () => this.unlockAll();
    document.getElementById('lodFar').onclick = () => this.setSelectionLOD('far');
    document.getElementById('lodAll').onclick = () => this.setSelectionLOD('all');
    document.getElementById('lodNear').onclick = () => this.setSelectionLOD('near');
    document.getElementById('stampBtn').onclick = () => this.recursiveStamp();
    document.getElementById('addBookmark').onclick = () => this.addBookmark();

    const ed = document.getElementById('text-editor');
    ed.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); ed.value = ''; ed.classList.remove('active'); this._textPos = null; }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.commitText(); }
      e.stopPropagation();
    });
    ed.addEventListener('blur', () => {
      // Ignore the spurious blur that can fire right as the editor opens
      // (e.g. focus contention with the canvas). Re-grab focus instead of
      // committing an empty box out of existence.
      if (ed.classList.contains('active') && performance.now() - (this._textOpenAt || 0) < 250) {
        requestAnimationFrame(() => { if (ed.classList.contains('active')) ed.focus(); });
        return;
      }
      this.commitText();
    });
    ed.addEventListener('input', () => {
      ed.style.width = 'auto';
      ed.style.width = Math.max(120, ed.scrollWidth + 4) + 'px';
      ed.style.height = 'auto';
      ed.style.height = ed.scrollHeight + 'px';
    });
  }

  _applyFillToSelection() {
    const fill = this.style.fillOn ? this.style.fillColor : null;
    if (this.selectedIds.size) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (it && (it.type === 'rect' || it.type === 'ellipse')) it.fill = fill;
      }
      this.scene._touch();
    }
    this.requestRender();
  }

  _buildSwatches() {
    const wrap = document.getElementById('swatches');
    wrap.innerHTML = '';
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.dataset.color = c;
      b.title = c;
      b.onclick = () => this.setStyle({ color: c });
      wrap.appendChild(b);
    }
    this._highlightSwatch();
  }
  _highlightSwatch() {
    document.querySelectorAll('.swatch').forEach(b =>
      b.classList.toggle('active', b.dataset.color === this.style.color));
  }

  // ---------------- keyboard ----------------
  _bindKeys() {
    window.addEventListener('keydown', e => {
      if (document.getElementById('text-editor').classList.contains('active')) return;
      const meta = e.metaKey || e.ctrlKey;
      if (e.code === 'Space' && !this.spaceDown) { this.spaceDown = true; this.canvas.style.cursor = 'grab'; }

      if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
      if (meta && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
      if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); return; }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); storage.downloadJSON(this.scene); this._toast('Saved JSON'); return; }
      if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSelection(); return; }
      if (meta && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copySelection(); return; }
      if (meta && e.key.toLowerCase() === 'x') { e.preventDefault(); this.cutSelection(); return; }
      if (meta && e.key.toLowerCase() === 'v') { e.preventDefault(); this.paste(); return; }
      if (meta && e.key.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? this.ungroupSelection() : this.groupSelection(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') { if (this.selectedIds.size) { e.preventDefault(); this.deleteSelection(); } return; }
      if (e.key === 'Escape') { this.selectedIds.clear(); this.draft = null; this.active = null; this.requestRender(); return; }

      // Shift+L / Shift+H lock / hide the selection (must run before the
      // lowercase tool switch, where 'l' = line and 'h' = pan).
      if (e.shiftKey && !meta && e.key.toLowerCase() === 'l') { e.preventDefault(); this.toggleLockSelection(); return; }
      if (e.shiftKey && !meta && e.key.toLowerCase() === 'h') { e.preventDefault(); this.toggleHideSelection(); return; }

      // In flipbook mode with nothing selected, ←/→ flip between pages. (When
      // something is selected, the arrows nudge it — handled just below.)
      if (this.anim.on && !this.selectedIds.size && !meta &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        e.key === 'ArrowLeft' ? this.prevFrame() : this.nextFrame();
        return;
      }

      // Arrow keys nudge the selection — 1px on screen, ×10 with Shift. Using
      // screen px keeps the felt step constant at any zoom.
      if (e.key.startsWith('Arrow') && this.selectedIds.size && !meta) {
        e.preventDefault();
        const step = this.camera.screenToWorldLen(e.shiftKey ? 10 : 1);
        let dx = 0, dy = 0;
        if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        else if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        this.nudgeSelection(dx, dy);
        return;
      }

      // z-order: ] front / [ back, with Ctrl for one-step raise/lower
      if (e.key === ']') { e.preventDefault(); meta ? this.raiseSelection() : this.bringToFront(); return; }
      if (e.key === '[') { e.preventDefault(); meta ? this.lowerSelection() : this.sendToBack(); return; }

      switch (e.key.toLowerCase()) {
        case 'p': this.setTool('pen'); break;
        case 'b': this.setTool('brush'); break;
        case 'l': this.setTool('line'); break;
        case 'a': this.setTool('arrow'); break;
        case 'r': this.setTool('rect'); break;
        case 'o': this.setTool('ellipse'); break;
        case 's': this.setTool('star'); break;
        case 't': this.setTool('text'); break;
        case 'v': this.setTool('select'); break;
        case 'c': this.setTool('connector'); break;
        case 'e': this.setTool('eraser'); break;
        case 'h': this.setTool('pan'); break;
        case 'f': this.fitAll(); break;
        case '0': this.resetView(); break;
        case '+': case '=': this.zoomAtCenter(1.25); break;
        case '-': case '_': this.zoomAtCenter(1 / 1.25); break;
        case 'g': { const t = document.getElementById('gridToggle'); t.checked = !t.checked; t.onchange({ target: t }); break; }
        case ',': if (this.selectedIds.size) { e.preventDefault(); this.rotateSelection(-Math.PI / 12); } break;
        case '.': if (this.selectedIds.size) { e.preventDefault(); this.rotateSelection(Math.PI / 12); } break;
        case '<': if (this.selectedIds.size) { e.preventDefault(); this.scaleSelection(1 / 1.1); } break;
        case '>': if (this.selectedIds.size) { e.preventDefault(); this.scaleSelection(1.1); } break;
      }
    });
    window.addEventListener('keyup', e => {
      if (e.code === 'Space') { this.spaceDown = false; this.canvas.style.cursor = ''; }
    });
  }

  // ---------------- clipboard ----------------
  copySelection() {
    if (!this.selectedIds.size) return 0;
    this.clipboard = [...this.selectedIds]
      .map(id => this.scene.byId(id))
      .filter(Boolean)
      .map(it => { const c = JSON.parse(JSON.stringify(it)); c._src = c.id; delete c.id; return c; });
    this._toast(`Copied ${this.clipboard.length}`);
    return this.clipboard.length;
  }
  cutSelection() {
    const n = this.copySelection();
    if (n) this.deleteSelection();
    return n;
  }
  paste() {
    if (!this.clipboard || !this.clipboard.length) return 0;
    const idMap = new Map();
    const clones = this.clipboard.map(c => {
      const n = JSON.parse(JSON.stringify(c));
      const src = n._src; delete n._src;
      n.id = `pst_${(this._pasteSeq = (this._pasteSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      if (src) idMap.set(src, n.id);
      return n;
    });
    this._relinkConnectors(clones, idMap);
    this._remapGroups(clones);
    let b = itemBBox(clones[0]); b = { ...b };
    for (const c of clones) { const ib = itemBBox(c); b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY); b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY); }
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // land the paste centred on the current view
    const dx = this.camera.x - cx, dy = this.camera.y - cy;
    for (const c of clones) translateItem(c, dx, dy);
    this._assignFrame(clones);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
    this._toast(`Pasted ${clones.length}`);
    return clones.length;
  }

  duplicateSelection() {
    if (!this.selectedIds.size) return;
    const off = this.camera.screenToWorldLen(16);
    const idMap = new Map();
    const clones = [...this.selectedIds].map(id => {
      const it = this.scene.byId(id);
      if (!it) return null;
      const c = JSON.parse(JSON.stringify(it));
      c.id = 'dup_' + Math.random().toString(36).slice(2, 9);
      idMap.set(id, c.id);
      translateItem(c, off, off);
      return c;
    }).filter(Boolean);
    this._relinkConnectors(clones, idMap);
    this._remapGroups(clones);
    this._assignFrame(clones);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
  }

  // ---------------- images ----------------
  /** Accept image files dropped onto the canvas, or pasted from the OS clipboard. */
  _bindImageDrop() {
    const c = this.canvas;
    c.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    c.addEventListener('drop', e => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].filter(f => /^image\//.test(f.type));
      if (!files.length) return;
      const s = this.evtScreen(e);
      files.forEach((f, i) => this.loadImageFile(f, { x: s.x + i * 14, y: s.y + i * 14 }));
    });
    // OS-clipboard image paste (separate from the in-app Ctrl+V clipboard)
    window.addEventListener('paste', e => {
      const items = [...(e.clipboardData?.items || [])];
      const imgItem = items.find(it => /^image\//.test(it.type));
      if (!imgItem) return;
      const file = imgItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      this.loadImageFile(file, { x: this.camera.width / 2, y: this.camera.height / 2 });
    });
  }

  /** World-space size for an image with the given natural pixel dimensions,
   *  scaled so it lands at a comfortable on-screen size (native px, capped). */
  _imageWorldSize(natW, natH) {
    natW = Math.max(1, natW || 1); natH = Math.max(1, natH || 1);
    const cap = Math.min(this.camera.width, this.camera.height) * 0.7;
    const longest = Math.max(natW, natH);
    const screenLongest = Math.min(longest, cap);
    const k = screenLongest / longest;                 // shrink-to-fit factor
    const screenW = natW * k, screenH = natH * k;
    return { w: this.camera.screenToWorldLen(screenW), h: this.camera.screenToWorldLen(screenH) };
  }

  /** Read an image File, decode its natural size, and drop it centred on a screen point. */
  loadImageFile(file, screenPoint) {
    const reader = new FileReader();
    reader.onload = () => this.placeImageDataURL(reader.result, screenPoint);
    reader.onerror = () => this._toast('Could not read image');
    reader.readAsDataURL(file);
  }

  /** Place an image from a data URL, centred on a screen point, at native-ish size. */
  placeImageDataURL(src, screenPoint = { x: this.camera.width / 2, y: this.camera.height / 2 }) {
    const probe = new Image();
    probe.onload = () => {
      const { w, h } = this._imageWorldSize(probe.naturalWidth, probe.naturalHeight);
      const c = this.toWorld(screenPoint.x, screenPoint.y);
      this.addImageItem(c.x - w / 2, c.y - h / 2, w, h, src, { select: true });
      this._toast(`Placed ${probe.naturalWidth}×${probe.naturalHeight} image`);
    };
    probe.onerror = () => this._toast('Invalid image data');
    probe.src = src;
  }

  /** Add an image item (world coords/size) through history. Returns the item id. */
  addImageItem(x, y, w, h, src, { select = false } = {}) {
    const it = makeImage(x, y, w, h, src, { opacity: this.style.opacity });
    if (src) this.renderer._image(src);   // begin decoding immediately
    this._assignFrame([it]);
    this.history.push(addItemsCmd(this.scene, [it]));
    if (select) { this.selectedIds = new Set([it.id]); if (this.tool !== 'select') this.setTool('select'); }
    this._updateHud();
    return it.id;
  }

  /** Count image items whose bitmap hasn't decoded yet (test/UX hook). */
  imagesPending() { return this.renderer.pendingImages(this.scene); }

  // ---------------- z-order ----------------
  _reorderSelection(mode) {
    if (!this.selectedIds.size) return;
    const before = this.scene.items.map(i => i.id);
    const sel = this.selectedIds;
    const selIds = before.filter(id => sel.has(id));
    const rest = before.filter(id => !sel.has(id));
    let after;
    if (mode === 'front') after = [...rest, ...selIds];
    else if (mode === 'back') after = [...selIds, ...rest];
    else if (mode === 'up') after = shiftOrder(before, sel, +1);
    else if (mode === 'down') after = shiftOrder(before, sel, -1);
    else return;
    if (after.join() === before.join()) return;
    this.history.push(reorderCmd(this.scene, before, after));
    this.requestRender();
  }
  bringToFront() { this._reorderSelection('front'); }
  sendToBack() { this._reorderSelection('back'); }
  raiseSelection() { this._reorderSelection('up'); }
  lowerSelection() { this._reorderSelection('down'); }

  // ---------------- lock / hide (layer flags) ----------------
  /** Set a boolean flag ('locked'|'hidden') on a set of items, reversibly.
   *  The flag is deleted (not set false) when off so JSON stays tidy. */
  _setFlag(ids, flag, on) {
    ids = (ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids.slice() : [ids])
            .filter(id => this.scene.byId(id));
    if (!ids.length) return;
    const scene = this.scene;
    const before = ids.map(id => ({ id, v: !!scene.byId(id)[flag] }));
    const set = (id, v) => { const it = scene.byId(id); if (it) { if (v) it[flag] = true; else delete it[flag]; } };
    this.history.push({
      label: `${on ? '' : 'un'}${flag} ${ids.length}`,
      do() { for (const id of ids) set(id, on); scene._touch(); },
      undo() { for (const { id, v } of before) set(id, v); scene._touch(); },
    });
  }

  setLocked(ids, on) {
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [ids];
    this._setFlag(list, 'locked', on);
    if (on) for (const id of list) this.selectedIds.delete(id); // a locked item can't stay selected
    this._updateHud(); this.requestRender();
  }
  setHidden(ids, on) {
    const list = ids instanceof Set ? [...ids] : Array.isArray(ids) ? ids : [ids];
    this._setFlag(list, 'hidden', on);
    if (on) for (const id of list) this.selectedIds.delete(id);
    this._updateHud(); this.requestRender();
  }

  toggleLockSelection() {
    const ids = [...this.selectedIds];
    if (!ids.length) { this._toast('Select something to lock'); return; }
    const anyUnlocked = ids.some(id => !this.scene.byId(id)?.locked);
    this.setLocked(ids, anyUnlocked);
    this._toast(anyUnlocked ? `🔒 Locked ${ids.length}` : `🔓 Unlocked ${ids.length}`);
  }
  toggleHideSelection() {
    const ids = [...this.selectedIds];
    if (!ids.length) { this._toast('Select something to hide'); return; }
    const anyVisible = ids.some(id => !this.scene.byId(id)?.hidden);
    this.setHidden(ids, anyVisible);
    this._toast(anyVisible ? `Hid ${ids.length}` : `Showed ${ids.length}`);
  }
  /** Recovery hatches — work on the WHOLE document, so items beyond the panel's
   *  display cap are always reachable. */
  showAll() {
    const ids = this.scene.items.filter(i => i.hidden).map(i => i.id);
    if (!ids.length) { this._toast('Nothing hidden'); return 0; }
    this.setHidden(ids, false); this._toast(`Showed ${ids.length}`); return ids.length;
  }
  unlockAll() {
    const ids = this.scene.items.filter(i => i.locked).map(i => i.id);
    if (!ids.length) { this._toast('Nothing locked'); return 0; }
    this.setLocked(ids, false); this._toast(`Unlocked ${ids.length}`); return ids.length;
  }
  lockedCount() { return this.scene.items.reduce((n, i) => n + (i.locked ? 1 : 0), 0); }
  hiddenCount() { return this.scene.items.reduce((n, i) => n + (i.hidden ? 1 : 0), 0); }

  // ---------------- objects / layers panel ----------------
  /** A short, glanceable label for an item row. */
  _layerLabel(it) {
    let glyph = { stroke: '✏️', line: '╱', arrow: '➤', rect: '▭', ellipse: '◯',
                  polygon: '★', text: 'T', image: '🖼', connector: '⇢' }[it.type] || '•';
    let name = it.type;
    if (it.type === 'stroke' && it.taper) { glyph = '🖌️'; name = 'brush'; }
    if (it.type === 'text') name += ' “' + String(it.text).replace(/\s+/g, ' ').slice(0, 10) + '”';
    if (it.group) name += ' ⊞';
    return `${glyph} ${name}`;
  }

  _selectFromPanel(id) {
    const it = this.scene.byId(id);
    if (!it || it.locked || it.hidden) return; // can't grab what you can't touch — use the toggles
    this.selectedIds = new Set(this._groupMembers(it));
    if (this.tool !== 'select') this.setTool('select');
    this._updateHud();
    this.requestRender();
  }

  _layerRow(it) {
    const row = document.createElement('div');
    row.className = 'layer-row' + (this.selectedIds.has(it.id) ? ' sel' : '');
    row.dataset.id = it.id;

    const name = document.createElement('button');
    name.className = 'lr-name';
    name.textContent = this._layerLabel(it);
    name.title = it.id;
    name.onclick = () => this._selectFromPanel(it.id);

    const hide = document.createElement('button');
    hide.className = 'lr-tog lr-hide' + (it.hidden ? '' : ' on');
    hide.textContent = it.hidden ? '🚫' : '👁';
    hide.title = it.hidden ? 'Show' : 'Hide';
    hide.onclick = (e) => { e.stopPropagation(); this.setHidden([it.id], !it.hidden); };

    const lock = document.createElement('button');
    lock.className = 'lr-tog lr-lock' + (it.locked ? ' on' : '');
    lock.textContent = it.locked ? '🔒' : '🔓';
    lock.title = it.locked ? 'Unlock' : 'Lock';
    lock.onclick = (e) => { e.stopPropagation(); this.setLocked([it.id], !it.locked); };

    row.append(name, hide, lock);
    return row;
  }

  /** Rebuild the Objects list, front-most first (top of z-stack on top). Capped
   *  for performance; recovery actions in the header cover anything past the cap. */
  _renderLayers() {
    const wrap = document.getElementById('layer-list');
    if (!wrap) return;
    const items = this.scene.items;
    const total = items.length;
    const CAP = 120;
    const shown = Math.min(CAP, total);
    wrap.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let k = 0; k < shown; k++) {
      frag.appendChild(this._layerRow(items[total - 1 - k])); // reverse → front on top
    }
    if (total > CAP) {
      const more = document.createElement('div');
      more.className = 'layer-more';
      more.textContent = `+${total - CAP} more — use 👁 / 🔓 above to reach all`;
      frag.appendChild(more);
    }
    wrap.appendChild(frag);
  }

  // ---------------- level-of-detail (zoom-dependent visibility) ----------------
  /** mode: 'near' (show only when zoomed in past now), 'far' (only zoomed out), 'all'. */
  setSelectionLOD(mode) {
    if (!this.selectedIds.size) return;
    const s = this.camera.scale;
    const ids = [...this.selectedIds];
    const before = ids.map(id => { const it = this.scene.byId(id); return { minScale: it?.minScale ?? null, maxScale: it?.maxScale ?? null }; });
    const apply = (it) => {
      if (mode === 'near') { it.minScale = s; it.maxScale = null; }
      else if (mode === 'far') { it.maxScale = s; it.minScale = null; }
      else { it.minScale = null; it.maxScale = null; }
    };
    const scene = this.scene;
    this.history.push({
      label: `lod ${mode}`,
      do() { for (const id of ids) { const it = scene.byId(id); if (it) apply(it); } scene._touch(); },
      undo() { ids.forEach((id, i) => { const it = scene.byId(id); if (it) { it.minScale = before[i].minScale; it.maxScale = before[i].maxScale; } }); scene._touch(); },
    });
    const label = mode === 'near' ? 'zoom-in only' : mode === 'far' ? 'zoom-out only' : 'always visible';
    this._toast(`LOD: ${this.selectedIds.size} item(s) → ${label}`);
    this.requestRender();
  }

  /** Count items currently visible at the present zoom (LOD pass). */
  visibleCount() {
    const s = this.camera.scale;
    let n = 0;
    for (const it of this.scene.items) if (lodVisible(it, s)) n++;
    return n;
  }

  // ---------------- recursive stamp (manual fractals) ----------------
  /** Drop `depth` progressively smaller copies of the selection toward its
   *  centre, each scaled by `factor`. Repeat to build a Droste-style fractal. */
  recursiveStamp({ factor = 0.42, depth = 3, anchor = null } = {}) {
    if (!this.selectedIds.size) return 0;
    const items = [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean);
    if (!items.length) return 0;
    let b = itemBBox(items[0]);
    b = { ...b };
    for (const it of items) { const ib = itemBBox(it); b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY); b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY); }
    const cx = anchor ? anchor.x : (b.minX + b.maxX) / 2;
    const cy = anchor ? anchor.y : (b.minY + b.maxY) / 2;
    const clones = [];
    let s = factor;
    for (let k = 0; k < depth; k++) {
      for (const it of items) {
        const c = JSON.parse(JSON.stringify(it));
        c.id = `st_${(this._stampSeq = (this._stampSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        scaleItemAbout(c, cx, cy, s);
        clones.push(c);
      }
      s *= factor;
    }
    this._assignFrame(clones);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
    this._toast(`Stamped ${clones.length} nested copies`);
    return clones.length;
  }

  // ---------------- bookmarks + animated fly-to ----------------
  _loadBookmarks() {
    try { this.bookmarks = JSON.parse(localStorage.getItem('infinizoom.bookmarks') || '[]'); }
    catch { this.bookmarks = []; }
    if (!Array.isArray(this.bookmarks)) this.bookmarks = [];
  }
  _saveBookmarks() {
    try { localStorage.setItem('infinizoom.bookmarks', JSON.stringify(this.bookmarks)); } catch { /* ignore */ }
  }
  addBookmark(name) {
    if (!this.bookmarks) this._loadBookmarks();
    const cam = this.camera.serialize();
    const bm = { name: name || `View ${this.bookmarks.length + 1}`, ...cam };
    this.bookmarks.push(bm);
    this._saveBookmarks();
    this._renderBookmarks();
    this._toast(`Bookmarked “${bm.name}”`);
    return bm;
  }
  removeBookmark(index) {
    if (!this.bookmarks) return;
    this.bookmarks.splice(index, 1);
    this._saveBookmarks();
    this._renderBookmarks();
  }
  gotoBookmark(index, animate = true) {
    const bm = this.bookmarks && this.bookmarks[index];
    if (!bm) return;
    if (animate) this.flyTo(bm, 700);
    else { this.camera.restore(bm); this._updateHud(); this.requestRender(); }
  }

  /** Smoothly animate the camera to a target {x,y,scale}. Scale is eased in
   *  log space so even billion-fold jumps feel natural. */
  flyTo(target, duration = 700) {
    if (this._flying) cancelAnimationFrame(this._flying);
    const start = this.camera.serialize();
    const end = { x: target.x, y: target.y, scale: clamp(target.scale || start.scale, this.camera.minScale, this.camera.maxScale) };
    if (duration <= 0) { this.camera.restore(end); this._updateHud(); this.requestRender(); return Promise.resolve(); }
    const t0 = performance.now();
    const ls = Math.log(start.scale), le = Math.log(end.scale);
    const ease = u => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
    return new Promise(resolve => {
      const step = () => {
        const u = clamp((performance.now() - t0) / duration, 0, 1);
        const e = ease(u);
        this.camera.scale = Math.exp(ls + (le - ls) * e);
        this.camera.x = start.x + (end.x - start.x) * e;
        this.camera.y = start.y + (end.y - start.y) * e;
        this._updateHud();
        this.requestRender();
        if (u < 1) { this._flying = requestAnimationFrame(step); }
        else { this._flying = null; resolve(); }
      };
      this._flying = requestAnimationFrame(step);
    });
  }

  _renderBookmarks() {
    const wrap = document.getElementById('bookmark-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!this.bookmarks) this._loadBookmarks();
    for (let i = 0; i < this.bookmarks.length; i++) {
      const bm = this.bookmarks[i];
      const row = document.createElement('div');
      row.className = 'bm-row';
      const go = document.createElement('button');
      go.className = 'bm-go';
      go.textContent = bm.name;
      go.title = `Fly to ${bm.name} (${formatZoom(bm.scale)})`;
      go.onclick = () => this.gotoBookmark(i, true);
      const del = document.createElement('button');
      del.className = 'bm-del';
      del.textContent = '×';
      del.title = 'Delete bookmark';
      del.onclick = (e) => { e.stopPropagation(); this.removeBookmark(i); };
      row.append(go, del);
      wrap.appendChild(row);
    }
  }

  // ---------------- flipbook / stop-motion animation ----------------
  /** The page an item lives on (absent `frame` ⇒ page 0). */
  frameOf(it) { return it ? (it.frame || 0) : 0; }

  /** Highest page index any item currently occupies (0 if none). */
  _framesMaxUsed() {
    let m = 0;
    for (const it of this.scene.items) { const f = it.frame || 0; if (f > m) m = f; }
    return m;
  }

  /** Keep page count ≥ pages actually drawn, and current page within range. */
  _reconcileFrames() {
    this.anim.count = Math.max(1, this.anim.count | 0, this._framesMaxUsed() + 1);
    this.anim.current = clamp(this.anim.current | 0, 0, this.anim.count - 1);
  }

  /** Tag freshly-created items with the active page (no-op when flipbook is off,
   *  so a normal infinite-canvas drawing never grows a `frame` field). */
  _assignFrame(items) {
    if (!this.anim.on) return items;
    const f = this.anim.current;
    for (const it of (Array.isArray(items) ? items : [items])) {
      if (f) it.frame = f; else delete it.frame; // page 0 is implicit
    }
    return items;
  }

  _itemsOnFrame(f) { return this.scene.items.filter(it => (it.frame || 0) === f); }
  /** How many items live on a page (default: the current one). */
  frameItemCount(f = this.anim.current) { return this._itemsOnFrame(f).length; }

  _ensureFlipbook() { if (!this.anim.on) this.setFlipbook(true); }

  /** Turn flipbook mode on/off. Turning on snaps the page count to what's drawn. */
  setFlipbook(on) {
    on = !!on;
    if (on === this.anim.on) { this._updateAnimUI(); return; }
    this.anim.on = on;
    if (on) this._reconcileFrames(); else this.stop();
    this.selectedIds.clear();           // a selection may now be off-page
    this._afterAnimChange();
    this._toast(on ? '🎬 Flipbook on — each page is a frame' : 'Flipbook off');
  }
  toggleFlipbook() { this.setFlipbook(!this.anim.on); }

  /** Jump to page i (clamped). Pure navigation — not an undo step. */
  setFrame(i) {
    this._ensureFlipbook();
    this.anim.current = clamp(i | 0, 0, this.anim.count - 1);
    this.selectedIds.clear();
    this._afterAnimChange();
  }
  nextFrame() { if (this.anim.count) this.setFrame((this.anim.current + 1) % this.anim.count); }
  prevFrame() { if (this.anim.count) this.setFrame((this.anim.current - 1 + this.anim.count) % this.anim.count); }

  /** Insert a blank page right after the current one (undoable). */
  addFrame() {
    this._ensureFlipbook();
    const at = this.anim.current, app = this, scene = this.scene;
    const shifted = scene.items.filter(it => (it.frame || 0) > at).map(it => it.id);
    const oldCount = this.anim.count, oldCur = this.anim.current;
    this.history.push({
      label: 'add frame',
      do() {
        for (const id of shifted) { const it = scene.byId(id); if (it) it.frame = (it.frame || 0) + 1; }
        app.anim.count = oldCount + 1; app.anim.current = at + 1; scene._touch(); app._afterAnimChange();
      },
      undo() {
        for (const id of shifted) { const it = scene.byId(id); if (it) { it.frame = (it.frame || 0) - 1; if (!it.frame) delete it.frame; } }
        app.anim.count = oldCount; app.anim.current = oldCur; scene._touch(); app._afterAnimChange();
      },
    });
    this._toast(`Added page ${at + 2}`);
  }

  /** Duplicate the current page's drawing onto a fresh page after it (undoable).
   *  The heart of stop-motion: copy a page, then nudge things a little. */
  duplicateFrame() {
    this._ensureFlipbook();
    const at = this.anim.current, app = this, scene = this.scene;
    const shifted = scene.items.filter(it => (it.frame || 0) > at).map(it => it.id);
    const src = this._itemsOnFrame(at);
    const idMap = new Map();
    const clones = src.map(it => {
      const c = JSON.parse(JSON.stringify(it));
      c.id = `fd_${(this._fdupSeq = (this._fdupSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      c.frame = at + 1;
      idMap.set(it.id, c.id);
      return c;
    });
    this._relinkConnectors(clones, idMap);
    this._remapGroups(clones);
    const oldCount = this.anim.count, oldCur = this.anim.current;
    this.history.push({
      label: 'duplicate frame',
      do() {
        for (const id of shifted) { const it = scene.byId(id); if (it) it.frame = (it.frame || 0) + 1; }
        scene.addMany(clones);
        app.anim.count = oldCount + 1; app.anim.current = at + 1; app._afterAnimChange();
      },
      undo() {
        scene.removeMany(clones.map(c => c.id));
        for (const id of shifted) { const it = scene.byId(id); if (it) { it.frame = (it.frame || 0) - 1; if (!it.frame) delete it.frame; } }
        app.anim.count = oldCount; app.anim.current = oldCur; app._afterAnimChange();
      },
    });
    this._toast(`Duplicated page → ${at + 2}`);
  }

  /** Delete the current page (its items and the slot), pulling later pages down.
   *  The final remaining page can't be removed — it's just emptied. (undoable) */
  deleteFrame() {
    this._ensureFlipbook();
    const scene = this.scene, app = this;
    if (this.anim.count <= 1) {
      const items = this._itemsOnFrame(0);
      if (items.length) this.history.push(removeItemsCmd(scene, items));
      this.anim.current = 0; this._afterAnimChange();
      return;
    }
    const at = this.anim.current;
    const doomed = this._itemsOnFrame(at);
    const snapshot = doomed.map(it => ({ item: it, index: scene.items.indexOf(it) })).sort((a, b) => a.index - b.index);
    const shifted = scene.items.filter(it => (it.frame || 0) > at).map(it => it.id);
    const oldCount = this.anim.count, oldCur = this.anim.current;
    const newCur = Math.min(at, oldCount - 2);
    this.history.push({
      label: 'delete frame',
      do() {
        scene.removeMany(doomed.map(i => i.id));
        for (const id of shifted) { const it = scene.byId(id); if (it) { it.frame = (it.frame || 0) - 1; if (!it.frame) delete it.frame; } }
        app.anim.count = oldCount - 1; app.anim.current = newCur; app._afterAnimChange();
      },
      undo() {
        for (const id of shifted) { const it = scene.byId(id); if (it) it.frame = (it.frame || 0) + 1; }
        for (const { item, index } of snapshot) { const a = Math.min(index, scene.items.length); scene.items.splice(a, 0, item); scene._index.set(item.id, item); }
        app.anim.count = oldCount; app.anim.current = oldCur; scene._touch(); app._afterAnimChange();
      },
    });
    this._toast(`Deleted page ${at + 1}`);
  }

  /** Reassign the selection onto another page (cross-frame edit, undoable). */
  moveSelectionToFrame(target) {
    if (!this.anim.on || !this.selectedIds.size) return;
    target = clamp(target | 0, 0, this.anim.count - 1);
    const ids = [...this.selectedIds].filter(id => this.scene.byId(id));
    if (!ids.length) return;
    const scene = this.scene;
    const before = ids.map(id => ({ id, frame: scene.byId(id).frame || 0 }));
    const setF = (id, f) => { const it = scene.byId(id); if (it) { if (f) it.frame = f; else delete it.frame; } };
    this.history.push({
      label: 'move to frame',
      do() { for (const id of ids) setF(id, target); scene._touch(); },
      undo() { for (const { id, frame } of before) setF(id, frame); scene._touch(); },
    });
    this.selectedIds.clear();           // they've left the current page
    this._afterAnimChange();
    this._toast(`Moved ${ids.length} to page ${target + 1}`);
  }

  // ---- playback ----
  play() {
    this._ensureFlipbook();
    if (this.anim.count <= 1) { this._toast('Add pages to animate first'); return; }
    if (this.anim.playing) return;
    this.anim.playing = true;
    this.selectedIds.clear();
    this._updateAnimUI(); this.requestRender();
    this._step();
  }
  _step() {
    if (!this.anim.playing) return;
    const dt = 1000 / clamp(this.anim.fps, 1, 60);
    this._playTimer = setTimeout(() => {
      this._playTimer = null;
      if (!this.anim.playing) return;
      let next = this.anim.current + 1;
      if (next >= this.anim.count) { if (this.anim.loop) next = 0; else { this.stop(); return; } }
      this.anim.current = next;
      this._updateAnimUI(); this.requestRender();
      this._step();
    }, dt);
  }
  stop() {
    if (this._playTimer) { clearTimeout(this._playTimer); this._playTimer = null; }
    if (this.anim.playing) { this.anim.playing = false; this._afterAnimChange(); }
  }
  togglePlay() { this.anim.playing ? this.stop() : this.play(); }

  setOnion(n) { this.anim.onion = clamp(n | 0, 0, 5); this._afterAnimChange(); }
  setFps(n) { this.anim.fps = clamp(n | 0, 1, 60); this._saveAnim(); this._updateAnimUI(); }
  setTint(on) { this.anim.tint = !!on; this._afterAnimChange(); }
  setLoop(on) { this.anim.loop = !!on; this._saveAnim(); this._updateAnimUI(); }

  /** Persist + refresh UI + repaint after any flipbook state change. */
  _afterAnimChange() {
    this._reconcileFrames();
    this._saveAnim();
    this._updateAnimUI();
    this._updateHud();
    this.requestRender();
  }

  _saveAnim() {
    const a = this.anim;
    try {
      localStorage.setItem('infinizoom.anim', JSON.stringify({
        on: a.on, current: a.current, count: a.count,
        onion: a.onion, fps: a.fps, tint: a.tint, loop: a.loop,
      }));
    } catch { /* ignore */ }
  }
  _restoreAnim() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('infinizoom.anim') || 'null'); } catch { s = null; }
    if (s && typeof s === 'object') {
      this.anim.on = !!s.on;
      this.anim.onion = clamp(s.onion == null ? 1 : s.onion, 0, 5);
      this.anim.fps = clamp(s.fps == null ? 6 : s.fps, 1, 60);
      this.anim.tint = s.tint !== false;
      this.anim.loop = s.loop !== false;
      this.anim.count = Math.max(1, s.count | 0);
      this.anim.current = clamp(s.current | 0, 0, this.anim.count - 1);
    }
    this.anim.playing = false;
    this._reconcileFrames();
  }

  /** Refresh the flipbook panel to match anim state. */
  _updateAnimUI() {
    const on = this.anim.on;
    const tgl = document.getElementById('flipToggle');
    if (tgl) tgl.classList.toggle('active', on);
    const ctrls = document.getElementById('flip-controls');
    if (ctrls) ctrls.classList.toggle('hidden', !on);
    document.body.classList.toggle('flip-on', on); // lifts the toast clear of the panel
    if (!on) return;
    const n = this.frameItemCount();
    const ind = document.getElementById('flipIndicator');
    if (ind) ind.textContent = `${this.anim.current + 1} / ${this.anim.count} · ${n} item${n === 1 ? '' : 's'}`;
    const scrub = document.getElementById('flipScrub');
    if (scrub && document.activeElement !== scrub) { scrub.max = String(this.anim.count - 1); scrub.value = String(this.anim.current); }
    const play = document.getElementById('flipPlay');
    if (play) { play.textContent = this.anim.playing ? '⏸' : '▶'; play.classList.toggle('active', this.anim.playing); }
    const fps = document.getElementById('flipFps'); if (fps && document.activeElement !== fps) fps.value = String(this.anim.fps);
    const onion = document.getElementById('flipOnion'); if (onion && document.activeElement !== onion) onion.value = String(this.anim.onion);
    const tint = document.getElementById('flipTint'); if (tint) tint.checked = this.anim.tint;
    const loop = document.getElementById('flipLoop'); if (loop) loop.checked = this.anim.loop;
  }

  // ---------------- generators ----------------
  /** Build a procedural scene. Returns the number of items created. */
  generate(name, opts = {}, { clear = false, fit = true } = {}) {
    const fn = GENERATORS[name];
    if (!fn) { this._toast(`Unknown generator: ${name}`); return 0; }
    const specs = fn(opts);
    const items = specs.map(s => {
      this._genSeq = (this._genSeq || 0) + 1;
      return { ...s, id: `g_${this._genSeq.toString(36)}_${Math.random().toString(36).slice(2, 6)}` };
    });
    this._assignFrame(items);
    if (clear && this.scene.count()) {
      const old = this.scene.items.slice();
      const scene = this.scene;
      this.history.push({
        label: `generate ${name}`,
        do() { scene.removeMany(old.map(i => i.id)); scene.addMany(items); },
        undo() { scene.removeMany(items.map(i => i.id)); scene.addMany(old); },
      });
    } else {
      this.history.push(addItemsCmd(this.scene, items));
    }
    if (fit) this.fitAll();
    this._toast(`Generated ${name} — ${items.length} shapes`);
    return items.length;
  }

  // ---------------- doc ops ----------------
  undo() { this.history.undo(); this._updateHud(); this.requestRender(); }
  redo() { this.history.redo(); this._updateHud(); this.requestRender(); }

  clearAll() {
    if (!this.scene.count()) return;
    const items = this.scene.items.slice();
    this.history.push(removeItemsCmd(this.scene, items));
    this.selectedIds.clear();
    this._toast('Cleared');
  }

  loadDoc(data) {
    const doc = data && data.doc ? data.doc : data;
    this.scene.loadJSON(doc || { items: [] });
    if (data && data.camera) this.camera.restore(data.camera);
    this.renderer.warmImages(this.scene);
    this.history.clear();
    this.selectedIds.clear();
    this.stop();
    this._reconcileFrames();          // page count tracks the loaded drawing
    this._updateAnimUI();
    this._updateHud();
    this.requestRender();
  }

  _restore() {
    const saved = storage.loadLocal();
    if (saved) {
      this.scene.loadJSON(saved.doc || { items: [] });
      this.camera.restore(saved.camera);
      this.renderer.warmImages(this.scene);
    }
  }

  // ---------------- render loop ----------------
  requestRender() { this._dirty = true; }
  render() {
    const t0 = performance.now();
    this.resolveConnectors(); // keep connector endpoints glued to their items
    const gk = this.active && this.active.kind;
    this.renderer.render(this.scene, {
      draft: this.draft, selectedIds: this.selectedIds,
      marquee: this.marquee, eraserCursor: this.eraserCursor,
      rotHandle: gk === 'rotate' ? null : this._rotHandleScreen(),
      // hide the corner handles mid-transform so they don't clutter the gesture
      scaleHandles: (gk === 'scale' || gk === 'rotate' || gk === 'marquee') ? null : this._scaleHandlesScreen(),
      // flipbook: which page is live + onion-skin reach (no onion during playback)
      frame: this.anim.on ? { current: this.anim.current,
                              onion: this.anim.playing ? 0 : this.anim.onion,
                              tint: this.anim.tint } : null,
    });
    this.minimap.render();
    this._stats.lastRenderMs = performance.now() - t0;
    this._stats.frames++;
  }
  _startLoop() {
    const loop = () => {
      if (this._dirty) { this._dirty = false; this.render(); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------- HUD ----------------
  _updateHud() {
    document.getElementById('hud-zoom').textContent = formatZoom(this.camera.scale);
    document.getElementById('hud-coord').textContent =
      `${formatCoord(this.mouseWorld.x)}, ${formatCoord(this.mouseWorld.y)}`;
    const n = this.scene.count();
    const sel = this.selectedIds.size;
    document.getElementById('hud-count').textContent =
      sel ? `${sel}/${n} selected` : `${n} item${n === 1 ? '' : 's'}`;
    document.getElementById('hud-tool').textContent = this.tool;
    if (this._scheduleLayers) this._scheduleLayers(); // refresh Objects list (debounced)
    if (this.anim.on) this._updateAnimUI();           // keep the page item-count live
  }
  _updateUndoRedo() {
    document.getElementById('undo').disabled = !this.history.canUndo();
    document.getElementById('redo').disabled = !this.history.canRedo();
  }

  _toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------------- test API ----------------
  _installTestApi() {
    window.app = this;
    window.__INFINIZOOM__ = {
      version: 2,
      ready: true,
      setTool: n => this.setTool(n),
      getTool: () => this.tool,
      setStyle: s => this.setStyle(s),
      getStyle: () => this.getStyle(),
      itemCount: () => this.scene.count(),
      getItems: () => JSON.parse(JSON.stringify(this.scene.items)),
      selectedCount: () => this.selectedIds.size,
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.history.canUndo(),
      canRedo: () => this.history.canRedo(),
      clear: () => this.clearAll(),
      selectAll: () => this.selectAll(),
      deleteSelection: () => this.deleteSelection(),
      copy: () => this.copySelection(),
      cut: () => this.cutSelection(),
      paste: () => this.paste(),
      clipboardCount: () => (this.clipboard || []).length,
      getCamera: () => this.camera.serialize(),
      setCamera: c => { this.camera.restore(c); this._updateHud(); this.requestRender(); },
      zoomBy: (f, sx, sy) => { this.camera.zoomBy(f, sx, sy); this._updateHud(); this.requestRender(); },
      resetView: () => this.resetView(),
      fitAll: () => this.fitAll(),
      worldToScreen: (x, y) => this.camera.worldToScreen(x, y),
      screenToWorld: (x, y) => this.camera.screenToWorld(x, y),
      bounds: () => this.scene.bounds(),
      toJSON: () => this.scene.toJSON(),
      toSVG: opts => { this.resolveConnectors(); return sceneToSVG(this.scene, opts); },
      loadJSON: d => this.loadDoc(d),
      stats: () => ({ ...this._stats }),
      drawnCount: () => { this.render(); return this.renderer.lastDrawn || 0; },
      // helpers that build geometry directly (world coords). They land on the
      // active flipbook page (when flipbook is on) just like interactive drawing.
      addStroke: (points, style) => {
        const it = makeStroke(points, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addRect: (x, y, w, h, style) => {
        const it = makeRect(x, y, w, h, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addEllipse: (x, y, w, h, style) => {
        const it = makeEllipse(x, y, w, h, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addText: (x, y, text, style) => {
        const it = makeText(x, y, text, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addArrow: (a, b, style) => {
        const it = makeArrow(a, b, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addPolygon: (x, y, w, h, style) => {
        const it = makePolygon(x, y, w, h, { ...this.drawStyle, ...style });
        this._assignFrame([it]); this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addImage: (x, y, w, h, src, opts) => this.addImageItem(x, y, w, h, src, opts || {}),
      // brush / tapered strokes — points may be [{x,y,p}] or [[x,y,p]] (p optional)
      addBrushStroke: (points, style = {}) => {
        const pts = (points || []).map(p => Array.isArray(p)
          ? { x: p[0], y: p[1], p: p[2] == null ? 1 : p[2] }
          : { x: p.x, y: p.y, ...(p.p == null ? {} : { p: p.p }) });
        const it = makeStroke(pts, { ...this.drawStyle, ...style });
        it.taper = true;
        if (style.smooth !== false) it.smooth = true; // brush strokes smooth by default
        this._assignFrame([it]);
        this.history.push(addItemsCmd(this.scene, [it]));
        return it.id;
      },
      smoothPoints: (points, segs) => catmullRom(points, segs == null ? 12 : segs),
      placeImage: (src, sx, sy) => this.placeImageDataURL(src, { x: sx ?? this.camera.width / 2, y: sy ?? this.camera.height / 2 }),
      imagesPending: () => this.imagesPending(),
      generate: (name, opts, flags) => this.generate(name, opts, flags),
      generators: () => Object.keys(GENERATORS),
      // z-order
      bringToFront: () => this.bringToFront(),
      sendToBack: () => this.sendToBack(),
      raise: () => this.raiseSelection(),
      lower: () => this.lowerSelection(),
      order: () => this.scene.items.map(i => i.id),
      // level of detail
      setLOD: mode => this.setSelectionLOD(mode),
      visibleCount: () => this.visibleCount(),
      // rotation
      rotateSelection: (ang, pivot) => this.rotateSelection(ang, pivot),
      rotHandle: () => this._rotHandleScreen(),
      scaleSelection: (factor, pivot) => this.scaleSelection(factor, pivot),
      scaleHandles: () => this._scaleHandlesScreen(),
      nudgeSelection: (dx, dy) => this.nudgeSelection(dx, dy),
      // grouping
      group: () => this.groupSelection(),
      ungroup: () => this.ungroupSelection(),
      groupOf: id => { const it = this.scene.byId(id); return it ? (it.group || null) : null; },
      // lock / hide (layer flags)
      setLocked: (ids, on) => this.setLocked(ids, on),
      setHidden: (ids, on) => this.setHidden(ids, on),
      lockSelection: () => this.toggleLockSelection(),
      hideSelection: () => this.toggleHideSelection(),
      showAll: () => this.showAll(),
      unlockAll: () => this.unlockAll(),
      isLocked: id => !!this.scene.byId(id)?.locked,
      isHidden: id => !!this.scene.byId(id)?.hidden,
      lockedCount: () => this.lockedCount(),
      hiddenCount: () => this.hiddenCount(),
      renderLayers: () => this._renderLayers(),
      // connectors
      addConnector: (from, to, style) => this.addConnector(from, to, style || {}),
      resolveConnectors: () => this.resolveConnectors(),
      // flipbook / stop-motion animation
      flipbook: () => ({ ...this.anim }),
      setFlipbook: on => this.setFlipbook(on),
      toggleFlipbook: () => this.toggleFlipbook(),
      currentFrame: () => this.anim.current,
      frameCount: () => this.anim.count,
      setFrame: i => this.setFrame(i),
      nextFrame: () => this.nextFrame(),
      prevFrame: () => this.prevFrame(),
      addFrame: () => this.addFrame(),
      duplicateFrame: () => this.duplicateFrame(),
      deleteFrame: () => this.deleteFrame(),
      moveSelectionToFrame: f => this.moveSelectionToFrame(f),
      frameItemCount: f => this.frameItemCount(f),
      frameOf: id => this.frameOf(this.scene.byId(id)),
      play: () => this.play(),
      stop: () => this.stop(),
      isPlaying: () => this.anim.playing,
      setOnion: n => this.setOnion(n),
      setFps: n => this.setFps(n),
      setTint: on => this.setTint(on),
      setLoop: on => this.setLoop(on),
      // recursive stamp
      stamp: opts => this.recursiveStamp(opts),
      // bookmarks + fly-to
      addBookmark: name => this.addBookmark(name),
      removeBookmark: i => this.removeBookmark(i),
      gotoBookmark: (i, animate) => this.gotoBookmark(i, animate),
      bookmarks: () => (this.bookmarks || []).slice(),
      flyTo: (target, dur) => this.flyTo(target, dur),
      pick: (wx, wy, tol = 5) => { const it = this.scene.pick(wx, wy, tol); return it ? it.id : null; },
      eyedrop: (wx, wy) => this.eyedrop(wx, wy),
      select: ids => { this.selectedIds = new Set(ids); this._updateHud(); this.requestRender(); },
      render: () => this.render(),
      dataURL: () => this.canvas.toDataURL('image/png'),
    };
  }
}

const app = new App();
window.__app = app;
