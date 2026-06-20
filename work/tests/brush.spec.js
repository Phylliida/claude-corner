import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk, mouseStroke } from './_helpers.js';

const PI = Math.PI;

/** Draw an arched brush stroke with the mouse. The curve keeps RDP from
 *  collapsing it to two points, so the per-point pressure data survives. */
async function brushArc(page) {
  await page.evaluate(() => { window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }); window.__INFINIZOOM__.setTool('brush'); });
  const pts = [];
  for (let i = 0; i <= 16; i++) pts.push([300 + i * 30, 400 + Math.sin((i / 16) * PI) * 120]);
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps: 3 });
  await page.mouse.up();
}

test.describe('brush / tapered strokes', () => {
  test('the brush tool makes a tapered stroke with per-point pressure', async ({ page }) => {
    await freshApp(page);
    await brushArc(page);
    const it = await page.evaluate(() => window.__INFINIZOOM__.getItems()[0]);
    expect(it.type).toBe('stroke');
    expect(it.taper).toBe(true);
    expect(it.points.length).toBeGreaterThan(3);
    for (const p of it.points) {
      expect(typeof p.p).toBe('number');
      expect(p.p).toBeGreaterThan(0);
      expect(p.p).toBeLessThanOrEqual(1);
    }
  });

  test('a brush stroke narrows toward both ends', async ({ page }) => {
    await freshApp(page);
    await brushArc(page);
    const ps = await page.evaluate(() => window.__INFINIZOOM__.getItems()[0].points.map(p => p.p));
    const mid = ps[Math.floor(ps.length / 2)];
    expect(ps[0]).toBeLessThan(mid);                 // tapered entry
    expect(ps[ps.length - 1]).toBeLessThan(mid);     // tapered exit
  });

  test('a brush stroke paints ink onto the canvas', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 });
      window.__INFINIZOOM__.addBrushStroke(
        [[-200, 0, 0.4], [-60, 0, 1], [60, 0, 1], [200, 0, 0.4]], { color: '#ffd43b', width: 30 });
    });
    const ink = await countInk(page, { grid: false });
    expect(ink).toBeGreaterThan(500);
  });

  test('addBrushStroke survives a JSON round-trip with its pressures', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() =>
      window.__INFINIZOOM__.addBrushStroke([[0, 0, 0.2], [50, 10, 0.9], [100, 0, 0.3]], { width: 8 }));
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.taper).toBe(true);
    expect(it.points.map(p => p.p)).toEqual([0.2, 0.9, 0.3]);
  });

  test('rotating a brush stroke bakes geometry but keeps pressures', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => {
      window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 });
      return window.__INFINIZOOM__.addBrushStroke([[-100, 0, 0.3], [0, 0, 1], [100, 0, 0.3]]);
    });
    await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 2)); // horizontal → vertical
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.rot).toBeUndefined();                          // point items bake rotation in
    expect(it.points.map(p => p.p)).toEqual([0.3, 1, 0.3]);  // pressure preserved
    expect(it.points[0].x).toBeCloseTo(0, 3);                // now vertical
    expect(it.points[2].x).toBeCloseTo(0, 3);
  });

  test('SVG export emits a filled ribbon polygon for a tapered stroke', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addBrushStroke([[0, 0, 0.4], [80, 0, 1], [160, 0, 0.4]], { width: 10 }));
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    expect(svg).toMatch(/<polygon /);
    expect(svg).not.toMatch(/<polyline /); // the brush stroke is a filled band, not a stroked line
  });

  test('the plain pen stays constant-width (no taper, no per-point pressure)', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setTool('pen'));
    await mouseStroke(page, [[300, 300], [360, 360], [440, 320], [520, 380]], 3);
    const it = await page.evaluate(() => window.__INFINIZOOM__.getItems()[0]);
    expect(it.type).toBe('stroke');
    expect(it.taper).toBeUndefined();
    expect(it.points.every(p => p.p === undefined)).toBe(true);
  });

  test('the eraser removes a brush stroke', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 });
      window.__INFINIZOOM__.addBrushStroke([[80, 0, 0.5], [220, 0, 0.5]], { width: 6 });
    });
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
    const pt = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(150, 0));
    await page.locator('.tool[data-tool="eraser"]').click();
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.mouse.move(pt.x + 2, pt.y, { steps: 2 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
  });

  test('no console errors while brushing', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await brushArc(page);
    await page.evaluate(() => window.__INFINIZOOM__.render());
    expect(errors).toEqual([]);
  });
});
