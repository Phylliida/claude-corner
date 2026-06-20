const { test } = require("./harness.cjs");

test("minimap canvas is present and sized", async (page, t) => {
  const r = await page.evaluate(() => {
    const mc = document.getElementById("minimapCanvas");
    return { exists: !!mc, w: mc.width, h: mc.height };
  });
  t.ok(r.exists, "minimap canvas exists");
  t.gt(r.w, 0); t.gt(r.h, 0);
});

test("minimap region includes off-screen content", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    // content far from the current viewport
    App.addStroke({ type: "rect", color: "#ff6b6b", width: 4, points: [{ x: 5000, y: 3000 }, { x: 5400, y: 3300 }] });
    return App.minimapRegion();
  });
  t.lt(r.minX, 5000); t.gt(r.maxX, 5400);
  t.lt(r.minY, 3000); t.gt(r.maxY, 3300);
});

test("centerOn places a world point at the screen centre", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    App.setZoom(2.5);
    App.centerOn(1234, -567);
    const s = App.worldToScreen(1234, -567);
    return { s, c: App.canvasSize() };
  });
  t.approx(r.s.x, r.c.w / 2, 0.5, "centred x");
  t.approx(r.s.y, r.c.h / 2, 0.5, "centred y");
});

test("minimapNavigate jumps the camera to the clicked world location", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    // put content far away, render so miniXf is current
    const cx = 4000, cy = -2500;
    App.addStroke({ type: "ellipse", color: "#34d2ff", width: 6, points: [{ x: cx - 200, y: cy - 200 }, { x: cx + 200, y: cy + 200 }] });
    App.renderNow();
    // compute the minimap client coords for the content centre
    const mc = document.getElementById("minimapCanvas");
    const reg = App.minimapRegion();
    const s = Math.min(mc.width / (reg.maxX - reg.minX), mc.height / (reg.maxY - reg.minY));
    const ox = (mc.width - (reg.maxX - reg.minX) * s) / 2, oy = (mc.height - (reg.maxY - reg.minY) * s) / 2;
    const px = (cx - reg.minX) * s + ox, py = (cy - reg.minY) * s + oy;
    const rect = mc.getBoundingClientRect();
    const clientX = rect.left + (px / mc.width) * rect.width;
    const clientY = rect.top + (py / mc.height) * rect.height;
    const world = App.minimapNavigate(clientX, clientY);
    const onScreen = App.worldToScreen(cx, cy);
    return { world, onScreen, c: App.canvasSize() };
  });
  t.approx(r.world.x, 4000, 60, "navigated near content x");
  t.approx(r.world.y, -2500, 60, "navigated near content y");
  // and that content is now roughly centred on the main canvas
  t.approx(r.onScreen.x, r.c.w / 2, r.c.w * 0.2, "content pulled toward centre x");
  t.approx(r.onScreen.y, r.c.h / 2, r.c.h * 0.2, "content pulled toward centre y");
});

test("clicking the minimap with the real mouse moves the camera", async (page, t) => {
  await page.evaluate(() => { App.resetView(); App.renderNow(); });
  const before = await page.evaluate(() => App.getCam());
  const box = await page.$eval("#minimapCanvas", (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // click in a corner of the minimap (away from centre) so the camera must move
  await page.mouse.click(box.x + box.w * 0.85, box.y + box.h * 0.2);
  const after = await page.evaluate(() => App.getCam());
  t.ok(after.x !== before.x || after.y !== before.y, "camera moved after minimap click");
});

test("minimap renders the frame's strokes", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView();
    // a big bright-red rect that should dominate the minimap
    App.addStroke({ type: "rect", color: "#ff0000", width: 8, points: [{ x: -300, y: -200 }, { x: 300, y: 200 }] });
    App.renderNow();
    const mc = document.getElementById("minimapCanvas");
    const d = mc.getContext("2d").getImageData(0, 0, mc.width, mc.height).data;
    let reddish = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) reddish++;
    }
    return { reddish };
  });
  t.gt(r.reddish, 10, "red stroke is visible on the minimap");
});

test("minimap toggle hides/shows and persists across reload", async (page, t) => {
  await page.evaluate(() => { App.setMinimap(false); App.save(); });
  const collapsed = await page.$eval("#minimap", (el) => el.classList.contains("collapsed"));
  t.ok(collapsed, "minimap collapsed after toggle off");
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  const r = await page.evaluate(() => ({
    state: App.state.minimap,
    collapsed: document.getElementById("minimap").classList.contains("collapsed"),
  }));
  t.equal(r.state, false, "minimap=false restored");
  t.ok(r.collapsed, "still collapsed after reload");
});
