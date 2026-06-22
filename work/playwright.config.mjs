import { defineConfig, devices } from '@playwright/test';
import { readdirSync, existsSync } from 'node:fs';

const PORT = process.env.PORT || 8137;

// On NixOS the Playwright-downloaded chromium can't run (its ELF interpreter
// /lib64/ld-linux-* is absent). Use a nix-store chromium instead, resolved at
// load time. Override with CHROMIUM_PATH if needed.
function resolveChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  try {
    // Prefer the NEWEST chromium: in this sandbox /sys/devices/system/cpu is
    // absent, which crashes older Chromium even in new-headless mode; only the
    // newest build survives. CDP 1.3 is stable so the version skew vs Playwright
    // 1.61 is fine. (Verified: chromium 143 cores, 148 runs.)
    const dirs = readdirSync('/nix/store')
      .filter((d) => /-chromium-\d/.test(d) && !d.includes('sandbox'))
      .sort()
      .reverse();
    for (const d of dirs) {
      const p = `/nix/store/${d}/bin/chromium`;
      if (existsSync(p)) return p;
    }
  } catch { /* not nixos */ }
  return undefined; // fall back to Playwright's bundled browser
}
const executablePath = resolveChromium();

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 390, height: 760 }, // mobile-ish default
    trace: 'retain-on-failure',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      // '--headless=new' is appended AFTER Playwright's own '--headless' (old),
      // and last-wins in Chrome — new headless is the only mode that survives
      // this sandbox. The rest harden against the missing /dev/shm + GPU.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--enable-unsafe-swiftshader',
        '--headless=new',
      ],
    },
  },
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 800 } } },
  ],
  webServer: {
    command: `node tools/serve.mjs`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
