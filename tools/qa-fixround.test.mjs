// Independent G2 (QA) re-verification of the S1 fix round (RF1-RF6, F5-F7): new bypass variants
// of each fix. Expected outcomes come from SPEC-001 sections 2 and 3.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalTarball, checkLockfile } from "./lockfile-check.mjs";
import { checkFile, PACKAGE_NAMES, rulesFor, scanTree } from "./policy-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE = "packages/core/src/x.ts";

function rules(text, file = CORE) {
  return [...new Set(checkFile(file, text, rulesFor(file)).map((f) => f.rule))].sort();
}

// ---- RF2: Math ---------------------------------------------------------------
const mathBad = [
  "export const r = Math?.random();",
  "export const r = ({ Math }).Math.random();",
  "export const r = Object.assign({}, Math);",
  "export const r = Math['ran' + 'dom']();",
  "export const r = Math['\\u0072andom']();",
  "export const r = Math[`random`]();",
  "export const r = Math[`ran$" + "{'dom'}`]();",
  "export const r = (0, Math).random();",
  "for (const k in Math) { k; }",
  "export const r = [Math][0].random();",
  "const m = Math; export { m };",
  "export const r = Math.random;",
  "export const r = (Math satisfies object).random();",
  "export const r = (<any>Math).random();",
  "export const r = Math!['random']();",
  "export const { random: r } = Math;",
  "export const { ['random']: r } = Math;",
  "export const r = Math.max['bind'](Math);",
  "export const r = (Math as { random(): number }).random();",
  "const { random } = Math; export { random };",
  "export const r = ((Math)).random();",
];
for (const t of mathBad) {
  test(`RF2 caught: ${t}`, () => {
    assert.ok(rules(t).includes("P-RANDOM"), t);
  });
}
for (const t of [
  "export const r = Math.max(1, 2) + Math.floor(1.5) + Math.PI;",
  "export const r = Math?.max(1, 2);",
  "export const r = Math['max'](1, 2);",
  "export const r = Math.max.call(null, 1);",
  "export type T = typeof Math;",
]) {
  test(`RF2 no false positive: ${t}`, () => {
    assert.deepEqual(rules(t), []);
  });
}

// ---- RF1: Date -----------------------------------------------------------------
for (const t of [
  "export const r = new Date(...[0]);",
  "export const r = new (Date)();",
  "export const r = new Date;",
  "export const r = new Date(0, ...[]);",
  "export const r = new (Date as any)(0);",
  "export const r = new Date(...[], 0);",
  "export const r = new Date?.(0);",
  "export const r = Reflect.construct(Date, []);",
  "export const D = [Date][0];",
  "export const r = (Date.UTC)(1970, 0);",
  "export const r = Date.now();",
  "export const r = new Date(1, 2);",
  "export const r = Date<number>;",
]) {
  test(`RF1 caught: ${t}`, () => {
    assert.ok(rules(t).includes("P-DATE") || rules(t).includes("P-IDENT"), t);
  });
}
for (const t of [
  "export const r = new Date(0);",
  "export const r = new Date(undefined);",
  "export const r = new Date(Date.UTC(2020, 0, 1)).toISOString();",
  "export function f(x: Date): Date { return x; }",
]) {
  test(`RF1 allowed: ${t}`, () => {
    assert.deepEqual(rules(t), []);
  });
}

// ---- RF3/RF4/RF7 spot checks (instantiation, locale destructuring, string export names) ----
for (const [t, rule] of [
  ["export const e = eval<string>;", "P-IDENT"],
  ["export const p = process<string>;", "P-PROCESS"],
  ["export const g = (globalThis as object)<string>;", "P-IDENT"],
  ["const { localeCompare } = 'a'; export { localeCompare };", "P-LOCALE"],
  ["const { 'localeCompare': c } = 'a'; export { c };", "P-LOCALE"],
  ["const { toLocaleString: s } = 1; export { s };", "P-LOCALE"],
  ["import { 'randomUUID' as r } from 'node:crypto'; export { r };", "P-RANDOM"],
  ["export { 'a' as 'b' } from 'node:fs';", "P-IMPORT"],
  ["import * as c from 'node:crypto'; export { c };", "P-IMPORT"],
]) {
  test(`caught: ${t}`, () => {
    assert.ok(rules(t).includes(rule), `${t} -> ${rules(t)}`);
  });
}

test("a throwing/odd input never crashes checkFile (syntax errors, empty file, BOM, huge line)", () => {
  for (const t of ["", "﻿export const a = 1;", "export const a = ;;;", "@@@", "x".repeat(200_000)]) {
    assert.doesNotThrow(() => rules(t));
  }
});

