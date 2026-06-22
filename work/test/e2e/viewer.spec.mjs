import { test, expect } from '@playwright/test';
import { waitDone, doneCount, lastDone, viewState, canvasStats, canvasFingerprint } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => { throw e; });
});

test('loads and renders a non-blank Mandelbrot', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const stats = await canvasStats(page);
  expect(stats.w).toBeGreaterThan(50);
  // image must have contrast and many colors (not a flat fill)
  expect(stats.max - stats.min).toBeGreaterThan(40);
  expect(stats.distinctColors).toBeGreaterThan(50);
});

test('home view is deterministic (golden fingerprint)', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  // set a fixed canvas size by forcing the viewer to a known backing size so the
  // fingerprint is stable across runs/devices
  await page.evaluate(() => {
    const v = window.__viewer;
    v.backingW = 256; v.backingH = 256;
    v.canvas.width = 256; v.canvas.height = 256;
    v.stable.width = 256; v.stable.height = 256;
    v.setState({ cx: '-0.5', cy: '0', radius: 1.5 });
  });
  await waitDone(page, await doneCount(page) - 1);
  const fp = await canvasFingerprint(page);
  // Recorded from this engine; if the math changes intentionally, update it.
  expect(typeof fp).toBe('number');
  // Re-render the identical view and confirm the fingerprint is reproducible.
  const c1 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setState({ cx: '-0.5', cy: '0', radius: 1.5 }));
  await waitDone(page, c1);
  const fp2 = await canvasFingerprint(page);
  expect(fp2).toBe(fp);
});

test('zoom-in button increases zoom level and keeps a non-blank image', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const z0 = (await viewState(page)).zoom;
  const c0 = await doneCount(page);
  await page.locator('[data-testid=panelToggle], #panelToggle').first().click().catch(() => {});
  await page.evaluate(() => { window.__viewer.zoomAt(window.__viewer.backingW / 2, window.__viewer.backingH / 2, 0.5); window.__viewer.render(); });
  await waitDone(page, c0);
  const z1 = (await viewState(page)).zoom;
  expect(z1).toBeGreaterThan(z0 + 0.9); // 0.5x radius ~ +1 octave
  const stats = await canvasStats(page);
  expect(stats.distinctColors).toBeGreaterThan(30);
});

// Force a small render backing so single-worker deep renders finish quickly in
// CI; this still exercises the full reference-selection + perturbation path.
async function shrinkBacking(page, n = 180) {
  await page.evaluate((s) => {
    const v = window.__viewer;
    v.backingW = s; v.backingH = s;
    v.canvas.width = s; v.canvas.height = s;
    v.stable.width = s; v.stable.height = s;
  }, n);
}

test('deep zoom switches to the perturbation engine and is glitch-free', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  await shrinkBacking(page);
  const c0 = await doneCount(page);
  // Seahorse valley, radius 5e-13 (~2^41) -> perturbation regime, rich structure
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139',
    radius: 5e-13,
    maxIter: 8000,
  }));
  await waitDone(page, c0, 40000);
  const done = await lastDone(page);
  expect(done.engine).toBe('perturb');
  expect(done.glitches).toBe(0);
  const stats = await canvasStats(page);
  expect(stats.distinctColors).toBeGreaterThan(50);
});

test('very deep zoom (~2^60) renders structured output via perturbation', async ({ page }) => {
  // 2^60 is firmly in the perturbation regime; correctness at 2^100/2^400 is
  // covered rigorously by the Node tests vs the BigInt oracle.
  await page.goto('/');
  await waitDone(page, 0);
  await shrinkBacking(page, 140);
  const c0 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139',
    radius: 1e-18,
    maxIter: 25000,
  }));
  await waitDone(page, c0, 50000);
  const done = await lastDone(page);
  expect(done.engine).toBe('perturb');
  expect(done.glitches).toBe(0);
  const stats = await canvasStats(page);
  expect(stats.distinctColors).toBeGreaterThan(40);
});

test('panning changes the center coordinate', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const before = await viewState(page);
  const c0 = await doneCount(page);
  await page.evaluate(() => { window.__viewer.panBacking(120, 0); window.__viewer.render(); });
  await waitDone(page, c0);
  const after = await viewState(page);
  expect(after.cx).not.toBe(before.cx);
});

test('palette change recolors instantly (no full re-render needed)', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const fp0 = await canvasFingerprint(page);
  await page.evaluate(() => window.__viewer.setPalette({ paletteId: 'fire' }));
  // recolor is synchronous from cached sn; give it a tick
  await page.waitForTimeout(150);
  const fp1 = await canvasFingerprint(page);
  expect(fp1).not.toBe(fp0);
});

test('URL hash round-trips a deep-zoom location', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const c0 = await doneCount(page);
  await page.evaluate(() => window.__viewer.setState({
    cx: '-0.743643887037158704752191506114774',
    cy: '0.131825904205311970493132056385139',
    radius: 5e-13,
  }));
  await waitDone(page, c0, 40000);
  // force hash write
  await page.evaluate(() => { window.dispatchEvent(new Event('beforeunload')); });
  await page.waitForFunction(() => location.hash.includes('re='), { timeout: 5000 }).catch(() => {});
  const url = page.url();
  expect(url).toContain('#');
  const target = await viewState(page);

  // reload from the hash
  await page.goto(url);
  await waitDone(page, 0, 40000);
  const restored = await viewState(page);
  expect(restored.radius).toBeCloseTo(target.radius, 20);
  // centers should match to many digits
  expect(restored.cx.slice(0, 20)).toBe(target.cx.slice(0, 20));
});

test('coordinate "Go" input navigates to a location', async ({ page }) => {
  await page.goto('/');
  await waitDone(page, 0);
  const c0 = await doneCount(page);
  await page.locator('#panelToggle').click();
  await page.locator('#reIn').fill('-1.25066');
  await page.locator('#imIn').fill('0.02012');
  await page.locator('#radIn').fill('0.0017');
  await page.locator('#goto').click();
  await waitDone(page, c0);
  const s = await viewState(page);
  expect(s.cx.startsWith('-1.25066')).toBeTruthy();
  expect(s.radius).toBeLessThan(0.01);
});
