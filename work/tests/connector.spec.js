import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

// Two filled rects: A on the left (centre -150,0), B on the right (centre 150,0).
async function twoBoxes(page) {
  await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
  const a = await page.evaluate(() => window.__INFINIZOOM__.addRect(-200, -50, 100, 100, { fill: '#69db7c' }));
  const b = await page.evaluate(() => window.__INFINIZOOM__.addRect(100, -50, 100, 100, { fill: '#4dabf7' }));
  return { a, b };
}

test.describe('connectors', () => {
  test('addConnector links two items; self/invalid links are rejected', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    const id = await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    expect(id).toBeTruthy();
    const conn = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(conn.type).toBe('connector');
    expect(conn.from).toBe(a); expect(conn.to).toBe(b);
    // rejects a self-link and a link to a missing item
    expect(await page.evaluate(({ a }) => window.__INFINIZOOM__.addConnector(a, a), { a })).toBeNull();
    expect(await page.evaluate(({ a }) => window.__INFINIZOOM__.addConnector(a, 'nope'), { a })).toBeNull();
    expect(errors).toEqual([]);
  });

  test('endpoints resolve to the edge between the two items', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    const id = await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    const conn = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    // A's right edge is ~ -100, B's left edge is ~ +100; the segment spans between
    expect(conn.ax).toBeGreaterThan(-150); expect(conn.ax).toBeLessThan(0);
    expect(conn.bx).toBeGreaterThan(0); expect(conn.bx).toBeLessThan(150);
    expect(conn.ay).toBeCloseTo(0, 0); expect(conn.by).toBeCloseTo(0, 0);
  });

  test('a connector tracks its items as they move', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    const id = await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    const before = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).ax, id);
    // shove box A to the right, then re-resolve
    await page.evaluate((a) => { window.app.scene.byId(a).x += 60; window.__INFINIZOOM__.resolveConnectors(); }, a);
    const after = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id).ax, id);
    expect(after).toBeGreaterThan(before);
  });

  test('the connector segment is hit-testable', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    const id = await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    // (0,0) lies on the connector, in the gap between the two boxes
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(0, 0, 3))).toBe(id);
  });

  test('deleting an endpoint item removes the connector too (one undo step)', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(3);
    await page.evaluate((a) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([a]); }, a);
    await page.evaluate(() => window.__INFINIZOOM__.deleteSelection());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1); // B only
    // undo brings back both the box and its connector
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(3);
  });

  test('connector renders without error and counts as a drawn item', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    expect(await page.evaluate(() => window.__INFINIZOOM__.drawnCount())).toBe(3);
    expect(errors).toEqual([]);
  });

  test('connector survives a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const conn = await page.evaluate(() => window.__INFINIZOOM__.getItems().find(i => i.type === 'connector'));
    expect(conn.from).toBe(a); expect(conn.to).toBe(b);
  });

  test('SVG export includes the connector', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b, { arrow: true }), { a, b });
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    // arrow connectors export a shaft polyline + a filled arrowhead polygon
    expect(svg).toContain('<polyline');
    expect(svg).toContain('<polygon');
  });

  test('connector tool: dragging from one box to another creates a connector', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    await page.evaluate(() => window.__INFINIZOOM__.setTool('connector'));
    // A centre (-150,0)→screen(490,360); B centre (150,0)→screen(790,360)
    await page.mouse.move(490, 360);
    await page.mouse.down();
    await page.mouse.move(790, 360, { steps: 6 });
    await page.mouse.up();
    const conn = await page.evaluate(() => window.__INFINIZOOM__.getItems().find(i => i.type === 'connector'));
    expect(conn).toBeTruthy();
    expect(conn.from).toBe(a); expect(conn.to).toBe(b);
  });

  test('copy/paste of a connected pair re-links the copies', async ({ page }) => {
    await freshApp(page);
    const { a, b } = await twoBoxes(page);
    await page.evaluate(({ a, b }) => window.__INFINIZOOM__.addConnector(a, b), { a, b });
    await page.evaluate(() => { window.__INFINIZOOM__.selectAll(); window.__INFINIZOOM__.copy(); window.__INFINIZOOM__.paste(); });
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(6);
    const pasted = items.filter(i => i.id.startsWith('pst_'));
    const pastedConn = pasted.find(i => i.type === 'connector');
    const pastedRectIds = pasted.filter(i => i.type === 'rect').map(i => i.id);
    expect(pastedConn).toBeTruthy();
    // the pasted connector points at the pasted boxes, not the originals
    expect(pastedRectIds).toContain(pastedConn.from);
    expect(pastedRectIds).toContain(pastedConn.to);
    expect(pastedConn.from).not.toBe(a);
  });
});
