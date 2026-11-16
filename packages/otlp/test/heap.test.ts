import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Heap high-water test (SPEC-003 N1.3 review F6). Each worst-case-density body is decoded at
 * DEFAULT limits in a fresh child process (so one case cannot hide behind another's garbage),
 * with a hard V8 old-space cap. The child reports `maxRSS`, the peak resident set of the whole
 * process, which includes every transient allocation of the decode. Measured numbers are in the
 * package README ("Memory high-water"); the bounds here are deliberately generous (about 2x the
 * measurement) so a slow or busy machine does not flake, yet an order-of-magnitude regression
 * fails.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const child = path.join(here, "heap-child.js");

const CASES: readonly (readonly [string, string, number])[] = [
  // [case, expected outcome, max peak RSS in MB]
  ["proto-attributes", "ok", 900],
  ["proto-unknown-flood", "ok", 400],
  ["proto-many-spans", "ok", 400],
  ["proto-nested-arrays", "ok", 450],
  ["json-attributes", "ok", 700],
  ["json-flat-array", "ok", 300],
  ["json-many-spans", "too-many-values", 400],
];

for (const [name, outcome, maxRss] of CASES) {
  test(`heap high-water: ${name} stays under ${maxRss} MB peak RSS`, () => {
    const r = spawnSync(process.execPath, ["--max-old-space-size=1024", child, name], {
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(r.status, 0, `child failed: ${r.stderr.slice(0, 300)}`);
    const m = JSON.parse(r.stdout) as {
      outcome: string;
      maxRssMB: number;
      ms: number;
      bodyMB: number;
    };
    console.log(`  ${name}: body ${m.bodyMB} MB, ${m.ms} ms, peak RSS ${m.maxRssMB} MB`);
    assert.equal(m.outcome, outcome);
    assert.ok(m.maxRssMB < maxRss, `${name}: peak RSS ${m.maxRssMB} MB`);
    assert.ok(m.ms < 30_000, `${name}: ${m.ms} ms`);
  });
}
