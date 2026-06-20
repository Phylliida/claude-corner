const { test } = require("./harness.cjs");

// Selection-tool suite. Strokes are built directly in WORLD coordinates with a
// fixed (non-zoom-aware) width so their bounding boxes are predictable:
//   A: horizontal line (-20,0)->(20,0)  → bbox x[-22,22] y[-2,2]
//   B: horizontal line (200,0)->(240,0) → bbox x[198,242] y[-2,2]
// (width 4 ⇒ half-width 2 padding on every side.)
const SETUP = `() => {
  App.resetView(); App.setGrid(false);
  App.setZoomDependent(false); App.setSize(4); App.setTaper(false);
  App.clearFrame();
  const A = App.drawPath([{x:-20,y:0},{x:20,y:0}], { tool: 'line' });
  const B = App.drawPath([{x:200,y:0},{x:240,y:0}], { tool: 'line' });
  App.setTool('select');
  return { a: A.id, b: B.id };
}`;

test("strokeBounds encloses a stroke including its half-width", async (page, t) => {
  const b = await page.evaluate((setup) => {
    eval(setup)();
    const s = App.currentStrokes()[0];
    return App.strokeBounds(s);
  }, SETUP);
  t.approx(b.minX, -22, 1e-6, "minX includes half-width");
  t.approx(b.maxX, 22, 1e-6);
  t.approx(b.minY, -2, 1e-6);
  t.approx(b.maxY, 2, 1e-6);
});

test("contain (window) marquee selects only fully-enclosed strokes", async (page, t) => {
  const r = await page.evaluate((setup) => {
    eval(setup)();
    // box around A only
    const n = App.selectInRect({ minX: -30, minY: -30, maxX: 30, maxY: 30 }, "contain");
    return { n, sel: App.getSelection().length, bounds: App.selectionBounds() };
  }, SETUP);
  t.equal(r.n, 1, "exactly one stroke selected");
  t.equal(r.sel, 1);
  t.approx(r.bounds.maxX, 22, 1e-6, "selection bounds = A's bounds");
});

test("contain does NOT select a stroke that only partially overlaps", async (page, t) => {
  const r = await page.evaluate((setup) => {
    eval(setup)();
    // rect starts at x=0, so A (x[-22,22]) is only partially inside → not contained
    return App.selectInRect({ minX: 0, minY: -30, maxX: 1000, maxY: 30 }, "contain");
  }, SETUP);
  t.equal(r, 1, "only B (fully inside) is selected by a window drag");
});

test("crossing marquee selects any touched stroke", async (page, t) => {
  const r = await page.evaluate((setup) => {
    eval(setup)();
    // same rect, crossing mode → A (touched) + B (inside)
    return App.selectInRect({ minX: 0, minY: -30, maxX: 1000, maxY: 30 }, "crossing");
  }, SETUP);
  t.equal(r, 2, "crossing catches the partially-overlapped stroke too");
});

test("crossing detects a stroke that spans the marquee without a vertex inside", async (page, t) => {
  // A long line passing straight through a small marquee box: no endpoint is
  // inside the box, but a segment crosses it. Bbox-only logic would miss this.
  const r = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setZoomDependent(false); App.setSize(2); App.clearFrame();
    App.drawPath([{ x: -500, y: 0 }, { x: 500, y: 0 }], { tool: "line" });
    const cross = App.selectInRect({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, "crossing");
    App.clearSelection();
    const contain = App.selectInRect({ minX: -10, minY: -10, maxX: 10, maxY: 10 }, "contain");
    return { cross, contain };
  });
  t.equal(r.cross, 1, "crossing finds the spanning line via segment intersection");
  t.equal(r.contain, 0, "window does not (the line extends well outside)");
});

