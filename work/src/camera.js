import { clamp } from './util.js';

/**
 * The camera maps between world space (where drawing geometry lives, in
 * unbounded f64 coordinates) and screen space (CSS pixels).
 *
 *   screen = (world - center) * scale + viewport/2
 *   world  = (screen - viewport/2) / scale + center
 *
 * `scale` is pixels-per-world-unit. center.{x,y} is the world point shown at
 * the middle of the screen. Zoom is "infinite" in the sense that scale can
 * range across ~30 orders of magnitude before f64 precision degrades; the
 * app rebases the origin (see Scene) to push that limit much further.
 */
export class Camera {
  constructor(width = 1, height = 1) {
    this.x = 0;          // world coord at screen center
    this.y = 0;
    this.scale = 1;      // pixels per world unit
    this.width = width;  // viewport size in CSS px
    this.height = height;
    this.minScale = 1e-12;
    this.maxScale = 1e12;
  }

  setViewport(w, h) { this.width = w; this.height = h; }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.scale + this.width / 2,
      y: (wy - this.y) * this.scale + this.height / 2,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.width / 2) / this.scale + this.x,
      y: (sy - this.height / 2) / this.scale + this.y,
    };
  }

  /** Distance/length conversions. */
  worldToScreenLen(l) { return l * this.scale; }
  screenToWorldLen(l) { return l / this.scale; }

  /** Apply this camera as a 2D context transform so geometry can be drawn in world coords. */
  applyTo(ctx) {
    ctx.setTransform(
      this.scale, 0,
      0, this.scale,
      this.width / 2 - this.x * this.scale,
      this.height / 2 - this.y * this.scale,
    );
  }

  /** Multiply scale by `factor`, keeping the world point under (sx,sy) fixed on screen. */
  zoomBy(factor, sx = this.width / 2, sy = this.height / 2) {
    const before = this.screenToWorld(sx, sy);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    const after = this.screenToWorld(sx, sy);
    // shift center so the anchor world point stays under the cursor
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Set absolute scale, anchored at a screen point. */
  zoomTo(scale, sx = this.width / 2, sy = this.height / 2) {
    const target = clamp(scale, this.minScale, this.maxScale);
    this.zoomBy(target / this.scale, sx, sy);
  }

  /** Pan by a screen-space delta (px). */
  panByScreen(dxScreen, dyScreen) {
    this.x -= dxScreen / this.scale;
    this.y -= dyScreen / this.scale;
  }

  /** The world-space rectangle currently visible. */
  visibleWorldRect() {
    const tl = this.screenToWorld(0, 0);
    const br = this.screenToWorld(this.width, this.height);
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
  }

  /** Center the view on a world bbox with some padding (0..1 fraction of margin). */
  fitToRect(rect, pad = 0.12) {
    const w = Math.max(rect.maxX - rect.minX, 1e-9);
    const h = Math.max(rect.maxY - rect.minY, 1e-9);
    const sx = (this.width * (1 - pad)) / w;
    const sy = (this.height * (1 - pad)) / h;
    this.scale = clamp(Math.min(sx, sy), this.minScale, this.maxScale);
    this.x = (rect.minX + rect.maxX) / 2;
    this.y = (rect.minY + rect.maxY) / 2;
  }

  serialize() { return { x: this.x, y: this.y, scale: this.scale }; }
  restore(s) {
    if (!s) return;
    if (Number.isFinite(s.x)) this.x = s.x;
    if (Number.isFinite(s.y)) this.y = s.y;
    if (Number.isFinite(s.scale)) this.scale = clamp(s.scale, this.minScale, this.maxScale);
  }
}
