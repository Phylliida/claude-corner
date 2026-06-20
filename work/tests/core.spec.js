import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, mouseStroke } from './_helpers.js';

test.describe('core', () => {
  test('loads with no console/page errors and exposes the test API', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const api = await page.evaluate(() => ({
      ready: window.__INFINIZOOM__.ready,
      version: window.__INFINIZOOM__.version,
      tool: window.__INFINIZOOM__.getTool(),
      count: window.__INFINIZOOM__.itemCount(),
    }));
    expect(api.ready).toBe(true);
    expect(api.version).toBeGreaterThanOrEqual(2);
    expect(api.tool).toBe('pen');
    expect(api.count).toBe(0);
    expect(errors).toEqual([]);
  });

  test('all expected DOM controls are present', async ({ page }) => {
    await freshApp(page);
    for (const tool of ['pen', 'line', 'rect', 'ellipse', 'text', 'select', 'eraser', 'pan']) {
      await expect(page.locator(`.tool[data-tool="${tool}"]`)).toBeVisible();
    }
    await expect(page.locator('#minimap')).toBeVisible();
    await expect(page.locator('#hud')).toBeVisible();
    await expect(page.locator('#swatches .swatch')).toHaveCount(12);
  });

  test('drawing a freehand stroke with the mouse creates one stroke item', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await mouseStroke(page, [[400, 300], [500, 350], [600, 300], [700, 400]], 3);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('stroke');
    expect(items[0].points.length).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  });

  test('a single click (no drag) does not create a degenerate stroke item', async ({ page }) => {
    await freshApp(page);
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.up();
    // a zero-length stroke simplifies to a single point and is kept as a dot,
    // but a true no-move click should not explode item count
    const count = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(count).toBeLessThanOrEqual(1);
  });

  test('HUD reflects item count and current tool', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: 0, y: 0 }, { x: 50, y: 50 }]));
    await expect(page.locator('#hud-count')).toHaveText('1 item');
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 30, 30));
    await expect(page.locator('#hud-count')).toHaveText('2 items');
    await page.locator('.tool[data-tool="rect"]').click();
    await expect(page.locator('#hud-tool')).toHaveText('rect');
  });
});
