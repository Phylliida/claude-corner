import { Camera } from './camera.js';
import { Scene, makeStroke, makeLine, makeRect, makeEllipse, makeText, makeArrow, makePolygon,
         translateItem, scaleItemAbout, itemBBox, lodVisible } from './scene.js';
import { Renderer } from './renderer.js';
import { Minimap } from './minimap.js';
import { History, addItemsCmd, removeItemsCmd, moveItemsCmd, reorderCmd } from './history.js';
import { simplify, debounce, clamp, dist, formatZoom, formatCoord, pointInRect } from './util.js';
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
                   textSize: 24, sides: 5, star: true, opacity: 1 };
    this.snap = false;

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

    this.scene.onChange = () => { this.requestRender(); this.autosave(); this._updateHud(); };
    this.history.onChange = () => { this._updateUndoRedo(); };

    this._bindUI();
    this._bindInput();
    this._bindKeys();
    this._buildSwatches();

    this._restore();
    this._loadBookmarks();
    this._renderBookmarks();
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
    // apply to current selection
    const fillable = new Set(['rect', 'ellipse', 'polygon']);
    if (this.selectedIds.size && (partial.color || partial.width || partial.fill !== undefined ||
                                  partial.sides !== undefined || partial.star !== undefined ||
                                  partial.opacity !== undefined)) {
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
             sides: this.style.sides, star: this.style.star, opacity: this.style.opacity };
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
    const it = makeStroke(pts, { color: this.draft.color, width: this.draft.width });
    this.draft = null;
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
    this.history.push(addItemsCmd(this.scene, [d]));
  }

  // ---- eraser ----
  _lodFilter() { const s = this.camera.scale; return it => lodVisible(it, s); }

  /** Sample the colour of the top-most item under a world point into the palette. */
  eyedrop(wx, wy) {
    const hit = this.scene.pick(wx, wy, this.camera.screenToWorldLen(6), this._lodFilter());
    if (hit && hit.color) { this.setStyle({ color: hit.color }); this._toast(`Picked ${hit.color}`); return hit.color; }
    return null;
  }

  _eraseRadiusWorld() { return this.camera.screenToWorldLen(10) + this.style.width / 2; }
  _eraseAt(w, _s) {
    const tol = this._eraseRadiusWorld();
    const hit = this.scene.pick(w.x, w.y, tol, this._lodFilter());
    if (hit && this.active && !this.active.removed.includes(hit)) {
      this.active.removed.push(hit);
      this.scene.remove(hit.id);
    }
  }

  // ---- selection ----
  _beginSelect(s, w, e) {
    const tol = this.camera.screenToWorldLen(6);
    // If clicking inside the bbox of an already-selected item, drag the whole
    // selection — even over an unfilled interior. This matches vector editors.
    if (this.selectedIds.size && !e.shiftKey) {
      for (const id of this.selectedIds) {
        const it = this.scene.byId(id);
        if (it && pointInRect(w.x, w.y, itemBBox(it))) {
          this.active = { kind: 'move', lastWorld: w, totalDx: 0, totalDy: 0 };
          return;
        }
      }
    }
    const hit = this.scene.pick(w.x, w.y, tol, this._lodFilter());
    if (hit) {
      if (e.shiftKey) {
        if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
        else this.selectedIds.add(hit.id);
      } else if (!this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set([hit.id]);
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
      for (const it of hits) this.selectedIds.add(it.id);
    }
    this.marquee = null;
    this._updateHud();
  }
  deleteSelection() {
    if (!this.selectedIds.size) return;
    const items = [...this.selectedIds].map(id => this.scene.byId(id)).filter(Boolean);
    this.history.push(removeItemsCmd(this.scene, items));
    this.selectedIds.clear();
    this._updateHud();
  }
  selectAll() {
    this.selectedIds = new Set(this.scene.items.map(i => i.id));
    if (this.tool !== 'select') this.setTool('select');
    this._updateHud();
    this.requestRender();
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
      this.history.push(addItemsCmd(this.scene, [it]));
    }
    this._textPos = null;
  }

  // ---------------- view ops ----------------
  zoomAtCenter(factor) { this.camera.zoomBy(factor); this._updateHud(); this.requestRender(); }
  resetView() { this.camera.x = 0; this.camera.y = 0; this.camera.scale = 1; this._updateHud(); this.requestRender(); }
  fitAll() {
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
    document.getElementById('sides').oninput = e => this.setStyle({ sides: parseInt(e.target.value, 10) });
    document.getElementById('opacity').oninput = e => this.setStyle({ opacity: parseFloat(e.target.value) });
    document.getElementById('starToggle').onchange = e => this.setStyle({ star: e.target.checked });
    document.getElementById('fillOn').onchange = e => { this.style.fillOn = e.target.checked; this._applyFillToSelection(); };
    document.getElementById('fillColor').oninput = e => { this.style.fillColor = e.target.value; if (this.style.fillOn) this._applyFillToSelection(); };

    document.getElementById('clearBtn').onclick = () => this.clearAll();
    document.getElementById('exportPng').onclick = () => { this.render(); storage.downloadPNG(this.canvas); this._toast('Exported PNG'); };
    document.getElementById('exportSvg').onclick = () => { storage.downloadSVG(sceneToSVG(this.scene)); this._toast('Exported SVG'); };
    document.getElementById('exportJson').onclick = () => { storage.downloadJSON(this.scene); this._toast('Exported JSON'); };
    document.getElementById('importJson').onclick = () => document.getElementById('importFile').click();
    document.getElementById('importFile').onchange = async e => {
      const f = e.target.files[0];
      if (!f) return;
      try { const data = await storage.readFileAsJSON(f); this.loadDoc(data); this._toast('Imported drawing'); }
      catch { this._toast('Import failed — invalid JSON'); }
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

    document.querySelectorAll('.gen-row button').forEach(b =>
      b.addEventListener('click', () => this.generate(b.dataset.gen, {}, { clear: false, fit: true })));

    document.getElementById('toBack').onclick = () => this.sendToBack();
    document.getElementById('toFront').onclick = () => this.bringToFront();
    document.getElementById('raise').onclick = () => this.raiseSelection();
    document.getElementById('lower').onclick = () => this.lowerSelection();
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

      if (e.key === 'Delete' || e.key === 'Backspace') { if (this.selectedIds.size) { e.preventDefault(); this.deleteSelection(); } return; }
      if (e.key === 'Escape') { this.selectedIds.clear(); this.draft = null; this.active = null; this.requestRender(); return; }

      // z-order: ] front / [ back, with Ctrl for one-step raise/lower
      if (e.key === ']') { e.preventDefault(); meta ? this.raiseSelection() : this.bringToFront(); return; }
      if (e.key === '[') { e.preventDefault(); meta ? this.lowerSelection() : this.sendToBack(); return; }

      switch (e.key.toLowerCase()) {
        case 'p': this.setTool('pen'); break;
        case 'l': this.setTool('line'); break;
        case 'a': this.setTool('arrow'); break;
        case 'r': this.setTool('rect'); break;
        case 'o': this.setTool('ellipse'); break;
        case 's': this.setTool('star'); break;
        case 't': this.setTool('text'); break;
        case 'v': this.setTool('select'); break;
        case 'e': this.setTool('eraser'); break;
        case 'h': this.setTool('pan'); break;
        case 'f': this.fitAll(); break;
        case '0': this.resetView(); break;
        case '+': case '=': this.zoomAtCenter(1.25); break;
        case '-': case '_': this.zoomAtCenter(1 / 1.25); break;
        case 'g': { const t = document.getElementById('gridToggle'); t.checked = !t.checked; t.onchange({ target: t }); break; }
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
      .map(it => { const c = JSON.parse(JSON.stringify(it)); delete c.id; return c; });
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
    const clones = this.clipboard.map(c => {
      const n = JSON.parse(JSON.stringify(c));
      n.id = `pst_${(this._pasteSeq = (this._pasteSeq || 0) + 1).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      return n;
    });
    let b = itemBBox(clones[0]); b = { ...b };
    for (const c of clones) { const ib = itemBBox(c); b.minX = Math.min(b.minX, ib.minX); b.minY = Math.min(b.minY, ib.minY); b.maxX = Math.max(b.maxX, ib.maxX); b.maxY = Math.max(b.maxY, ib.maxY); }
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    // land the paste centred on the current view
    const dx = this.camera.x - cx, dy = this.camera.y - cy;
    for (const c of clones) translateItem(c, dx, dy);
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
    this._toast(`Pasted ${clones.length}`);
    return clones.length;
  }

  duplicateSelection() {
    if (!this.selectedIds.size) return;
    const off = this.camera.screenToWorldLen(16);
    const clones = [...this.selectedIds].map(id => {
      const it = this.scene.byId(id);
      if (!it) return null;
      const c = JSON.parse(JSON.stringify(it));
      c.id = undefined;
      const made = c;
      return made;
    }).filter(Boolean);
    // assign fresh ids & offset
    for (const c of clones) {
      c.id = 'dup_' + Math.random().toString(36).slice(2, 9);
      translateItem(c, off, off);
    }
    this.history.push(addItemsCmd(this.scene, clones));
    this.selectedIds = new Set(clones.map(c => c.id));
    this._updateHud();
  }

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
    this.history.clear();
    this.selectedIds.clear();
    this._updateHud();
    this.requestRender();
  }

  _restore() {
    const saved = storage.loadLocal();
    if (saved) {
      this.scene.loadJSON(saved.doc || { items: [] });
      this.camera.restore(saved.camera);
    }
  }

  // ---------------- render loop ----------------
  requestRender() { this._dirty = true; }
  render() {
    const t0 = performance.now();
    this.renderer.render(this.scene, {
      draft: this.draft, selectedIds: this.selectedIds,
      marquee: this.marquee, eraserCursor: this.eraserCursor,
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
      toSVG: opts => sceneToSVG(this.scene, opts),
      loadJSON: d => this.loadDoc(d),
      stats: () => ({ ...this._stats }),
      drawnCount: () => { this.render(); return this.renderer.lastDrawn || 0; },
      // helpers that build geometry directly (world coords)
      addStroke: (points, style) => {
        const it = makeStroke(points, { ...this.drawStyle, ...style });
        this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addRect: (x, y, w, h, style) => {
        const it = makeRect(x, y, w, h, { ...this.drawStyle, ...style });
        this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addEllipse: (x, y, w, h, style) => {
        const it = makeEllipse(x, y, w, h, { ...this.drawStyle, ...style });
        this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addText: (x, y, text, style) => {
        const it = makeText(x, y, text, { ...this.drawStyle, ...style });
        this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addArrow: (a, b, style) => {
        const it = makeArrow(a, b, { ...this.drawStyle, ...style });
        this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
      addPolygon: (x, y, w, h, style) => {
        const it = makePolygon(x, y, w, h, { ...this.drawStyle, ...style });
        this.history.push(addItemsCmd(this.scene, [it])); return it.id;
      },
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
