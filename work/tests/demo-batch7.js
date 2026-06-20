// Visual showcase for batch-7 features: the stop-motion flipbook (onion skins)
// and zoom-dependent line width. Saves screenshots to screenshots/. Run with
// the server up (npm run serve).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { BASE_URL, launchOptions, waitReady, captureErrors } from './_helpers.js';

mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = captureErrors(page);
await page.goto(BASE_URL);
await waitReady(page);
await page.evaluate(() => localStorage.clear());

const shot = async (name) => {
  await page.evaluate(() => window.__INFINIZOOM__.render());
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/${name}.png` });
  console.log('  saved', name);
};

// --- flipbook: a 5-page bouncing-ball animation, viewed with onion skins ---
console.log('flipbook onion-skin showcase...');
await page.evaluate(() => {
  const A = window.__INFINIZOOM__;
  A.clear();
  A.setCamera({ x: 0, y: 0, scale: 2 });
  A.setFlipbook(true);
  A.setTool('select');
  // page 0: ball up-left
  const ball = (cx, cy) => A.addEllipse(cx - 20, cy - 20, 40, 40, { color: '#ffd43b', fill: '#ffa94d' });
  const arc = [[-120, -60], [-60, 20], [0, 50], [60, 20], [120, -60]];
  ball(arc[0][0], arc[0][1]);
  for (let i = 1; i < arc.length; i++) {
    A.duplicateFrame();           // clone previous page
    A.selectAll();
    A.deleteSelection();          // clear the clone…
    ball(arc[i][0], arc[i][1]);   // …and redraw the ball a step along the arc
  }
  A.setOnion(3);
  A.setFrame(arc.length - 1);     // last page, so all earlier pages ghost behind
});
await shot('batch7-flipbook-onion');

// --- zoom-dependent line width: world vs screen, zoomed in 6x ---
console.log('width-mode showcase...');
await page.evaluate(() => {
  const A = window.__INFINIZOOM__;
  A.setFlipbook(false);
  A.clear();
  A.setCamera({ x: 0, y: 0, scale: 6 });
  // identical base width 4; left = world (thickens with zoom), right = screen (constant)
  A.addStroke([{ x: -60, y: -60 }, { x: -60, y: 60 }], { color: '#69db7c', width: 4, widthMode: 'world' });
  A.addText(-90, -90, 'world', { color: '#69db7c', size: 12 });
  A.addStroke([{ x: 60, y: -60 }, { x: 60, y: 60 }], { color: '#4dabf7', width: 4, widthMode: 'screen' });
  A.addText(40, -90, 'screen', { color: '#4dabf7', size: 12 });
});
await shot('batch7-widthmode');

if (errors.length) { console.error('PAGE ERRORS:', errors); process.exitCode = 1; }
else console.log('no page errors');
await browser.close();
