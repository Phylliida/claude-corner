import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

const PI = Math.PI;

// Centre a single rect on world origin at scale 1 and select it (so the
// selection chrome / handles are live). Screen centre is (640,360) at 1280×720.
async function selectedRect(page, { x = -50, y = -50, w = 100, h = 100, width = 4, fill = '#69db7c' } = {}) {
  await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
  const id = await page.evaluate(({ x, y, w, h, width, fill }) =>
    window.__INFINIZOOM__.addRect(x, y, w, h, { fill, width }), { x, y, w, h, width, fill });
  await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
  return id;
}
const get = (page, id) => page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);

test.describe('scale handles', () => {
  test('scaleSelection doubles a box about its centre and scales the stroke width', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.scaleSelection(2));
    const it = await get(page, id);
    // centre (0,0) is fixed → corner moves from (-50,-50) to (-100,-100)
    expect(it.x).toBeCloseTo(-100, 3);
    expect(it.y).toBeCloseTo(-100, 3);
    expect(it.w).toBeCloseTo(200, 3);
    expect(it.h).toBeCloseTo(200, 3);
    expect(it.width).toBeCloseTo(8, 3); // stroke width scales too
    expect(errors).toEqual([]);
  });

  test('scaleSelection is reversible (undo/redo restores exact size)', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.scaleSelection(2.5));
    expect((await get(page, id)).w).toBeCloseTo(250, 3);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect((await get(page, id)).w).toBeCloseTo(100, 6);
    await page.evaluate(() => window.__INFINIZOOM__.redo());
    expect((await get(page, id)).w).toBeCloseTo(250, 3);
  });

  test('scaleHandles() returns the four selection corners in screen space', async ({ page }) => {
    await freshApp(page);
    await selectedRect(page); // bbox padded by width/2 (=2) → corners at ±52
    const handles = await page.evaluate(() => window.__INFINIZOOM__.scaleHandles());
    expect(handles).toHaveLength(4);
    const xs = handles.map(h => Math.round(h.x)).sort((a, b) => a - b);
    const ys = handles.map(h => Math.round(h.y)).sort((a, b) => a - b);
    // screen centre 640,360; corners at world ±52 → screen 588/692 and 308/412
    expect(xs[0]).toBeCloseTo(588, 0);
    expect(xs[3]).toBeCloseTo(692, 0);
    expect(ys[0]).toBeCloseTo(308, 0);
    expect(ys[3]).toBeCloseTo(412, 0);
  });

  test('no selection → no handles and scaleSelection is a safe no-op', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    expect(await page.evaluate(() => window.__INFINIZOOM__.scaleHandles())).toBe(null);
    await page.evaluate(() => window.__INFINIZOOM__.scaleSelection(2)); // nothing selected
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
    expect(errors).toEqual([]);
  });

  test('dragging the SE corner handle grows the box, pinning the NW corner', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const id = await selectedRect(page, { width: 0 }); // no padding → exact corners
    const before = await get(page, id);
    // SE handle at world (50,50) → screen (690,410); pivot is NW (-50,-50).
    const se = await page.evaluate(() => window.__INFINIZOOM__.scaleHandles()
      .reduce((m, h) => (h.x + h.y > m.x + m.y ? h : m)));
    await page.mouse.move(se.x, se.y);
    await page.mouse.down();
    // drag to world (150,150) → screen (790,510): a 2× uniform scale about NW
    await page.mouse.move(790, 510, { steps: 8 });
    await page.mouse.up();
    const after = await get(page, id);
    expect(after.x).toBeCloseTo(before.x, 0); // NW corner stayed put
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.w).toBeCloseTo(200, -1);     // ~2× (within ~10 world units)
    expect(after.h).toBeCloseTo(200, -1);
    expect(errors).toEqual([]);
  });

  test('a corner-drag resize is one undoable step', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page, { width: 0 });
    const se = await page.evaluate(() => window.__INFINIZOOM__.scaleHandles()
      .reduce((m, h) => (h.x + h.y > m.x + m.y ? h : m)));
    await page.mouse.move(se.x, se.y);
    await page.mouse.down();
    await page.mouse.move(790, 510, { steps: 8 });
    await page.mouse.up();
    expect((await get(page, id)).w).toBeGreaterThan(150);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect((await get(page, id)).w).toBeCloseTo(100, 1); // single undo restores original
  });

  test('keyboard > grows and < shrinks the selection by 10%', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.keyboard.press('>');
    expect((await get(page, id)).w).toBeCloseTo(110, 4);
    await page.keyboard.press('<');
    expect((await get(page, id)).w).toBeCloseTo(100, 4); // 110 / 1.1 = 100
  });

  test('scaling keeps a rotated box rotated (uniform scale commutes with rot)', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 4));
    await page.evaluate(() => window.__INFINIZOOM__.scaleSelection(2));
    const it = await get(page, id);
    expect(it.rot).toBeCloseTo(PI / 4, 4); // rotation untouched
    expect(it.w).toBeCloseTo(200, 3);       // size doubled
  });

  test('scaling a brush stroke preserves per-point pressure', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const id = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      // a stroke whose points carry per-point pressure `p` (as the brush makes)
      const pts = [{ x: -40, y: 0, p: 0.2 }, { x: 0, y: 0, p: 0.9 }, { x: 40, y: 0, p: 0.3 }];
      const sid = A.addStroke(pts, { width: 6 });
      A.setTool('select'); A.select([sid]);
      return sid;
    });
    await page.evaluate(() => window.__INFINIZOOM__.scaleSelection(3));
    const it = await get(page, id);
    expect(it.points.map(p => p.p)).toEqual([0.2, 0.9, 0.3]); // pressures survive scale
    expect(it.width).toBeCloseTo(18, 3);                       // width tripled
    // geometry tripled about centre (0,0): x −40 → −120
    expect(it.points[0].x).toBeCloseTo(-120, 3);
  });

  test('the handles are hidden mid-resize and reappear after the drag', async ({ page }) => {
    await freshApp(page);
    await selectedRect(page, { width: 0 });
    const se = await page.evaluate(() => window.__INFINIZOOM__.scaleHandles()
      .reduce((m, h) => (h.x + h.y > m.x + m.y ? h : m)));
    await page.mouse.move(se.x, se.y);
    await page.mouse.down();
    await page.mouse.move(760, 480, { steps: 4 });
    // a scale gesture is active → render state suppresses the corner handles
    const midGesture = await page.evaluate(() =>
      window.app.active && window.app.active.kind);
    expect(midGesture).toBe('scale');
    await page.mouse.up();
    // ...and they are back once the gesture ends
    expect(await page.evaluate(() => window.__INFINIZOOM__.scaleHandles())).toHaveLength(4);
  });
});
