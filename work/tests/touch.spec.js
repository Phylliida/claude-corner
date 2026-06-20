import { test, expect } from '@playwright/test';
import { freshApp, captureErrors } from './_helpers.js';

/**
 * Drive the canvas with synthetic touch PointerEvents to exercise the
 * two-finger pinch path (which real mouse tests can't reach).
 */
async function dispatchPointer(page, type, id, x, y) {
  await page.evaluate(({ type, id, x, y }) => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const ev = new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', isPrimary: id === 1,
      clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true,
    });
    c.dispatchEvent(ev);
  }, { type, id, x, y });
}

test.describe('touch / pinch', () => {
  test('two-finger pinch outward zooms in', async ({ page }) => {
    const errors = captureErrors(page);
    await freshApp(page);
    const before = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);

    // two fingers start close together around the centre
    await dispatchPointer(page, 'pointerdown', 1, 600, 400);
    await dispatchPointer(page, 'pointerdown', 2, 680, 400);
    // spread them apart over several steps
    for (let i = 1; i <= 5; i++) {
      await dispatchPointer(page, 'pointermove', 1, 600 - i * 40, 400);
      await dispatchPointer(page, 'pointermove', 2, 680 + i * 40, 400);
    }
    await dispatchPointer(page, 'pointerup', 1, 400, 400);
    await dispatchPointer(page, 'pointerup', 2, 880, 400);

    const after = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    expect(after).toBeGreaterThan(before * 1.5);
    expect(errors).toEqual([]);
  });

  test('two-finger pinch inward zooms out', async ({ page }) => {
    await freshApp(page);
    await page.evaluate(() => window.__INFINIZOOM__.setCamera({ x: 0, y: 0, scale: 4 }));
    const before = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);

    await dispatchPointer(page, 'pointerdown', 1, 300, 400);
    await dispatchPointer(page, 'pointerdown', 2, 900, 400);
    for (let i = 1; i <= 5; i++) {
      await dispatchPointer(page, 'pointermove', 1, 300 + i * 50, 400);
      await dispatchPointer(page, 'pointermove', 2, 900 - i * 50, 400);
    }
    await dispatchPointer(page, 'pointerup', 1, 550, 400);
    await dispatchPointer(page, 'pointerup', 2, 650, 400);

    const after = await page.evaluate(() => window.__INFINIZOOM__.getCamera().scale);
    expect(after).toBeLessThan(before);
  });

  test('a single touch with the pen tool still draws a stroke', async ({ page }) => {
    await freshApp(page);
    await dispatchPointer(page, 'pointerdown', 1, 400, 300);
    await dispatchPointer(page, 'pointermove', 1, 500, 380);
    await dispatchPointer(page, 'pointermove', 1, 620, 320);
    await dispatchPointer(page, 'pointerup', 1, 620, 320);
    const items = await page.evaluate(() => window.__INFINIZOOM__.getItems());
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('stroke');
  });
});
