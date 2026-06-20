import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

test.describe('z-order', () => {
  const seed = (page) => page.evaluate(() => {
    const A = window.__INFINIZOOM__;
    return [A.addRect(0, 0, 10, 10), A.addRect(5, 5, 10, 10), A.addRect(10, 10, 10, 10)];
  });

  test('bring to front moves selection to the end of the order', async ({ page }) => {
    await freshApp(page);
    const ids = await seed(page);
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), ids[0]);
    await page.evaluate(() => window.__INFINIZOOM__.bringToFront());
    const order = await page.evaluate(() => window.__INFINIZOOM__.order());
    expect(order[order.length - 1]).toBe(ids[0]);
  });

  test('send to back moves selection to the start of the order', async ({ page }) => {
    await freshApp(page);
    const ids = await seed(page);
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), ids[2]);
    await page.evaluate(() => window.__INFINIZOOM__.sendToBack());
    const order = await page.evaluate(() => window.__INFINIZOOM__.order());
    expect(order[0]).toBe(ids[2]);
  });

  test('raise / lower move one step and are undoable', async ({ page }) => {
    await freshApp(page);
    const ids = await seed(page); // order [0,1,2]
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), ids[0]);
    await page.evaluate(() => window.__INFINIZOOM__.raise());
    let order = await page.evaluate(() => window.__INFINIZOOM__.order());
    expect(order).toEqual([ids[1], ids[0], ids[2]]);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    order = await page.evaluate(() => window.__INFINIZOOM__.order());
    expect(order).toEqual(ids);
  });
});

test.describe('level of detail (zoom-dependent visibility)', () => {
  test('"near" hides an item when zoomed out, shows it when zoomed in', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(-40, -40, 80, 80, { fill: '#5b8cff' }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setLOD('near')); // minScale = 1
    // zoom OUT past threshold -> hidden
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 0.5 }));
    expect(await page.evaluate(() => window.__INFINIZOOM__.visibleCount())).toBe(0);
    expect(await countInk(page, { grid: false })).toBeLessThan(20);
    // zoom IN past threshold -> visible
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 2 }));
    expect(await page.evaluate(() => window.__INFINIZOOM__.visibleCount())).toBe(1);
    expect(await countInk(page, { grid: false })).toBeGreaterThan(500);
    expect(errors).toEqual([]);
  });

  test('"far" hides when zoomed in, "all" clears the threshold', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(-40, -40, 80, 80, { fill: '#ff5b6e' }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setLOD('far')); // maxScale = 1
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 4 }));
    expect(await page.evaluate(() => window.__INFINIZOOM__.visibleCount())).toBe(0);
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setLOD('all'));
    expect(await page.evaluate(() => window.__INFINIZOOM__.visibleCount())).toBe(1);
  });

  test('LOD survives a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 10, 10));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 3 }));
    await page.evaluate(() => window.__INFINIZOOM__.setLOD('near'));
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    expect(json.items[0].minScale).toBeCloseTo(3, 1);
  });
});

test.describe('recursive stamp', () => {
  test('stamps nested shrinking copies and is one undo step', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(-100, -100, 200, 200, { fill: '#69db7c' }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    const made = await page.evaluate(() => window.__INFINIZOOM__.stamp({ factor: 0.4, depth: 3 }));
    expect(made).toBe(3);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(4);
    // copies must be progressively smaller than the original
    const sizes = await page.evaluate(() => window.__INFINIZOOM__.getItems().map(i => Math.abs(i.w)));
    const sorted = [...sizes].sort((a, b) => b - a);
    expect(sorted[0]).toBeGreaterThan(sorted[1]);
    expect(sorted[1]).toBeGreaterThan(sorted[2]);
    // single undo removes all stamped copies
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
  });

  test('stamp does nothing with an empty selection', async ({ page }) => {
    await freshApp(page);
    const made = await page.evaluate(() => window.__INFINIZOOM__.stamp());
    expect(made).toBe(0);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
  });
});

test.describe('bookmarks + fly-to', () => {
  test('add a bookmark, move away, then go back (instant)', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 100, y: 200, scale: 5 }));
    await page.evaluate(() => window.__INFINIZOOM__.addBookmark('spot'));
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: -9000, y: 9000, scale: 0.01 }));
    await page.evaluate(() => window.__INFINIZOOM__.gotoBookmark(0, false));
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.x).toBeCloseTo(100, 1);
    expect(cam.y).toBeCloseTo(200, 1);
    expect(cam.scale).toBeCloseTo(5, 1);
  });

  test('animated flyTo arrives at the target', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    await page.evaluate(() => window.__INFINIZOOM__.flyTo({ x: 500, y: -300, scale: 1000 }, 250));
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.x).toBeCloseTo(500, 0);
    expect(cam.y).toBeCloseTo(-300, 0);
    expect(cam.scale).toBeCloseTo(1000, -1); // within ~10
  });

  test('bookmarks persist across reload', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => { window.__INFINIZOOM__.setCamera({ x: 7, y: 8, scale: 9 }); window.__INFINIZOOM__.addBookmark('persist'); });
    await page.reload();
    await page.waitForFunction(() => window.__INFINIZOOM__ && window.__INFINIZOOM__.ready);
    const bms = await page.evaluate(() => window.__INFINIZOOM__.bookmarks());
    expect(bms.length).toBe(1);
    expect(bms[0].name).toBe('persist');
    expect(bms[0].scale).toBeCloseTo(9, 1);
  });

  test('remove a bookmark', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => { localStorage.removeItem('infinizoom.bookmarks'); });
    await page.evaluate(() => { window.__INFINIZOOM__.addBookmark('a'); window.__INFINIZOOM__.addBookmark('b'); });
    expect(await page.evaluate(() => window.__INFINIZOOM__.bookmarks().length)).toBe(2);
    await page.evaluate(() => window.__INFINIZOOM__.removeBookmark(0));
    const bms = await page.evaluate(() => window.__INFINIZOOM__.bookmarks());
    expect(bms.length).toBe(1);
    expect(bms[0].name).toBe('b');
  });

  test('bookmark UI chip appears and flying to it works', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => localStorage.removeItem('infinizoom.bookmarks'));
    await page.evaluate(() => { window.__INFINIZOOM__.setCamera({ x: 321, y: 654, scale: 12 }); });
    await page.locator('#addBookmark').click();
    await expect(page.locator('#bookmark-list .bm-go')).toHaveCount(1);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    await page.locator('#bookmark-list .bm-go').first().click();
    await page.waitForTimeout(900); // allow the fly animation to finish
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.x).toBeCloseTo(321, 0);
    expect(cam.scale).toBeCloseTo(12, 0);
  });
});
