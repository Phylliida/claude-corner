// Visual showcase: generates each procedural scene and a deep-zoom sequence,
// saving screenshots to screenshots/. Run with the server up (npm run serve)
// or it will use whatever IZ_URL/IZ_PORT point to.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { BASE_URL, launchOptions, waitReady, captureErrors } from './_helpers.js';

mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = captureErrors(page);
await page.goto(BASE_URL);
await waitReady(page);
await page.evaluate(() => localStorage.clear());

const shot = async (name) => {
  await page.evaluate(() => window.__INFINIZOOM__.render());
  await page.waitForTimeout(120);
  await page.screenshot({ path: `screenshots/${name}.png` });
  console.log('  saved', name);
};

// --- gallery of every generator ---
const gens = await page.evaluate(() => window.__INFINIZOOM__.generators());
console.log('generators:', gens.join(', '));
for (const g of gens) {
  await page.evaluate((g) => window.__INFINIZOOM__.generate(g, {}, { clear: true, fit: true }), g);
  await shot(`gen-${g}`);
}

// --- deep zoom showcase on the spiral ---
console.log('deep-zoom sequence...');
await page.evaluate(() => window.__INFINIZOOM__.generate('spiral', { count: 110, shrink: 0.9 }, { clear: true, fit: true }));
await shot('zoom-00-overview');

// progressively zoom toward the spiral's drifting eye
for (let step = 1; step <= 6; step++) {
  await page.evaluate(() => {
    const A = window.__INFINIZOOM__;
    // aim at the densest cluster: pick the bbox of the smallest (last) items
    const items = window.app.scene.items;
    const tail = items.slice(-6);
    let cx = 0, cy = 0, n = 0;
    for (const it of tail) { for (const p of it.points || []) { cx += p.x; cy += p.y; n++; } }
    if (n) { cx /= n; cy /= n; }
    const cam = A.getCamera();
    A.setCamera({ x: cx, y: cy, scale: cam.scale * 7 });
  });
  await shot(`zoom-${String(step).padStart(2, '0')}`);
  const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
  console.log(`    step ${step}: scale=${cam.scale.toExponential(2)}`);
}

// --- shapes showcase ---
console.log('shapes showcase...');
await page.evaluate(() => {
  const A = window.__INFINIZOOM__;
  A.clear(); A.setCamera({ x: 0, y: 0, scale: 1 });
  A.addArrow({ x: -520, y: -220 }, { x: -160, y: -300 }, { color: '#ffa94d', width: 7 });
  A.addArrow({ x: 160, y: -300 }, { x: 520, y: -160 }, { color: '#ff5b6e', width: 12 });
  A.addPolygon(-540, 40, 190, 190, { star: true, sides: 5, color: '#ffd43b', fill: '#ffd43b' });
  A.addPolygon(-300, 40, 190, 190, { star: true, sides: 9, color: '#f783ac', fill: null });
  A.addPolygon(-40, 40, 190, 190, { star: false, sides: 6, color: '#69db7c', fill: '#38d9a9' });
  A.addPolygon(220, 40, 190, 190, { star: false, sides: 3, color: '#4dabf7', fill: null });
  A.addText(-520, 260, 'arrows · stars · polygons', { size: 40, color: '#e8e8ef' });
  A.fitAll();
});
await shot('shapes');

// --- rotation showcase: a fan of rotated, translucent bars around one centre ---
console.log('rotation showcase...');
await page.evaluate(() => {
  const A = window.__INFINIZOOM__;
  A.clear(); A.setCamera({ x: 0, y: 0, scale: 1 }); A.setTool('select');
  const cols = ['#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#5b8cff', '#b197fc', '#f783ac'];
  const ids = [];
  for (let i = 0; i < cols.length; i++) {
    // each bar is centred on world (0,0); rotateSelection spins it about that centre
    const id = A.addRect(-26, -150, 52, 300, { color: cols[i], fill: cols[i], opacity: 0.5 });
    A.select([id]);
    A.rotateSelection((i / cols.length) * Math.PI);
    ids.push(id);
  }
  A.select(ids); A.group();           // bind the whole pinwheel into one group
  A.select([]);
  A.addText(-360, 250, 'free rotation + groups', { size: 44, color: '#e8e8ef' });
  A.fitAll();
});
await shot('rotation');

// --- brush showcase: pressure-tapered ink swashes ---
console.log('brush showcase...');
await page.evaluate(() => {
  const A = window.__INFINIZOOM__;
  A.clear(); A.setCamera({ x: 0, y: 0, scale: 1 });
  const cols = ['#ff5b6e', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];
  for (let r = 0; r < cols.length; r++) {
    const pts = [];
    const y0 = -210 + r * 95;
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      const x = -560 + t * 1120;
      const y = y0 + Math.sin(t * Math.PI * 2 + r) * 42;
      const p = 0.12 + 0.88 * Math.sin(t * Math.PI); // swells in the middle, tapers at the ends
      pts.push([x, y, p]);
    }
    A.addBrushStroke(pts, { color: cols[r], width: 48 });
  }
  A.addText(-560, 250, 'pressure brush — tapered ink', { size: 40, color: '#e8e8ef' });
  A.fitAll();
});
await shot('brush');

// --- recursive-stamp fractal, then a deep zoom into its heart ---
console.log('stamp-fractal deep zoom...');
await page.evaluate(() => {
  const A = window.__INFINIZOOM__;
  A.clear(); A.setCamera({ x: 0, y: 0, scale: 1 });
  // a ring of colored polygons as the motif
  const cols = ['#ff5b6e', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc'];
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ids.push(A.addPolygon(Math.cos(a) * 260 - 70, Math.sin(a) * 260 - 70, 140, 140,
      { star: i % 2 === 0, sides: 5, color: cols[i], fill: cols[i] }));
  }
  A.select(ids);
  A.stamp({ factor: 0.5, depth: 9 }); // nested copies toward the centre
  A.select([]);
  A.fitAll();
});
await shot('fractal-00');
for (let step = 1; step <= 5; step++) {
  await page.evaluate(() => {
    const A = window.__INFINIZOOM__;
    const cam = A.getCamera();
    A.setCamera({ x: 0, y: 0, scale: cam.scale * 8 });
  });
  await shot(`fractal-${String(step).padStart(2, '0')}`);
  const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
  console.log(`    fractal step ${step}: scale=${cam.scale.toExponential(2)}`);
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
