const { test } = require("./harness.cjs");

const DRAW = `(size) => {
  const c = App.canvasSize();
  const a = App.screenToWorld(c.w/2 - 100, c.h/2);
  const b = App.screenToWorld(c.w/2 + 100, c.h/2);
  App.setSize(size||14);
  return App.drawPath([a, b], { tool: 'pen' });
}`;

test("encodeGIF emits a GIF the browser can actually decode", async (page, t) => {
  const r = await page.evaluate(async () => {
    const W = 80, H = 50;
    const mk = (color) => {
      const cv = document.createElement("canvas");
      cv.width = W; cv.height = H;
      const c = cv.getContext("2d");
      c.fillStyle = "#0d0f15"; c.fillRect(0, 0, W, H);
      c.fillStyle = color; c.fillRect(10, 10, 40, 20);
      return cv;
    };
    const frames = [mk("#ff3030"), mk("#30ff30"), mk("#3040ff")];
    const bytes = window.encodeGIF(frames, 8, W, H);
    const blob = new Blob([bytes], { type: "image/gif" });
    const url = URL.createObjectURL(blob);
    const dims = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res({ ok: true, w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => res({ ok: false });
      im.src = url;
    });
    return {
      header: String.fromCharCode(...bytes.slice(0, 6)),
      trailer: bytes[bytes.length - 1],
      len: bytes.length,
      dims,
    };
  });
  t.equal(r.header, "GIF89a", "valid GIF89a signature");
  t.equal(r.trailer, 0x3b, "GIF trailer byte present");
  t.gt(r.len, 100, "non-trivial payload");
  t.ok(r.dims.ok, "browser decoded the GIF without error");
  t.equal(r.dims.w, 80, "decoded width matches");
  t.equal(r.dims.h, 50, "decoded height matches");
});

test("GIF export button renders frames and reports success", async (page, t) => {
  await page.evaluate((draw) => {
    App.resetView();
    eval(draw)();
    App.addFrame();
    eval(draw)();
  }, DRAW);
  await page.click("#exportGif");
  await page.waitForFunction(
    () => document.getElementById("toast").textContent === "Exported GIF",
    { timeout: 8000 }
  );
  t.ok(true, "export completed and toast confirmed success");
});

test("PNG export triggers a .png download", async (page, t) => {
  await page.evaluate((draw) => { App.resetView(); eval(draw)(); }, DRAW);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }),
    page.click("#exportPng"),
  ]);
  t.ok(/\.png$/.test(download.suggestedFilename()), "filename ends in .png");
});

test("JSON export triggers a .json download with valid project data", async (page, t) => {
  await page.evaluate((draw) => { App.resetView(); eval(draw)(); App.addFrame(); }, DRAW);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }),
    page.click("#exportJson"),
  ]);
  t.ok(/\.json$/.test(download.suggestedFilename()), "filename ends in .json");
  const stream = await download.createReadStream();
  let body = "";
  for await (const chunk of stream) body += chunk;
  const data = JSON.parse(body);
  t.equal(data.frames.length, 2, "exported JSON has both frames");
});
