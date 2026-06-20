import { test, expect } from '@playwright/test';
import { freshApp } from './_helpers.js';

test.describe('keyboard shortcuts', () => {
  const toolKeys = [
    ['p', 'pen'], ['l', 'line'], ['r', 'rect'], ['o', 'ellipse'],
    ['t', 'text'], ['v', 'select'], ['e', 'eraser'], ['h', 'pan'],
  ];

  for (const [key, tool] of toolKeys) {
    test(`"${key}" selects the ${tool} tool`, async ({ page }) => {
      await freshApp(page);
      await page.keyboard.press(key);
      expect(await page.evaluate(() => window.__INFINIZOOM__.getTool())).toBe(tool);
    });
  }

  test('Ctrl+Z / Ctrl+Shift+Z undo and redo', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 10, 10));
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
    await page.keyboard.press('Control+Shift+z');
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
  });

  test('Ctrl+A selects all', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => { const A = window.__INFINIZOOM__; A.addRect(0, 0, 10, 10); A.addRect(20, 20, 10, 10); });
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(2);
  });

  test('Delete removes the selection', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => { const A = window.__INFINIZOOM__; A.addRect(0, 0, 10, 10); A.addRect(20, 20, 10, 10); });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
  });

  test('Ctrl+D duplicates the selection', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 40, 40));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.keyboard.press('Control+d');
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
    // duplicate should be offset, not on top of the original
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items[1].x).not.toBe(items[0].x);
  });

  test('+ / - zoom via keyboard', async ({ page }) => {
    await freshApp(page);
    const s0 = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    await page.keyboard.press('+');
    const s1 = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    expect(s1).toBeGreaterThan(s0);
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    const s2 = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    expect(s2).toBeLessThan(s1);
  });

  test('"f" zooms to fit and "0" resets', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addRect(1000, 1000, 200, 200));
    await page.keyboard.press('f');
    let cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam.x).toBeGreaterThan(500);
    await page.keyboard.press('0');
    cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam).toMatchObject({ x: 0, y: 0, scale: 1 });
  });

  test('"g" toggles the grid', async ({ page }) => {
    await freshApp(page);
    const before = await page.evaluate(() => window.app.renderer.showGrid);
    await page.keyboard.press('g');
    const after = await page.evaluate(() => window.app.renderer.showGrid);
    expect(after).toBe(!before);
  });
});
