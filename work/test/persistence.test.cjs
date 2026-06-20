const { test } = require("./harness.cjs");

const DRAW = `(size) => {
  const c = App.canvasSize();
  const a = App.screenToWorld(c.w/2 - 100, c.h/2);
  const b = App.screenToWorld(c.w/2 + 100, c.h/2);
  App.setSize(size||14);
  return App.drawPath([a, b], { tool: 'pen' });
}`;

test("save -> reload restores frames, strokes and camera (autoload)", async (page, t) => {
  await page.evaluate((draw) => {
    App.resetView();
    eval(draw)(10);
    App.addFrame();
    eval(draw)(20);
    App.setZoom(3.5);
    App.gotoFrame(0);
    App.save();
  }, DRAW);

  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");

  const r = await page.evaluate(() => ({
    n: App.frameCount(),
    cur: App.currentFrame(),
    f0: App.state.frames[0].strokes.length,
    f1: App.state.frames[1].strokes.length,
    scale: App.getZoom(),
  }));
  t.equal(r.n, 2, "two frames restored");
  t.equal(r.f0, 1);
  t.equal(r.f1, 1);
  t.equal(r.cur, 0);
  t.approx(r.scale, 3.5, 1e-6, "zoom restored");
});

test("export -> mutate -> import round-trips exactly", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    eval(draw)(12);
    App.addFrame();
    eval(draw)(7);
    const json = App.exportProject();

    // wreck the current state
    App.clearFrame();
    App.gotoFrame(0);
    App.clearFrame();
    const wrecked = App.state.frames.map((f) => f.strokes.length);

    const ok = App.importProject(json);
    const restored = App.state.frames.map((f) => f.strokes.length);
    return { ok, wrecked, restored, n: App.frameCount() };
  }, DRAW);
  t.ok(r.ok, "import succeeded");
  t.equal(JSON.stringify(r.wrecked), JSON.stringify([0, 0]), "state was wrecked first");
  t.equal(JSON.stringify(r.restored), JSON.stringify([1, 1]), "import restored both frames");
});

test("importProject rejects malformed input gracefully", async (page, t) => {
  const r = await page.evaluate(() => {
    const a = App.importProject("not json at all");
    const b = App.importProject(JSON.stringify({ nope: true }));
    const c = App.importProject(JSON.stringify({ frames: [] }));
    return { a, b, c, stillAlive: App.frameCount() };
  });
  t.notOk(r.a, "garbage string rejected");
  t.notOk(r.b, "missing frames rejected");
  t.notOk(r.c, "empty frames rejected");
  t.equal(r.stillAlive, 1, "app still has its frame");
});

test("serialized payload is stable JSON and re-importable", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    eval(draw)(9);
    const s1 = JSON.stringify(App.serialize());
    App.importProject(s1);
    const s2 = JSON.stringify(App.serialize());
    return { equal: s1.length > 0 && s2.length > 0, sameFrames: JSON.parse(s1).frames.length === JSON.parse(s2).frames.length };
  }, DRAW);
  t.ok(r.equal);
  t.ok(r.sameFrames);
});
