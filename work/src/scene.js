import { uid, bboxOfPoints, distToSegment, dist, rectsIntersect, rectContains, pointInRect, rotatePoint } from './util.js';

/** Item types that carry an optional `rot` (radians) about their own centre.
 *  Point-based items (stroke/line/arrow) bake rotation into their points instead. */
export const ROTATABLE = new Set(['rect', 'ellipse', 'polygon', 'image', 'text']);

/**
 * Item shapes (all geometry in world coordinates):
 *   stroke  : { points:[{x,y}...], color, width }
 *   line    : { points:[a,b], color, width }
 *   rect    : { x, y, w, h, color, width, fill }
 *   ellipse : { x, y, w, h, color, width, fill }
 *   text    : { x, y, text, color, size }   // size is world-units font size
 *   image   : { x, y, w, h, src }           // src is a data URL (or any URL)
 *   connector: { from, to, ax, ay, bx, by, color, width, arrow }
 *             // from/to are item ids; ax..by are the resolved endpoint world
 *             // coords (a cache kept fresh by App.resolveConnectors each render)
 */

// Only attach `opacity` when it's actually translucent, to keep JSON tidy.
const op = s => (s && s.opacity != null && s.opacity < 1 ? { opacity: s.opacity } : {});

export function makeStroke(points, style) {
  return { id: uid('s'), type: 'stroke', points, color: style.color, width: style.width, ...op(style) };
}
export function makeLine(a, b, style) {
  return { id: uid('l'), type: 'line', points: [a, b], color: style.color, width: style.width, ...op(style) };
}
export function makeRect(x, y, w, h, style) {
  return { id: uid('r'), type: 'rect', x, y, w, h, color: style.color, width: style.width,
           fill: style.fill || null, ...op(style) };
}
export function makeEllipse(x, y, w, h, style) {
  return { id: uid('e'), type: 'ellipse', x, y, w, h, color: style.color, width: style.width,
           fill: style.fill || null, ...op(style) };
}
export function makeText(x, y, text, style) {
  return { id: uid('t'), type: 'text', x, y, text, color: style.color, size: style.size, ...op(style) };
}
export function makeArrow(a, b, style) {
  return { id: uid('a'), type: 'arrow', points: [a, b], color: style.color, width: style.width, ...op(style) };
}
export function makePolygon(x, y, w, h, style) {
  return { id: uid('p'), type: 'polygon', x, y, w, h,
           sides: style.sides || 5, star: !!style.star,
           color: style.color, width: style.width, fill: style.fill || null, ...op(style) };
}
export function makeImage(x, y, w, h, src, style = {}) {
  return { id: uid('img'), type: 'image', x, y, w, h, src, ...op(style) };
}
export function makeConnector(fromId, toId, style = {}) {
  return { id: uid('c'), type: 'connector', from: fromId, to: toId,
           ax: 0, ay: 0, bx: 0, by: 0,
           color: style.color, width: style.width, arrow: style.arrow !== false, ...op(style) };
}

/** Point where the segment from box centre (cx,cy) toward (tx,ty) exits `box`. */
export function boxEdgePoint(cx, cy, tx, ty, box) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const eps = 1e-6 * (Math.abs(box.maxX - box.minX) + Math.abs(box.maxY - box.minY) + 1);
  let best = Infinity;
  const cand = [];
  if (dx > 0) cand.push((box.maxX - cx) / dx); else if (dx < 0) cand.push((box.minX - cx) / dx);
  if (dy > 0) cand.push((box.maxY - cy) / dy); else if (dy < 0) cand.push((box.minY - cy) / dy);
  for (const t of cand) {
    if (t < 0 || t > 1) continue;
    const px = cx + dx * t, py = cy + dy * t;
    if (px >= box.minX - eps && px <= box.maxX + eps && py >= box.minY - eps && py <= box.maxY + eps) {
      best = Math.min(best, t);
    }
  }
  if (!isFinite(best)) return { x: cx, y: cy };
  return { x: cx + dx * best, y: cy + dy * best };
}

