// Shared helpers for both the Playwright test runner and standalone scripts.
import { readdirSync, existsSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';

export const PORT = parseInt(process.env.IZ_PORT || '8231', 10);
export const BASE_URL = process.env.IZ_URL || `http://127.0.0.1:${PORT}`;

/**
 * Prebuilt Playwright browsers can't run on NixOS (missing dynamic linker),
 * so locate a Nix-provided chromium wrapper instead. Falls back to the
 * default (works on normal Linux/macOS) when none is found.
 */
export function resolveChromium() {
  if (process.env.IZ_CHROMIUM && existsSync(process.env.IZ_CHROMIUM)) return process.env.IZ_CHROMIUM;
  const store = '/nix/store';
  if (!existsSync(store)) return undefined;
  let best = null, bestVer = -1;
  let entries = [];
  try { entries = readdirSync(store); } catch { return undefined; }
  for (const e of entries) {
    // match "<hash>-chromium-<version>" dirs that contain bin/chromium
    const m = /-chromium-(\d+)\./.exec(e);
    if (!m) continue;
    const bin = join(store, e, 'bin', 'chromium');
    if (!existsSync(bin)) continue;
    try { accessSync(bin, constants.X_OK); } catch { continue; }
    const ver = parseInt(m[1], 10);
    if (ver > bestVer) { bestVer = ver; best = bin; }
  }
  return best || undefined;
}

export const CHROMIUM_PATH = resolveChromium();

export const launchOptions = {
  executablePath: CHROMIUM_PATH,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};

// ---- in-page driving helpers (run via page.evaluate from tests) ----

/** Wait until the app's test API is ready. */
export async function waitReady(page) {
  await page.waitForFunction(() => window.__INFINIZOOM__ && window.__INFINIZOOM__.ready, { timeout: 10000 });
}

/** Fresh app state: clear storage then reload. */
export async function freshApp(page) {
  await page.goto(BASE_URL);
  await waitReady(page);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await waitReady(page);
}

/** Draw a freehand stroke through a list of [x,y] *screen* points with real mouse events. */
export async function mouseStroke(page, points, steps = 1) {
  if (!points.length) return;
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    await page.mouse.move(points[i][0], points[i][1], { steps });
  }
  await page.mouse.up();
}

/**
 * Count "ink" pixels (those differing from the background) inside a centred
 * sample window of the main canvas. Used to assert that something was actually
 * painted. Pass {grid:false} to hide the grid first so only content counts.
 */
export async function countInk(page, { sample = 600, grid = true } = {}) {
  return page.evaluate(({ sample, grid }) => {
    const app = window.app;
    const prev = app.renderer.showGrid;
    app.renderer.showGrid = grid;
    app.render();
    const c = document.getElementById('canvas');
    const ctx = c.getContext('2d');
    const sw = Math.min(c.width, sample), sh = Math.min(c.height, Math.round(sample * 0.66));
    const sx = Math.floor((c.width - sw) / 2), sy = Math.floor((c.height - sh) / 2);
    const data = ctx.getImageData(sx, sy, sw, sh).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - 14) + Math.abs(data[i + 1] - 15) + Math.abs(data[i + 2] - 19);
      if (d > 40) ink++;
    }
    app.renderer.showGrid = prev;
    app.render();
    return ink;
  }, { sample, grid });
}

/** Collect console + page errors into the returned array (call before navigation). */
export function captureErrors(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  return errors;
}
