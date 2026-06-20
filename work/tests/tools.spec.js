import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, mouseStroke } from './_helpers.js';

const dragShape = async (page, x0, y0, x1, y1) => {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 4 });
  await page.mouse.up();
};

test.describe('tools', () => {
  test('line tool draws a 2-point line', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="line"]').click();
    await dragShape(page, 300, 300, 700, 450);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('line');
    expect(items[0].points).toHaveLength(2);
  });

  test('rectangle tool draws a rect with width/height', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="rect"]').click();
    await dragShape(page, 300, 250, 600, 500);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('rect');
    expect(Math.abs(items[0].w)).toBeGreaterThan(10);
    expect(Math.abs(items[0].h)).toBeGreaterThan(10);
  });

  test('ellipse tool draws an ellipse', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="ellipse"]').click();
    await dragShape(page, 350, 300, 650, 480);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('ellipse');
  });

  test('tiny shape drag is discarded (no accidental dots)', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="rect"]').click();
    await dragShape(page, 500, 400, 501, 401);
    const count = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(count).toBe(0);
  });

  test('text tool places a text item with typed content', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="text"]').click();
    await page.mouse.click(450, 350);
    const editor = page.locator('#text-editor');
    await expect(editor).toHaveClass(/active/);
    await expect(editor).toBeFocused();
    await page.keyboard.type('hello infinity');
    await page.keyboard.press('Control+Enter');
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('text');
    expect(items[0].text).toBe('hello infinity');
  });

  test('empty text is not committed', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="text"]').click();
    await page.mouse.click(450, 350);
    await page.keyboard.press('Escape');
    const count = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
    expect(count).toBe(0);
  });

  test('eraser removes items under the cursor', async ({ page }) => {
    await freshApp(page);
    // place two strokes via API at known world positions
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addStroke([{ x: -200, y: 0 }, { x: -100, y: 0 }]); // left
      A.addStroke([{ x: 100, y: 0 }, { x: 200, y: 0 }]);   // right
    });
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(2);
    // figure out the screen position of the right stroke midpoint and erase there
    const pt = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(150, 0));
    await page.locator('.tool[data-tool="eraser"]').click();
    await page.mouse.move(pt.x, pt.y);
    await page.mouse.down();
    await page.mouse.move(pt.x + 2, pt.y, { steps: 2 });
    await page.mouse.up();
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    // the surviving one should be the left stroke
    expect(items[0].points[0].x).toBeLessThan(0);
  });

  test('select + drag moves an item', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(-50, -50, 100, 100, { fill: '#5b8cff' }));
    const before = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    await page.locator('.tool[data-tool="select"]').click();
    const center = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(0, 0));
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 150, center.y + 80, { steps: 6 });
    await page.mouse.up();
    const after = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(after.x).toBeGreaterThan(before.x + 50);
    expect(after.y).toBeGreaterThan(before.y + 20);
  });

  test('marquee selects fully-contained items', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addRect(-300, -100, 40, 40);  // inside marquee
      A.addRect(-260, -60, 40, 40);   // inside marquee
      A.addRect(2000, 2000, 40, 40);  // far away, outside
    });
    await page.locator('.tool[data-tool="select"]').click();
    // marquee over the two near rects (origin area)
    const tl = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(-340, -140));
    const br = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(-180, 20));
    await page.mouse.move(tl.x, tl.y);
    await page.mouse.down();
    await page.mouse.move(br.x, br.y, { steps: 6 });
    await page.mouse.up();
    const sel = await page.evaluate(() => window.__INFINIZOOM__.selectedCount());
    expect(sel).toBe(2);
  });

  test('style changes apply to the current selection', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: 0, y: 0 }, { x: 100, y: 0 }], { color: '#ffffff' }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ color: '#ff5b6e', width: 12 }));
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.color.toLowerCase()).toBe('#ff5b6e');
    expect(it.width).toBe(12);
  });

  test('no errors across a multi-tool drawing session', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await mouseStroke(page, [[300, 300], [350, 360], [420, 320]], 2);
    await page.locator('.tool[data-tool="line"]').click();
    await dragShape(page, 400, 200, 800, 260);
    await page.locator('.tool[data-tool="rect"]').click();
    await dragShape(page, 500, 400, 700, 520);
    await page.locator('.tool[data-tool="ellipse"]').click();
    await dragShape(page, 850, 300, 1000, 420);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(4);
    expect(errors).toEqual([]);
  });
});
