const { test } = require("./harness.cjs");

const DRAW = `(opts) => {
  const c = App.canvasSize();
  const a = App.screenToWorld(c.w/2 - 100, c.h/2);
  const b = App.screenToWorld(c.w/2 + 100, c.h/2);
  App.setSize((opts&&opts.size)||16);
  return App.drawPath([a, b], Object.assign({ tool: 'pen' }, opts||{}));
}`;

test("brush opacity is stored on the stroke and dims the pixels", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView(); App.setGrid(false);
    App.setColor("#ffffff");

    App.setOpacity(100);
    const full = eval(draw)({ size: 20 });
    const c = App.canvasSize();
    App.renderNow();
    const pxFull = App.getCanvasPixel(c.w / 2, c.h / 2);

    App.clearFrame();
    App.setOpacity(30);
    const faint = eval(draw)({ size: 20 });
    App.renderNow();
    const pxFaint = App.getCanvasPixel(c.w / 2, c.h / 2);

    return { fullAlpha: full.alpha, faintAlpha: faint.alpha, pxFull, pxFaint };
  }, DRAW);
  t.approx(r.fullAlpha, 1, 1e-6, "full stroke alpha = 1");
  t.approx(r.faintAlpha, 0.3, 1e-6, "faint stroke alpha = 0.3");
  // a 30% white stroke is much darker than a 100% white stroke
  t.gt(r.pxFull.r, 200, "opaque white is bright");
  t.lt(r.pxFaint.r, 160, "30% white is dim");
  t.gt(r.pxFull.r, r.pxFaint.r + 50, "opacity visibly changes brightness");
});

test("eyedropper picks the colour of the stroke under the cursor", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    App.setColor("#ff6b6b");
    const s = eval(draw)({ size: 24 });
    // change current colour to something else
    App.setColor("#34d2ff");
    const before = App.getColor();
    // pick from the middle of the red stroke
    const mid = s.points[Math.floor(s.points.length / 2)];
    const picked = App.pickColorAt({ x: mid.x, y: mid.y });
    return { before, picked, after: App.getColor() };
  }, DRAW);
  t.equal(r.before, "#34d2ff");
  t.equal(r.picked, "#ff6b6b", "picked the stroke colour");
  t.equal(r.after, "#ff6b6b", "current colour updated to the picked colour");
});

test("eyedropper tool via real click samples a colour", async (page, t) => {
  await page.evaluate(() => {
    App.resetView();
    App.setColor("#7CFC8A");
    const c = App.canvasSize();
    const a = App.screenToWorld(c.w / 2 - 120, c.h / 2);
    const b = App.screenToWorld(c.w / 2 + 120, c.h / 2);
    App.setSize(26);
    App.drawPath([a, b], { tool: "pen" });
    App.setColor("#ffffff");
    App.setTool("eyedropper");
  });
  const c = await page.evaluate(() => App.canvasSize());
  await page.mouse.click(c.w / 2, c.h / 2);
  const picked = await page.evaluate(() => App.getColor());
  t.equal(picked, "#7cfc8a", "clicking with the eyedropper picked the green stroke");
});

test("background colour changes the canvas and is rendered behind strokes", async (page, t) => {
  const r = await page.evaluate(() => {
    App.resetView(); App.setGrid(false);
    App.setBg("#102040");
    App.renderNow();
    const c = App.canvasSize();
    const px = App.getCanvasPixel(20, 20); // a corner, no strokes
    return { px, bg: App.getBg() };
  });
  t.equal(r.bg, "#102040");
  // #102040 = rgb(16,32,64): blue dominant
  t.gt(r.px.b, r.px.r, "background blue channel dominant");
  t.between(r.px.b, 50, 80, "background colour drawn");
});

test("ping-pong playback bounces back and forth", async (page, t) => {
  await page.evaluate(() => {
    App.addFrame(); App.addFrame(); // 3 frames (0,1,2)
    App.gotoFrame(0);
    App.setPingpong(true);
    App.setFps(30); // ~33ms/frame
  });
  // sample the current frame over time and confirm it goes up then comes back down
  const seq = [];
  await page.evaluate(() => App.play());
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(35);
    seq.push(await page.evaluate(() => App.currentFrame()));
  }
  await page.evaluate(() => App.pause());
  const maxF = Math.max(...seq);
  const reachedEnd = seq.includes(2);
  const cameBack = seq.indexOf(2) >= 0 && seq.slice(seq.indexOf(2) + 1).some((v) => v < 2);
  t.equal(maxF, 2, "reached the last frame");
  t.ok(reachedEnd, "hit frame index 2");
  t.ok(cameBack, "bounced back toward lower indices");
});

test("opacity + bg + pingpong survive a save/reload", async (page, t) => {
  await page.evaluate((draw) => {
    App.resetView();
    App.setOpacity(45);
    App.setBg("#223311");
    App.setPingpong(true);
    eval(draw)({ size: 12 });
    App.save();
  }, DRAW);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  const r = await page.evaluate(() => ({
    opacity: App.getOpacity(),
    bg: App.getBg(),
    pingpong: App.state.pingpong,
    strokeAlpha: App.currentStrokes()[0] && App.currentStrokes()[0].alpha,
  }));
  t.approx(r.opacity, 0.45, 1e-6);
  t.equal(r.bg, "#223311");
  t.ok(r.pingpong, "ping-pong restored");
  t.approx(r.strokeAlpha, 0.45, 1e-6, "stroke alpha persisted");
});
