/* Resolves Playwright + a usable Chromium executable in this sandbox.
 *
 * Why this exists: the npx-cached Playwright ships a chrome-headless-shell that
 * is dynamically linked against /lib64/ld-linux-x86-64.so.2, which does not
 * exist on NixOS — so it fails to spawn (ENOENT). Instead we point Playwright
 * at a nix-store-provided, properly-wrapped chromium via executablePath.
 *
 * Both the playwright module path and the chromium path are discovered at
 * runtime so the suite keeps working across spawns even if store hashes change.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function firstExisting(paths) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function resolvePlaywright() {
  // 1) plain require (works via the node_modules symlink in work/)
  try { return require("playwright"); } catch (e) {}
  // 2) probe known npx cache locations
  const home = process.env.HOME || "/home/bepis";
  const npxRoot = path.join(home, ".npm", "_npx");
  try {
    for (const dir of fs.readdirSync(npxRoot)) {
      const cand = path.join(npxRoot, dir, "node_modules", "playwright");
      if (fs.existsSync(cand)) return require(cand);
    }
  } catch (e) {}
  throw new Error("Could not resolve the 'playwright' module");
}

function resolveChromium() {
  if (process.env.INFINITEDRAW_CHROMIUM && fs.existsSync(process.env.INFINITEDRAW_CHROMIUM)) {
    return process.env.INFINITEDRAW_CHROMIUM;
  }
  // Prefer wrapped chromium binaries that have correct loaders.
  let candidates = [];
  try {
    const out = execSync(
      "ls -d /nix/store/*chromium*/bin/chromium 2>/dev/null; ls -d /nix/store/*google-chrome*/bin/google-chrome-stable 2>/dev/null",
      { encoding: "utf8" }
    );
    candidates = out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {}
  // Sort so plain "chromium-<ver>" (the wrapped runnable) beats "-sandbox" helpers.
  candidates.sort((a, b) => {
    const score = (p) => (p.includes("-sandbox") ? 1 : 0) + (p.includes("unwrapped") ? 1 : 0);
    return score(a) - score(b);
  });
  const found = firstExisting(candidates);
  if (!found) throw new Error("No nix-store chromium found. Set INFINITEDRAW_CHROMIUM.");
  return found;
}

function indexUrl() {
  return "file://" + path.resolve(__dirname, "..", "index.html");
}

async function launch(opts) {
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({
    executablePath: resolveChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
    ...(opts || {}),
  });
  return browser;
}

module.exports = { resolvePlaywright, resolveChromium, indexUrl, launch };
