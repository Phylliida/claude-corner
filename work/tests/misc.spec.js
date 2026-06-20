import { test, expect } from '@playwright/test';
import { freshApp, captureErrors, countInk } from './_helpers.js';

test.describe('eyedropper', () => {
  test('eyedrop() samples the colour of the item under a point', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: -50, y: 0 }, { x: 50, y: 0 }], { color: '#ff5b6e', width: 10 }));
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ color: '#ffffff' }));
    const picked = await page.evaluate(() => window.__INFINIZOOM__.eyedrop(0, 0));
    expect(picked.toLowerCase()).toBe('#ff5b6e');
    expect((await page.evaluate(() => window.__INFINIZOOM__.getStyle())).color.toLowerCase()).toBe('#ff5b6e');
  });

  test('Alt+click samples colour with the mouse', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    await page.evaluate(() => window.__INFINIZOOM__.addRect(-60, -60, 120, 120, { color: '#69db7c', fill: '#69db7c' }));
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ color: '#ffffff' }));
    const c = await page.evaluate(() => window.__INFINIZOOM__.worldToScreen(0, 0));
    await page.keyboard.down('Alt');
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up('Alt');
    const color = (await page.evaluate(() => window.__INFINIZOOM__.getStyle())).color.toLowerCase();
    expect(color).toBe('#69db7c');
    // alt-click must NOT create a new item
    expect(await page.evaluate(() => window.__INFINIZOOM__.itemCount())).toBe(1);
  });

  test('eyedrop on empty space returns null and keeps the colour', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setStyle({ color: '#abcdef' }));
    const picked = await page.evaluate(() => window.__INFINIZOOM__.eyedrop(99999, 99999));
    expect(picked).toBeNull();
    expect((await page.evaluate(() => window.__INFINIZOOM__.getStyle())).color).toBe('#abcdef');
  });
});

test.describe('grid styles', () => {
  test('default grid style is lines and paints reference pixels', async ({ page }) => {
    await freshApp(page);
    expect(await page.evaluate(() => window.app.renderer.gridStyle)).toBe('lines');
    // empty doc, grid ON -> the grid itself produces some ink
    expect(await countInk(page, { grid: true })).toBeGreaterThan(0);
  });

  test('switching to the dot grid updates the renderer and still paints', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.selectOption('#gridStyle', 'dots');
    expect(await page.evaluate(() => window.app.renderer.gridStyle)).toBe('dots');
    expect(await countInk(page, { grid: true })).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('turning the grid off removes all grid ink on an empty canvas', async ({ page }) => {
    await freshApp(page);
    await page.locator('#gridToggle').uncheck();
    expect(await page.evaluate(() => window.app.renderer.showGrid)).toBe(false);
    // grid:true here means "render with whatever showGrid currently is" via countInk's flag,
    // so force a plain render and sample: empty + grid off -> ~0 ink
    const ink = await page.evaluate(() => {
      window.app.render();
      const c = document.getElementById('canvas');
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - 14) + Math.abs(d[i + 1] - 15) + Math.abs(d[i + 2] - 19) > 24) n++;
      }
      return n;
    });
    expect(ink).toBe(0);
  });
});

test.describe('rendering determinism', () => {
  // Compare two full-canvas frames produced by `mutate` (a string of JS run in
  // the page between grabs) and return the fraction of pixels that differ.
  // A tiny tolerance absorbs SwiftShader sub-pixel jitter while still catching
  // any genuine rendering change (a different scene differs in many percent).
  async function diffFraction(page, mutateSrc) {
    return page.evaluate((src) => {
      const A = window.__INFINIZOOM__;
      const mutate = new Function('A', src);
      const grab = () => {
        A.render();
        const c = document.getElementById('canvas');
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      };
      mutate(A); const a = grab();
      mutate(A); const b = grab();
      let diff = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) diff++;
      }
      return diff / (a.length / 4);
    }, mutateSrc);
  }
  const TOL = 0.002; // < 0.2% of pixels may jitter

  test('the same generator yields a near-identical render twice', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const frac = await diffFraction(page, "A.generate('spiral', { count: 60 }, { clear: true, fit: true });");
    console.log(`    spiral re-render diff: ${(frac * 100).toFixed(4)}%`);
    expect(frac).toBeLessThan(TOL);
    expect(errors).toEqual([]);
  });

  test('loading identical JSON twice renders identically', async ({ page }) => {
    await freshApp(page);
    const frac = await diffFraction(page, `
      A.loadJSON({ camera: { x: 0, y: 0, scale: 1 }, doc: { version: 2, items: [
        { id: 'a', type: 'rect', x: -100, y: -80, w: 200, h: 160, color: '#5b8cff', width: 4, fill: '#b197fc' },
        { id: 'b', type: 'ellipse', x: -40, y: -40, w: 80, h: 80, color: '#ffd43b', width: 3, fill: null },
      ] } });`);
    console.log(`    json re-render diff: ${(frac * 100).toFixed(4)}%`);
    expect(frac).toBeLessThan(TOL);
  });

  test('a round-tripped document renders the same as the original', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.generate('sierpinski', { depth: 5 }, { clear: true, fit: true }));
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 1 }));
    const frac = await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      const grab = () => { A.render(); const c = document.getElementById('canvas'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
      const before = grab();
      const json = A.toJSON();
      A.loadJSON({ doc: json, camera: { x: 0, y: 0, scale: 1 } });
      const after = grab();
      let diff = 0;
      for (let i = 0; i < before.length; i += 4) {
        if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]) > 12) diff++;
      }
      return diff / (before.length / 4);
    });
    console.log(`    round-trip diff: ${(frac * 100).toFixed(4)}%`);
    expect(frac).toBeLessThan(TOL);
  });
});