/** Vertices (world coords) of a polygon/star item, fitted to its bbox. */
export function polygonVertices(it) {
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
  const rx = it.w / 2, ry = it.h / 2;
  const n = Math.max(3, it.sides || 5);
  const steps = it.star ? n * 2 : n;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const ang = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    const r = it.star ? (i % 2 === 0 ? 1 : 0.42) : 1;
    pts.push({ x: cx + Math.cos(ang) * rx * r, y: cy + Math.sin(ang) * ry * r });
  }
  return pts;
}

function pointInPolygon(px, py, verts) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y, xj = verts[j].x, yj = verts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Rough text extents in world units (longest line × ~0.6em wide, 1.1em tall). */
function textMetrics(it) {
  const lines = String(it.text).split('\n');
  const cols = lines.reduce((m, l) => Math.max(m, l.length), 1);
  return { w: cols * it.size * 0.6, h: lines.length * it.size * 1.1 };
}

/** Axis-aligned bbox in the item's OWN (unrotated) frame — no padding. */
function localBox(it) {
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      return bboxOfPoints(it.points);
    case 'connector':
      return bboxOfPoints([{ x: it.ax, y: it.ay }, { x: it.bx, y: it.by }]);
    case 'rect':
    case 'ellipse':
    case 'polygon':
    case 'image': {
      const minX = Math.min(it.x, it.x + it.w);
      const minY = Math.min(it.y, it.y + it.h);
      return { minX, minY, maxX: minX + Math.abs(it.w), maxY: minY + Math.abs(it.h) };
    }
    case 'text': {
      const { w, h } = textMetrics(it);
      return { minX: it.x, minY: it.y, maxX: it.x + w, maxY: it.y + h };
    }
    default:
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
}

/** Centre of a rotatable item, in world units (the pivot its `rot` turns about). */
export function rotCenter(it) {
  if (it.type === 'text') { const { w, h } = textMetrics(it); return { x: it.x + w / 2, y: it.y + h / 2 }; }
  return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
}

/** World-space bounding box for any item type, padded by half stroke width.
 *  For a rotated item this is the AABB of its rotated corners. */
export function itemBBox(it) {
  let b = localBox(it);
  if (it.rot && ROTATABLE.has(it.type)) {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
    for (const [px, py] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]) {
      const r = rotatePoint(px, py, cx, cy, it.rot);
      if (r.x < nx0) nx0 = r.x; if (r.y < ny0) ny0 = r.y;
      if (r.x > nx1) nx1 = r.x; if (r.y > ny1) ny1 = r.y;
    }
    b = { minX: nx0, minY: ny0, maxX: nx1, maxY: ny1 };
  }
  const pad = (it.width || 0) / 2 + 1e-9;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Does an item lie under world point (x,y) within `tol` world units? */
export function hitTest(it, x, y, tol) {
  // For a rotated box, map the query point into the item's local frame so the
  // existing axis-aligned tests below work unchanged.
  if (it.rot && ROTATABLE.has(it.type)) {
    const c = rotCenter(it);
    const p = rotatePoint(x, y, c.x, c.y, -it.rot);
    x = p.x; y = p.y;
  }
  const reach = tol + (it.width || 0) / 2;
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow': {
      const p = it.points;
      for (let i = 1; i < p.length; i++) {
        if (distToSegment(x, y, p[i - 1].x, p[i - 1].y, p[i].x, p[i].y) <= reach) return true;
      }
      if (p.length === 1) return dist(x, y, p[0].x, p[0].y) <= reach;
      return false;
    }
    case 'connector':
      return distToSegment(x, y, it.ax, it.ay, it.bx, it.by) <= reach;
    case 'polygon': {
      const verts = polygonVertices(it);
      if (it.fill && pointInPolygon(x, y, verts)) return true;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= reach) return true;
      }
      return false;
    }
    case 'image': {
      // images are opaque rectangles: a hit anywhere inside (plus edge reach)
      const r = normRect(it);
      return x >= r.minX - reach && x <= r.maxX + reach &&
             y >= r.minY - reach && y <= r.maxY + reach;
    }
    case 'rect': {
      const r = normRect(it);
      if (it.fill && pointInRect(x, y, r)) return true;
      return nearRectEdge(x, y, r, reach);
    }
    case 'ellipse': {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      const rx = Math.abs(it.w) / 2, ry = Math.abs(it.h) / 2;
      if (rx < 1e-9 || ry < 1e-9) return false;
      const nx = (x - cx) / rx, ny = (y - cy) / ry;
      const d = nx * nx + ny * ny;
      if (it.fill && d <= 1) return true;
      // distance from unit circle, scaled back approximately
      const ring = Math.abs(Math.sqrt(d) - 1) * Math.min(rx, ry);
      return ring <= reach;
    }
    case 'text': {
      // local (unrotated) box — the point is already in local space above
      return pointInRect(x, y, localBox(it));
    }
  }
  return false;
}