test("moveSelection translates points and is undoable", async (page, t) => {
  const r = await page.evaluate((setup) => {
    const ids = eval(setup)();
    App.selectIds([ids.a]);
    const before = App.currentStrokes().find((s) => s.id === ids.a).points.map((p) => ({ x: p.x, y: p.y }));
    App.moveSelection(100, 50);
    const moved = App.currentStrokes().find((s) => s.id === ids.a).points.map((p) => ({ x: p.x, y: p.y }));
    App.undo();
    const undone = App.currentStrokes().find((s) => s.id === ids.a).points.map((p) => ({ x: p.x, y: p.y }));
    App.redo();
    const redone = App.currentStrokes().find((s) => s.id === ids.a).points.map((p) => ({ x: p.x, y: p.y }));
    return { before, moved, undone, redone };
  }, SETUP);
  t.approx(r.moved[0].x, r.before[0].x + 100, 1e-6, "x shifted by dx");
  t.approx(r.moved[0].y, r.before[0].y + 50, 1e-6, "y shifted by dy");
  t.approx(r.undone[0].x, r.before[0].x, 1e-6, "undo restores original position");
  t.approx(r.redone[0].x, r.before[0].x + 100, 1e-6, "redo re-applies the move");
});

test("moving the selection leaves unselected strokes untouched", async (page, t) => {
  const r = await page.evaluate((setup) => {
    const ids = eval(setup)();
    App.selectIds([ids.a]);
    const bBefore = App.currentStrokes().find((s) => s.id === ids.b).points[0].x;
    App.moveSelection(100, 50);
    const bAfter = App.currentStrokes().find((s) => s.id === ids.b).points[0].x;
    return { bBefore, bAfter };
  }, SETUP);
  t.approx(r.bAfter, r.bBefore, 1e-6, "B did not move");
});

test("scaleSelection scales geometry about a pivot and is undoable", async (page, t) => {
  const r = await page.evaluate((setup) => {
    const ids = eval(setup)();
    App.selectIds([ids.a]);
    const w0 = App.currentStrokes().find((s) => s.id === ids.a).width;
    App.scaleSelection(2, 2, { x: 0, y: 0 });
    const s = App.currentStrokes().find((st) => st.id === ids.a);
    const pts = s.points.map((p) => ({ x: p.x, y: p.y }));
    const w1 = s.width;
    App.undo();
    const w2 = App.currentStrokes().find((st) => st.id === ids.a).width;
    return { pts, w0, w1, w2 };
  }, SETUP);
  t.approx(r.pts[0].x, -40, 1e-6, "(-20,0) doubled about origin → -40");
  t.approx(r.pts[1].x, 40, 1e-6, "(20,0) doubled about origin → 40");
  t.approx(r.w1, r.w0 * 2, 1e-6, "width scales by geometric mean (sqrt(2*2)=2)");
  t.approx(r.w2, r.w0, 1e-6, "undo restores width");
});

test("scaling a tapered stroke scales its per-point widths too", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setZoomDependent(false); App.setSize(12);
    App.setTaper(true); App.setTaperAmount(60); App.clearFrame();
    // varying-speed pen stroke → a real widths array
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push({ x: -100 + i * (8 + i * 4), y: 0 });
    const s = App.drawPath(pts, { tool: "pen" });
    App.setTool("select"); App.selectIds([s.id]);
    if (!s.widths) return { had: false };
    const before = s.widths.slice();
    App.scaleSelection(2, 2, { x: 0, y: 0 });
    const after = App.currentStrokes().find((st) => st.id === s.id).widths.slice();
    return { had: true, before, after };
  });
  t.ok(r.had, "stroke recorded a per-point width array");
  let allDoubled = true;
  for (let i = 0; i < r.before.length; i++) {
    if (Math.abs(r.after[i] - r.before[i] * 2) > 1e-6) allDoubled = false;
  }
  t.ok(allDoubled, "every per-point width scaled by the same factor as the body");
});

test("deleteSelection removes selected strokes and is undoable", async (page, t) => {
  const r = await page.evaluate((setup) => {
    const ids = eval(setup)();
    App.selectIds([ids.a, ids.b]);
    const before = App.currentStrokes().length;
    const n = App.deleteSelection();
    const after = App.currentStrokes().length;
    App.undo();
    const restored = App.currentStrokes().length;
    return { before, n, after, restored, selAfter: App.selectionSize() };
  }, SETUP);
  t.equal(r.before, 2);
  t.equal(r.n, 2, "deleted both");
  t.equal(r.after, 0, "frame emptied");
  t.equal(r.restored, 2, "undo brings both strokes back");
  t.equal(r.selAfter, 0, "selection cleared after delete");
});

test("selectAll selects every stroke; clearSelection empties it", async (page, t) => {
  const r = await page.evaluate((setup) => {
    eval(setup)();
    const all = App.selectAll();
    const afterClear = (App.clearSelection(), App.selectionSize());
    return { all, afterClear };
  }, SETUP);
  t.equal(r.all, 2, "both strokes selected");
  t.equal(r.afterClear, 0);
});

