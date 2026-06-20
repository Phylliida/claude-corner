import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

const ALL = ['tree', 'spiral', 'droste', 'sierpinski', 'flowers'];

test.describe('generators', () => {
  test('the test API lists all generators', async ({ page }) => {
    await freshApp(page);
    const gens = await page.evaluate(() => window.__INFINIZOOM__.generators());
    expect(gens.sort()).toEqual([...ALL].sort());
  });

  for (const g of ALL) {
    test(`"${g}" produces valid items and paints pixels`, async ({ page }) => {
      const errors = captureErrors(page);
      await freshApp(page);
      const n = await page.evaluate((g) => window.__INFINIZOOM__.generate(g, {}, { clear: true, fit: true }), g);
      expect(n).toBeGreaterThan(0);
      // validate types + finite geometry inside the page (one round-trip, one assert)
      const check = await page.evaluate(() => {
        const known = new Set(['stroke', 'line', 'rect', 'ellipse', 'text']);
        for (const it of window.app.scene.items) {
          if (!known.has(it.type)) return { ok: false, why: 'type ' + it.type };
          const nums = [];
          for (const p of it.points || []) nums.push(p.x, p.y);
          for (const v of [it.x, it.y, it.w, it.h]) if (v !== undefined) nums.push(v);
          for (const v of nums) if (!Number.isFinite(v)) return { ok: false, why: 'nonfinite' };
        }
        return { ok: true, count: window.app.scene.count() };
      });
      expect(check.ok).toBe(true);
      expect(check.count).toBe(n);
      const ink = await countInk(page, { grid: false });
      expect(ink).toBeGreaterThan(200);
      expect(errors).toEqual([]);
    });
  }

  test('generate with clear:true replaces existing content as one undo step', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 10, 10));
    await page.evaluate(() => window.__INFINIZOOM__.generate('tree', { depth: 6 }, { clear: true, fit: false }));
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    // the lone rect should be gone, replaced by tree lines
    expect(items.find(i => i.type === 'rect')).toBeUndefined();
    // a single undo brings the rect back
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    const after = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(after).toHaveLength(1);
    expect(after[0].type).toBe('rect');
  });

  test('additive generate is a single undoable step', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.generate('flowers', {}, { clear: false, fit: false }));
    const n = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(n).toBeGreaterThan(0);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
  });

  test('deep zoom into the spiral still renders fresh detail (infinite zoom)', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.generate('spiral', { count: 120, shrink: 0.9 }, { clear: true, fit: true }));
    // zoom toward the tail (smallest) squares ~50,000x and verify content is visible
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      const tail = window.app.scene.items.slice(-5);
      let cx = 0, cy = 0, n = 0;
      for (const it of tail) for (const p of it.points || []) { cx += p.x; cy += p.y; n++; }
      A.setCamera({ x: cx / n, y: cy / n, scale: 5e4 });
    });
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.scale).toBeGreaterThan(1e4);
    const ink = await countInk(page, { grid: false });
    expect(ink).toBeGreaterThan(100);
    expect(errors).toEqual([]);
  });
});