function normRect(it) {
  const minX = Math.min(it.x, it.x + it.w);
  const minY = Math.min(it.y, it.y + it.h);
  return { minX, minY, maxX: minX + Math.abs(it.w), maxY: minY + Math.abs(it.h) };
}
function nearRectEdge(x, y, r, reach) {
  const onX = x >= r.minX - reach && x <= r.maxX + reach;
  const onY = y >= r.minY - reach && y <= r.maxY + reach;
  const nearLeft = Math.abs(x - r.minX) <= reach && onY;
  const nearRight = Math.abs(x - r.maxX) <= reach && onY;
  const nearTop = Math.abs(y - r.minY) <= reach && onX;
  const nearBot = Math.abs(y - r.maxY) <= reach && onX;
  return nearLeft || nearRight || nearTop || nearBot;
}

/**
 * Zoom-dependent visibility (level of detail): an item may carry minScale /
 * maxScale (in camera pixels-per-world-unit). It only shows when the current
 * scale is within that band. This makes the canvas behave like nested worlds —
 * fine detail appears only once you zoom in far enough.
 */
export function lodVisible(it, scale) {
  if (it.minScale != null && scale < it.minScale) return false;
  if (it.maxScale != null && scale > it.maxScale) return false;
  return true;
}

/** Scale an item in place about (cx,cy) by factor s (geometry + stroke width). */
export function scaleItemAbout(it, cx, cy, s) {
  if (it.type === 'connector') return it; // endpoints are item-anchored; nothing to scale
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      // spread keeps per-point extras (e.g. brush pressure `p`) intact
      it.points = it.points.map(p => ({ ...p, x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s }));
      break;
    default:
      it.x = cx + (it.x - cx) * s;
      it.y = cy + (it.y - cy) * s;
      if (it.w != null) it.w *= s;
      if (it.h != null) it.h *= s;
      if (it.size != null) it.size *= s;
  }
  if (it.width != null) it.width *= s;
  // LOD thresholds scale with the geometry so nested copies reveal correctly
  if (it.minScale != null) it.minScale /= s;
  if (it.maxScale != null) it.maxScale /= s;
  return it;
}

/**
 * Rotate a set of items in place by `ang` radians about world pivot (px,py).
 * Box items accumulate `ang` into their `rot` and have their centre swung about
 * the pivot; point items (stroke/line/arrow) bake the rotation into their points.
 */
export function rotateItemsAbout(items, px, py, ang) {
  for (const it of items) {
    if (it.type === 'stroke' || it.type === 'line' || it.type === 'arrow') {
      // spread the original point so per-point extras (brush `p`) survive
      it.points = it.points.map(p => ({ ...p, ...rotatePoint(p.x, p.y, px, py, ang) }));
    } else if (ROTATABLE.has(it.type)) {
      const c = rotCenter(it);
      const nc = rotatePoint(c.x, c.y, px, py, ang);
      // shift x,y so the (unchanged-size) box re-centres on the swung centre
      it.x += nc.x - c.x; it.y += nc.y - c.y;
      it.rot = (it.rot || 0) + ang;
    }
  }
  return items;
}