test("switching frames clears the selection (ids are per-frame)", async (page, t) => {
  const r = await page.evaluate((setup) => {
    eval(setup)();
    App.selectAll();
    const before = App.selectionSize();
    App.addFrame(); // moves to a new frame
    return { before, after: App.selectionSize() };
  }, SETUP);
  t.equal(r.before, 2);
  t.equal(r.after, 0, "selection does not bleed across frames");
});

test("Delete key removes the selection when the select tool is active", async (page, t) => {
  await page.evaluate((setup) => { eval(setup)(); App.selectAll(); }, SETUP);
  await page.keyboard.press("Delete");
  const n = await page.evaluate(() => App.currentStrokes().length);
  t.equal(n, 0, "pressing Delete cleared the selected strokes");
});

test("Escape clears the selection", async (page, t) => {
  await page.evaluate((setup) => { eval(setup)(); App.selectAll(); }, SETUP);
  const before = await page.evaluate(() => App.selectionSize());
  await page.keyboard.press("Escape");
  const after = await page.evaluate(() => App.selectionSize());
  t.equal(before, 2);
  t.equal(after, 0);
});

test("'v' selects the select tool", async (page, t) => {
  await page.evaluate(() => App.setTool("pen"));
  await page.keyboard.press("v");
  const tool = await page.evaluate(() => App.getTool());
  t.equal(tool, "select");
});

test("a real left→right (window) marquee drag selects an enclosed stroke", async (page, t) => {
  const setup = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setZoomDependent(false); App.setSize(4); App.clearFrame();
    const c = App.canvasSize();
    // a small stroke near screen centre
    const a = App.screenToWorld(c.w / 2 - 20, c.h / 2);
    const b = App.screenToWorld(c.w / 2 + 20, c.h / 2);
    const s = App.drawPath([a, b], { tool: "line" });
    App.setTool("select");
    return { id: s.id, w: c.w, h: c.h, rect: document.getElementById("board").getBoundingClientRect() };
  });
  const id = setup.id;
  const c = { w: setup.w, h: setup.h };
  const R = setup.rect;
  // drag a window box left→right fully around the stroke
  await page.mouse.move(R.left + c.w / 2 - 60, R.top + c.h / 2 - 40);
  await page.mouse.down();
  await page.mouse.move(R.left + c.w / 2 + 60, R.top + c.h / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const res = await page.evaluate((sid) => ({ size: App.selectionSize(), sel: App.isSelected(sid) }), id);
  t.equal(res.size, 1, "one stroke selected by the window drag");
  t.ok(res.sel, "it is the stroke we drew");
});

test("a real drag inside the selection moves it (undoable end-to-end)", async (page, t) => {
  const setup = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setZoomDependent(false); App.setSize(4); App.clearFrame();
    const c = App.canvasSize();
    // a tall box so the centre is well clear of the edge/corner handles (a thin
    // selection's handle hit-areas would otherwise overlap its interior)
    const a = App.screenToWorld(c.w / 2 - 50, c.h / 2 - 50);
    const b = App.screenToWorld(c.w / 2 + 50, c.h / 2 + 50);
    const s = App.drawPath([a, b], { tool: "rect" });
    App.setTool("select");
    App.selectIds([s.id]);
    return { id: s.id, x0: s.points[0].x, w: c.w, h: c.h, rect: document.getElementById("board").getBoundingClientRect() };
  });
  const R = setup.rect;
  const cx = R.left + setup.w / 2, cy = R.top + setup.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 70, cy + 30, { steps: 6 });
  await page.mouse.up();
  const res = await page.evaluate((id) => {
    const s = App.currentStrokes().find((st) => st.id === id);
    return { x0: s.points[0].x, canUndo: App.canUndo() };
  }, setup.id);
  // scale is 1, so a +70px screen drag is +70 in world
  t.approx(res.x0, setup.x0 + 70, 2, "stroke moved by the drag delta");
  t.ok(res.canUndo, "the move pushed an undoable step");
});

