import { test, expect } from '@playwright/test';
import { freshApp, waitReady, BASE_URL } from './_helpers.js';

test.describe('persistence', () => {
  test('drawing survives a page reload (localStorage autosave)', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addStroke([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
      A.addRect(200, 200, 50, 50);
    });
    // give the debounced autosave time to flush
    await page.waitForTimeout(600);
    await page.reload();
    await waitReady(page);
    const count = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(count).toBe(2);
  });

  test('camera position is persisted across reload', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 123, y: 456, scale: 7 }));
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 10, 10)); // triggers save
    await page.waitForTimeout(600);
    await page.reload();
    await waitReady(page);
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.x).toBeCloseTo(123, 1);
    expect(cam.y).toBeCloseTo(456, 1);
    expect(cam.scale).toBeCloseTo(7, 1);
  });

  test('JSON round-trip preserves items exactly', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addStroke([{ x: 1, y: 2 }, { x: 3, y: 4 }], { color: '#ff0000', width: 5 });
      A.addRect(10, 20, 30, 40, { color: '#00ff00', fill: '#0000ff' });
      A.addText(5, 5, 'roundtrip', { size: 18 });
    });
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const reloaded = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    expect(reloaded.items).toHaveLength(3);
    expect(reloaded.items[0].color).toBe('#ff0000');
    expect(reloaded.items[1].fill).toBe('#0000ff');
    expect(reloaded.items[2].text).toBe('roundtrip');
  });

  test('loadJSON with a wrapped {doc, camera} payload works', async ({ page }) => {
    await freshApp(page);
    const payload = {
      doc: { version: 2, items: [{ id: 'a', type: 'rect', x: 0, y: 0, w: 50, h: 50, color: '#fff', width: 2, fill: null }] },
      camera: { x: 10, y: 10, scale: 2 },
    };
    await page.evaluate((p) => window.__INFINIZOOM__.loadJSON(p), payload);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.scale).toBeCloseTo(2, 1);
  });

  test('corrupt localStorage does not crash the app', async ({ page }) => {
    await page.goto(BASE_URL);
    await waitReady(page);
    await page.evaluate(() => localStorage.setItem('infinizoom.doc.v2', '{not valid json'));
    await page.reload();
    await waitReady(page); // should still come up
    const count = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(count).toBe(0);
  });
});
