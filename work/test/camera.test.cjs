const { test } = require("./harness.cjs");

test("API surface is present and app booted", async (page, t) => {
  const has = await page.evaluate(() => {
    const need = ["worldToScreen", "screenToWorld", "zoomAt", "drawPath", "addFrame", "undo", "save"];
    return need.every((k) => typeof window.App[k] === "function");
  });
  t.ok(has, "all expected App methods exist");
  const ready = await page.evaluate(() => document.body.dataset.ready);
  t.equal(ready, "1");
});

test("world<->screen round-trips at several zooms", async (page, t) => {
  const results = await page.evaluate(() => {
    const out = [];
    for (const scale of [0.5, 1, 3, 50]) {
      App.setZoom(scale);
      for (const [wx, wy] of [[0, 0], [123.4, -57.2], [-1000, 800]]) {
        const s = App.worldToScreen(wx, wy);
        const w = App.screenToWorld(s.x, s.y);
        out.push([wx - w.x, wy - w.y]);
      }
    }
    return out;
  });
  for (const [dx, dy] of results) { t.approx(dx, 0, 1e-6); t.approx(dy, 0, 1e-6); }
});

test("zoomAt keeps the point under the cursor fixed (infinite zoom anchor)", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const sx = 300, sy = 220;
    const before = App.screenToWorld(sx, sy);
    App.zoomAt(sx, sy, 6.5);    // zoom in
    const afterIn = App.screenToWorld(sx, sy);
    App.zoomAt(sx, sy, 0.05);   // zoom way out
    const afterOut = App.screenToWorld(sx, sy);
    return { before, afterIn, afterOut, scale: App.getZoom() };
  });
  t.approx(r.before.x, r.afterIn.x, 1e-3, "x stable on zoom in");
  t.approx(r.before.y, r.afterIn.y, 1e-3, "y stable on zoom in");
  t.approx(r.before.x, r.afterOut.x, 1e-3, "x stable on zoom out");
  t.approx(r.before.y, r.afterOut.y, 1e-3, "y stable on zoom out");
});

test("zoom is clamped to the configured range", async (page, t) => {
  const r = await page.evaluate(() => {
    App.setZoom(1e9);
    const hi = App.getZoom();
    App.setZoom(1e-12);
    const lo = App.getZoom();
    return { hi, lo, max: App.CONFIG.MAX_SCALE, min: App.CONFIG.MIN_SCALE };
  });
  t.equal(r.hi, r.max, "clamps to MAX_SCALE");
  t.equal(r.lo, r.min, "clamps to MIN_SCALE");
});

test("panBy moves the world under a fixed screen point", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const before = App.screenToWorld(640, 400);
    App.panBy(100, -40); // drag right/up
    const after = App.screenToWorld(640, 400);
    return { before, after, scale: App.getZoom() };
  });
  // dragging content right by 100px at scale 1 shifts world by -100/scale
  t.approx(r.after.x - r.before.x, -100 / r.scale, 1e-6);
  t.approx(r.after.y - r.before.y, 40 / r.scale, 1e-6);
});

test("resetView restores 100% and centers the origin", async (page, t) => {
  const r = await page.evaluate(() => {
    App.setZoom(12);
    App.panBy(500, 500);
    App.resetView();
    const c = App.canvasSize();
    const o = App.worldToScreen(0, 0);
    return { scale: App.getZoom(), o, c };
  });
  t.approx(r.scale, 1, 1e-9);
  t.approx(r.o.x, r.c.w / 2, 0.5, "origin at horizontal center");
  t.approx(r.o.y, r.c.h / 2, 0.5, "origin at vertical center");
});
