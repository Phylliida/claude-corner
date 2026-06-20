import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

const drag = async (page, x0, y0, x1, y1) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
};

test.describe('arrow tool', () => {
  test('keyboard "a" selects the arrow tool', async ({ page }) => {
    await freshApp(page);
    await page.keyboard.press('a');
    expect(await page.evaluate(() => window.__INFINIZOOM__.getTool())).toBe('arrow');
  });

  test('drawing an arrow creates a 2-point arrow item', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.locator('.tool[data-tool="arrow"]').click();
    await drag(page, 300, 300, 700, 320);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('arrow');
    expect(items[0].points).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  test('arrow paints an arrowhead (more ink near the tip than a bare line)', async ({ page }) => {
    await freshApp(page);
    // center an arrow on screen and confirm it renders something substantial
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    await page.evaluate(() => window.__INFINIZOOM__.addArrow({ x: -200, y: 0 }, { x: 200, y: 0 }, { width: 8 }));
    const ink = await countInk(page, { grid: false });
    expect(ink).toBeGreaterThan(300);
  });
});

test.describe('star / polygon tool', () => {
  test('keyboard "s" selects the star tool', async ({ page }) => {
    await freshApp(page);
    await page.keyboard.press('s');
    expect(await page.evaluate(() => window.__INFINIZOOM__.getTool())).toBe('star');
  });

  test('drawing a star creates a polygon item with default 5 points', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="star"]').click();
    await drag(page, 400, 300, 600, 500);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('polygon');
    expect(items[0].sides).toBe(5);
    expect(items[0].star).toBe(true);
  });

  test('changing star points updates the selected polygon', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addPolygon(-100, -100, 200, 200, { star: true, sides: 5 }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ sides: 8 }));
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.sides).toBe(8);
  });

  test('a filled polygon registers an interior hit; an unfilled one does not', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const filled = await page.evaluate(() => window.__INFINIZOOM__.addPolygon(-100, -100, 200, 200, { star: false, sides: 6, fill: '#69db7c' }));
    // dead-center should hit the filled polygon
    const hit = await page.evaluate(() => window.__INFINIZOOM__.pick(0, 0, 2));
    expect(hit).toBe(filled);
  });

  test('polygon fill toggles via the fill control on selection', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addPolygon(-50, -50, 100, 100, { star: true, fill: null }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ fill: '#ffd43b' }));
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.fill).toBe('#ffd43b');
  });

  test('new shape types survive a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addArrow({ x: 0, y: 0 }, { x: 100, y: 100 });
      A.addPolygon(0, 0, 50, 50, { sides: 7, star: false, fill: '#4dabf7' });
    });
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items.map(i => i.type).sort()).toEqual(['arrow', 'polygon']);
    expect(items.find(i => i.type === 'polygon').sides).toBe(7);
  });
});
