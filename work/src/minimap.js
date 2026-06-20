import { itemBBox } from './scene.js';
import { withAlpha } from './util.js';

/**
 * A small overview that shows the document bounds, every item as a dot/box,
 * and the current viewport rectangle. Clicking recenters the camera.
 */
export class Minimap {
  constructor(canvas, camera, scene) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.camera = camera;
    this.scene = scene;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.enabled = true;
    this._lastWorld = null; // mapping cache for click handling
    this._resize();
  }

  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  /** Union of document bounds and current view, with padding — the mapped region. */
  _worldRegion() {
    const view = this.camera.visibleWorldRect();
    let r = this.scene.bounds();
    if (!r) r = { ...view };
    else {
      r = {
        minX: Math.min(r.minX, view.minX), minY: Math.min(r.minY, view.minY),
        maxX: Math.max(r.maxX, view.maxX), maxY: Math.max(r.maxY, view.maxY),
      };
    }
    const w = Math.max(r.maxX - r.minX, 1e-6), h = Math.max(r.maxY - r.minY, 1e-6);
    const pad = 0.15;
    return { minX: r.minX - w * pad, minY: r.minY - h * pad,
             maxX: r.maxX + w * pad, maxY: r.maxY + h * pad };
  }

  render() {
    if (!this.enabled) return;
    const { ctx } = this;
    if (this.canvas.width !== Math.round(this.canvas.getBoundingClientRect().width * this.dpr)) this._resize();
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const region = this._worldRegion();
    this._lastWorld = region;
    const rw = region.maxX - region.minX, rh = region.maxY - region.minY;
    const s = Math.min(W / rw, H / rh);
    const offX = (W - rw * s) / 2, offY = (H - rh * s) / 2;
    const map = (wx, wy) => ({ x: (wx - region.minX) * s + offX, y: (wy - region.minY) * s + offY });

    // items
    for (const it of this.scene.items) {
      const b = itemBBox(it);
      const a = map(b.minX, b.minY), c = map(b.maxX, b.maxY);
      ctx.fillStyle = withAlpha(it.color || '#e8e8ef', 0.85);
      const w = Math.max(c.x - a.x, 1.2), h = Math.max(c.y - a.y, 1.2);
      ctx.fillRect(a.x, a.y, w, h);
    }

    // viewport rect
    const v = this.camera.visibleWorldRect();
    const a = map(v.minX, v.minY), c = map(v.maxX, v.maxY);
    ctx.strokeStyle = withAlpha('#5b8cff', 0.95);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.fillStyle = withAlpha('#5b8cff', 0.08);
    ctx.fillRect(a.x, a.y, c.x - a.x, c.y - a.y);
  }

  /** Map a click (canvas-local px) back to a world point; null if not ready. */
  clickToWorld(localX, localY) {
    if (!this._lastWorld) return null;
    const region = this._lastWorld;
    const W = this.canvas.width / this.dpr, H = this.canvas.height / this.dpr;
    const rw = region.maxX - region.minX, rh = region.maxY - region.minY;
    const s = Math.min(W / rw, H / rh);
    const offX = (W - rw * s) / 2, offY = (H - rh * s) / 2;
    return { x: (localX - offX) / s + region.minX, y: (localY - offY) / s + region.minY };
  }
}
