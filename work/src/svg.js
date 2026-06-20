import { polygonVertices, rotCenter, ROTATABLE } from './scene.js';
import { ribbonOutline, catmullRom } from './util.js';

// Serialize the whole document to a standalone SVG string. World coordinates
// map 1:1 to SVG user units (both are y-down), so the export is resolution
// independent — the vector analogue of the infinite canvas.

const escAttr = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function ptsAttr(points) {
  return points.map(p => `${round(p.x)},${round(p.y)}`).join(' ');
}
const round = n => (Math.abs(n) < 1e-4 ? 0 : +n.toFixed(4));

function arrowHead(a, b, width) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const head = Math.min(len * 0.4, Math.max(width * 3.5, len * 0.12));
  return {
    head,
    shaftEnd: { x: b.x - Math.cos(ang) * head * 0.8, y: b.y - Math.sin(ang) * head * 0.8 },
    tri: [b,
      { x: b.x - Math.cos(ang - 0.5) * head, y: b.y - Math.sin(ang - 0.5) * head },
      { x: b.x - Math.cos(ang + 0.5) * head, y: b.y - Math.sin(ang + 0.5) * head }],
  };
}

function itemToSVG(it) {
  const stroke = `stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (it.type) {
    case 'stroke': {
      if (it.taper) {
        // variable-width brush stroke → a single filled ribbon polygon
        const half = (it.width || 1) / 2;
        if (it.points.length === 1) {
          return `<circle cx="${round(it.points[0].x)}" cy="${round(it.points[0].y)}" r="${round(half)}" fill="${escAttr(it.color)}"/>`;
        }
        // mirror the on-canvas Catmull-Rom smoothing so the export matches
        const pts = (it.smooth && it.points.length >= 3) ? catmullRom(it.points, 16) : it.points;
        const outline = ribbonOutline(pts, i => Math.max(1e-4, half * (pts[i].p == null ? 1 : pts[i].p)));
        return `<polygon points="${ptsAttr(outline)}" fill="${escAttr(it.color)}"/>`;
      }
      return `<polyline points="${ptsAttr(it.points)}" ${stroke}/>`;
    }
    case 'line':
      return `<polyline points="${ptsAttr(it.points)}" ${stroke}/>`;
    case 'arrow': {
      const [a, b] = it.points;
      const h = arrowHead(a, b, it.width || 1);
      return `<polyline points="${ptsAttr([a, h.shaftEnd])}" ${stroke}/>` +
             `<polygon points="${ptsAttr(h.tri)}" fill="${escAttr(it.color)}"/>`;
    }
    case 'connector': {
      const a = { x: it.ax, y: it.ay }, b = { x: it.bx, y: it.by };
      if (it.arrow === false) return `<polyline points="${ptsAttr([a, b])}" ${stroke}/>`;
      const h = arrowHead(a, b, it.width || 1);
      return `<polyline points="${ptsAttr([a, h.shaftEnd])}" ${stroke}/>` +
             `<polygon points="${ptsAttr(h.tri)}" fill="${escAttr(it.color)}"/>`;
    }
    case 'rect': {
      const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
      const fill = it.fill ? escAttr(it.fill) : 'none';
      return `<rect x="${round(x)}" y="${round(y)}" width="${round(Math.abs(it.w))}" height="${round(Math.abs(it.h))}" fill="${fill}" stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}"/>`;
    }
    case 'ellipse': {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      const fill = it.fill ? escAttr(it.fill) : 'none';
      return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(Math.abs(it.w / 2))}" ry="${round(Math.abs(it.h / 2))}" fill="${fill}" stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}"/>`;
    }
    case 'polygon': {
      const fill = it.fill ? escAttr(it.fill) : 'none';
      return `<polygon points="${ptsAttr(polygonVertices(it))}" fill="${fill}" stroke="${escAttr(it.color)}" stroke-width="${round(it.width || 1)}"/>`;
    }
    case 'image': {
      const x = Math.min(it.x, it.x + it.w), y = Math.min(it.y, it.y + it.h);
      const op = (it.opacity != null && it.opacity < 1) ? ` opacity="${round(it.opacity)}"` : '';
      return `<image href="${escAttr(it.src)}" x="${round(x)}" y="${round(y)}" width="${round(Math.abs(it.w))}" height="${round(Math.abs(it.h))}" preserveAspectRatio="none"${op}/>`;
    }
    case 'text': {
      const lines = String(it.text).split('\n');
      const tspans = lines.map((l, i) =>
        `<tspan x="${round(it.x)}" dy="${i === 0 ? round(it.size) : round(it.size * 1.1)}">${escAttr(l)}</tspan>`).join('');
      return `<text x="${round(it.x)}" y="${round(it.y)}" fill="${escAttr(it.color)}" font-size="${round(it.size)}" font-family="sans-serif">${tspans}</text>`;
    }
  }
  return '';
}

export function sceneToSVG(scene, { pad = 0.06, background = '#0e0f13' } = {}) {
  const b = scene.bounds() || { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
  const px = w * pad, py = h * pad;
  const X = b.minX - px, Y = b.minY - py, W = w + 2 * px, H = h + 2 * py;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(X)} ${round(Y)} ${round(W)} ${round(H)}" width="${round(W)}" height="${round(H)}">`,
  ];
  if (background) out.push(`<rect x="${round(X)}" y="${round(Y)}" width="${round(W)}" height="${round(H)}" fill="${escAttr(background)}"/>`);
  for (const it of scene.items) {
    if (it.hidden) continue;           // hidden items are omitted, like on-canvas
    let s = itemToSVG(it);
    if (!s) continue;
    if (it.rot && ROTATABLE.has(it.type)) {
      const c = rotCenter(it);
      s = `<g transform="rotate(${round(it.rot * 180 / Math.PI)} ${round(c.x)} ${round(c.y)})">${s}</g>`;
    }
    out.push(s);
  }
  out.push('</svg>');
  return out.join('\n');
}
