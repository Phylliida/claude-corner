const { test } = require("./harness.cjs");

test("frames default to a hold of 1", async (page, t) => {
  const r = await page.evaluate(() => {
    App.addFrame();
    return { h0: App.getFrameHold(0), h1: App.getFrameHold(1) };
  });
  t.equal(r.h0, 1);
  t.equal(r.h1, 1);
});

test("setFrameHold clamps to [1, 99] and updates the badge text", async (page, t) => {
  const r = await page.evaluate(() => {
    App.setFrameHold(0, 5);
    const five = App.getFrameHold(0);
    App.setFrameHold(0, 0);   // clamp low
    const low = App.getFrameHold(0);
    App.setFrameHold(0, 999); // clamp high
    const high = App.getFrameHold(0);
    App.setFrameHold(0, 3);
    const badge = document.getElementById("holdOut").textContent;
    return { five, low, high, badge };
  });
  t.equal(r.five, 5);
  t.equal(r.low, 1, "clamped to >= 1");
  t.equal(r.high, 99, "clamped to <= 99");
  t.equal(r.badge, "×3", "current-frame hold shown");
});

test("duplicate frame carries the hold value over", async (page, t) => {
  const r = await page.evaluate(() => {
    App.setFrameHold(0, 4);
    App.dupFrame();
    return { dup: App.getFrameHold(App.currentFrame()) };
  });
  t.equal(r.dup, 4);
});

test("GIF per-frame delays reflect hold * base frame time", async (page, t) => {
  const r = await page.evaluate(() => {
    App.addFrame(); App.addFrame(); // 3 frames
    App.setFps(10);                 // base = 10cs / frame
    App.setFrameHold(0, 1);
    App.setFrameHold(1, 3);
    App.setFrameHold(2, 2);
    return App.frameDelaysCs();
  });
  t.equal(JSON.stringify(r), JSON.stringify([10, 30, 20]), "delays = hold * (100/fps)");
});

test("a held frame stays on screen longer during playback", async (page, t) => {
  await page.evaluate(() => {
    App.addFrame(); // 2 frames
    App.gotoFrame(0);
    App.state.loop = false;
    App.setFps(20);          // base ~50ms
    App.setFrameHold(0, 5);  // hold frame 0 for ~250ms
    App.play();
  });
  // shortly after starting we should still be on frame 0 (it's held)
  await page.waitForTimeout(120);
  const early = await page.evaluate(() => App.currentFrame());
  // after the hold elapses we should have advanced
  await page.waitForTimeout(300);
  const later = await page.evaluate(() => { const f = App.currentFrame(); App.pause(); return f; });
  t.equal(early, 0, "still on the held frame early on");
  t.equal(later, 1, "advanced once the hold elapsed");
});

test("hold values persist across reload", async (page, t) => {
  await page.evaluate(() => {
    App.addFrame();
    App.setFrameHold(0, 6);
    App.setFrameHold(1, 2);
    App.save();
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  const r = await page.evaluate(() => ({ h0: App.getFrameHold(0), h1: App.getFrameHold(1) }));
  t.equal(r.h0, 6);
  t.equal(r.h1, 2);
});

test("GIF with per-frame holds still decodes in the browser", async (page, t) => {
  const r = await page.evaluate(async () => {
    const W = 60, H = 40;
    const mk = (color) => {
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const c = cv.getContext("2d"); c.fillStyle = "#111"; c.fillRect(0, 0, W, H);
      c.fillStyle = color; c.fillRect(8, 8, 30, 16); return cv;
    };
    const bytes = window.encodeGIF([mk("#f00"), mk("#0f0")], [10, 40], W, H);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
    const ok = await new Promise((res) => { const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false); im.src = url; });
    return { ok, header: String.fromCharCode(...bytes.slice(0, 6)) };
  });
  t.equal(r.header, "GIF89a");
  t.ok(r.ok, "variable-delay GIF decodes");
});