// ---- RF5: scanTree completeness ---------------------------------------------------
function tree() {
  const root = mkdtempSync(path.join(tmpdir(), "atm-qa-rf5-"));
  for (const pkg of PACKAGE_NAMES) {
    mkdirSync(path.join(root, "packages", pkg, "src"), { recursive: true });
    mkdirSync(path.join(root, "packages", pkg, "dist", "src"), { recursive: true });
    writeFileSync(path.join(root, "packages", pkg, "src", "ok.ts"), "export const ok = 1;\n");
    writeFileSync(
      path.join(root, "packages", pkg, "dist", "src", "ok.js"),
      "export const ok = 1;\n",
    );
  }
  return root;
}
const summary = (root) => scanTree(root).map((f) => `${f.file}:${f.rule}`);

test("RF5: symlinked dist/src is scanned through the link (hostile content still found)", () => {
  const root = tree();
  const outside = mkdtempSync(path.join(tmpdir(), "atm-qa-rf5-out-"));
  try {
    rmSync(path.join(root, "packages/core/dist/src"), { recursive: true });
    writeFileSync(path.join(outside, "ok.js"), "export const ok = eval('1');\n");
    symlinkSync(outside, path.join(root, "packages/core/dist/src"), "dir");
    assert.deepEqual(summary(root), ["packages/core/dist/src/ok.js:P-IDENT"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("RF5: dangling symlink as dist/src or src does not pass silently", () => {
  const root = tree();
  try {
    rmSync(path.join(root, "packages/core/dist/src"), { recursive: true });
    symlinkSync(path.join(root, "nowhere"), path.join(root, "packages/core/dist/src"), "dir");
    let out;
    try {
      out = summary(root);
    } catch {
      out = "threw"; // failing closed with an exception is acceptable
    }
    assert.notDeepEqual(out, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RF5: a symlinked .js file in dist/src pointing at hostile code is scanned", () => {
  const root = tree();
  const outside = mkdtempSync(path.join(tmpdir(), "atm-qa-rf5-out-"));
  try {
    writeFileSync(path.join(outside, "evil.js"), "export const e = Function('return 1');\n");
    writeFileSync(path.join(root, "packages/core/src/evil.ts"), "export const e = 1;\n");
    symlinkSync(path.join(outside, "evil.js"), path.join(root, "packages/core/dist/src/evil.js"));
    assert.deepEqual(summary(root), ["packages/core/dist/src/evil.js:P-IDENT"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("RF5: dist/src with only .d.ts / maps, or only an empty subdirectory, is P-MISSING", () => {
  const root = tree();
  try {
    rmSync(path.join(root, "packages/cli/dist/src/ok.js"));
    writeFileSync(path.join(root, "packages/cli/dist/src/ok.d.ts"), "export {};\n");
    mkdirSync(path.join(root, "packages/cli/dist/src/sub"));
    assert.deepEqual(summary(root), ["packages/cli/dist/src:P-MISSING"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RF5: src containing only a nested empty directory is P-MISSING", () => {
  const root = tree();
  try {
    rmSync(path.join(root, "packages/core/src/ok.ts"));
    mkdirSync(path.join(root, "packages/core/src/empty"));
    assert.ok(summary(root).includes("packages/core/src:P-MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RF5: hostile file names in a missing-tree report are control-escaped by formatFinding", async () => {
  const { formatFinding } = await import("./policy-check.mjs");
  assert.ok(
    !formatFinding({ file: "a\u001b[2J", line: 1, col: 1, rule: "P-MISSING" }).includes("\u001b"),
  );
});

// ---- RF6: lockfile tarball / integrity pin -------------------------------------------
const lock = JSON.parse(readFileSync(path.join(here, "..", "package-lock.json"), "utf8"));
const closure = JSON.parse(readFileSync(path.join(here, "expected-lock-closure.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const thirdParty = Object.keys(lock.packages).filter(
  (k) => k.startsWith("node_modules/") && !k.startsWith("node_modules/@swain/"),
);
const codes = (l) => checkLockfile(l, closure).map((f) => f.code);

test("RF6: the real lockfile passes", () => {
  assert.deepEqual(codes(lock), []);
});

test("RF6: tampered resolved URL forms are all rejected (scoped and unscoped)", () => {
  const scoped = thirdParty.find((k) => k.includes("node_modules/@")) ?? thirdParty[0];
  const plain =
    thirdParty.find((k) => !k.slice("node_modules/".length).startsWith("@")) ?? thirdParty[0];
  for (const key of [scoped, plain]) {
    const e = lock.packages[key];
    const good = e.resolved;
    const mutations = [
      `${good}?x=1`,
      `${good}#frag`,
      `${good}/`,
      good.replace("registry.npmjs.org", "REGISTRY.npmjs.org"),
      good.replace("https://registry.npmjs.org/", "https://registry.npmjs.org//"),
      good.replace("/-/", "/%2d/"),
      good.replace(".tgz", ".TGZ"),
      good.replace("/-/", "/../x/-/"),
      good.replace("https://registry.npmjs.org/", "https://registry.npmjs.org/evil/../"),
      good.replace("https://registry.npmjs.org/", "https://registry.npmjs.org:443/"),
      good.replace("https://registry.npmjs.org/", "https://registry.npmjs.org@evil.example/"),
      good.replace("https://registry.npmjs.org/", "https://registry.npmjs.org.evil.example/"),
      `${good}\n`,
      [" ", good].join(""),
      good.replace(e.version, "0.0.1"),
      good.replace(/-[^/-]+\.tgz$/, "-x.tgz"),
    ];
    for (const m of mutations) {
      const l = clone(lock);
      l.packages[key].resolved = m;
      assert.notDeepEqual(codes(l), [], `${key}: ${JSON.stringify(m)}`);
    }
    // also: canonical URL for a different name
    assert.notEqual(canonicalTarball("a", "1.0.0"), canonicalTarball("b", "1.0.0"));
  }
});

test("RF6: missing, wrong-algorithm, truncated or changed integrity is rejected", () => {
  const key = thirdParty[0];
  for (const m of [undefined, "sha1-AAAA", "sha256-AAAA", "", 5, null, "sha512-AAAA"]) {
    const l = clone(lock);
    if (m === undefined) delete l.packages[key].integrity;
    else l.packages[key].integrity = m;
    assert.notDeepEqual(codes(l), [], String(m));
  }
  // flipping one character of a real sha512 is caught by the pin
  const l = clone(lock);
  const i = l.packages[key].integrity;
  l.packages[key].integrity = i.slice(0, -4) + (i.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
  assert.ok(codes(l).includes("L-INTEGRITY-PIN"));
});

test("RF6: alias (name field), added/removed packages, link flag, forbidden refs and extra @swain are rejected", () => {
  const key = thirdParty[0];
  let l = clone(lock);
  l.packages[key].name = "left-pad";
  assert.ok(codes(l).includes("L-ALIAS"));
  l = clone(lock);
  l.packages["node_modules/evil"] = {
    version: "1.0.0",
    resolved: canonicalTarball("evil", "1.0.0"),
    integrity: lock.packages[key].integrity,
  };
  assert.ok(codes(l).includes("L-CLOSURE"));
  l = clone(lock);
  delete l.packages[key];
  assert.ok(codes(l).includes("L-CLOSURE"));
  l = clone(lock);
  l.packages[key].link = true;
  assert.ok(codes(l).includes("L-LINK"));
  l = clone(lock);
  l.packages[key].dependencies = { x: "git+https://example.invalid/x.git" };
  assert.ok(codes(l).includes("L-FORBIDDEN-REF"));
  l = clone(lock);
  l.packages["node_modules/@swain/evil"] = { version: "0.0.0" };
  assert.ok(codes(l).includes("L-SWAIN-LINK"));
  l = clone(lock);
  l.packages["node_modules/x/node_modules/@swain/core"] = {
    version: "0.0.0",
    resolved: "https://registry.npmjs.org/@swain/core/-/core-0.0.0.tgz",
    integrity: "sha512-AAAA",
  };
  assert.ok(codes(l).includes("L-SWAIN-LINK"));
  l = clone(lock);
  l.lockfileVersion = 2;
  assert.ok(codes(l).includes("L-LOCKVER"));
  l = clone(lock);
  l.packages["vendor/x"] = { version: "1.0.0" };
  assert.ok(codes(l).includes("L-UNCLASSIFIED"));
  l = clone(lock);
  l.packages[key] = "string";
  assert.ok(codes(l).includes("L-UNCLASSIFIED"));
});

test("RF6: __proto__/constructor package names in closure maps cannot hide a package", () => {
  const l = clone(lock);
  l.packages["node_modules/constructor"] = {
    version: "1.0.0",
    resolved: canonicalTarball("constructor", "1.0.0"),
    integrity: "sha512-AAAA",
  };
  assert.ok(codes(l).includes("L-CLOSURE"));
  const l2 = clone(lock);
  l2.packages["node_modules/toString"] = {
    version: "1.0.0",
    resolved: canonicalTarball("toString", "1.0.0"),
    integrity: "sha512-AAAA",
  };
  assert.ok(codes(l2).includes("L-CLOSURE"));
});
