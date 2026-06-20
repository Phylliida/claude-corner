import { test, expect } from '@playwright/test';
import { freshApp, waitReady, captureErrors, countInk, BASE_URL } from './_helpers.js';

// Build a small solid-colour PNG data URL inside the page (valid bitmap, tiny).
async function makeImageSrc(page, color = '#ff5b6e', size = 8) {
  return page.evaluate(({ color, size }) => {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const x = c.getContext('2d');
    x.fillStyle = color; x.fillRect(0, 0, size, size);
    return c.toDataURL('image/png');
  }, { color, size });
}

// Wait until every image item's bitmap has decoded (deterministic render).
const waitImages = (page) =>
  page.waitForFunction(() => window.__INFINIZOOM__.imagesPending() === 0, null, { timeout: 6000 });

test.describe('image items', () => {
  test('addImage creates an image item with the expected fields', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const src = await makeImageSrc(page);
    const id = await page.evaluate((src) => window.__INFINIZOOM__.addImage(-100, -50, 200, 100, src), src);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    const it = items[0];
    expect(it.type).toBe('image');
    expect(it.id).toBe(id);
    expect(it.x).toBe(-100); expect(it.y).toBe(-50);
    expect(it.w).toBe(200); expect(it.h).toBe(100);
    expect(it.src).toMatch(/^data:image\/png;base64,/);
    expect(errors).toEqual([]);
  });

  test('an image bitmap decodes and paints its pixels onto the canvas', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const src = await makeImageSrc(page, '#69db7c');
    await page.evaluate((src) => window.__INFINIZOOM__.addImage(-150, -150, 300, 300, src), src);
    await waitImages(page);
    const ink = await countInk(page, { grid: false });
    expect(ink).toBeGreaterThan(2000); // a 300x300 solid fill is a lot of ink
  });

  test('pendingImages resolves to 0 even for a broken source', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addImage(0, 0, 100, 100, 'data:image/png;base64,not-a-real-image'));
    // a broken decode must still settle so callers do not hang forever
    await waitImages(page);
    expect(await page.evaluate(() => window.__INFINIZOOM__.imagesPending())).toBe(0);
  });

  test('image hit-tests as a solid rectangle (interior hit, miss outside)', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const src = await makeImageSrc(page);
    const id = await page.evaluate((src) => window.__INFINIZOOM__.addImage(-100, -100, 200, 200, src), src);
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(0, 0, 2))).toBe(id);      // dead centre
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(90, 90, 2))).toBe(id);     // inside corner
    expect(await page.evaluate(() => window.__INFINIZOOM__.pick(400, 400, 2))).toBe(null); // far outside
  });

  test('select + drag moves an image', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const src = await makeImageSrc(page);
    const id = await page.evaluate((src) => window.__INFINIZOOM__.addImage(-100, -100, 200, 200, src), src);
    await page.evaluate((id) => { window.__INFINIZOOM__.setTool('select'); window.__INFINIZOOM__.select([id]); }, id);
    // screen centre (640,400) maps to world (0,0) at scale 1 — drag right+down
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(740, 460, { steps: 5 });
    await page.mouse.up();
    const it = await page.evaluate((id) => window.__INFINIZOOM__.getItems().find(i => i.id === id), id);
    expect(it.x).toBeGreaterThan(-60);  // moved ~+100 in x (was -100)
    expect(it.y).toBeGreaterThan(-60);
    expect(it.w).toBe(200);             // size unchanged
  });

  test('image survives a JSON round-trip', async ({ page }) => {
    await freshApp(page);
    const src = await makeImageSrc(page, '#4dabf7');
    await page.evaluate((src) => window.__INFINIZOOM__.addImage(5, 6, 70, 40, src), src);
    const json = await page.evaluate(() => window.__INFINIZOOM__.toJSON());
    await page.evaluate(() => window.__INFINIZOOM__.clear());
    await page.evaluate((j) => window.__INFINIZOOM__.loadJSON(j), json);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('image');
    expect(items[0].x).toBe(5); expect(items[0].w).toBe(70);
    expect(items[0].src).toBe(src);
  });

  test('SVG export embeds the image as an <image> element', async ({ page }) => {
    await freshApp(page);
    const src = await makeImageSrc(page);
    await page.evaluate((src) => window.__INFINIZOOM__.addImage(0, 0, 100, 80, src), src);
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    expect(svg).toContain('<image');
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).toContain('width="100"');
  });

  test('undo removes a placed image, redo restores it', async ({ page }) => {
    await freshApp(page);
    const src = await makeImageSrc(page);
    await page.evaluate((src) => window.__INFINIZOOM__.addImage(0, 0, 50, 50, src), src);
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
    await page.evaluate(() => window.__INFINIZOOM__.undo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(0);
    await page.evaluate(() => window.__INFINIZOOM__.redo());
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
    expect(await page.evaluate(() => window.__INFINIZOOM__.getItems()[0].type)).toBe('image');
  });

  test('an image obeys the LOD system (hidden when zoomed past its band)', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const src = await makeImageSrc(page);
    const id = await page.evaluate((src) => window.__INFINIZOOM__.addImage(-50, -50, 100, 100, src), src);
    await page.evaluate((id) => window.__INFINIZOOM__.select([id]), id);
    // "near": only visible when zoomed IN past the current scale (1)
    await page.evaluate(() => window.__INFINIZOOM__.setLOD('near'));
    expect(await page.evaluate(() => window.__INFINIZOOM__.visibleCount())).toBe(1); // still at scale 1
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 0.5 }));
    expect(await page.evaluate(() => window.__INFINIZOOM__.visibleCount())).toBe(0); // zoomed out → hidden
    expect(await page.evaluate(() => window.__INFINIZOOM__.drawnCount())).toBe(0);
  });

  test('placed image survives a page reload', async ({ page }) => {
    await freshApp(page);
    const src = await makeImageSrc(page);
    await page.evaluate((src) => window.__INFINIZOOM__.addImage(0, 0, 40, 40, src), src);
    await page.waitForTimeout(600); // let the debounced autosave flush
    await page.reload();
    await waitReady(page);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('image');
  });

  test('placeImage drops a centred, natively-sized image at a screen point', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const src = await makeImageSrc(page, '#b197fc', 16); // 16x16 native
    // no screen point → defaults to the view centre, which is world (0,0) here
    await page.evaluate((src) => window.__INFINIZOOM__.placeImage(src), src);
    await page.waitForFunction(() => window.__INFINIZOOM__.itemCount() === 1, null, { timeout: 6000 });
    const it = (await page.evaluate(() => window.__INFINIZOOM__.getItems()))[0];
    expect(it.type).toBe('image');
    // 16px native at scale 1 → 16 world units, centred on world (0,0) → x≈-8
    expect(it.w).toBeCloseTo(16, 1);
    expect(it.h).toBeCloseTo(16, 1);
    expect(it.x).toBeCloseTo(-8, 1);
    expect(it.y).toBeCloseTo(-8, 1);
  });

  test('a file dropped on the canvas becomes an image item', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const src = await makeImageSrc(page, '#ffd43b');
    // Synthesize a real drop with a DataTransfer carrying a PNG File.
    await page.evaluate(async (src) => {
      const blob = await (await fetch(src)).blob();
      const file = new File([blob], 'drop.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const canvas = document.getElementById('canvas');
      const opts = { bubbles: true, cancelable: true, clientX: 640, clientY: 400 };
      canvas.dispatchEvent(new DragEvent('dragover', { ...opts, dataTransfer: dt }));
      canvas.dispatchEvent(new DragEvent('drop', { ...opts, dataTransfer: dt }));
    }, src);
    // the drop reads the file async, then decodes natural size async
    await page.waitForFunction(() => window.__INFINIZOOM__.itemCount() === 1, null, { timeout: 6000 });
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items[0].type).toBe('image');
    expect(errors).toEqual([]);
  });
});
