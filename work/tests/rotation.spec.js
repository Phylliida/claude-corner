import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

const PI = Math.PI;

// Centre a single filled rect on world origin and select it.
async function selectedRect(page, { x = -50, y = -50, w = 100, h = 100, fill = '#69db7c' } = {}) {
  await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
  const id = await page.evaluate(({ x, y, w, h, fill }) =>
    window.__INFINIZOOM__.addRect(x, y, w, h, { fill }), { x, y, w, h, fill });
  await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
  return id;
}

test.describe('rotation', () => {
  test('rotateSelection stores an angle on a box item and grows its AABB', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate((a) => window.__INFINIZOOM__.rotateSelection(a), PI / 4);
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.rot).toBeCloseTo(PI / 4, 3);
    // a 100×100 box rotated 45° has an AABB of ~141 on a side
    const b = await page.evaluate(() => window.__INFINIZOOM__.bounds());
    expect(b.maxX - b.minX).toBeGreaterThan(135);
    expect(errors).toEqual([]);
  });

  test('keyboard . and , rotate the selection by ±15°', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.keyboard.press('.');
    let it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.rot).toBeCloseTo(PI / 12, 4);
    await page.keyboard.press('.');
    await page.keyboard.press(',');
    it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.rot).toBeCloseTo(PI / 12, 4); // +15 +15 -15 = +15
  });

  test('hit-testing respects rotation (a thin bar swaps its long axis)', async ({ page }) => {
    await freshApp(page);
    // wide thin filled bar centred on origin: x∈[-100,100], y∈[-20,20]
    const id = await selectedRect(page, { x: -100, y: -20, w: 200, h: 40 });
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(0, 60, 2))).toBe(null);  // above the bar
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 2));        // stand it up
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(0, 60, 2))).toBe(id);     // now inside
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(60, 0, 2))).toBe(null);   // now outside
  });

  test('rotation is reversible via undo/redo', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 3));
    expect(await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).rot, id)).toBeCloseTo(PI / 3, 3);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    const after = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).rot, id);
    expect(after == null || Math.abs(after) < 1e-9).toBeTruthy();
    await page.evaluate(() => window.__INFINIZOOM__.redo());
    expect(await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).rot, id)).toBeCloseTo(PI / 3, 3);
  });

  test('rotation survives a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(0.7));
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const it = await page.evaluate(() => window.__INFINIZOOM__.getItems()[0]);
    expect(it.rot).toBeCloseTo(0.7, 4);
  });

  test('SVG export emits a rotate() transform for a rotated box', async ({ page }) => {
    await freshApp(page);
    await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 2));
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    expect(svg).toMatch(/transform="rotate\(90 /);
  });

  test('point items (strokes) bake rotation into their geometry, no rot field', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    // horizontal stroke through origin
    const id = await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: -100, y: 0 }, { x: 100, y: 0 }]));
    await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 2)); // → vertical
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.rot).toBeUndefined();
    expect(it.points[0].x).toBeCloseTo(0, 3);
    expect(it.points[1].x).toBeCloseTo(0, 3);
    expect(Math.abs(it.points[0].y - it.points[1].y)).toBeCloseTo(200, 1); // length preserved
  });

  test('a rotated, filled box still paints onto the canvas', async ({ page }) => {
    await freshApp(page);
    await selectedRect(page, { x: -120, y: -120, w: 240, h: 240, fill: '#ffd43b' });
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 5));
    const ink = await countInk(page, { grid: false });
    expect(ink).toBeGreaterThan(2000);
  });

  test('dragging the rotation handle turns the selection ~90°', async ({ page }) => {
    await freshApp(page);
    await selectedRect(page); // centred on world origin (0,0)
    const handle = await page.evaluate(() => window.__INFINIZOOM__.rotHandle());
    expect(handle).not.toBeNull();
    const pivot = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(0, 0));
    const radius = pivot.y - handle.y; // handle sits straight above the pivot
    // drag the handle from "up" to "right of pivot" → +90°
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.mouse.move(pivot.x + radius, pivot.y, { steps: 8 });
    await page.mouse.up();
    const rot = await page.evaluate(() => window.__INFINIZOOM__.getItems()[0].rot);
    expect(rot).toBeGreaterThan(PI / 2 - 0.25);
    expect(rot).toBeLessThan(PI / 2 + 0.25);
  });
});
