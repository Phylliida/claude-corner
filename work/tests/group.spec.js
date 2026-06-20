import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

const PI = Math.PI;

// Two filled rects: A centred on world (0,0), B centred on world (250,0).
async function twoRects(page) {
  await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
  const a = await page.evaluate(() => window.__INFINIZOOM__.addRect(-50, -50, 100, 100, { fill: '#69db7c' }));
  const b = await page.evaluate(() => window.__INFINIZOOM__.addRect(200, -50, 100, 100, { fill: '#4dabf7' }));
  await page.evaluate(() => window.__INFINIZOOM__.setTool('select'));
  return { a, b };
}

test.describe('grouping', () => {
  test('group() tags 2+ selected items with one shared id; <2 is a no-op', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const { a, b } = await twoRects(page);
    // one item → refuses to group
    await page.evaluate((a) => window.__INFINIZOOM__.select([a]), a);
    expect(await page.evaluate(() => window.__INFINIZOOM__.group())).toBeNull();
    // two items → grouped under one id
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    const gid = await page.evaluate(() => window.__INFINIZOOM__.group());
    expect(gid).toBeTruthy();
    expect(await page.evaluate((a) => window.__INFINIZOOM__.groupOf(a), a)).toBe(gid);
    expect(await page.evaluate((b) => window.__INFINIZOOM__.groupOf(b), b)).toBe(gid);
    expect(errors).toEqual([]);
  });

  test('clicking one grouped member selects the whole group', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    await page.evaluate(() => window.__INFINIZOOM__.group());
    await page.evaluate(() => window.__INFINIZOOM__.select([])); // clear
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(0);
    await page.mouse.click(640, 360); // world (0,0) — inside rect A
    expect(await page.evaluate(() => window.__INFINIZOOM__.selectedCount())).toBe(2);
  });

  test('dragging one member moves the entire group', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    await page.evaluate(() => window.__INFINIZOOM__.group());
    // drag from inside rect A (screen 640,360) rightwards by 60px → +60 world
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await page.mouse.move(700, 360, { steps: 5 });
    await page.mouse.up();
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    const A = items.find(i => i.id === a), B = items.find(i => i.id === b);
    expect(A.x).toBeCloseTo(10, 0);   // -50 + 60
    expect(B.x).toBeCloseTo(260, 0);  // 200 + 60
  });

  test('rotating a group turns all members about the group centre', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    await page.evaluate(() => window.__INFINIZOOM__.group());
    await page.evaluate(() => window.__INFINIZOOM__.rotateSelection(Math.PI / 2));
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items.find(i => i.id === a).rot).toBeCloseTo(PI / 2, 3);
    expect(items.find(i => i.id === b).rot).toBeCloseTo(PI / 2, 3);
  });

  test('ungroup() clears the tag from every member', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    await page.evaluate(() => window.__INFINIZOOM__.group());
    // selecting just one member then ungrouping should still free both
    await page.evaluate((a) => window.__INFINIZOOM__.select([a]), a);
    expect(await page.evaluate(() => window.__INFINIZOOM__.ungroup())).toBe(2);
    expect(await page.evaluate((a) => window.__INFINIZOOM__.groupOf(a), a)).toBeNull();
    expect(await page.evaluate((b) => window.__INFINIZOOM__.groupOf(b), b)).toBeNull();
  });

  test('group / ungroup are reversible with undo/redo', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    const gid = await page.evaluate(() => window.__INFINIZOOM__.group());
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate((a) => window.__INFINIZOOM__.groupOf(a), a)).toBeNull();
    await page.evaluate(() => window.__INFINIZOOM__.redo());
    expect(await page.evaluate((a) => window.__INFINIZOOM__.groupOf(a), a)).toBe(gid);
  });

  test('group tags survive a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    const gid = await page.evaluate(() => window.__INFINIZOOM__.group());
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items.every(i => i.group === gid)).toBe(true);
  });

  test('pasting a group gives the copies a fresh, distinct group id', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    const gid = await page.evaluate(() => window.__INFINIZOOM__.group());
    await page.evaluate(() => { window.__INFINIZOOM__.copy(); window.__INFINIZOOM__.paste(); });
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(4);
    const pasted = items.filter(i => i.group && i.group !== gid);
    expect(pasted).toHaveLength(2);
    expect(pasted[0].group).toBe(pasted[1].group); // copies still grouped together
  });

  test('Ctrl+G groups and Ctrl+Shift+G ungroups', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoRects(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.select([a, b]), { a, b });
    await page.keyboard.press('Control+g');
    expect(await page.evaluate((a) => window.__INFINIZOOM__.groupOf(a), a)).toBeTruthy();
    await page.keyboard.press('Control+Shift+g');
    expect(await page.evaluate((a) => window.__INFINIZOOM__.groupOf(a), a)).toBeNull();
  });
});