test("a real handle drag scales the selection", async (page, t) => {
  const setup = await page.evaluate(() => {
    App.resetView(); App.setGrid(false); App.setZoomDependent(false); App.setSize(4); App.clearFrame();
    // a square-ish rect so the bottom-right handle is well away from the pivot
    const s = App.drawPath([{ x: -30, y: -30 }, { x: 30, y: 30 }], { tool: "rect" });
    App.setTool("select"); App.selectIds([s.id]);
    const b = App.selectionBounds();
    const br = App.worldToScreen(b.maxX, b.maxY); // bottom-right handle, screen coords
    return { id: s.id, maxX0: b.maxX, w0: s.width, br, rect: document.getElementById("board").getBoundingClientRect() };
  });
  const R = setup.rect;
  const hx = R.left + setup.br.x, hy = R.top + setup.br.y;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 50, hy + 50, { steps: 6 }); // drag the corner outward
  await page.mouse.up();
  const res = await page.evaluate((id) => {
    const s = App.currentStrokes().find((st) => st.id === id);
    return { maxX: App.selectionBounds().maxX, w: s.width };
  }, setup.id);
  t.gt(res.maxX, setup.maxX0 + 20, "selection grew outward from the pivot");
  t.gt(res.w, setup.w0, "stroke width scaled up with the box");
});

test("shift+marquee adds to the existing selection", async (page, t) => {
  const r = await page.evaluate((setup) => {
    const ids = eval(setup)();
    // select A by a window box around it
    App.selectInRect({ minX: -30, minY: -30, maxX: 30, maxY: 30 }, "contain");
    // additive window around B
    App.selectInRect({ minX: 190, minY: -30, maxX: 260, maxY: 30 }, "contain", true);
    return { size: App.selectionSize(), a: App.isSelected(ids.a), b: App.isSelected(ids.b) };
  }, SETUP);
  t.equal(r.size, 2, "both strokes selected after an additive marquee");
  t.ok(r.a && r.b);
});

test("duplicateSelection clones the selection, offset and re-selected, undoably", async (page, t) => {
  const r = await page.evaluate((setup) => {
    const ids = eval(setup)();
    App.selectIds([ids.a]);
    const before = App.currentStrokes().length;
    const origX = App.currentStrokes().find((s) => s.id === ids.a).points[0].x;
    const n = App.duplicateSelection();
    const after = App.currentStrokes().length;
    // the new selection should be the clone, not the original
    const selIds = App.getSelection();
    const clone = App.currentStrokes().find((s) => selIds.includes(s.id));
    const cloneX = clone.points[0].x;
    App.undo();
    const undone = App.currentStrokes().length;
    return { before, n, after, selSize: selIds.length, selHasOriginal: selIds.includes(ids.a), origX, cloneX, undone };
  }, SETUP);
  t.equal(r.n, 1, "one stroke duplicated");
  t.equal(r.after, r.before + 1, "frame gained a stroke");
  t.equal(r.selSize, 1, "selection now holds just the clone");
  t.notOk(r.selHasOriginal, "the original is no longer selected");
  t.gt(r.cloneX, r.origX, "clone is offset from the original");
  t.equal(r.undone, r.before, "undo removes the clone");
});

test("arrow keys nudge the selection by on-screen pixels", async (page, t) => {
  const id = await page.evaluate((setup) => {
    const ids = eval(setup)();
    App.selectIds([ids.a]);
    return ids.a;
  }, SETUP);
  const x0 = await page.evaluate((id) => App.currentStrokes().find((s) => s.id === id).points[0].x, id);
  await page.keyboard.press("ArrowRight"); // +1px at scale 1
  const x1 = await page.evaluate((id) => App.currentStrokes().find((s) => s.id === id).points[0].x, id);
  await page.keyboard.press("Shift+ArrowRight"); // +10px
  const x2 = await page.evaluate((id) => App.currentStrokes().find((s) => s.id === id).points[0].x, id);
  t.approx(x1, x0 + 1, 1e-6, "ArrowRight nudges +1 world unit at zoom 1");
  t.approx(x2, x1 + 10, 1e-6, "Shift+ArrowRight nudges +10");
});

test("selection overlay renders without error for the select tool", async (page, t) => {
  await page.evaluate((setup) => {
    eval(setup)();
    App.selectAll();
    App.renderNow();
  }, SETUP);
  // the harness fails the test if the page logged any error during render
  t.ok(true, "overlay drew cleanly");
});
