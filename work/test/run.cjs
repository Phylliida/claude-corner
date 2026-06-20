/* Test entry point: load every *.test.cjs in this dir, then run. */
const fs = require("fs");
const path = require("path");
const { run } = require("./harness.cjs");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.cjs")).sort();
// allow `node run.cjs camera` to run a subset
const filter = process.argv[2];
for (const f of files) {
  if (filter && !f.includes(filter)) continue;
  require(path.join(dir, f));
}

run().then((res) => {
  if (res.failCount) process.exit(1);
}).catch((e) => {
  console.error("Harness crashed:", e);
  process.exit(2);
});
