import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

// A selected rect at the origin, camera at scale 1 (so 1 screen px = 1 world unit).
async function selectedRect(page) {
  await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
  const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(-50, -50, 100, 100, { fill: '#74c0fc' }));
  await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
  return id;
}
const get = (page, id) => page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);

test.describe('arrow-key nudge', () => {
  test('arrow keys move the selection one screen pixel', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const id = await selectedRect(page);
    const before = await get(page, id);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const after = await get(page, id);
    expect(after.x).toBeCloseTo(before.x + 1, 6);
    expect(after.y).toBeCloseTo(before.y + 1, 6);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    const back = await get(page, id);
    expect(back.x).toBeCloseTo(before.x, 6);
    expect(back.y).toBeCloseTo(before.y, 6);
    expect(errors).toEqual([]);
  });

  test('Shift+Arrow nudges by ten pixels', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    const x0 = (await get(page, id)).x;
    await page.keyboard.press('Shift+ArrowRight');
    expect((await get(page, id)).x).toBeCloseTo(x0 + 10, 6);
  });

  test('each nudge is its own undo step', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    const x0 = (await get(page, id)).x;
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect((await get(page, id)).x).toBeCloseTo(x0 + 2, 6);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect((await get(page, id)).x).toBeCloseTo(x0 + 1, 6);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect((await get(page, id)).x).toBeCloseTo(x0, 6);
  });

  test('the nudge step scales with zoom (constant on-screen feel)', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 4 }));
    const x0 = (await get(page, id)).x;
    await page.keyboard.press('ArrowRight'); // 1 screen px at scale 4 → 0.25 world units
    expect((await get(page, id)).x).toBeCloseTo(x0 + 0.25, 6);
  });

  test('nudgeSelection(dx,dy) moves by an exact world delta', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    const before = await get(page, id);
    await page.evaluate(() => window.__INFINIZOOM__.nudgeSelection(7, -3));
    const after = await get(page, id);
    expect(after.x).toBeCloseTo(before.x + 7, 6);
    expect(after.y).toBeCloseTo(before.y - 3, 6);
  });

  test('arrow keys with nothing selected are a safe no-op', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.evaluate(() => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([]); });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => window.__INFINIZOOM__.canUndo())).toBe(false);
    expect(errors).toEqual([]);
  });

  test('a locked item is not nudged', async ({ page }) => {
    await freshApp(page);
    const id = await selectedRect(page);
    const x0 = (await get(page, id)).x;
    // lock it (this also clears it from the selection), then re-select via API and nudge
    await page.evaluate((id) => window.__INFINIZOOM__.setLocked([id], true), id);
    await page.evaluate((id) => window.app.selectedIds = new Set([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.nudgeSelection(5, 5));
    expect((await get(page, id)).x).toBeCloseTo(x0, 6); // locked → unmoved
  });
});
