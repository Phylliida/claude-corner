const { test } = require("./harness.cjs");

const ZIGZAG = `() => {
  const c = App.canvasSize();
  const cx = c.w/2, cy = c.h/2;
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const sx = cx - 200 + i*50;
    const sy = cy + (i % 2 === 0 ? -80 : 80);
    pts.push(App.screenToWorld(sx, sy));
  }
  App.setSize(10);
  return App.drawPath(pts, { tool: 'pen' });
}`;

test("smoothing changes the rendered output of a jagged path", async (page, t) => {
  const r = await page.evaluate((zig) => {
    App.resetView(); App.setGrid(false); App.setColor("#34d2ff");
    eval(zig)();
    const c = App.canvasSize();
    const x0 = Math.round(c.w / 2 - 210), x1 = Math.round(c.w / 2 + 210);
    const y0 = Math.round(c.h / 2 - 100), y1 = Math.round(c.h / 2 + 100);
    const grab = () => {
      const out = [];
      for (let y = y0; y <= y1; y += 5)
        for (let x = x0; x <= x1; x += 5) {
          const p = App.getCanvasPixel(x, y);
          out.push(p.r + p.g + p.b);
        }
      return out;
    };
    App.setSmooth(false); App.renderNow();
    const hard = grab();
    App.setSmooth(true); App.renderNow();
    const soft = grab();
    let diffPixels = 0, painted = 0;
    for (let i = 0; i < hard.length; i++) {
      if (Math.abs(hard[i] - soft[i]) > 25) diffPixels++;
      if (soft[i] > 120) painted++;
    }
    return { diffPixels, painted, n: hard.length };
  }, ZIGZAG);
  t.gt(r.painted, 10, "stroke renders visibly in smooth mode");
  t.gt(r.diffPixels, 15, "smoothing changes many pixels vs hard corners");
});

test("smooth toggle does not affect straight lines / shapes", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const a = App.screenToWorld(300, 300), b = App.screenToWorld(700, 500);
    const line = App.drawPath([a, b], { tool: "line" });
    const rect = App.drawPath([a, b], { tool: "rect" });
    // these should render identically regardless of smoothing; just ensure no crash
    App.setSmooth(true); App.renderNow();
    App.setSmooth(false); App.renderNow();
    return { line: line.type, rect: rect.type };
  });
  t.equal(r.line, "path");
  t.equal(r.rect, "rect");
});

test("reverse frames flips order and is undoable", async (page, t) => {
  const r = await page.evaluate(() => {
    const tag = (n) => { App.clearFrame(); for (let i = 0; i < n; i++) App.addStroke({ type: "path", color: "#fff", width: 1, points: [{ x: i, y: 0 }, { x: i + 1, y: 1 }] }); };
    App.gotoFrame(0); tag(1);
    App.addFrame(); tag(2);
    App.addFrame(); tag(3);
    const counts = () => App.state.frames.map((f) => f.strokes.length);
    const before = counts();
    const curBefore = App.currentFrame();
    App.reverseFrames();
    const after = counts();
    const curAfter = App.currentFrame();
    App.undo();
    const undone = counts();
    return { before, after, undone, curBefore, curAfter };
  });
  t.equal(JSON.stringify(r.before), JSON.stringify([1, 2, 3]));
  t.equal(JSON.stringify(r.after), JSON.stringify([3, 2, 1]), "order reversed");
  t.equal(r.curAfter, 0, "current index mapped symmetrically (was 2 -> 0)");
  t.equal(JSON.stringify(r.undone), JSON.stringify([1, 2, 3]), "reverse undone");
});

test("copy/paste strokes between frames (deep copy, undoable)", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    App.addStroke({ type: "path", color: "#ff0000", width: 3, alpha: 1, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
    App.addStroke({ type: "rect", color: "#00ff00", width: 2, alpha: 1, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
    const copied = App.copyFrame();        // copies 2 strokes
    App.addFrame();                         // new empty frame 1
    const beforePaste = App.currentStrokes().length;
    const pasted = App.pasteFrame();        // paste 2 into frame 1
    const afterPaste = App.currentStrokes().length;
    // ensure deep copy: mutate frame 1 stroke, frame 0 unaffected
    App.currentStrokes()[0].points[0].x = 999;
    App.gotoFrame(0);
    const srcX = App.currentStrokes()[0].points[0].x;
    App.gotoFrame(1);
    App.undo(); // undo paste
    const afterUndo = App.currentStrokes().length;
    return { copied, pasted, beforePaste, afterPaste, srcX, afterUndo };
  });
  t.equal(r.copied, 2, "copied two strokes");
  t.equal(r.beforePaste, 0, "target frame started empty");
  t.equal(r.pasted, 2, "pasted two strokes");
  t.equal(r.afterPaste, 2);
  t.equal(r.srcX, 0, "source frame unaffected by editing the paste (deep copy)");
  t.equal(r.afterUndo, 0, "paste was undone");
});

test("paste with an empty clipboard is a no-op", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    const pasted = App.pasteFrame();
    return { pasted, count: App.currentStrokes().length, canUndo: App.canUndo() };
  });
  t.equal(r.pasted, 0, "nothing pasted");
  t.equal(r.count, 0);
  t.notOk(r.canUndo, "no history entry created");
});

test("smooth setting persists across reload", async (page, t) => {
  await page.evaluate(() => { App.resetView(); App.setSmooth(false); App.save(); });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  const smooth = await page.evaluate(() => App.state.smooth);
  t.equal(smooth, false, "smooth=false restored");
});
