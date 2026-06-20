const { test } = require("./harness.cjs");

// End-to-end interaction via REAL input events (mouse, wheel, keyboard),
// not just the App API — this is the "browser automation" the task asked for.

test("drawing with the mouse creates a visible stroke", async (page, t) => {
  await page.evaluate(() => { App.resetView(); App.setTool("pen"); App.setColor("#34d2ff"); App.setSize(16); });
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(560, 400, { steps: 6 });
  await page.mouse.move(620, 440, { steps: 6 });
  await page.mouse.up();
  const r = await page.evaluate(() => {
    App.renderNow();
    return { count: App.currentStrokes().length, px: App.getCanvasPixel(560, 400) };
  });
  t.equal(r.count, 1, "a stroke was created by mouse drag");
  t.gt(r.px.b + r.px.g, 200, "pixels along the drag are painted");
});

test("scroll wheel zooms toward the cursor", async (page, t) => {
  await page.evaluate(() => App.resetView());
  await page.mouse.move(800, 300);
  const before = await page.evaluate(() => ({ scale: App.getZoom(), w: App.screenToWorld(800, 300) }));
  await page.mouse.wheel(0, -600); // negative delta -> zoom in
  await page.waitForTimeout(30);
  const after = await page.evaluate(() => ({ scale: App.getZoom(), w: App.screenToWorld(800, 300) }));
  t.gt(after.scale, before.scale, "zoomed in");
  t.approx(after.w.x, before.w.x, 0.5, "world point under cursor preserved (x)");
  t.approx(after.w.y, before.w.y, 0.5, "world point under cursor preserved (y)");
});

test("space-drag pans without drawing", async (page, t) => {
  await page.evaluate(() => { App.resetView(); App.setTool("pen"); });
  const before = await page.evaluate(() => App.getCam());
  await page.mouse.move(640, 400);
  await page.keyboard.down("Space");
  await page.mouse.down();
  await page.mouse.move(540, 360, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const r = await page.evaluate(() => ({ cam: App.getCam(), strokes: App.currentStrokes().length }));
  t.equal(r.strokes, 0, "space-drag did not draw");
  t.notEqual(r.cam.x, before.x, "camera moved");
});

test("keyboard shortcuts switch tools and frames", async (page, t) => {
  await page.click("#board", { position: { x: 10, y: 10 } }).catch(() => {});
  await page.keyboard.press("r");
  const tool1 = await page.evaluate(() => App.getTool());
  await page.keyboard.press("o");
  const tool2 = await page.evaluate(() => App.getTool());
  await page.keyboard.press("n"); // new frame
  const r = await page.evaluate(() => ({ tool2: App.getTool(), n: App.frameCount(), cur: App.currentFrame() }));
  t.equal(tool1, "rect");
  t.equal(r.tool2, "ellipse");
  t.equal(r.n, 2, "N added a frame");
});

test("toolbar buttons are wired (undo button reacts to history)", async (page, t) => {
  await page.evaluate(() => {
    App.resetView();
    App.drawPath([{ x: 0, y: 0 }, { x: 20, y: 20 }], { tool: "pen" });
  });
  const undoDisabledBefore = await page.$eval("#undo", (b) => b.disabled);
  await page.click("#undo");
  const count = await page.evaluate(() => App.currentStrokes().length);
  t.notOk(undoDisabledBefore, "undo enabled after a draw");
  t.equal(count, 0, "clicking Undo removed the stroke");
});

test("clicking a frame thumbnail navigates to it", async (page, t) => {
  await page.evaluate(() => { App.addFrame(); App.addFrame(); App.gotoFrame(0); });
  // thumbnails render in #thumbs; click the 3rd
  await page.waitForSelector('.thumb[data-index="2"]');
  await page.click('.thumb[data-index="2"]');
  const cur = await page.evaluate(() => App.currentFrame());
  t.equal(cur, 2, "thumbnail click selected frame 3");
});

test("play/pause button toggles playback", async (page, t) => {
  await page.evaluate(() => { App.addFrame(); App.setFps(12); App.gotoFrame(0); });
  await page.click("#playPause");
  const playing = await page.evaluate(() => App.isPlaying());
  await page.click("#playPause");
  const stopped = await page.evaluate(() => App.isPlaying());
  t.ok(playing, "play started");
  t.notOk(stopped, "pause stopped it");
});
