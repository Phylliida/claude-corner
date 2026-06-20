const { launch, indexUrl } = require("./env.cjs");
(async () => {
  const b = await launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(indexUrl());
  await p.waitForFunction(() => document.body.dataset.ready === "1");
  await p.evaluate(() => {
    App.clearStorage();
    App.resetView();
    // doodle a little scene across a couple of frames
    const C = App.canvasSize();
    App.setColor("#34d2ff"); App.setSize(8);
    App.drawPath([[ -200,-60],[ -120,-120],[ -40,-60],[40,-120],[120,-60]].map(([x,y])=>({x,y})), {tool:"pen"});
    App.setColor("#ffd166"); App.setSize(14);
    App.drawPath([{x:-160,y:80},{x:160,y:80}], {tool:"line"});
    App.setColor("#ff6b6b"); App.setSize(6);
    App.addStroke({type:"ellipse",color:"#ff6b6b",width:6/App.getZoom(),points:[{x:-90,y:-20},{x:90,y:150}]});
    App.setColor("#7CFC8A"); App.setSize(5);
    App.addStroke({type:"rect",color:"#7CFC8A",width:5/App.getZoom(),points:[{x:-220,y:-160},{x:220,y:180}]});
    App.addFrame();
    App.setColor("#c792ea"); App.setSize(10);
    App.drawPath([{x:-100,y:0},{x:100,y:0}], {tool:"pen"});
    App.setFrameHold(1, 3);   // show the ×3 hold badge
    App.gotoFrame(0);
    App.setOnion(true);
    App.fitView();
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: require("path").resolve(__dirname, "..", "screenshot.png") });
  console.log("screenshot saved");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
