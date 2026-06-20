// Quick standalone smoke check (not part of the PW test runner).
// Assumes the server is running (npm run serve) or starts its own.
import { chromium } from 'playwright';
import { BASE_URL, launchOptions, waitReady, captureErrors } from './_helpers.js';

const browser = await chromium.launch(launchOptions);
const page = await browser.newPage();
const errors = captureErrors(page);

await page.goto(BASE_URL);
await waitReady(page);

const api = await page.evaluate(() => ({
  tool: window.__INFINIZOOM__.getTool(),
  count: window.__INFINIZOOM__.itemCount(),
  cam: window.__INFINIZOOM__.getCamera(),
}));
console.log('API ready:', JSON.stringify(api));

await page.evaluate(() => window.__INFINIZOOM__.addStroke([{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 0 }]));
const count = await page.evaluate(() => window.__INFINIZOOM__.itemCount());
console.log('after addStroke, count =', count);

await page.screenshot({ path: 'screenshots/smoke.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);
