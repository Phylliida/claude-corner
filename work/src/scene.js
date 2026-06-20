import { uid, bboxOfPoints, distToSegment, dist, rectsIntersect, rectContains, pointInRect } from './util.js';

/**
 * Item shapes (all geometry in world coordinates):
 *   stroke  : { points:[{x,y}...], color, width }
 *   line    : { points:[a,b], color, width }
 *   rect    : { x, y, w, h, color, width, fill }
 *   ellipse : { x, y, w, h, color, width, fill }
 *   text    : { x, y, text, color, size }   // size is world-units font size
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

/** World-space bounding box for any item type, padded by half stroke width. */
export function itemBBox(it) {
  let b;
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      b = bboxOfPoints(it.points);
      break;
    case 'rect':
    case 'ellipse':
    case 'polygon': {
      const minX = Math.min(it.x, it.x + it.w);
      const minY = Math.min(it.y, it.y + it.h);
      b = { minX, minY, maxX: minX + Math.abs(it.w), maxY: minY + Math.abs(it.h) };
      break;
    }
    case 'text': {
      // Rough: width ~ 0.6 em per char on the longest line.
      const lines = String(it.text).split('\n');
      const cols = lines.reduce((m, l) => Math.max(m, l.length), 1);
      const w = cols * it.size * 0.6;
      const h = lines.length * it.size * 1.1;
      b = { minX: it.x, minY: it.y, maxX: it.x + w, maxY: it.y + h };
      break;
    }
    default:
      b = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  const pad = (it.width || 0) / 2 + 1e-9;
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/** Does an item lie under world point (x,y) within `tol` world units? */
export function hitTest(it, x, y, tol) {
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
    case 'polygon': {
      const verts = polygonVertices(it);
      if (it.fill && pointInPolygon(x, y, verts)) return true;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= reach) return true;
      }
      return false;
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
      const b = itemBBox(it);
      return pointInRect(x, y, b);
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
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      it.points = it.points.map(p => ({ x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s }));
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

/** Translate an item in place by (dx,dy) world units. Returns the item. */
export function translateItem(it, dx, dy) {
  switch (it.type) {
    case 'stroke':
    case 'line':
    case 'arrow':
      it.points = it.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
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
  /** Items fully contained in rect (for marquee selection). */
  itemsContainedIn(rect) {
    return this.items.filter(it => rectContains(rect, itemBBox(it)));
  }

  /** Top-most item under a world point, or null. Optional `filter` excludes items. */
  pick(x, y, tol, filter = null) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (filter && !filter(it)) continue;
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
