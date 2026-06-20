import { test, expect } from '@playwright/test';
import { freshApp } from './_helpers.js';

test.describe('SVG export', () => {
  test('produces well-formed SVG that the browser can parse', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addStroke([{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], { color: '#ff5b6e', width: 4 });
      A.addRect(120, 0, 80, 60, { color: '#69db7c', fill: '#38d9a9' });
      A.addEllipse(0, 120, 90, 60, { color: '#4dabf7' });
      A.addArrow({ x: 220, y: 0 }, { x: 320, y: 80 }, { color: '#ffd43b', width: 3 });
      A.addPolygon(220, 120, 80, 80, { star: true, sides: 5, color: '#b197fc', fill: '#b197fc' });
      A.addText(0, 220, 'svg!', { size: 24, color: '#e8e8ef' });
    });
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    // contains each expected element kind
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="');
    expect(svg).toMatch(/<polyline/);
    expect(svg).toMatch(/<rect/);
    expect(svg).toMatch(/<ellipse/);
    expect(svg).toMatch(/<polygon/);
    expect(svg).toContain('svg!');

    // it must actually parse as XML with no parser errors
    const parseInfo = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const err = doc.querySelector('parsererror');
      return {
        ok: !err,
        root: doc.documentElement.tagName,
        shapeCount: doc.querySelectorAll('polyline, rect, ellipse, polygon, text').length,
      };
    }, svg);
    expect(parseInfo.ok).toBe(true);
    expect(parseInfo.root).toBe('svg');
    // 6 items, but arrow emits a polyline + polygon and rect (bg) adds one rect
    expect(parseInfo.shapeCount).toBeGreaterThanOrEqual(7);
  });

  test('viewBox frames the content bounds', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addRect(100, 200, 300, 400, { color: '#fff' }));
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG({ pad: 0 }));
    const m = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg);
    expect(m).not.toBeNull();
    const [, x, y, w, h] = m.map(Number);
    // rect spans (100,200)-(400,600); allow tiny stroke padding
    expect(x).toBeLessThanOrEqual(101);
    expect(y).toBeLessThanOrEqual(201);
    expect(w).toBeGreaterThanOrEqual(299);
    expect(h).toBeGreaterThanOrEqual(399);
  });

  test('escapes special characters in text', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.addText(0, 0, 'a < b & c > d', { size: 20 }));
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    expect(svg).toContain('a &lt; b &amp; c &gt; d');
    expect(svg).not.toContain('a < b & c > d');
  });

  test('empty document still yields a valid SVG', async ({ page }) => {
    await freshApp(page);
    const svg = await page.evaluate(() => window.__INFINIZOOM__.toSVG());
    const ok = await page.evaluate((svg) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return !doc.querySelector('parsererror') && doc.documentElement.tagName === 'svg';
    }, svg);
    expect(ok).toBe(true);
  });
});
