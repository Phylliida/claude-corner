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

/**
 * Closed outline (world points) of a variable-width "ribbon" swept along
 * `points`, where `halfAt(i)` returns the half-width at point i. The outline
 * runs up one side and back the other, ready to fill as a single polygon.
 * Normals use a central difference so the band stays smooth along curves.
 * Returns [] for an empty list and null for a single point (caller draws a dot).
 */
export function ribbonOutline(points, halfAt) {
  const n = points.length;
  if (n === 0) return [];
  if (n === 1) return null;
  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    // normal = perpendicular to the local tangent (prev→next)
    let nx = -(next.y - prev.y), ny = next.x - prev.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    const h = halfAt(i);
    left.push({ x: points[i].x + nx * h, y: points[i].y + ny * h });
    right.push({ x: points[i].x - nx * h, y: points[i].y - ny * h });
  }
  right.reverse();
  return left.concat(right);
}

/**
 * Resample a polyline through a uniform Catmull-Rom spline so it reads as a
 * smooth curve rather than straight chords between (often RDP-thinned) control
 * points. The curve passes through every input point; `segs` interpolated
 * points are emitted per span. Per-point pressure `p` (used by the brush) is
 * carried along, linearly across each span. Endpoints use duplicated phantom
 * neighbours so the curve doesn't overshoot at the tips.
 * Returns a copy for < 3 points (nothing to smooth).
 */
export function catmullRom(points, segs = 12) {
  const n = points.length;
  if (n < 3 || segs < 2) return points.slice();
  const at = i => points[Math.max(0, Math.min(n - 1, i))];
  const pr = pt => (pt.p == null ? 1 : pt.p);
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let s = 0; s < segs; s++) {
      const t = s / segs, t2 = t * t, t3 = t2 * t;
      const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y, p: pr(p1) + (pr(p2) - pr(p1)) * t });
    }
  }
  const end = at(n - 1);
  out.push({ x: end.x, y: end.y, p: pr(end) });
  return out;
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
