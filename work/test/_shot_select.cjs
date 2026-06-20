// Visual check for the selection overlay: draws a little scene, selects a few
// strokes with the select tool, and captures both a settled-selection shot and
// an in-progress crossing-marquee shot.
const { launch, indexUrl } = require("./env.cjs");
const path = require("path");
(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(indexUrl());
  await p.waitForFunction(() => document.body.dataset.ready === "1");
  await p.evaluate(() => {
    App.clearStorage();
    App.resetView(); App.setOnion(false);
    App.setColor("#34d2ff"); App.setSize(8);
    App.drawPath([[-200, -60], [-120, -120], [-40, -60], [40, -120], [120, -60]].map(([x, y]) => ({ x, y })), { tool: "pen" });
    App.setColor("#ffd166"); App.setSize(14);
    App.drawPath([{ x: -160, y: 80 }, { x: 160, y: 80 }], { tool: "line" });
    App.setColor("#ff6b6b"); App.setSize(6);
    App.addStroke({ type: "ellipse", color: "#ff6b6b", width: 6 / App.getZoom(), points: [{ x: -90, y: -20 }, { x: 90, y: 150 }] });
    App.setColor("#7cfc8a"); App.setSize(5);
    App.drawPath([{ x: 180, y: -140 }, { x: 320, y: -10 }], { tool: "pen" });
    App.fitView();
    App.setTool("select");
    // select the wavy pen line + the yellow rule
    const strokes = App.currentStrokes();
    App.selectIds([strokes[0].id, strokes[1].id]);
    App.renderNow();
  });
  await p.waitForTimeout(150);
  await p.screenshot({ path: path.resolve(__dirname, "..", "selection_demo.png") });
  console.log("selection_demo.png saved (settled selection: bbox + 8 handles)");

  // Now show an in-progress crossing marquee (right→left) mid-drag.
  const geom = await p.evaluate(() => {
    App.clearSelection();
    const c = App.canvasSize();
    return { rect: document.getElementById("board").getBoundingClientRect(), w: c.w, h: c.h };
  });
  const R = geom.rect;
  // start at the right, drag leftwards = crossing (dashed green)
  await p.mouse.move(R.left + geom.w * 0.78, R.top + geom.h * 0.30);
  await p.mouse.down();
  await p.mouse.move(R.left + geom.w * 0.30, R.top + geom.h * 0.70, { steps: 8 });
  await p.waitForTimeout(80);
  await p.screenshot({ path: path.resolve(__dirname, "..", "crossing_marquee.png") });
  await p.mouse.up();
  console.log("crossing_marquee.png saved (in-progress crossing drag: dashed green)");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
