import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

test.describe('camera / infinite zoom', () => {
  test('wheel scroll changes zoom level', async ({ page }) => {
    await freshApp(page);
    const before = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, -600); // zoom in
    const after = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    expect(after).toBeGreaterThan(before);
    await page.mouse.wheel(0, 1200); // zoom out past start
    const last = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    expect(last).toBeLessThan(after);
  });

  test('zoom is anchored at the cursor — world point under cursor stays fixed', async ({ page }) => {
    await freshApp(page);
    const sx = 900, sy = 250;
    const worldBefore = await page.evaluate(([x, y]) => window.__INFINIZOOM__.screenToWorld(x, y), [sx, sy]);
    await page.evaluate(([f, x, y]) => window.__INFINIZOOM__.zoomBy(f, x, y), [8, sx, sy]);
    const worldAfter = await page.evaluate(([x, y]) => window.__INFINIZOOM__.screenToWorld(x, y), [sx, sy]);
    expect(Math.abs(worldAfter.x - worldBefore.x)).toBeLessThan(1e-6);
    expect(Math.abs(worldAfter.y - worldBefore.y)).toBeLessThan(1e-6);
  });

  test('deep zoom (1e9x) keeps round-trip world<->screen precision', async ({ page }) => {
    await freshApp(page);
    // place a marker far from origin then zoom in massively centered on it
    const target = { x: 1234.56789, y: -987.6543 };
    await page.evaluate((t) => {
      const A = window.__INFINIZOOM__;
      A.setCamera({ x: t.x, y: t.y, scale: 1e9 });
    }, target);
    const result = await page.evaluate((t) => {
      const A = window.__INFINIZOOM__;
      const s = A.worldToScreen(t.x, t.y);
      const back = A.screenToWorld(s.x, s.y);
      return { back, scale: A.getCamera().scale };
    }, target);
    expect(result.scale).toBeCloseTo(1e9, 0);
    // world coord recovered to sub-micro precision even at billion-x zoom
    expect(Math.abs(result.back.x - target.x)).toBeLessThan(1e-3);
    expect(Math.abs(result.back.y - target.y)).toBeLessThan(1e-3);
  });

  test('extreme zoom in and out is clamped, never NaN/Infinity', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    await page.mouse.move(640, 400);
    for (let i = 0; i < 60; i++) await page.mouse.wheel(0, -400);
    let cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(Number.isFinite(cam.scale)).toBe(true);
    expect(cam.scale).toBeLessThanOrEqual(1e12 + 1);
    for (let i = 0; i < 140; i++) await page.mouse.wheel(0, 400);
    cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(Number.isFinite(cam.scale)).toBe(true);
    expect(cam.scale).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('panning with the pan tool moves the camera', async ({ page }) => {
    await freshApp(page);
    await page.locator('.tool[data-tool="pan"]').click();
    const before = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(440, 300, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    // dragging left/up moves the camera right/down in world space
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
  });

  test('zoom to fit frames all content', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => {
      const A = window.__INFINIZOOM__;
      A.addRect(-500, -500, 100, 100);
      A.addRect(800, 600, 120, 120);
    });
    await page.evaluate(() => window.__INFINIZOOM__.fitAll());
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    const bounds = await page.evaluate(() => window.__INFINIZOOM__.bounds());
    // camera should be centered roughly on the content bbox center
    const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
    expect(Math.abs(cam.x - cx)).toBeLessThan(1);
    expect(Math.abs(cam.y - cy)).toBeLessThan(1);
    // and all content corners should be on-screen
    const onScreen = await page.evaluate((b) => {
      const A = window.__INFINIZOOM__;
      const corners = [[b.minX, b.minY], [b.maxX, b.maxY]];
      return corners.map(([x, y]) => A.worldToScreen(x, y));
    }, bounds);
    for (const p of onScreen) {
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(1281);
      expect(p.y).toBeGreaterThanOrEqual(-1);
      expect(p.y).toBeLessThanOrEqual(801);
    }
  });

  test('reset view returns to origin at 100%', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 999, y: -333, scale: 42 }));
    await page.keyboard.press('0');
    const cam = await page.evaluate(() => window.__INFINIZOOM__.getCamera());
    expect(cam).toMatchObject({ x: 0, y: 0, scale: 1 });
  });
});
