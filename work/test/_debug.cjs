const { launch, indexUrl } = require("./env.cjs");
(async () => {
  const b = await launch();
  const p = await b.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message + "\n" + (e.stack || "")));
  p.on("console", (m) => errs.push("CONSOLE[" + m.type() + "]: " + m.text()));
  await p.goto(indexUrl(), { waitUntil: "load" });
  await p.waitForTimeout(800);
  const info = await p.evaluate(() => ({
    ready: document.body.dataset.ready,
    hasApp: typeof window.App,
    hasGif: typeof window.encodeGIF,
    title: document.title,
    bodyChildren: document.body.children.length,
  }));
  console.log("INFO", JSON.stringify(info, null, 2));
  console.log("ERRORS:\n" + (errs.join("\n") || "(none)"));
  await b.close();
})().catch((e) => { console.error("DBG FAIL", e); process.exit(1); });
