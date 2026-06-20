// Pure procedural-art generators. Each returns an array of *item spec* objects
// (no ids) in world coordinates; the app wraps them into real scene items.
// These exist to show off infinite zoom: several recurse down many octaves so
// there's fresh detail however far you zoom in.

const TAU = Math.PI * 2;

/** A recursive binary tree of line segments. Depth N → up to 2^N twigs. */
export function fractalTree({ depth = 11, len = 280, angle = 0.42, shrink = 0.74,
                              x = 0, y = 400, color = '#69db7c' } = {}) {
  const items = [];
  const rec = (px, py, dir, length, d) => {
    if (d > depth || length < 1e-7) return;
    const ex = px + Math.cos(dir) * length;
    const ey = py + Math.sin(dir) * length;
    const w = Math.max(length * 0.06, length * 0.012);
    const t = d / depth;
    // fade from trunk color to a leafy tip
    const col = d > depth - 3 ? '#b7f7c2' : color;
    items.push({ type: 'line', points: [{ x: px, y: py }, { x: ex, y: ey }], color: col, width: w });
    rec(ex, ey, dir - angle, length * shrink, d + 1);
    rec(ex, ey, dir + angle, length * shrink, d + 1);
  };
  rec(x, y, -Math.PI / 2, len, 0);
  return items;
}

/**
 * A logarithmic spiral of shrinking, rotating squares. Great for deep zoom:
 * with shrink 0.86 and 90 squares the smallest is ~0.86^90 ≈ 1.4e-6 of the
 * first, so you can zoom ~700,000× into the eye and still find structure.
 */
export function spiralSquares({ count = 90, size = 320, shrink = 0.9, turn = 0.5,
                                x = 0, y = 0 } = {}) {
  const items = [];
  const palette = ['#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];
  let s = size, ang = 0, cx = x, cy = y;
  for (let i = 0; i < count; i++) {
    const half = s / 2;
    // four corners rotated by `ang` about (cx,cy)
    const pts = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
      .map(([dx, dy]) => ({
        x: cx + dx * Math.cos(ang) - dy * Math.sin(ang),
        y: cy + dx * Math.sin(ang) + dy * Math.cos(ang),
      }));
    items.push({ type: 'stroke', points: pts, color: palette[i % palette.length], width: Math.max(s * 0.02, s * 0.004) });
    // step the spiral inward toward a drifting center
    cx += Math.cos(ang) * s * 0.18;
    cy += Math.sin(ang) * s * 0.18;
    ang += turn;
    s *= shrink;
  }
  return items;
}

/**
 * A "Droste" stack of nested rings + ticks that recurses toward a point,
 * shrinking by `shrink` each step. Zooming the center reveals the same motif
 * forever (well, for `count` octaves).
 */
export function drosteRings({ count = 60, r = 300, shrink = 0.84, x = 0, y = 0,
                              color = '#5b8cff' } = {}) {
  const items = [];
  let radius = r;
  for (let i = 0; i < count; i++) {
    // approximate a circle with an ellipse item
    items.push({ type: 'ellipse', x: x - radius, y: y - radius, w: radius * 2, h: radius * 2,
                 color: i % 2 ? color : '#b197fc', width: Math.max(radius * 0.03, radius * 0.005), fill: null });
    // tick marks around the ring
    const ticks = 12;
    for (let k = 0; k < ticks; k++) {
      const a = (k / ticks) * TAU + i * 0.2;
      const inner = radius * 0.86, outer = radius * 1.0;
      items.push({
        type: 'line',
        points: [{ x: x + Math.cos(a) * inner, y: y + Math.sin(a) * inner },
                 { x: x + Math.cos(a) * outer, y: y + Math.sin(a) * outer }],
        color: '#e8e8ef', width: Math.max(radius * 0.012, radius * 0.003),
      });
    }
    radius *= shrink;
  }
  return items;
}

/** Sierpinski triangle as outlined triangles (strokes), depth octaves. */
export function sierpinski({ depth = 7, size = 520, x = 0, y = 0, color = '#ffd43b' } = {}) {
  const items = [];
  const h = size * Math.sqrt(3) / 2;
  const tri = (ax, ay, bx, by, cx, cy, d) => {
    if (d === 0) {
      items.push({ type: 'stroke',
        points: [{ x: ax, y: ay }, { x: bx, y: by }, { x: cx, y: cy }, { x: ax, y: ay }],
        color, width: Math.max(size * 0.0015, 0.05) });
      return;
    }
    const ab = [(ax + bx) / 2, (ay + by) / 2];
    const bc = [(bx + cx) / 2, (by + cy) / 2];
    const ca = [(cx + ax) / 2, (cy + ay) / 2];
    tri(ax, ay, ab[0], ab[1], ca[0], ca[1], d - 1);
    tri(ab[0], ab[1], bx, by, bc[0], bc[1], d - 1);
    tri(ca[0], ca[1], bc[0], bc[1], cx, cy, d - 1);
  };
  tri(x, y - h / 2, x - size / 2, y + h / 2, x + size / 2, y + h / 2, depth);
  return items;
}

/** A field of concentric "flowers" — quick, colorful, fills the screen. */
export function flowerField({ rows = 4, cols = 6, gap = 220, x = -550, y = -330 } = {}) {
  const items = [];
  const palette = ['#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#b197fc', '#f783ac'];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = x + c * gap, cy = y + r * gap;
      const petals = 6 + ((r + c) % 4);
      const rad = 60 + ((r * c) % 30);
      const col = palette[(r * cols + c) % palette.length];
      for (let p = 0; p < petals; p++) {
        const a = (p / petals) * TAU;
        items.push({ type: 'ellipse',
          x: cx + Math.cos(a) * rad * 0.5 - rad * 0.4,
          y: cy + Math.sin(a) * rad * 0.5 - rad * 0.2,
          w: rad * 0.8, h: rad * 0.4, color: col, width: 2, fill: null });
      }
      items.push({ type: 'ellipse', x: cx - 12, y: cy - 12, w: 24, h: 24, color: '#ffd43b', width: 2, fill: '#ffd43b' });
    }
  }
  return items;
}

export const GENERATORS = {
  tree: fractalTree,
  spiral: spiralSquares,
  droste: drosteRings,
  sierpinski,
  flowers: flowerField,
};
