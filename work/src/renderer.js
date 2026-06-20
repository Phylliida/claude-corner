import { itemBBox, lodVisible, polygonVertices, rotCenter, ROTATABLE } from './scene.js';
import { withAlpha, clamp, ribbonOutline, catmullRom } from './util.js';

/**
 * Owns the <canvas>, handles device-pixel-ratio, and paints everything:
 * adaptive grid, scene items (culled to the viewport), the in-progress draft,
 * and selection chrome. Geometry is drawn in world space via a combined
 * DPR×camera transform; UI chrome (grid, handles) is drawn in screen space.
 */
export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.showGrid = true;
    this.gridStyle = 'lines'; // 'lines' | 'dots'
    this.bg = '#0e0f13';
    this.gridColor = '#ffffff';
    this._images = new Map(); // src -> { img, loaded, broken }
    this.onAsyncLoad = null;  // called when a deferred image bitmap finishes loading
    this.resize();
  }

  /**
   * Lazily decode an image `src` into a cached HTMLImageElement. Returns the
   * cache entry immediately; when an async decode completes it flips `loaded`
   * (or `broken`) and fires `onAsyncLoad` so the app can repaint. Reused across
   * frames so panning/zooming never re-decodes.
   */
  _image(src) {
    let entry = this._images.get(src);
    if (entry) return entry;
    entry = { img: new Image(), loaded: false, broken: false };
    entry.img.onload = () => { entry.loaded = true; this.onAsyncLoad && this.onAsyncLoad(); };
    entry.img.onerror = () => { entry.broken = true; this.onAsyncLoad && this.onAsyncLoad(); };
    entry.img.src = src;
    // data URLs may already be decoded synchronously in some engines
    if (entry.img.complete && entry.img.naturalWidth) entry.loaded = true;
    this._images.set(src, entry);
    return entry;
  }

  /** Kick off decoding of every image src in the scene so bitmaps are ready
   *  before they scroll into view (and so pendingImages is meaningful even when
   *  an image is currently culled offscreen). */
  warmImages(scene) {
    for (const it of scene.items) if (it.type === 'image' && it.src) this._image(it.src);
  }

  /** How many image items still have an undecoded bitmap (test/UX hook). */
  pendingImages(scene) {
    let n = 0;
    for (const it of scene.items) {
      if (it.type !== 'image' || !it.src) continue;
      const e = this._images.get(it.src);
      if (!e || (!e.loaded && !e.broken)) n++;
    }
    return n;
  }

  resize() {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.setViewport(w, h);
  }

  _screenSpace() { this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); }
  _worldSpace() {
    const c = this.camera, d = this.dpr;
    this.ctx.setTransform(
      c.scale * d, 0, 0, c.scale * d,
      (c.width / 2 - c.x * c.scale) * d,
      (c.height / 2 - c.y * c.scale) * d,
    );
  }

  /** Full repaint. `state` carries draft/selection info from the app. */
  render(scene, state = {}) {
    const { ctx, camera } = this;
    this._screenSpace();
    ctx.clearRect(0, 0, camera.width, camera.height);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, camera.width, camera.height);

    if (this.showGrid) this._drawGrid();

    // Scene items in world space (culled).
    this._worldSpace();
    const view = camera.visibleWorldRect();
    // expand cull rect slightly so wide strokes near edges still draw
    const margin = camera.screenToWorldLen(64);
    const cull = { minX: view.minX - margin, minY: view.minY - margin,
                   maxX: view.maxX + margin, maxY: view.maxY + margin };
    const selected = state.selectedIds instanceof Set ? state.selectedIds : new Set();
    const fv = state.frame || null;                         // flipbook page view, or null
    let drawn = 0;
    for (const it of scene.items) {
      if (it.hidden) continue;                              // layer visibility (eye toggle)
      if (!lodVisible(it, camera.scale)) continue;          // zoom-dependent visibility
      if (it.type === 'connector' && (!scene.byId(it.from) || !scene.byId(it.to))) continue; // dangling
      // flipbook: skip off-page items, ghost neighbouring pages (onion skin)
      let alphaMul = 1, tint = null;
      if (fv) {
        const fs = this._frameStyle(it, fv);
        if (!fs) continue;
        alphaMul = fs.alpha; tint = fs.tint;
      }
      const b = itemBBox(it);
      if (b.maxX < cull.minX || b.minX > cull.maxX || b.maxY < cull.minY || b.minY > cull.maxY) continue;
      this._drawItem(it, false, alphaMul, tint);
      drawn++;
    }
    this.lastDrawn = drawn;

    // Draft (in-progress) item, drawn in world space.
    if (state.draft) this._drawItem(state.draft, true);

    // Selection chrome & marquee in screen space.
    this._screenSpace();
    if (selected.size) this._drawSelection(scene, selected);
    if (state.scaleHandles) this._drawScaleHandles(state.scaleHandles);
    if (state.rotHandle) this._drawRotHandle(state.rotHandle);
    if (state.marquee) this._drawMarquee(state.marquee);
    if (state.eraserCursor) this._drawEraserCursor(state.eraserCursor);
  }

  /**
   * Flipbook page styling for an item, given the view {current, onion, tint}.
   * Returns null to hide the item, else { alpha, tint } where alpha multiplies
   * its opacity and tint (a flat colour) marks an onion-skin ghost. The current
   * page draws at full strength in its own colours; adjacent pages within the
   * onion reach fade with distance and tint warm (past) / cool (future), the
   * traditional-animation convention.
   */
  _frameStyle(it, fv) {
    const df = (it.frame || 0) - fv.current;
    if (df === 0) return { alpha: 1, tint: null };
    const onion = fv.onion || 0;
    if (onion <= 0 || Math.abs(df) > onion) return null;
    const fade = 1 - (Math.abs(df) - 1) / (onion + 0.6); // nearer ghosts stronger
    const alpha = 0.34 * Math.max(0.12, fade);
    const tint = fv.tint ? (df < 0 ? '#ff6b6b' : '#5b8cff') : null;
    return { alpha, tint };
  }

  // ---- grid ----
  _drawGrid() {
    const { ctx, camera } = this;
    const targetPx = 78;                    // desired screen gap between minor lines
    const worldPerTarget = targetPx / camera.scale;
    const pow = Math.pow(10, Math.floor(Math.log10(worldPerTarget)));
    // choose 1/2/5 multiple so minor spacing lands near targetPx
    let step = pow;
    for (const m of [1, 2, 5, 10]) {
      if (pow * m * camera.scale >= targetPx) { step = pow * m; break; }
      step = pow * m;
    }
    const minorPx = step * camera.scale;
    const majorStep = step * 5;

    // fade minor grid as it approaches major spacing / gets dense
    const minorAlpha = clamp((minorPx - 6) / 60, 0, 1) * 0.06;
    const majorAlpha = 0.12;

    const view = camera.visibleWorldRect();
    ctx.lineWidth = 1;

    const drawSet = (spacing, alpha) => {
      if (alpha <= 0.001) return;
      ctx.strokeStyle = withAlpha(this.gridColor, alpha);
      ctx.beginPath();
      const startX = Math.floor(view.minX / spacing) * spacing;
      for (let wx = startX; wx <= view.maxX; wx += spacing) {
        const sx = Math.round((wx - camera.x) * camera.scale + camera.width / 2) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, camera.height);
      }
      const startY = Math.floor(view.minY / spacing) * spacing;
      for (let wy = startY; wy <= view.maxY; wy += spacing) {
        const sy = Math.round((wy - camera.y) * camera.scale + camera.height / 2) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(camera.width, sy);
      }
      ctx.stroke();
    };

    if (this.gridStyle === 'dots') {
      this._drawDots(step, view, Math.min(minorAlpha * 2.2, 0.18));
      this._drawDots(majorStep, view, 0.3);
    } else {
      drawSet(step, minorAlpha);
      drawSet(majorStep, majorAlpha);
    }

    // emphasize the world origin axes
    const o = camera.worldToScreen(0, 0);
    if (o.x >= 0 && o.x <= camera.width) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.35);
      ctx.beginPath(); ctx.moveTo(o.x + 0.5, 0); ctx.lineTo(o.x + 0.5, camera.height); ctx.stroke();
    }
    if (o.y >= 0 && o.y <= camera.height) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.35);
      ctx.beginPath(); ctx.moveTo(0, o.y + 0.5); ctx.lineTo(camera.width, o.y + 0.5); ctx.stroke();
    }
  }

  _drawDots(spacing, view, alpha) {
    if (alpha <= 0.002) return;
    const { ctx, camera } = this;
    const px = spacing * camera.scale;
    if (px < 6) return; // too dense to be useful
    const size = Math.min(2.4, Math.max(1.2, px * 0.03));
    ctx.fillStyle = withAlpha(this.gridColor, alpha);
    const startX = Math.floor(view.minX / spacing) * spacing;
    const startY = Math.floor(view.minY / spacing) * spacing;
    for (let wx = startX; wx <= view.maxX; wx += spacing) {
      const sx = (wx - camera.x) * camera.scale + camera.width / 2;
      for (let wy = startY; wy <= view.maxY; wy += spacing) {
        const sy = (wy - camera.y) * camera.scale + camera.height / 2;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      }
    }
  }

  // ---- items ----
  /**
   * Paint one item. `alphaMul` scales its opacity (used for onion-skin ghosts);
   * `tint` overrides its colour with a flat ghost colour (and suppresses fills),
   * also for onion skinning. Both default to the no-op identity so normal draws
   * are byte-identical to before.
   */
  _drawItem(it, isDraft = false, alphaMul = 1, tint = null) {
    const { ctx, camera } = this;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = (it.opacity == null ? 1 : it.opacity) * alphaMul;
    const col = tint || it.color;          // onion ghosts draw in a flat tint
    const fillCol = tint ? null : it.fill; // tint ⇒ stroke-only ghost (no fill)
    // Stroke width: world units that scale with zoom (default), or — when the
    // item opts into widthMode:'screen' — a constant on-screen pixel width.
    const minWorldWidth = camera.screenToWorldLen(0.75); // keep hairlines visible
    const lw = it.widthMode === 'screen'
      ? camera.screenToWorldLen(Math.max(it.width || 1, 0.75))
      : Math.max(it.width || 1, minWorldWidth);

    // Rotated box items draw in a locally-rotated world frame; point items bake
    // their rotation into the geometry so they need no transform here.
    const rotated = !!it.rot && ROTATABLE.has(it.type);
    if (rotated) {
      const c = rotCenter(it);
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(it.rot);
      ctx.translate(-c.x, -c.y);
    }

    switch (it.type) {
      case 'stroke': {
        const p = it.points;
        if (!p.length) break;
        if (it.taper) { this._drawRibbon(it, lw, col); break; }   // pressure/tapered brush
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        if (p.length === 1) { ctx.lineTo(p[0].x + 1e-6, p[0].y); }
        else { for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y); }
        ctx.stroke();
        break;
      }
      case 'line': {
        const [a, b] = it.points;
        ctx.strokeStyle = col;
        ctx.lineWidth = lw;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        break;
      }
      case 'arrow': {
        const [a, b] = it.points;
        this._drawArrowSeg(a, b, col, lw, true);
        break;
      }
      case 'connector': {
        const a = { x: it.ax, y: it.ay }, b = { x: it.bx, y: it.by };
        this._drawArrowSeg(a, b, col, lw, it.arrow !== false);
        break;
      }
      case 'polygon': {
        const verts = polygonVertices(it);
        if (!verts.length) break;
        ctx.beginPath();
        ctx.moveTo(verts[0].x, verts[0].y);
        for (let i = 1; i < verts.length; i++) ctx.lineTo(verts[i].x, verts[i].y);
        ctx.closePath();
        if (fillCol) { ctx.fillStyle = fillCol; ctx.fill(); }
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
        break;
      }
      case 'rect': {
        if (fillCol) { ctx.fillStyle = fillCol; ctx.fillRect(it.x, it.y, it.w, it.h); }
        ctx.strokeStyle = col; ctx.lineWidth = lw;
        ctx.strokeRect(it.x, it.y, it.w, it.h);
        break;
      }
      case 'ellipse': {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        const rx = Math.abs(it.w / 2), ry = Math.abs(it.h / 2);
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (fillCol) { ctx.fillStyle = fillCol; ctx.fill(); }
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke();
        break;
      }
      case 'image': {
        const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
        const w = Math.abs(it.w), h = Math.abs(it.h);
        const entry = it.src ? this._image(it.src) : null;
        if (entry && entry.loaded) {
          // crisper downscales when an image is shrunk far below native size
          ctx.imageSmoothingEnabled = true;
          try { ctx.drawImage(entry.img, x, y, w, h); }
          catch { this._drawImagePlaceholder(x, y, w, h, true); }
        } else {
          this._drawImagePlaceholder(x, y, w, h, entry ? entry.broken : true);
        }
        break;
      }
      case 'text': {
        ctx.fillStyle = col;
        ctx.textBaseline = 'top';
        ctx.font = `${it.size}px ui-sans-serif, system-ui, sans-serif`;
        const lines = String(it.text).split('\n');
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], it.x, it.y + i * it.size * 1.1);
        }
        break;
      }
    }
    if (rotated) ctx.restore();
    if (isDraft) { /* draft uses same styling; hook kept for future ghosting */ }
    ctx.globalAlpha = 1;
  }

  /** Draw a line a→b, optionally capped with a filled arrowhead at b. */
  _drawArrowSeg(a, b, color, lw, withHead) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!withHead) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); return; }
    ctx.fillStyle = color;
    const head = Math.min(len * 0.4, Math.max(lw * 3.5, len * 0.12));
    // shaft stops short of the head so the tip is crisp
    const sx = b.x - Math.cos(ang) * head * 0.8, sy = b.y - Math.sin(ang) * head * 0.8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(sx, sy); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(ang - 0.5) * head, b.y - Math.sin(ang - 0.5) * head);
    ctx.lineTo(b.x - Math.cos(ang + 0.5) * head, b.y - Math.sin(ang + 0.5) * head);
    ctx.closePath(); ctx.fill();
  }

  /** Paint a variable-width "brush" stroke: a filled ribbon whose half-width at
   *  each point is the base half-width times that point's pressure `p`. Recomputed
   *  every frame in world space, so it stays crisp at any zoom (a tiny floor keeps
   *  it visible when zoomed far out). A 1-point stroke renders as a round dab. */
  _drawRibbon(it, lw, col = it.color) {
    const { ctx, camera } = this;
    let p = it.points;
    const base = lw / 2;
    const minHalf = camera.screenToWorldLen(0.35);
    ctx.fillStyle = col;
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0].x, p[0].y, Math.max(minHalf, base), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Catmull-Rom smoothing: resample at a density tied to on-screen size so the
    // curve stays smooth when zoomed in, cheap when small. World-space → crisp.
    if (it.smooth && p.length >= 3) {
      let len = 0;
      for (let i = 1; i < p.length; i++) len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
      const avgPx = camera.worldToScreenLen(len / (p.length - 1));
      const segs = clamp(Math.round(avgPx / 7), 4, 48);
      p = catmullRom(p, segs);
    }
    const outline = ribbonOutline(p, i => Math.max(minHalf, base * (p[i].p == null ? 1 : p[i].p)));
    if (!outline || !outline.length) return;
    ctx.beginPath();
    ctx.moveTo(outline[0].x, outline[0].y);
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
    ctx.closePath();
    ctx.fill();
  }

  /** Placeholder frame shown while an image decodes (or when it fails). */
  _drawImagePlaceholder(x, y, w, h, broken) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = withAlpha(broken ? '#ff5b6e' : '#5b8cff', 0.10);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = withAlpha(broken ? '#ff5b6e' : '#5b8cff', 0.6);
    ctx.lineWidth = this.camera.screenToWorldLen(1);
    ctx.setLineDash([this.camera.screenToWorldLen(6), this.camera.screenToWorldLen(4)]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    // diagonal cross conveys "image" without needing a font
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
    ctx.stroke();
    ctx.restore();
  }

  // ---- selection ----
  _drawSelection(scene, ids) {
    const { ctx, camera } = this;
    let any = false, R = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const id of ids) {
      const it = scene.byId(id);
      if (!it || it.hidden) continue;
      if (!lodVisible(it, camera.scale)) continue; // don't frame invisible items
      any = true;
      const b = itemBBox(it);
      const tl = camera.worldToScreen(b.minX, b.minY);
      const br = camera.worldToScreen(b.maxX, b.maxY);
      ctx.strokeStyle = withAlpha('#5b8cff', 0.9);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
      ctx.setLineDash([]);
      R.minX = Math.min(R.minX, tl.x); R.minY = Math.min(R.minY, tl.y);
      R.maxX = Math.max(R.maxX, br.x); R.maxY = Math.max(R.maxY, br.y);
    }
    if (any && ids.size > 1) {
      ctx.strokeStyle = withAlpha('#5b8cff', 0.5);
      ctx.strokeRect(R.minX - 3, R.minY - 3, R.maxX - R.minX + 6, R.maxY - R.minY + 6);
    }
  }

  /** Small square grab handles at the selection corners for uniform resize. */
  _drawScaleHandles(handles) {
    const { ctx } = this;
    const sz = 4; // half-side in px
    ctx.lineWidth = 1.5;
    for (const h of handles) {
      ctx.fillStyle = withAlpha('#0e0f13', 0.9);
      ctx.strokeStyle = withAlpha('#5b8cff', 0.9);
      ctx.beginPath();
      ctx.rect(h.x - sz, h.y - sz, sz * 2, sz * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /** A small round grab handle above the selection for free rotation. */
  _drawRotHandle(h) {
    const { ctx } = this;
    ctx.strokeStyle = withAlpha('#5b8cff', 0.85);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(h.x, h.y + 22); ctx.lineTo(h.x, h.y);   // stalk down to the bbox top
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha('#0e0f13', 0.9); ctx.fill();
    ctx.stroke();
  }

  _drawMarquee(m) {
    const { ctx } = this;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    ctx.fillStyle = withAlpha('#5b8cff', 0.10);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = withAlpha('#5b8cff', 0.8);
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }

  _drawEraserCursor(c) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha('#ff5b6e', 0.9);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
