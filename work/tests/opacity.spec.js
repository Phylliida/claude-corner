import { test, expect } from '@playwright/test';
import { freshApp } from './_helpers.js';

/** Read the RGBA of the centre pixel of the main canvas. */
async function centerPixel(page) {
  return page.evaluate(() => {
    window.app.render();
    const c = document.getElementById('canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  });
}

test.describe('opacity', () => {
  test('new items inherit the current opacity', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ opacity: 0.5 }));
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 40, 40, { opacity: 0.5 }));
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.opacity).toBeCloseTo(0.5, 2);
  });

  test('opacity 1 carries no opacity field (kept tidy)', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 40, 40, { opacity: 1 }));
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.opacity).toBeUndefined();
  });

  test('setStyle opacity applies to selection and is removable', async ({ page }) => {
    await freshApp(page);
    const id = await page.evaluate(() => window.__INFINIZOOM__.addRect(0, 0, 40, 40, { fill: '#fff' }));
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ opacity: 0.4 }));
    let it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.opacity).toBeCloseTo(0.4, 2);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ opacity: 1 }));
    it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.opacity).toBeUndefined();
  });

  test('opacity survives a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addEllipse(0, 0, 50, 50, { opacity: 0.25 }));
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const it = await page.evaluate(() => window.__INFINIZOOM__.getItems()[0]);
    expect(it.opacity).toBeCloseTo(0.25, 2);
  });

  test('lower opacity renders a visibly dimmer fill', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    // big red square covering the centre at full opacity
    await page.evaluate(() => window.__INFINIZOOM__.addRect(-400, -300, 800, 600, { color: '#ff0000', fill: '#ff0000', opacity: 1 }));
    const opaque = await centerPixel(page);
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate(() => window.__INFINIZOOM__.addRect(-400, -300, 800, 600, { color: '#ff0000', fill: '#ff0000', opacity: 0.25 }));
    const faint = await centerPixel(page);
    // red channel should be much lower when translucent over the dark background
    expect(opaque[0]).toBeGreaterThan(200);
    expect(faint[0]).toBeLessThan(opaque[0] - 60);
  });
});
