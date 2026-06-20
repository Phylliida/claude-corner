// Small dependency-free helpers shared across modules.

let _idCounter = 0;
/** Monotonic, collision-resistant id. Deterministic-ish but unique per session. */
export function uid(prefix = 'i') {
  _idCounter += 1;
  return `${prefix}_${_idCounter.toString(36)}_${Math.floor(performance.now()).toString(36)}`;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
};

export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/** Distance from point p to segment ab (all in same coordinate space). */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  return dist(px, py, ax + t * dx, ay + t * dy);
}

/** Rotate point (px,py) by `ang` radians about centre (cx,cy). */
export function rotatePoint(px, py, cx, cy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Axis-aligned bbox of a list of {x,y} points. */
export function bboxOfPoints(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function rectsIntersect(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function rectContains(outer, inner) {
  return outer.minX <= inner.minX && outer.maxX >= inner.maxX &&
         outer.minY <= inner.minY && outer.maxY >= inner.maxY;
}

export function pointInRect(px, py, r) {
  return px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
}

/**
 * Ramer–Douglas–Peucker simplification. Reduces freehand point count while
 * keeping shape. epsilon is in the same units as the points.
 */
export function simplify(points, epsilon) {
  if (points.length < 3) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0, idx = -1;
    const a = points[first], b = points[last];
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(points[i].x, points[i].y, a.x, a.y, b.x, b.y);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx !== -1) {
      keep[idx] = true;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Format a zoom scale (pixels per world unit) as a friendly percentage/multiplier. */
export function formatZoom(scale) {
  const pct = scale * 100;
  if (pct >= 100000) return (scale).toExponential(1) + '×';
  if (pct >= 1000) return Math.round(scale) + '×';
  if (pct >= 10) return Math.round(pct) + '%';
  if (pct >= 1) return pct.toFixed(1) + '%';
  return pct.toPrecision(2) + '%';
}

/** Format a world coordinate compactly across many magnitudes. */
export function formatCoord(n) {
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return n.toExponential(2);
  if (a >= 100) return n.toFixed(0);
  if (a >= 1) return n.toFixed(1);
  return n.toFixed(3);
}

/** Debounce a function by `ms`. */
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = () => { if (t) { clearTimeout(t); t = null; } };
  return wrapped;
}

/** Convert "#rrggbb" + alpha to rgba() string. */
export function withAlpha(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
