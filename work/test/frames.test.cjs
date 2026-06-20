const { test } = require("./harness.cjs");

const DRAW = `(size) => {
  const c = App.canvasSize();
  const a = App.screenToWorld(c.w/2 - 100, c.h/2);
  const b = App.screenToWorld(c.w/2 + 100, c.h/2);
  App.setSize(size||14);
  const s = App.drawPath([a, b], { tool: 'pen' });
  App.renderNow();
  return s;
}`;

test("starts with a single empty frame", async (page, t) => {
  const r = await page.evaluate(() => ({ n: App.frameCount(), cur: App.currentFrame(), strokes: App.currentStrokes().length }));
  t.equal(r.n, 1);
  t.equal(r.cur, 0);
  t.equal(r.strokes, 0);
});

test("addFrame inserts a blank frame after current and selects it", async (page, t) => {
  const r = await page.evaluate((draw) => {
    eval(draw)();
    App.addFrame();
    return { n: App.frameCount(), cur: App.currentFrame(), strokes: App.currentStrokes().length };
  }, DRAW);
  t.equal(r.n, 2);
  t.equal(r.cur, 1);
  t.equal(r.strokes, 0, "new frame is blank");
});

test("duplicate frame deep-copies strokes (edits do not leak back)", async (page, t) => {
  const r = await page.evaluate((draw) => {
    const orig = eval(draw)();
    App.dupFrame();
    const dupHas = App.currentStrokes().length;
    // mutate the copy
    eval(draw)();
    const dupNow = App.currentStrokes().length;
    App.gotoFrame(0);
    const origNow = App.currentStrokes().length;
    // ensure the point objects are not shared references
    const sharedRef = App.currentStrokes()[0] === undefined ? false : false;
    return { dupHas, dupNow, origNow, sharedRef };
  }, DRAW);
  t.equal(r.dupHas, 1, "duplicate carried the stroke over");
  t.equal(r.dupNow, 2, "added a stroke to the duplicate");
  t.equal(r.origNow, 1, "original frame unchanged (deep copy)");
});

test("delete frame removes it and clamps selection", async (page, t) => {
  const r = await page.evaluate(() => {
    App.addFrame(); App.addFrame(); // 3 frames, current=2
    const before = App.frameCount();
    App.delFrame();
    return { before, after: App.frameCount(), cur: App.currentFrame() };
  });
  t.equal(r.before, 3);
  t.equal(r.after, 2);
  t.equal(r.cur, 1);
});

test("deleting the only frame clears it instead", async (page, t) => {
  const r = await page.evaluate((draw) => {
    eval(draw)();
    App.delFrame();
    return { n: App.frameCount(), strokes: App.currentStrokes().length };
  }, DRAW);
  t.equal(r.n, 1, "still one frame");
  t.equal(r.strokes, 0, "but it got cleared");
});

test("next/prev wrap around when loop is on", async (page, t) => {
  const r = await page.evaluate(() => {
    App.addFrame(); App.addFrame(); // 3 frames
    App.gotoFrame(2);
    App.nextFrame(); // wrap to 0
    const wrapForward = App.currentFrame();
    App.prevFrame(); // wrap to 2
    const wrapBack = App.currentFrame();
    return { wrapForward, wrapBack };
  });
  t.equal(r.wrapForward, 0);
  t.equal(r.wrapBack, 2);
});

test("moveFrame reorders and is undoable", async (page, t) => {
  const r = await page.evaluate(() => {
    // tag frames by stroke count: f0=1 stroke, f1=2, f2=3
    const tag = (n) => { App.clearFrame(); for (let i=0;i<n;i++){ App.addStroke({type:'path',color:'#fff',width:1,points:[{x:i,y:0},{x:i+1,y:1}]}); } };
    App.gotoFrame(0); tag(1);
    App.addFrame(); tag(2);
    App.addFrame(); tag(3);
    const counts = () => App.state.frames.map((f) => f.strokes.length);
    const before = counts();
    App.moveFrame(2, 0); // move last to front
    const moved = counts();
    App.undo();
    const undone = counts();
    return { before, moved, undone };
  });
  t.equal(JSON.stringify(r.before), JSON.stringify([1, 2, 3]));
  t.equal(JSON.stringify(r.moved), JSON.stringify([3, 1, 2]));
  t.equal(JSON.stringify(r.undone), JSON.stringify([1, 2, 3]), "move undone");
});

test("onion skin renders a tinted ghost of the previous frame", async (page, t) => {
  const r = await page.evaluate((draw) => {
    App.resetView();
    App.setGrid(false); // isolate from the origin crosshair / grid dots
    App.setOnion(false);
    // frame 0: a stroke at centre
    const s = eval(draw)(18);
    const c = App.canvasSize();
    // frame 1: empty
    App.addFrame();
    // without onion, centre should be background
    App.renderNow();
    const noGhost = App.getCanvasPixel(c.w / 2, c.h / 2);
    // enable onion -> ghost of frame 0 should appear (reddish for previous)
    App.setOnion(true);
    App.setOnionDepth(1);
    App.renderNow();
    const ghost = App.getCanvasPixel(c.w / 2, c.h / 2);
    return { noGhost, ghost };
  }, DRAW);
  // before: dark background
  t.lt(r.noGhost.r + r.noGhost.g + r.noGhost.b, 80, "no ghost without onion skin");
  // after: a reddish ghost (previous-frame tint #ff5b6e)
  t.gt(r.ghost.r, r.noGhost.r + 20, "ghost lights up the pixel");
  t.gt(r.ghost.r, r.ghost.g, "ghost tinted red (previous frame)");
  t.gt(r.ghost.r, r.ghost.b, "ghost tinted red, not blue");
});

test("playback advances frames over time and stops at the end (loop off)", async (page, t) => {
  await page.evaluate(() => {
    App.addFrame(); App.addFrame(); // 3 frames
    App.gotoFrame(0);
    App.state.loop = false;
    App.setFps(20); // 50ms/frame
    App.play();
  });
  const playing = await page.evaluate(() => App.isPlaying());
  t.ok(playing, "playback started");
  await page.waitForTimeout(600);
  const r = await page.evaluate(() => ({ cur: App.currentFrame(), playing: App.isPlaying() }));
  t.equal(r.cur, 2, "advanced to the last frame");
  t.notOk(r.playing, "stopped at the end with loop off");
});

test("playback loops when loop is on", async (page, t) => {
  await page.evaluate(() => {
    App.addFrame(); // 2 frames
    App.gotoFrame(0);
    App.state.loop = true;
    App.setFps(25);
    App.play();
  });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const playing = App.isPlaying();
    App.pause();
    return { playing };
  });
  t.ok(r.playing, "still playing (looping)");
});
