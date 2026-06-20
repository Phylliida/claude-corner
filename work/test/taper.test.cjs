const { test } = require("./harness.cjs");

// Draw a horizontal pen stroke across the screen centre with a chosen sample
// spacing (px). Small spacing ≈ slow pen ≈ thick; large spacing ≈ fast ≈ thin.
// Returns the committed stroke.
const DRAW_H = `(yOffset, spacing, size, taperOn) => {
  const c = App.canvasSize();
  const cx = c.w/2, cy = c.h/2 + (yOffset||0);
  App.setSize(size || 16);
  App.setTaper(!!taperOn);
  const pts = [];
  for (let x = cx - 150; x <= cx + 150 + 0.01; x += spacing) pts.push(App.screenToWorld(x, cy));
  const s = App.drawPath(pts, { tool: 'pen' });
  App.renderNow();
  return s;
}`;

// Count the vertical thickness (lit pixels) of a horizontal stroke at column x.
const THICKNESS = `(x, yc, span) => {
  let n = 0;
  for (let y = yc - span; y <= yc + span; y++) {
    const p = App.getCanvasPixel(x, y);
    if (p.r + p.g + p.b > 200) n++;
  }
  return n;
}`;

test("taper off: pen strokes carry no per-point widths (backward compatible)", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView(); App.setGrid(false);
    const s = eval(draw)(0, 6, 14, false);
    return { hasWidths: !!s.widths, count: App.currentStrokes().length };
  }, DRAW_H);
  t.notOk(r.hasWidths, "no widths array when taper is off");
  t.equal(r.count, 1);
});

test("taper on: a pen stroke records a varying per-point width array", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView(); App.setGrid(false);
    const s = eval(draw)(0, 6, 16, true);
    return { hasWidths: !!s.widths, n: s.widths ? s.widths.length : 0, pts: s.points.length, base: s.width };
  }, DRAW_H);
  t.ok(r.hasWidths, "widths array attached");
  t.equal(r.n, r.pts, "one width per point");
  t.gt(r.base, 0, "base width preserved");
});

test("faster pen movement produces a thinner stored width than slow movement", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView(); App.setGrid(false);
    App.setTaperAmount(60);
    const slow = eval(draw)(-80, 5, 18, true);   // 5px spacing → slow → thick
    const fast = eval(draw)(80, 45, 18, true);   // 45px spacing → fast → thin
    const last = (a) => a[a.length - 1];
    const max = (a) => a.reduce((m, v) => Math.max(m, v), 0);
    return {
      base: slow.width,
      slowLast: last(slow.widths), fastLast: last(fast.widths),
      slowMax: max(slow.widths), fastMax: max(fast.widths),
    };
  }, DRAW_H);
  t.gt(r.slowLast, r.fastLast, "slow stroke ends thicker than fast stroke");
  // a fast flick taps out near the min factor (well below the base width)...
  t.lt(r.fastLast, r.base * 0.75, "fast stroke thins below 75% of base");
  // ...while a slow stroke stays near full width
  t.gt(r.slowMax, r.base * 0.85, "slow stroke stays near full base width");
});

test("velocity taper renders a visibly thinner line for a fast flick (pixels)", async (page, t) => {
  const r = await page.evaluate(({ draw, thick }) => {
    App.resetView(); App.setGrid(false); App.setColor("#ffffff");
    App.setTaperAmount(70);
    const c = App.canvasSize();
    const slow = eval(draw)(-70, 5, 20, true);
    const fast = eval(draw)(70, 50, 20, true);
    App.renderNow();
    const T = eval(thick);
    return {
      slowThick: T(Math.round(c.w / 2), Math.round(c.h / 2 - 70), 25),
      fastThick: T(Math.round(c.w / 2), Math.round(c.h / 2 + 70), 25),
    };
  }, { draw: DRAW_H, thick: THICKNESS });
  t.gt(r.slowThick, 6, "slow stroke renders with body");
  t.gt(r.fastThick, 0, "fast stroke still visible (min-width floor)");
  t.gt(r.slowThick, r.fastThick + 2, "slow stroke is measurably thicker than the fast flick");
});

