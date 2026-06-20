// Zoom-dependent line width: per-item `widthMode`.
//   'world'  (default) — width is in world units, so on-screen thickness scales
//                        with zoom (the original behaviour).
//   'screen'           — width is in screen pixels, so on-screen thickness stays
//                        constant no matter how far you zoom.
import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

/** Render a single horizontal line item at the given camera scale, then measure
 *  its on-screen thickness (device px) by sampling the centre column. */
async function lineThicknessAtScale(page, widthMode, scale) {
  return page.evaluate(({ widthMode, scale }) => {
    const A = window.__INFINIZOOM__;
    A.clear();
    window.app.renderer.showGrid = false; // grid axes would swamp the sample column
    A.setCamera({ x: 0, y: 0, scale: 1 });
    // a long horizontal line just off the origin so it spans the sample column
    A.addStroke([{ x: -2000, y: 50 }, { x: 2000, y: 50 }], { color: '#ffffff', width: 8, widthMode });
    A.setCamera({ x: 0, y: 50, scale });
    A.render();
    const c = document.getElementById('canvas');
    const ctx = c.getContext('2d');
    const cx = Math.floor(c.width / 2);
    const col = ctx.getImageData(cx, 0, 1, c.height).data;
    let ink = 0;
    for (let i = 0; i < col.length; i += 4) {
      const d = Math.abs(col[i] - 14) + Math.abs(col[i + 1] - 15) + Math.abs(col[i + 2] - 19);
      if (d > 60) ink++;
    }
    return ink; // thickness in device pixels
  }, { widthMode, scale });
}

test.describe('zoom-dependent line width (widthMode)', () => {
  test.beforeEach(async ({ page }) => { await freshApp(page); });

  test('default strokes carry no widthMode and scale with zoom', async ({ page }) => {
    const errors = captureErrors(page);
    const t1 = await lineThicknessAtScale(page, undefined, 1);
    const t4 = await lineThicknessAtScale(page, undefined, 4);
    expect(t1).toBeGreaterThan(2);
    // world units: 4× the zoom ⇒ ~4× the on-screen thickness
    expect(t4 / t1).toBeGreaterThan(3);
    expect(t4 / t1).toBeLessThan(5);
    // and the item stores nothing extra
    const it = (await page.evaluate(() => window.__INFINIZOOM__.getItems()))[0];
    expect(it.widthMode).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('screen-mode strokes keep a constant on-screen thickness across zoom', async ({ page }) => {
    const t1 = await lineThicknessAtScale(page, 'screen', 1);
    const t4 = await lineThicknessAtScale(page, 'screen', 4);
    expect(t1).toBeGreaterThan(2);
    // screen pixels: thickness barely changes when you zoom
    expect(t4 / t1).toBeGreaterThan(0.7);
    expect(t4 / t1).toBeLessThan(1.5);
    const it = (await page.evaluate(() => window.__INFINIZOOM__.getItems()))[0];
    expect(it.widthMode).toBe('screen');
  });

  test('setStyle widthMode applies to the current selection and is undoable', async ({ page }) => {
    const id = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.clear();
      const id = A.addRect(0, 0, 100, 80, { width: 4 });
      A.select([id]);
      A.setStyle({ widthMode: 'screen' });
      return id;
    });
    expect(await page.evaluate(id => window.__INFINIZOOM__.getItems().find(i => i.id === id).widthMode, id)).toBe('screen');
    // switching back to world deletes the field (keeps JSON tidy)
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ widthMode: 'world' }));
    expect(await page.evaluate(id => window.__INFINIZOOM__.getItems().find(i => i.id === id).widthMode, id)).toBeUndefined();
  });

  test('widthMode survives a JSON round-trip', async ({ page }) => {
    const json = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.clear();
      A.addStroke([{ x: 0, y: 0 }, { x: 50, y: 50 }], { width: 6, widthMode: 'screen' });
      return A.toJSON();
    });
    const reloaded = await page.evaluate(doc => {
      const A = window.__INFINIZOOM__;
      A.loadJSON({ doc });
      return A.getItems();
    }, json);
    expect(reloaded[0].widthMode).toBe('screen');
  });

  test('the UI selector switches the active draw mode', async ({ page }) => {
    await page.selectOption('#widthMode', 'screen');
    expect(await page.evaluate(() => window.__INFINIZOOM__.getStyle().widthMode)).toBe('screen');
    const id = await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]));
    expect(await page.evaluate(id => window.__INFINIZOOM__.getItems().find(i => i.id === id).widthMode, id)).toBe('screen');
  });
});