/** Translate an item in place by (dx,dy) world units. Returns the item. */
export function translateItem(it, dx, dy) {
  switch (it.type) {
    case 'connector':
      break; // endpoints follow the items it links; no independent position
    case 'stroke':
    case 'line':
    case 'arrow':
      it.points = it.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
      break;
    default:
      it.x += dx; it.y += dy;
  }
  return it;
}

/**
 * The document: an ordered list of items plus a world-origin offset used for
 * deep-zoom precision rebasing. The scene fires `onChange` after mutations so
 * the app can persist & redraw.
 */
export class Scene {
  constructor() {
    this.items = [];
    this.onChange = null;
    this._index = new Map(); // id -> item
  }

  _touch() { if (this.onChange) this.onChange(); }

  add(item) {
    this.items.push(item);
    this._index.set(item.id, item);
    this._touch();
    return item;
  }
  addMany(items) {
    for (const it of items) { this.items.push(it); this._index.set(it.id, it); }
    if (items.length) this._touch();
  }
  remove(id) {
    const i = this.items.findIndex(it => it.id === id);
    if (i >= 0) {
      const [it] = this.items.splice(i, 1);
      this._index.delete(id);
      this._touch();
      return it;
    }
    return null;
  }
  removeMany(ids) {
    const set = new Set(ids);
    let removed = 0;
    this.items = this.items.filter(it => {
      if (set.has(it.id)) { this._index.delete(it.id); removed++; return false; }
      return true;
    });
    if (removed) this._touch();
    return removed;
  }
  byId(id) { return this._index.get(id) || null; }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this._index.clear();
    this._touch();
  }

  /** Reorder items to match the given id sequence (used by z-order undo/redo). */
  _applyOrder(ids) {
    const next = [];
    for (const id of ids) { const it = this._index.get(id); if (it) next.push(it); }
    // keep any items not mentioned (shouldn't happen) at the end
    if (next.length !== this.items.length) {
      const seen = new Set(ids);
      for (const it of this.items) if (!seen.has(it.id)) next.push(it);
    }
    this.items = next;
    this._touch();
  }

  count() { return this.items.length; }

  /** All items whose bbox intersects the world rect, top-most last. */
  itemsInRect(rect) {
    return this.items.filter(it => rectsIntersect(itemBBox(it), rect));
  }
  /** Items fully contained in rect (for marquee selection). Skips hidden &
   *  locked items — neither can be grabbed by a selection rectangle. */
  itemsContainedIn(rect) {
    return this.items.filter(it => !it.hidden && !it.locked && rectContains(rect, itemBBox(it)));
  }

  /** Top-most item under a world point, or null. Optional `filter` excludes
   *  items. Hidden items are always skipped (they aren't on screen); `locked`
   *  is left to the caller's `filter` so e.g. connectors can still target them. */
  pick(x, y, tol, filter = null) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.hidden) continue;
      if (filter && !filter(it)) continue;
      if (it.type === 'connector' && (!this._index.get(it.from) || !this._index.get(it.to))) continue;
      if (hitTest(it, x, y, tol)) return it;
    }
    return null;
  }

  /** Bounding box of the whole document (or null when empty). */
  bounds() {
    if (!this.items.length) return null;
    let r = itemBBox(this.items[0]);
    r = { ...r };
    for (let i = 1; i < this.items.length; i++) {
      const b = itemBBox(this.items[i]);
      if (b.minX < r.minX) r.minX = b.minX;
      if (b.minY < r.minY) r.minY = b.minY;
      if (b.maxX > r.maxX) r.maxX = b.maxX;
      if (b.maxY > r.maxY) r.maxY = b.maxY;
    }
    return r;
  }

  toJSON() {
    return { version: 2, items: this.items };
  }
  loadJSON(data, { merge = false } = {}) {
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    if (!merge) { this.items = []; this._index.clear(); }
    for (const it of items) {
      if (!it.id) it.id = uid('x');
      this.items.push(it);
      this._index.set(it.id, it);
    }
    this._touch();
  }
}
