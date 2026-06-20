const { test } = require("./harness.cjs");

test("grid toggle changes what is rendered at the origin", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const c = App.canvasSize();
    App.setGrid(true); App.renderNow();
    const withGrid = App.getCanvasPixel(c.w / 2, c.h / 2); // origin crosshair
    App.setGrid(false); App.renderNow();
    const noGrid = App.getCanvasPixel(c.w / 2, c.h / 2);
    return { withGrid, noGrid };
  });
  const sum = (p) => p.r + p.g + p.b;
  t.gt(sum(r.withGrid), sum(r.noGrid), "grid lights up the origin crosshair");
  t.lt(sum(r.noGrid), 80, "background only when grid off");
});

test("fitView frames the drawing within the viewport", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    App.setGrid(false);
    // draw a box far from the origin and at an awkward zoom
    App.setZoom(0.3);
    const pts = [
      App.screenToWorld(100, 100),
      App.screenToWorld(140, 110),
    ];
    // place strokes around an arbitrary world rectangle
    App.addStroke({ type: "rect", color: "#fff", width: 2, points: [{ x: 4000, y: -2000 }, { x: 5200, y: -1200 }] });
    App.fitView();
    const c = App.canvasSize();
    const b = App.contentBounds();
    const a = App.worldToScreen(b.minX, b.minY);
    const d = App.worldToScreen(b.maxX, b.maxY);
    return { c, a, d, scale: App.getZoom() };
  });
  // bounds must be on-screen and reasonably large (fills a good chunk)
  t.between(r.a.x, -5, r.c.w, "left edge on screen");
  t.between(r.d.x, 0, r.c.w + 5, "right edge on screen");
  t.gt(r.d.x - r.a.x, r.c.w * 0.4, "drawing fills a good fraction of the width");
});

test("deep zoom keeps world<->screen precise (infinite zoom sanity)", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const out = [];
    for (const scale of [1e-3, 1, 1e2, 1e4]) {
      App.setZoom(scale);
      const w0 = App.screenToWorld(321, 654);
      const s = App.worldToScreen(w0.x, w0.y);
      out.push([s.x - 321, s.y - 654, App.getZoom()]);
    }
    return out;
  });
  for (const [dx, dy] of r) { t.approx(dx, 0, 1e-3); t.approx(dy, 0, 1e-3); }
});