test("taper applies only to the pen — lines and shapes stay uniform", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setTaper(true);
    const a = App.screenToWorld(300, 300), b = App.screenToWorld(700, 500);
    const line = App.drawPath([a, b], { tool: "line" });
    const rect = App.drawPath([a, b], { tool: "rect" });
    const ell = App.drawPath([a, b], { tool: "ellipse" });
    return { line: !!line.widths, rect: !!rect.widths, ell: !!ell.widths };
  });
  t.notOk(r.line, "line has no taper widths");
  t.notOk(r.rect, "rect has no taper widths");
  t.notOk(r.ell, "ellipse has no taper widths");
});

test("a self-overlapping tapered stroke does not double-darken at low alpha", async (page, t) => {
  // The ribbon is one filled path; the nonzero winding rule fills the union of
  // discs + quads exactly once, so overlaps must not compound the alpha.
  const r = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setColor("#ffffff");
    App.setTaper(true); App.setOpacity(50); App.setSize(22);
    const c = App.canvasSize(), cx = c.w / 2, cy = c.h / 2;
    // doubled-back stroke: A -> B -> A along the same horizontal line (full overlap)
    const A = App.screenToWorld(cx - 100, cy), B = App.screenToWorld(cx + 100, cy);
    App.drawPath([A, B, A], { tool: "pen" });
    App.renderNow();
    const overlap = App.getCanvasPixel(cx, cy);            // covered by both passes
    App.clearFrame();
    // control: a single-pass stroke of the same alpha well below it
    const C = App.screenToWorld(cx - 100, cy + 120), D = App.screenToWorld(cx + 100, cy + 120);
    App.drawPath([C, D], { tool: "pen" });
    App.renderNow();
    const single = App.getCanvasPixel(cx, cy + 120);
    return { overlap: overlap.r, single: single.r };
  });
  t.gt(r.single, 60, "control stroke painted at ~half alpha");
  t.between(r.overlap, r.single - 22, r.single + 22, "overlap brightness ≈ single coverage (filled once)");
});

test("taper settings + per-point widths survive save / reload", async (page, t) => {
  await page.evaluate((draw) => {
    App.resetView(); App.setGrid(false);
    App.setTaperAmount(40);
    eval(draw)(0, 7, 16, true);
    App.save();
  }, DRAW_H);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  const r = await page.evaluate(() => {
    const s = App.currentStrokes()[0];
    return { taper: App.isTaper(), amt: App.getTaperAmount(), hasWidths: !!(s && s.widths), n: s ? s.widths.length : 0, pts: s ? s.points.length : 0 };
  });
  t.equal(r.taper, true, "taper toggle restored");
  t.equal(r.amt, 40, "taper amount restored");
  t.ok(r.hasWidths, "per-point widths restored");
  t.equal(r.n, r.pts, "widths length matches points after reload");
});

test("export -> import round-trips tapered widths exactly", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView(); App.setGrid(false);
    const s = eval(draw)(0, 8, 16, true);
    const before = s.widths.slice();
    const json = App.exportProject();
    App.clearFrame();
    App.importProject(json);
    const after = App.currentStrokes()[0].widths;
    return { before, after, same: JSON.stringify(before) === JSON.stringify(after) };
  }, DRAW_H);
  t.ok(r.before.length > 2, "had a multi-point width array");
  t.ok(r.same, "widths array identical after export/import");
});

test("taper amount clamps to [0, 100]", async (page, t) => {
  const r = await page.evaluate(() => {
    App.setTaperAmount(-30); const lo = App.getTaperAmount();
    App.setTaperAmount(250); const hi = App.getTaperAmount();
    App.setTaperAmount(33); const mid = App.getTaperAmount();
    return { lo, hi, mid };
  });
  t.equal(r.lo, 0);
  t.equal(r.hi, 100);
  t.equal(r.mid, 33);
});

test("'t' key toggles velocity taper", async (page, t) => {
  const before = await page.evaluate(() => { App.setTaper(false); return App.isTaper(); });
  await page.keyboard.press("t"); // real key event, bubbles to the window handler
  const after = await page.evaluate(() => App.isTaper());
  t.equal(before, false);
  t.equal(after, true, "pressing t turned taper on");
});
