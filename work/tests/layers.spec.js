import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

/** Add a filled rect at world coords and return its id. */
async function addRect(page, x, y, w, h, fill = '#69db7c') {
  return page.evaluate(({ x, y, w, h, fill }) => {
    window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 });
    return window.__INFINIZOOM__.addRect(x, y, w, h, { fill });
  }, { x, y, w, h, fill });
}

test.describe('layers — lock / hide', () => {
  test('hiding an item keeps it in the document but off the canvas', async ({ page }) => {
    await freshApp(page);
    const id = await addRect(page, -80, -80, 160, 160);
    await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
    await page.evaluate(() => window.__INFINIZOOM__.hideSelection());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
    expect(await page.evaluate((id) => window.__INFINIZOOM__.isHidden(id), id)).toBe(true);
    expect(await page.evaluate(() => window.__INFINIZOOM__.hiddenCount())).toBe(1);
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(0); // hide deselects
    const ink = await countInk(page, { grid: false });
    expect(ink).toBeLessThan(60); // nothing painted
  });

  test('a hidden item is not pickable', async ({ page }) => {
    await freshApp(page);
    const id = await addRect(page, -50, -50, 100, 100);
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(0, 0, 4))).toBe(id);
    await page.evaluate((id) => window.__INFINIZOOM__.setHidden([id], true), id);
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(0, 0, 4))).toBe(null);
  });

  test('a locked item cannot be clicked-to-select or dragged', async ({ page }) => {
    await freshApp(page);
    const id = await addRect(page, -50, -50, 100, 100);
    await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.setLocked([id], true); }, id);
    expect(await page.evaluate((id) => window.__INFINIZOOM__.isLocked(id), id)).toBe(true);
    const c = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(0, 0));
    // click the centre: a locked item should not be selectable
    await page.mouse.click(c.x, c.y);
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(0);
    // drag across it: it must not move
    const before = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).x, id);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 120, c.y + 40, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).x, id);
    expect(after).toBeCloseTo(before, 6);
  });

  test('the eraser will not erase a locked item', async ({ page }) => {
    await freshApp(page);
    const id = await addRect(page, -40, -40, 80, 80);
    await page.evaluate((id) => window.__INFINIZOOM__.setLocked([id], true), id);
    const c = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(0, 0));
    await page.locator('.tool[data-tool="eraser"]').click();
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 3, c.y, { steps: 2 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1); // survived
  });

  test('hide is reversible via undo / redo', async ({ page }) => {
    await freshApp(page);
    const id = await addRect(page, 0, 0, 50, 50);
    await page.evaluate((id) => window.__INFINIZOOM__.setHidden([id], true), id);
    expect(await page.evaluate((id) => window.__INFINIZOOM__.isHidden(id), id)).toBe(true);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate((id) => window.__INFINIZOOM__.isHidden(id), id)).toBe(false);
    await page.evaluate(() => window.__INFINIZOOM__.redo());
    expect(await page.evaluate((id) => window.__INFINIZOOM__.isHidden(id), id)).toBe(true);
  });

  test('show-all and unlock-all are global recovery hatches', async ({ page }) => {
    await freshApp(page);
    const a = await addRect(page, -200, 0, 40, 40);
    const b = await addRect(page, 0, 0, 40, 40);
    const c = await addRect(page, 200, 0, 40, 40);
    await page.evaluate(({ a, b, c }) => {
      window.__INFINIZOOM__.setHidden([a, b], true);
      window.__INFINIZOOM__.setLocked([c], true);
    }, { a, b, c });
    expect(await page.evaluate(() => window.__INFINIZOOM__.hiddenCount())).toBe(2);
    expect(await page.evaluate(() => window.__INFINIZOOM__.lockedCount())).toBe(1);
    await page.evaluate(() => { window.__INFINIZOOM__.showAll(); window.__INFINIZOOM__.unlockAll(); });
    expect(await page.evaluate(() => window.__INFINIZOOM__.hiddenCount())).toBe(0);
    expect(await page.evaluate(() => window.__INFINIZOOM__.lockedCount())).toBe(0);
  });

  test('lock / hide flags survive a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const a = await addRect(page, -60, 0, 40, 40);
    const b = await addRect(page, 60, 0, 40, 40);
    await page.evaluate(({ a, b }) => { window.__INFINIZOOM__.setHidden([a], true); window.__INFINIZOOM__.setLocked([b], true); }, { a, b });
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    expect(await page.evaluate((a) => window.__INFINIZOOM__.isHidden(a), a)).toBe(true);
    expect(await page.evaluate((b) => window.__INFINIZOOM__.isLocked(b), b)).toBe(true);
  });

  test('select-all skips locked and hidden items', async ({ page }) => {
    await freshApp(page);
    const a = await addRect(page, -200, 0, 40, 40);
    const b = await addRect(page, 0, 0, 40, 40);
    const c = await addRect(page, 200, 0, 40, 40);
    await page.evaluate(({ b, c }) => { window.__INFINIZOOM__.setLocked([b], true); window.__INFINIZOOM__.setHidden([c], true); }, { b, c });
    await page.evaluate(() => window.__INFINIZOOM__.selectAll());
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(1); // only `a`
  });

  test('marquee skips locked and hidden items', async ({ page }) => {
    await freshApp(page);
    const a = await addRect(page, -120, -40, 40, 40);
    const b = await addRect(page, -40, -40, 40, 40);
    const c = await addRect(page, 40, -40, 40, 40);
    await page.evaluate(({ b, c }) => { window.__INFINIZOOM__.setLocked([b], true); window.__INFINIZOOM__.setHidden([c], true); }, { b, c });
    await page.locator('.tool[data-tool="select"]').click();
    const tl = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(-160, -80));
    const br = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(100, 40));
    await page.mouse.move(tl.x, tl.y);
    await page.mouse.down();
    await page.mouse.move(br.x, br.y, { steps: 6 });
    await page.mouse.up();
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(1); // only `a`
  });

  test('a hidden item is omitted from the SVG export', async ({ page }) => {
    await freshApp(page);
    const a = await addRect(page, -50, -50, 100, 100);
    await addRect(page, 200, 200, 60, 60);
    await page.evaluate((a) => window.__INFINIZOOM__.setHidden([a], true), a);
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    // background <rect> + one visible content <rect> = 2 (the hidden one is gone)
    expect((svg.match(/<rect /g) || []).length).toBe(2);
  });

  test('the Objects panel lists items and its row toggles work', async ({ page }) => {
    await freshApp(page);
    const a = await addRect(page, -80, 0, 40, 40);
    const b = await addRect(page, 80, 0, 40, 40);
    await page.evaluate(() => window.__INFINIZOOM__.renderLayers());
    const rows = page.locator('#layer-list .layer-row');
    await expect(rows).toHaveCount(2);
    // top row is the front-most (last added = b); click its name to select it
    await rows.first().locator('.lr-name').click();
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(1);
    expect(await page.evaluate((b) => window.app.selectedIds.has(b), b)).toBe(true);
    // toggle that row's lock + hide
    await page.evaluate(() => window.__INFINIZOOM__.renderLayers());
    await page.locator('#layer-list .layer-row').first().locator('.lr-lock').click();
    expect(await page.evaluate(() => window.__INFINIZOOM__.lockedCount())).toBe(1);
    await page.evaluate(() => window.__INFINIZOOM__.renderLayers());
    await page.locator('#layer-list .layer-row').first().locator('.lr-hide').click();
    expect(await page.evaluate(() => window.__INFINIZOOM__.hiddenCount())).toBe(1);
  });

  test('no console errors while locking, hiding and recovering', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const id = await addRect(page, 0, 0, 60, 60);
    await page.evaluate((id) => {
      const A = window.__INFINIZOOM__;
      A.setHidden([id], true); A.showAll();
      A.setLocked([id], true); A.unlockAll();
    }, id);
    await page.evaluate(() => window.__INFINIZOOM__.render());
    expect(errors).toEqual([]);
  });
});
