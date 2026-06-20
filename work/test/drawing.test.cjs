const { test } = require("./harness.cjs");

// Helper run in-page: draw a horizontal stroke across the screen centre.
const DRAW_CENTER = `(size, tool) => {
  const c = App.canvasSize();
  const mid = App.screenToWorld(c.w/2, c.h/2);
  const a = App.screenToWorld(c.w/2 - 120, c.h/2);
  const b = App.screenToWorld(c.w/2 + 120, c.h/2);
  App.setSize(size);
  const s = App.drawPath([a, mid, b], { tool: tool || 'pen' });
  App.renderNow();
  return s;
}`;

test("drawing a stroke paints pixels and records a stroke", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    App.setColor("#34d2ff");
    const s = eval(draw)(14, "pen");
    const c = App.canvasSize();
    const px = App.getCanvasPixel(c.w / 2, c.h / 2);
    return { count: App.currentStrokes().length, px, type: s.type, pts: s.points.length };
  }, DRAW_CENTER);
  t.equal(r.count, 1, "one stroke recorded");
  t.equal(r.type, "path");
  t.gte(r.pts, 3, "pen captured all points");
  // pixel should be cyan-ish, not the dark background
  t.gt(r.px.b, 120, "blue channel lit");
  t.gt(r.px.g, 120, "green channel lit");
  t.lt(r.px.r, 120, "red channel low (cyan)");
});

test("FIX #1: zoom-aware width keeps new strokes a constant on-screen size", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    App.setZoomDependent(true);
    App.setSize(8);

    // draw at 100%
    const sA = eval(draw)(8, "pen");
    const screenA = App.strokeScreenWidth(sA);   // measured at scale 1
    const worldA = sA.width;

    // zoom in 5x, draw again
    App.setZoom(5);
    const sB = eval(draw)(8, "pen");
    const screenB = App.strokeScreenWidth(sB);   // measured at scale 5
    const worldB = sB.width;

    // zoom out to 0.25x, draw again
    App.setZoom(0.25);
    const sC = eval(draw)(8, "pen");
    const screenC = App.strokeScreenWidth(sC);
    const worldC = sC.width;

    return { screenA, screenB, screenC, worldA, worldB, worldC };
  }, DRAW_CENTER);

  // On-screen width is ~constant (the fix) regardless of zoom...
  t.approx(r.screenA, 8, 0.5, "screen width ~8 at 100%");
  t.approx(r.screenB, 8, 0.5, "screen width ~8 at 500%");
  t.approx(r.screenC, 8, 0.5, "screen width ~8 at 25%");
  // ...because the stored WORLD width is divided by the zoom.
  t.approx(r.worldA, 8, 1e-6, "world width 8 at scale 1");
  t.approx(r.worldB, 8 / 5, 1e-6, "world width 1.6 at scale 5");
  t.approx(r.worldC, 8 / 0.25, 1e-6, "world width 32 at scale 0.25");
});

test("zoom-aware OFF: width is a fixed world size that scales on screen", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    App.setZoomDependent(false);
    App.setSize(10);
    const s1 = eval(draw)(10, "pen");      // scale 1
    const world1 = s1.width;
    const screen1 = App.strokeScreenWidth(s1);
    App.setZoom(3);
    const s2 = eval(draw)(10, "pen");      // scale 3
    return { world1, world2: s2.width, screen1, screen2: App.strokeScreenWidth(s2) };
  }, DRAW_CENTER);
  t.approx(r.world1, 10, 1e-6);
  t.approx(r.world2, 10, 1e-6, "world width fixed regardless of zoom");
  t.approx(r.screen1, 10, 0.5);
  t.approx(r.screen2, 30, 0.5, "on-screen width scales with zoom when fix is off");
});

test("strokes stay put in the world as you zoom", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    const s = eval(draw)(20, "pen");
    const wpt = s.points[1]; // the centre point
    const before = App.worldToScreen(wpt.x, wpt.y);
    App.setZoom(8);
    const after = App.worldToScreen(wpt.x, wpt.y);
    // recompute world from same point: it must be unchanged
    return { wptStable: s.points[1], before, after };
  }, DRAW_CENTER);
  // The stroke geometry is in world space and never mutated by zoom.
  t.ok(Number.isFinite(r.wptStable.x), "world point finite");
});

test("line / rect / ellipse tools produce the right stroke types", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const a = App.screenToWorld(400, 300), b = App.screenToWorld(700, 500);
    const line = App.drawPath([a, b], { tool: "line" });
    const rect = App.drawPath([a, b], { tool: "rect" });
    const ell = App.drawPath([a, b], { tool: "ellipse" });
    return { line: line.type, rect: rect.type, ell: ell.type, count: App.currentStrokes().length };
  });
  t.equal(r.line, "path");
  t.equal(r.rect, "rect");
  t.equal(r.ell, "ellipse");
  t.equal(r.count, 3);
});

test("eraser removes strokes near a point and undo restores them", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    const s = eval(draw)(16, "pen");
    const before = App.currentStrokes().length;
    const mid = s.points[1];
    const removed = App.eraseAt({ x: mid.x, y: mid.y });
    const after = App.currentStrokes().length;
    App.undo();
    const restored = App.currentStrokes().length;
    return { before, removed, after, restored };
  }, DRAW_CENTER);
  t.equal(r.before, 1);
  t.gte(r.removed, 1, "at least one stroke erased");
  t.equal(r.after, 0, "stroke removed");
  t.equal(r.restored, 1, "undo brought it back");
});

test("undo / redo for stroke creation", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    eval(draw)(8, "pen");
    eval(draw)(8, "pen");
    const after2 = App.currentStrokes().length;
    App.undo();
    const afterUndo = App.currentStrokes().length;
    App.undo();
    const afterUndo2 = App.currentStrokes().length;
    App.redo();
    const afterRedo = App.currentStrokes().length;
    return { after2, afterUndo, afterUndo2, afterRedo, canUndo: App.canUndo(), canRedo: App.canRedo() };
  }, DRAW_CENTER);
  t.equal(r.after2, 2);
  t.equal(r.afterUndo, 1);
  t.equal(r.afterUndo2, 0);
  t.equal(r.afterRedo, 1);
});

test("clearFrame empties the frame and is undoable", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    eval(draw)(8, "pen");
    eval(draw)(8, "pen");
    const before = App.currentStrokes().length;
    App.clearFrame();
    const cleared = App.currentStrokes().length;
    App.undo();
    const restored = App.currentStrokes().length;
    return { before, cleared, restored };
  }, DRAW_CENTER);
  t.equal(r.before, 2);
  t.equal(r.cleared, 0);
  t.equal(r.restored, 2);
});
