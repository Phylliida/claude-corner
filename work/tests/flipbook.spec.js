// Stop-motion flipbook: each item carries an optional `frame` (page) and the
// app shows/edits one page at a time, with onion-skin ghosts of neighbours.
import { test, expect } from '@playwright/test';
import { freshApp, waitReady, captureErrors } from './_helpers.js';

const A = () => window.__INFINIZOOM__;

test.describe('flipbook / stop-motion animation', () => {
  test.beforeEach(async ({ page }) => { await freshApp(page); });

  test('flipbook is off by default and drawing tags no frame', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      const fb = a.flipbook();
      const id = a.addStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
      return { on: fb.on, frame: a.getItems().find(i => i.id === id).frame };
    });
    expect(r.on).toBe(false);
    expect(r.frame).toBeUndefined(); // no `frame` field on a plain-canvas drawing
  });

  test('turning flipbook on snaps page count to what is drawn', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.addStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]); // page 0
      a.setFlipbook(true);
      return a.flipbook();
    });
    expect(r.on).toBe(true);
    expect(r.count).toBe(1);
    expect(r.current).toBe(0);
  });

  test('each new page is its own frame; only the current page is live', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.setOnion(0); // disable ghosts so drawnCount = current page only
      const id0 = a.addStroke([{ x: -50, y: 0 }, { x: -40, y: 0 }]);   // page 0
      a.addFrame();                                                    // → page 1
      const id1 = a.addStroke([{ x: 40, y: 0 }, { x: 50, y: 0 }]);     // page 1
      const onP1 = a.drawnCount();
      a.setFrame(0);
      const onP0 = a.drawnCount();
      return {
        count: a.frameCount(),
        f0: a.frameOf(id0), f1: a.frameOf(id1),
        onP0, onP1,
      };
    });
    expect(r.count).toBe(2);
    expect(r.f0).toBe(0);
    expect(r.f1).toBe(1);
    expect(r.onP0).toBe(1); // only page-0 stroke draws on page 0
    expect(r.onP1).toBe(1); // only page-1 stroke draws on page 1
  });

  test('onion skin draws neighbouring pages but they stay non-interactive', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.setOnion(1);
      a.addStroke([{ x: -50, y: 0 }, { x: -40, y: 0 }]); // page 0
      a.addFrame();
      a.addStroke([{ x: 40, y: 0 }, { x: 50, y: 0 }]);   // page 1
      // on page 1: page-1 stroke (full) + page-0 stroke (ghost) both draw
      const drawnWithOnion = a.drawnCount();
      // but only the current page can be selected
      a.selectAll();
      const selectable = a.selectedCount();
      return { drawnWithOnion, selectable };
    });
    expect(r.drawnWithOnion).toBe(2); // current + 1 onion ghost
    expect(r.selectable).toBe(1);     // only the live page is editable
  });

  test('duplicate frame clones the current page onto a new page after it', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.addStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
      a.addRect(0, 0, 20, 20);
      const before = a.itemCount();
      a.duplicateFrame();
      return {
        before, after: a.itemCount(),
        count: a.frameCount(), current: a.currentFrame(),
        onNew: a.frameItemCount(1),
      };
    });
    expect(r.before).toBe(2);
    expect(r.after).toBe(4);     // page duplicated
    expect(r.count).toBe(2);
    expect(r.current).toBe(1);   // lands on the new page
    expect(r.onNew).toBe(2);
  });

  test('add frame in the middle shifts later pages up', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      const id0 = a.addStroke([{ x: 0, y: 0 }, { x: 1, y: 0 }]); // page 0
      a.addFrame();
      const id1 = a.addStroke([{ x: 0, y: 0 }, { x: 2, y: 0 }]); // page 1
      a.setFrame(0);
      a.addFrame(); // insert blank between old 0 and old 1 → old page-1 becomes page 2
      return { count: a.frameCount(), current: a.currentFrame(), f0: a.frameOf(id0), f1: a.frameOf(id1) };
    });
    expect(r.count).toBe(3);
    expect(r.current).toBe(1); // on the new blank page
    expect(r.f0).toBe(0);
    expect(r.f1).toBe(2);      // pushed up by the insert
  });

  test('delete frame removes its items and pulls later pages down', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.addStroke([{ x: 0, y: 0 }, { x: 1, y: 0 }]);     // page 0
      a.addFrame();
      a.addStroke([{ x: 0, y: 0 }, { x: 2, y: 0 }]);     // page 1
      a.addFrame();
      const id2 = a.addStroke([{ x: 0, y: 0 }, { x: 3, y: 0 }]); // page 2
      a.setFrame(1);
      a.deleteFrame(); // remove page 1; page 2 becomes page 1
      return { count: a.frameCount(), items: a.itemCount(), f2: a.frameOf(id2), current: a.currentFrame() };
    });
    expect(r.count).toBe(2);
    expect(r.items).toBe(2);   // the page-1 stroke is gone
    expect(r.f2).toBe(1);      // page 2 pulled down to page 1
  });

  test('frame ops are undoable (count, current and items all restored)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.addStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
      a.addRect(0, 0, 20, 20);
      a.duplicateFrame(); // count 2, current 1, items 4
      const mid = { count: a.frameCount(), current: a.currentFrame(), items: a.itemCount() };
      a.undo();
      const after = { count: a.frameCount(), current: a.currentFrame(), items: a.itemCount() };
      a.redo();
      const redone = { count: a.frameCount(), current: a.currentFrame(), items: a.itemCount() };
      return { mid, after, redone };
    });
    expect(r.mid).toEqual({ count: 2, current: 1, items: 4 });
    expect(r.after).toEqual({ count: 1, current: 0, items: 2 });
    expect(r.redone).toEqual({ count: 2, current: 1, items: 4 });
  });

  test('moveSelectionToFrame reassigns selected items to another page', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      const id = a.addStroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
      a.addFrame(); // current 1
      a.setFrame(0);
      a.select([id]);
      a.moveSelectionToFrame(1);
      return { frame: a.frameOf(id), onP0: a.frameItemCount(0), onP1: a.frameItemCount(1) };
    });
    expect(r.frame).toBe(1);
    expect(r.onP0).toBe(0);
    expect(r.onP1).toBe(1);
  });

  test('playback toggles state and looping advances the page', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.addStroke([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
      a.duplicateFrame();          // 2 pages
      a.setFrame(0);
      a.play();
      const playing = a.isPlaying();
      a.stop();
      const stopped = a.isPlaying();
      // wrap-around navigation
      a.setFrame(1); a.nextFrame();
      const wrapped = a.currentFrame();
      return { playing, stopped, wrapped };
    });
    expect(r.playing).toBe(true);
    expect(r.stopped).toBe(false);
    expect(r.wrapped).toBe(0); // next from last page loops to 0
  });

  test('flipbook state and pages survive a reload', async ({ page }) => {
    await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.setFps(12);
      a.addStroke([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
      a.addFrame();
      a.addStroke([{ x: 0, y: 0 }, { x: 2, y: 0 }]); // page 1
    });
    await page.waitForTimeout(600); // let the debounced scene autosave flush
    await page.reload();
    await waitReady(page);
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      return { on: a.flipbook().on, count: a.frameCount(), fps: a.flipbook().fps, items: a.itemCount() };
    });
    expect(r.on).toBe(true);
    expect(r.count).toBe(2);
    expect(r.fps).toBe(12);
    expect(r.items).toBe(2);
  });

  test('turning flipbook off restores the full infinite canvas (all items live)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const a = window.__INFINIZOOM__;
      a.setFlipbook(true);
      a.setOnion(0);
      a.addStroke([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
      a.addFrame();
      a.addStroke([{ x: 0, y: 0 }, { x: 2, y: 0 }]);
      const live = a.drawnCount();      // one page visible
      a.setFlipbook(false);
      const all = a.drawnCount();        // everything visible again
      return { live, all };
    });
    expect(r.live).toBe(1);
    expect(r.all).toBe(2);
  });

  test('the Flipbook toggle button shows the controls and no errors occur', async ({ page }) => {
    const errors = captureErrors(page);
    await page.click('#flipToggle');
    await expect(page.locator('#flip-controls')).toBeVisible();
    await page.click('#flipAdd');
    await page.click('#flipNext');
    await page.click('#flipPrev');
    expect(await page.evaluate(() => window.__INFINIZOOM__.frameCount())).toBe(2);
    expect(errors).toEqual([]);
  });
});
