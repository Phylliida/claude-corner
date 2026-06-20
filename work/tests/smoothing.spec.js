import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

const PI = Math.PI;

// number of coordinate pairs in the first <polygon> of an SVG string
function polygonPointCount(svg) {
  const m = /<polygon points="([^"]+)"/.exec(svg);
  if (!m) return 0;
  return m[1].trim().split(/\s+/).length;
}

// a wavy multi-point brush stroke (curvy, so smoothing visibly changes it)
const WAVE = [[-160, 0, 0.3], [-80, 60, 0.9], [0, -60, 1], [80, 60, 0.9], [160, 0, 0.3]];

test.describe('brush smoothing (Catmull-Rom)', () => {
  test('smoothPoints densifies a path through its control points, carrying pressure', async ({ page }) => {
    await freshApp(page);
    const out = await page.evaluate(() => window.__INFINIZOOM__.smoothPoints(
      [{ x: 0, y: 0, p: 0.2 }, { x: 10, y: 0, p: 1 }, { x: 20, y: 0, p: 0.4 }], 8));
    expect(out.length).toBe(17);                 // (3-1)*8 + 1
    expect(out[0].x).toBeCloseTo(0, 6);          // passes through the endpoints
    expect(out[out.length - 1].x).toBeCloseTo(20, 6);
    expect(out[0].p).toBeCloseTo(0.2, 6);        // endpoint pressures preserved
    expect(out[out.length - 1].p).toBeCloseTo(0.4, 6);
    expect(out.every(p => typeof p.p === 'number' && p.p > 0)).toBe(true);
  });

  test('smoothPoints leaves a 2-point path alone (nothing to smooth)', async ({ page }) => {
    await freshApp(page);
    const out = await page.evaluate(() => window.__INFINIZOOM__.smoothPoints(
      [{ x: 0, y: 0 }, { x: 5, y: 5 }], 8));
    expect(out.length).toBe(2);
  });

  test('a smooth brush stroke exports a far denser SVG ribbon than an un-smoothed one', async ({ page }) => {
    await freshApp(page);
    // smoothed (default)
    await page.evaluate((wave) => window.__INFINIZOOM__.addBrushStroke(wave, { width: 12 }), WAVE);
    const smoothCount = polygonPointCount(await page.evaluate(() => window.__INFINIZOOM__.toSVG()));
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    // same control points, smoothing off
    await page.evaluate((wave) => window.__INFINIZOOM__.addBrushStroke(wave, { width: 12, smooth: false }), WAVE);
    const rawCount = polygonPointCount(await page.evaluate(() => window.__INFINIZOOM__.toSVG()));
    expect(rawCount).toBe(WAVE.length * 2);      // outline = 2 vertices per control point
    expect(smoothCount).toBeGreaterThan(rawCount * 3);
  });

  test('smoothing is render-only: the stored control points stay compact', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate((wave) => window.__INFINIZOOM__.addBrushStroke(wave, { width: 10 }), WAVE);
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.points.length).toBe(WAVE.length);  // unchanged — the curve is rebuilt at draw time
    expect(it.smooth).toBe(true);
  });

  test('the brush tool honours the Smooth toggle', async ({ page }) => {
    await freshApp(page);
    // helper to draw an arc with the brush tool through real pointer moves
    const drawArc = async () => {
      await page.evaluate(() => { window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }); window.__INFINIZOOM__.setTool('brush'); });
      const pts = [];
      for (let i = 0; i <= 14; i++) pts.push([300 + i * 30, 400 + Math.sin((i / 14) * PI) * 110]);
      await page.mouse.move(pts[0][0], pts[0][1]);
      await page.mouse.down();
      for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1], { steps: 3 });
      await page.mouse.up();
    };
    await drawArc();
    expect(await page.evaluate(() => window.__INFINIZOOM__.getItems()[0].smooth)).toBe(true);
    // turn smoothing off and draw again
    await page.locator('#brushSmooth').uncheck();
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await drawArc();
    expect(await page.evaluate(() => window.__INFINIZOOM__.getItems()[0].smooth)).toBeUndefined();
  });

  test('the smooth flag survives a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate((wave) => window.__INFINIZOOM__.addBrushStroke(wave), WAVE);
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.smooth).toBe(true);
    expect(it.taper).toBe(true);
  });

  test('a smoothed stroke still paints ink, even zoomed in deep (adaptive segments)', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.evaluate((wave) => {
      window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 });
      window.__INFINIZOOM__.addBrushStroke(wave, { color: '#ffd43b', width: 24 });
    }, WAVE);
    expect(await countInk(page, { grid: false })).toBeGreaterThan(500);
    // zoom in hard, centred on a point the wave passes through (its middle
    // control point) — exercises the on-screen-density adaptive segment path
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: -60, scale: 20 }));
    expect(await countInk(page, { grid: false })).toBeGreaterThan(500);
    expect(errors).toEqual([]);
  });
});
