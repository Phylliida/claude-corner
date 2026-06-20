/* Tiny test harness built on the Playwright core library (no @playwright/test).
 *
 * Usage:
 *   const { suite, test, run } = require("./harness.cjs");
 *   test("does a thing", async (page, t) => { t.equal(1+1, 2); });
 *   run();   // discovers nothing on its own; require test files first.
 */
const { launch, indexUrl } = require("./env.cjs");

const tests = [];
let only = false;

function test(name, fn, opts) {
  tests.push({ name, fn, opts: opts || {} });
}
test.only = function (name, fn, opts) {
  only = true;
  tests.push({ name, fn, opts: Object.assign({ only: true }, opts) });
};
test.skip = function (name) { tests.push({ name, skip: true }); };

function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps == null ? 1e-6 : eps);
}

function makeAsserts(ctx) {
  let count = 0;
  const fail = (msg) => { throw new Error(msg); };
  const A = {
    get checks() { return count; },
    ok(v, msg) { count++; if (!v) fail(msg || `expected truthy, got ${v}`); },
    notOk(v, msg) { count++; if (v) fail(msg || `expected falsy, got ${v}`); },
    equal(a, b, msg) { count++; if (a !== b) fail(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); },
    notEqual(a, b, msg) { count++; if (a === b) fail(msg || `expected != ${JSON.stringify(b)}`); },
    approx(a, b, eps, msg) { count++; if (!approx(a, b, eps)) fail(msg || `expected ~${b} (±${eps}), got ${a}`); },
    gt(a, b, msg) { count++; if (!(a > b)) fail(msg || `expected ${a} > ${b}`); },
    gte(a, b, msg) { count++; if (!(a >= b)) fail(msg || `expected ${a} >= ${b}`); },
    lt(a, b, msg) { count++; if (!(a < b)) fail(msg || `expected ${a} < ${b}`); },
    between(a, lo, hi, msg) { count++; if (!(a >= lo && a <= hi)) fail(msg || `expected ${a} in [${lo}, ${hi}]`); },
  };
  return A;
}

async function freshPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => { ctxErrors.push("pageerror: " + e.message); });
  page.on("console", (m) => { if (m.type() === "error") ctxErrors.push("console.error: " + m.text()); });
  await page.goto(indexUrl());
  await page.waitForFunction(() => document.body.dataset.ready === "1", { timeout: 8000 });
  // deterministic: wipe storage and reload so each test starts clean
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} window.App.clearStorage(); });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1", { timeout: 8000 });
  return page;
}

let ctxErrors = [];

async function run() {
  const browser = await launch();
  let pass = 0, failCount = 0, skip = 0;
  const failures = [];
  const started = Date.now();
  console.log(`\nRunning ${tests.length} test(s) with Chromium…\n`);

  for (const t of tests) {
    if (only && !t.opts.only) { skip++; continue; }
    if (t.skip) { console.log(`  ⊘ ${t.name} (skipped)`); skip++; continue; }
    ctxErrors = [];
    let page;
    const t0 = Date.now();
    try {
      page = await freshPage(browser);
      const A = makeAsserts();
      await t.fn(page, A);
      if (ctxErrors.length && !t.opts.allowErrors) {
        throw new Error("page produced errors:\n    " + ctxErrors.join("\n    "));
      }
      const ms = Date.now() - t0;
      console.log(`  ✓ ${t.name}  (${A.checks} checks, ${ms}ms)`);
      pass++;
    } catch (err) {
      const ms = Date.now() - t0;
      console.log(`  ✗ ${t.name}  (${ms}ms)`);
      console.log(`      ${String(err.message).split("\n").join("\n      ")}`);
      failures.push({ name: t.name, err });
      failCount++;
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  await browser.close();
  const total = Date.now() - started;
  console.log(`\n${pass} passed, ${failCount} failed, ${skip} skipped  (${total}ms)\n`);
  if (failCount) process.exitCode = 1;
  return { pass, failCount, skip };
}

module.exports = { test, run, indexUrl };
