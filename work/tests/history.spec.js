import { test, expect } from '@playwright/test';
import { freshApp } from './_helpers.js';

test.describe('undo / redo', () => {
  test('undo removes the last item, redo restores it', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: 0, y: 0 }, { x: 50, y: 50 }]));
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 40, 40));
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
    await page.evaluate(() => window.__INFINIZOOM__.redo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
  });

  test('undo/redo buttons disable at stack ends', async ({ page }) => {
    await freshApp(page);
    await expect(page.locator('#undo')).toBeDisabled();
    await expect(page.locator('#redo')).toBeDisabled();
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 10, 10));
    await expect(page.locator('#undo')).toBeEnabled();
    await page.locator('#undo').click();
    await expect(page.locator('#undo')).toBeDisabled();
    await expect(page.locator('#redo')).toBeEnabled();
  });

  test('a new action clears the redo stack', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 10, 10));
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.canRedo())).toBe(true);
    await page.evaluate(() => window.__INFINIZOOM__.addEllipse(0, 0, 20, 20));
    expect(await page.evaluate(() => window.__INFINIZOOM__.canRedo())).toBe(false);
  });

  test('undo reverses a move', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 80, 80));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.locator('.tool[data-tool="select"]').click();
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    const center = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(40, 40));
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 120, center.y + 60, { steps: 6 });
    await page.mouse.up();
    const moved = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(moved.x).toBeGreaterThan(50);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    const restored = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(Math.abs(restored.x - 0)).toBeLessThan(1);
    expect(Math.abs(restored.y - 0)).toBeLessThan(1);
  });

  test('undo reverses clear-all', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addRect(0, 0, 10, 10); A.addRect(20, 20, 10, 10); A.addRect(40, 40, 10, 10);
    });
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(3);
  });

  test('undo restores z-order after delete', async ({ page }) => {
    await freshApp(page);
    const ids = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      return [A.addRect(0, 0, 10, 10), A.addRect(1, 1, 10, 10), A.addRect(2, 2, 10, 10)];
    });
    // delete the middle one
    await page.evaluate((id) => { window.__INFINIZOOM__.select([id]); window.__INFINIZOOM__.deleteSelection(); }, ids[1]);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    const order = await page.evaluate(() => window.__INFINIZOOM__.getItems().map(i => i.id));
    expect(order).toEqual(ids);
  });
});
