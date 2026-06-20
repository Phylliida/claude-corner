import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

/** Build a document of N small rects on a wide grid, loaded in one shot. */
async function loadGrid(page, n, span = 60) {
  await page.evaluate(({ n, span }) => {
    const items = [];
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) {
      const x = (i % cols) * span - (cols * span) / 2;
      const y = Math.floor(i / cols) * span - (cols * span) / 2;
      items.push({ id: 'p' + i, type: 'rect', x, y, w: span * 0.7, h: span * 0.7,
                   color: '#5b8cff', width: 2, fill: i % 7 === 0 ? '#b197fc' : null });
    }
    window.__INFINIZOOM__.loadJSON({ version: 2, items });
  }, { n, span });
}

test.describe('performance @ scale', () => {
  test('renders 5,000 items within a sane frame budget', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await loadGrid(page, 5000);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(5000);
    await page.evaluate(() => window.__INFINIZOOM__.fitAll());
    // average a few renders to smooth out noise
    const ms = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      let total = 0;
      for (let i = 0; i < 5; i++) { A.render(); total += A.stats().lastRenderMs; }
      return total / 5;
    });
    console.log(`    5k-item render avg: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(400); // generous headless budget
    expect(errors).toEqual([]);
  });

  test('viewport culling: zoomed into a corner, only a few items are drawn', async ({ page }) => {
    await freshApp(page);
    await loadGrid(page, 5000, 60);
    const total = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(total).toBe(5000);
    // zoom way into one item near origin
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 30 }));
    const drawn = await page.evaluate(() => window.__INFINIZOOM__.drawnCount());
    console.log(`    drawn when zoomed in: ${drawn} / ${total}`);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(total / 10); // culling is doing real work
  });

  test('fit-all then deep zoom stays responsive (no runaway)', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await loadGrid(page, 2000);
    await page.evaluate(() => window.__INFINIZOOM__.fitAll());
    // ramp the zoom up hard and ensure each render is bounded
    const worst = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      let worst = 0;
      for (let s = 1; s <= 1e6; s *= 10) {
        A.setCamera({ x: 0, y: 0, scale: s });
        A.render();
        worst = Math.max(worst, A.stats().lastRenderMs);
      }
      return worst;
    });
    console.log(`    worst render across zoom ramp: ${worst.toFixed(1)}ms`);
    expect(worst).toBeLessThan(400);
    expect(errors).toEqual([]);
  });
});
