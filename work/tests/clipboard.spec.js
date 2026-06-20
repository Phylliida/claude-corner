import { test, expect } from '@playwright/test';
import { freshApp } from './_helpers.js';

test.describe('clipboard', () => {
  test('copy then paste adds a copy and selects it', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 50, 50, { fill: '#5b8cff' }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    expect(await page.evaluate(() => window.__INFINIZOOM__.copy())).toBe(1);
    expect(await page.evaluate(() => window.__INFINIZOOM__.paste())).toBe(1);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(1);
  });

  test('paste lands centred on the current view', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 40, 40));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.copy());
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 1000, y: 1000, scale: 1 }));
    await page.evaluate(() => window.__INFINIZOOM__.paste());
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    const pasted = items[items.length - 1];
    const cx = pasted.x + pasted.w / 2, cy = pasted.y + pasted.h / 2;
    expect(Math.abs(cx - 1000)).toBeLessThan(2);
    expect(Math.abs(cy - 1000)).toBeLessThan(2);
  });

  test('cut removes the original; paste restores a copy', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 30, 30));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    expect(await page.evaluate(() => window.__INFINIZOOM__.cut())).toBe(1);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
    await page.evaluate(() => window.__INFINIZOOM__.paste());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
  });

  test('paste with an empty clipboard does nothing', async ({ page }) => {
    await freshApp(page);
    expect(await page.evaluate(() => window.__INFINIZOOM__.paste())).toBe(0);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
  });

  test('Ctrl+C / Ctrl+V work from the keyboard', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => { const A = window.__INFINIZOOM__; A.addRect(0, 0, 20, 20); A.addRect(40, 0, 20, 20); });
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    expect(await page.evaluate(() => window.__INFINIZOOM__.clipboardCount())).toBe(2);
    await page.keyboard.press('Control+v');
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(4);
  });

  test('a paste is a single undo step', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => { const A = window.__INFINIZOOM__; const a = A.addRect(0, 0, 10, 10); const b = A.addRect(20, 0, 10, 10); A.select([a, b]); });
    await page.evaluate(() => window.__INFINIZOOM__.copy());
    await page.evaluate(() => window.__INFINIZOOM__.paste());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(4);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
  });
});
