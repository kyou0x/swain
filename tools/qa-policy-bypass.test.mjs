// Independent G2 (QA) policy-check tests: extra bypass attempts beyond fixtures 1-11, false
// positive guards, and characterization of known residual gaps. Gaps that contradict an explicit
// SPEC-001 rule live in tools/qa-failing-policy.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkFile, PACKAGE_NAMES, rulesFor, scanTree } from "./policy-check.mjs";

const CORE = "packages/core/src/x.ts";
const CLI = "packages/cli/src/main.ts";
const BIN = "packages/cli/src/bin.ts";
const DIST_BIN = "packages/cli/dist/src/bin.js";
const DIST_CORE = "packages/core/dist/src/x.js";

function rules(file, text) {
  return [...new Set(checkFile(file, text, rulesFor(file)).map((f) => f.rule))].sort();
}

/** [label, file, source, expected rule set (exact)] */
const caught = [
  ["optional chaining process?.env", CORE, "export const a = process?.env;", ["P-PROCESS"]],
  ["optional element process?.['env']", CORE, "export const a = process?.['env'];", ["P-PROCESS"]],
  ["process in cli non-bin", CLI, "export const a = process.argv;", ["P-PROCESS"]],
  ["process shadow declaration", CORE, "export const process = 1;", ["P-PROCESS"]],
  [
    "import type from node:fs",
    CORE,
    "import type { Stats } from 'node:fs'; export type T = Stats;",
    ["P-IMPORT"],
  ],
  [
    "mixed type+value import from node:crypto",
    CORE,
    "import { createHash, type Hash } from 'node:crypto'; export const h = createHash;",
    ["P-RANDOM"],
  ],
  [
    "import type from node:crypto (type-only imports still subject to the allowlist)",
    CORE,
    "import type { Hash } from 'node:crypto'; export type T = Hash;",
    ["P-RANDOM"],
  ],
  [
    "namespace import of node:crypto",
    CORE,
    "import * as c from 'node:crypto'; export const h = c;",
    ["P-IMPORT"],
  ],
  [
    "default import of node:crypto",
    CORE,
    "import c from 'node:crypto'; export const h = c;",
    ["P-IMPORT"],
  ],
  ["side-effect import of node:crypto", CORE, "import 'node:crypto';", ["P-IMPORT"]],
  [
    "renamed randomUUID",
    CORE,
    "import { randomUUID as ok } from 'node:crypto'; export const h = ok;",
    ["P-RANDOM"],
  ],
  [
    "export {x as default} from node:fs",
    CORE,
    "export { readFileSync as default } from 'node:fs';",
    ["P-IMPORT"],
  ],
  ["export * as ns from node:crypto", CORE, "export * as c from 'node:crypto';", ["P-IMPORT"]],
  [
    "export {createHash} from node:crypto (re-export not allowed)",
    CORE,
    "export { createHash } from 'node:crypto';",
    ["P-IMPORT"],
  ],
  [
    "import x = require(node:crypto)",
    CORE,
    "import c = require('node:crypto'); export const x = c;",
    ["P-IMPORT"],
  ],
  [
    "import type via import() type node",
    CORE,
    "export type T = import('node:fs').Stats;",
    ["P-IMPORT"],
  ],
  [
    "bare builtin without node: prefix",
    CORE,
    "import fs from 'fs'; export const a = fs;",
    ["P-IMPORT"],
  ],
  [
    "specifier with trailing slash",
    CORE,
    "import c from 'node:crypto/'; export const a = c;",
    ["P-IMPORT"],
  ],
  ["specifier case change", CORE, "import c from 'NODE:crypto'; export const a = c;", ["P-IMPORT"]],
  [
    "specifier with unicode-escape spelling of node:fs",
    CORE,
    "import c from '\\u006eode:fs'; export const a = c;",
    ["P-IMPORT"],
  ],
  [
    "backslash relative specifier",
    CORE,
    "import c from '..\\\\test\\\\x.js'; export const a = c;",
    ["P-IMPORT"],
  ],
  [
    "relative that normalizes outside src",
    CORE,
    "import c from './sub/../../../x.js'; export const a = c;",
    ["P-RELATIVE"],
  ],
  ["bare '..' import", CORE, "import c from '..'; export const a = c;", ["P-RELATIVE"]],
  [
    "core importing @swain/core (only cli may)",
    CORE,
    "import { deriveId } from '@swain/core'; export const a = deriveId;",
    ["P-IMPORT"],
  ],
  [
    "cli importing node:crypto",
    CLI,
    "import { createHash } from 'node:crypto'; export const a = createHash;",
    ["P-IMPORT"],
  ],
  [
    "cli importing look-alike @swain/core-evil",
    CLI,
    "import x from '@swain/core-evil'; export const a = x;",
    ["P-IMPORT"],
  ],
  [
    "cli importing @swain/cli sibling package",
    CLI,
    "import x from '@swain/other'; export const a = x;",
    ["P-IMPORT"],
  ],
  [
    "dynamic import of relative file",
    CORE,
    "export const a = async () => import('./y.js');",
    ["P-DYNIMPORT"],
  ],
  [
    "await import with template",
    CORE,
    "export const a = async () => await import(`./y.js`);",
    ["P-DYNIMPORT"],
  ],
  ["import.meta.url", CORE, "export const a = import.meta.url;", ["P-IMPORTMETA"]],
  ["unicode-escaped identifier eval", CORE, "\\u0065val('1');", ["P-IDENT"]],
  [
    "unicode-escaped identifier in the middle (Fun\\u0063tion)",
    CORE,
    "export const a = Fun\\u0063tion('return 1');",
    ["P-IDENT"],
  ],
  ["unicode-escaped process", CORE, "export const a = \\u0070rocess.env;", ["P-PROCESS"]],
  ["labelled statement hiding eval", CORE, "l: { eval('1'); break l; }", ["P-IDENT"]],
  ["tagged template eval", CORE, "eval`1`;", ["P-IDENT"]],
  ["tagged template Function", CORE, "export const a = Function`return 1`;", ["P-IDENT"]],
  ["Function.prototype access", CORE, "export const a = Function.prototype;", ["P-IDENT"]],
  ["class static block with eval", CORE, "export class A { static { eval('1'); } }", ["P-IDENT"]],
  [
    "class heritage value position (extends Function)",
    CORE,
    "export class A extends Function {}",
    ["P-IDENT"],
  ],
  [
    "nested class expression inside heritage with eval",
    CORE,
    "export class A extends (class { m() { return eval('1'); } }) {}",
    ["P-IDENT"],
  ],
  ["decorator call using eval", CORE, "@eval('1') class A {}", ["P-IDENT"]],
  ["shorthand property {eval}", CORE, "export const o = { eval };", ["P-IDENT"]],
  ["export { eval }", CORE, "export { eval };", ["P-IDENT"]],
  ["export default eval", CORE, "export default eval;", ["P-IDENT"]],
  ["comma-operator indirect eval", CORE, "export const a = (0, eval)('1');", ["P-IDENT"]],
  ["globalThis?.fetch", CORE, "export const a = globalThis?.fetch;", ["P-IDENT"]],
  ["Reflect?.get", CORE, "export const a = Reflect?.get;", ["P-IDENT"]],
  ["new Proxy", CORE, "export const a = new Proxy({}, {});", ["P-IDENT"]],
  ["computed key via global", CORE, "export const a = globalThis['ev' + 'al'];", ["P-IDENT"]],
  ["Atomics", CORE, "export const a = Atomics.wait;", ["P-IDENT"]],
  ["SharedArrayBuffer", CORE, "export const a = new SharedArrayBuffer(1);", ["P-IDENT"]],
  ["WeakRef", CORE, "export const a = new WeakRef({});", ["P-IDENT"]],
  ["setTimeout string form", CORE, "setTimeout('x', 0);", ["P-IDENT"]],
  ["queueMicrotask", CORE, "queueMicrotask(() => 1);", ["P-IDENT"]],
  ["constructor via optional chain", CORE, "export const a = x?.constructor;", ["P-CTOR"]],
  ["constructor via optional element", CORE, "export const a = x?.['constructor'];", ["P-CTOR"]],
  [
    "unicode-escaped constructor string",
    CORE,
    "export const a = x['\\u0063onstructor'];",
    ["P-CTOR"],
  ],
  [
    "constructor as no-substitution template",
    CORE,
    "export const a = x[`constructor`];",
    ["P-CTOR"],
  ],
  ["__proto__ in an object literal", CORE, "export const a = { __proto__: null };", ["P-CTOR"]],
  [
    "quoted __proto__ in object literal",
    CORE,
    "export const a = { '__proto__': null };",
    ["P-CTOR"],
  ],
  [
    "computed __proto__ literal in object literal",
    CORE,
    "export const a = { ['__proto__']: null };",
    ["P-CTOR"],
  ],
  ["__defineGetter__ call", CORE, "x.__defineGetter__('a', () => 1);", ["P-CTOR"]],
  [
    "destructured constructor",
    CORE,
    "const { constructor: C } = () => {}; export { C };",
    ["P-CTOR"],
  ],
  [
    "Object.getPrototypeOf(..).constructor",
    CORE,
    "export const a = Object.getPrototypeOf(() => 1).constructor;",
    ["P-CTOR"],
  ],
  ["Date.now", CORE, "export const a = Date.now();", ["P-DATE"]],
  ["Date.parse", CORE, "export const a = Date.parse('x');", ["P-DATE"]],
  ["new Date()", CORE, "export const a = new Date();", ["P-DATE"]],
  ["new Date(a,b)", CORE, "export const a = new Date(1, 2);", ["P-DATE"]],
  ["Date()", CORE, "export const a = Date();", ["P-DATE"]],
  ["Date alias", CORE, "const D = Date; export const a = D;", ["P-DATE"]],
  ["Date element access", CORE, "export const a = Date['now']();", ["P-DATE"]],
  ["Date.UTC passed as value", CORE, "export const a = Date.UTC;", ["P-DATE"]],
  ["Math.random", CORE, "export const a = Math.random();", ["P-RANDOM"]],
  ["Math['random']", CORE, "export const a = Math['random']();", ["P-RANDOM"]],
  ["Math?.random", CORE, "export const a = Math?.random();", ["P-RANDOM"]],
  ["crypto.randomUUID", CORE, "export const a = crypto.randomUUID();", ["P-IDENT"]],
  ["performance.now", CORE, "export const a = performance.now();", ["P-IDENT"]],
  ["Intl", CORE, "export const a = new Intl.Collator();", ["P-IDENT"]],
  ["localeCompare", CORE, "export const a = 'a'.localeCompare('b');", ["P-LOCALE"]],
  ["localeCompare element", CORE, "export const a = 'a'['localeCompare']('b');", ["P-LOCALE"]],
  ["toLocaleString optional chain", CORE, "export const a = (1)?.toLocaleString();", ["P-LOCALE"]],
  ["toLocaleUpperCase", CORE, "export const a = 'a'.toLocaleUpperCase();", ["P-LOCALE"]],
  // bin.ts rules (N6)
  ["bin: process.stdout stored", BIN, "const o = process.stdout; o;", ["P-PROCESS"]],
  ["bin: process.stdout property chain", BIN, "process.stdout._handle;", ["P-PROCESS"]],
  ["bin: process.stdout.fd as argument", BIN, "f(process.stdout.fd);", ["P-PROCESS"]],
  ["bin: process.stdout.write.call", BIN, "process.stdout.write.call(null, 'x');", ["P-PROCESS"]],
  ["bin: process.stdout['write']", BIN, "process.stdout['write']('x');", ["P-PROCESS"]],
  ["bin: parenthesised process.stdout", BIN, "(process.stdout).write('x');", ["P-PROCESS"]],
  ["bin: spread of process.stdout", BIN, "f(...[process.stdout]);", ["P-PROCESS"]],
  ["bin: process.env", BIN, "process.env;", ["P-PROCESS"]],
  ["bin: process['argv']", BIN, "process['argv'];", ["P-PROCESS"]],
  [
    "bin: process.stdout nested in object in object",
    BIN,
    "f({ a: { b: process.stdout } });",
    ["P-PROCESS"],
  ],
  ["bin: process.stdout as array element", BIN, "f([process.stdout]);", ["P-PROCESS"]],
  ["bin: process.stdout in spread object", BIN, "f({ ...process.stdout });", ["P-PROCESS"]],
  [
    "bin: process.stdout alongside process.env",
    BIN,
    "f(process.stdout, process.env);",
    ["P-PROCESS"],
  ],
  ["bin: process.binding", BIN, "process.binding('x');", ["P-PROCESS"]],
  ["bin: process.stdout cast", BIN, "f(process.stdout as unknown);", ["P-PROCESS"]],
  [
    "bin.ts in a subdirectory is not the allowed bin",
    "packages/cli/src/sub/bin.ts",
    "export const a = process.argv;",
    ["P-PROCESS"],
  ],
  [
    "bin.ts name in core is not allowed",
    "packages/core/src/bin.ts",
    "export const a = process.argv;",
    ["P-PROCESS"],
  ],
  // dist (JS) scanning
  [
    "dist: emitted Function() is caught in JS",
    DIST_CORE,
    "export const a = Function('return 1');",
    ["P-IDENT"],
  ],
  ["dist: emitted Math.random()", DIST_CORE, "export const a = Math.random();", ["P-RANDOM"]],
  [
    "dist: process.env in cli dist non-bin",
    "packages/cli/dist/src/main.js",
    "export const a = process.env;",
    ["P-PROCESS"],
  ],
  ["dist: bin.js process.env", DIST_BIN, "process.env;", ["P-PROCESS"]],
];

for (const [label, file, text, expected] of caught) {
  test(`caught: ${label}`, () => {
    assert.deepEqual(rules(file, text), expected);
  });
}

/** Inputs that must produce zero findings (false-positive guards and harmless constructs). */
const clean = [
  [
    "comments shaped like imports/evals",
    CORE,
    "// import fs from 'fs'\n/* eval('1'); process.env; globalThis */\nexport const a = 1;",
  ],
  [
    "strings shaped like imports/evals",
    CORE,
    'export const a = ["import(\'node:fs\')", \'eval(1)\', "process.env", `Function(\'x\')`, "require(\'fs\')", "__proto_", "constructors", "Constructor"];',
  ],
  ["regex literal shaped like constructor", CORE, "export const a = /constructor/u;"],
  [
    "property named process/eval/Function on an object",
    CORE,
    "export const a = { process: 1, eval: 2, Function: 3, fetch: 4 };",
  ],
  [
    "member access named like banned globals",
    CORE,
    "export const a = (x as { eval: number }).eval + x.process + x.fetch;",
  ],
  [
    "type-only references to banned names",
    CORE,
    "export type T = typeof globalThis | typeof process | Function | Proxy<object>; export let g: typeof eval | undefined;",
  ],
  [
    "interface with member named constructor",
    CORE,
    "export interface I { constructor: Function; process: number }",
  ],
  ["class constructor declaration", CORE, "export class A { constructor(readonly x: number) {} }"],
  ["new.target", CORE, "export function f() { return new.target; }"],
  [
    "Date.UTC call and new Date(ms)",
    CORE,
    "export const a = new Date(Date.UTC(2020, 0, 1)).toISOString();",
  ],
  [
    "createHash import",
    CORE,
    "import { createHash } from 'node:crypto'; export const a = createHash('sha256');",
  ],
  [
    "createHash renamed import",
    CORE,
    "import { createHash as h } from 'node:crypto'; export const a = h;",
  ],
  ["relative import inside src", CORE, "import { a } from './sub/../y.js'; export const b = a;"],
  ["label named like banned ident", CORE, "eval: for (;;) { break eval; }"],
  [
    "cli @swain/core and subpath imports",
    CLI,
    "import { a } from '@swain/core'; import { b } from '@swain/core/sub'; export const c = a + b;",
  ],
  [
    "bin: allowed forms",
    BIN,
    // SPEC-002 section 2.3: stdout/stderr are allowed only inside the single runMain(...) call.
    "process.exitCode = runMain({ argv: process.argv.slice(2), stdout: process.stdout, stderr: (s) => process.stderr.write(s), env: { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }, nowMs: Date.now });",
  ],
  [
    "dist bin.js allowed form",
    DIST_BIN,
    "process.exitCode = runMain({ stdout: process.stdout, nowMs: Date.now });",
  ],
  [
    "unrelated identifiers sharing a prefix",
    CORE,
    "export const a = [evaluate, Functional, processing, globalThisX, requires, selfie, moduleName];",
  ],
];

for (const [label, file, text] of clean) {
  test(`clean: ${label}`, () => {
    assert.deepEqual(checkFile(file, text, rulesFor(file)), []);
  });
}

test("finding positions point at the offending token (line/col are 1-based)", () => {
  const f = checkFile(CORE, "export const a = 1;\n  eval('1');", rulesFor(CORE));
  assert.deepEqual(
    f.map((x) => [x.line, x.col, x.rule]),
    [[2, 3, "P-IDENT"]],
  );
});

/** Complete minimal tree: both scanned packages have a src file and its emitted dist twin. */
function baseline(root) {
  for (const pkg of PACKAGE_NAMES) {
    mkdirSync(path.join(root, "packages", pkg, "src"), { recursive: true });
    mkdirSync(path.join(root, "packages", pkg, "dist", "src"), { recursive: true });
    writeFileSync(path.join(root, "packages", pkg, "src", "ok.ts"), "export const ok = 1;\n");
    writeFileSync(
      path.join(root, "packages", pkg, "dist", "src", "ok.js"),
      "export const ok = 1;\n",
    );
  }
}

test("non-.ts files in src are P-EXT (case, d.ts, mts, no extension, dotfile)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-qa-policy-"));
  try {
    baseline(root);
    for (const name of [
      "a.TS",
      "b.d.ts",
      "c.mts",
      "d.cts",
      "e",
      ".f.ts.bak",
      "g.tsx",
      "h.js",
      "i.json",
    ]) {
      writeFileSync(path.join(root, "packages/core/src", name), "export const a = 1;\n");
    }
    const f = scanTree(root);
    assert.deepEqual(f.map((x) => `${x.file}:${x.rule}`).sort(), [
      "packages/core/src/.f.ts.bak:P-EXT",
      "packages/core/src/a.TS:P-EXT",
      "packages/core/src/b.d.ts:P-EXT",
      "packages/core/src/c.mts:P-EXT",
      "packages/core/src/d.cts:P-EXT",
      "packages/core/src/e:P-EXT",
      "packages/core/src/g.tsx:P-EXT",
      "packages/core/src/h.js:P-EXT",
      "packages/core/src/i.json:P-EXT",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dist: stale .d.ts/.map/.js without a source twin are P-EXT; hostile file names are escaped by formatFinding", async () => {
  const { formatFinding } = await import("./policy-check.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "atm-qa-policy-"));
  try {
    baseline(root);
    writeFileSync(path.join(root, "packages/cli/src/a.ts"), "export const a = 1;\n");
    for (const n of ["a.js", "a.d.ts", "a.js.map", "a.d.ts.map"]) {
      writeFileSync(path.join(root, "packages/cli/dist/src", n), "export const a = 1;\n");
    }
    assert.deepEqual(scanTree(root), []);
    for (const n of ["ghost.js", "ghost.d.ts", "ghost.js.map", "evil.mjs", "evil.cjs", "x.txt"]) {
      writeFileSync(path.join(root, "packages/cli/dist/src", n), "export const a = 1;\n");
    }
    const f = scanTree(root);
    assert.equal(f.length, 6);
    assert.ok(f.every((x) => x.rule === "P-EXT"));
    const hostile = { file: "a\u001b]8;;x\u0007‮.ts", line: 1, col: 1, rule: "P-EXT" };
    const line = formatFinding(hostile);
    assert.ok(!line.includes("\u001b") && !line.includes("\u0007") && !line.includes("‮"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- characterization of KNOWN RESIDUAL gaps (current behaviour; documented, not endorsed) ----
// These pass today. If production code later closes a gap, update the expectation.

test("RESIDUAL (spec-silent): dynamically computed property names are not detected (N5 covers literals only)", () => {
  for (const text of [
    "export const a = (() => 1)['constr' + 'uctor']('return 1');",
    "const k = 'constr'; export const a = (() => 1)[k + 'uctor'];",
    "export const a = (() => 1)[`constr$" + "{'uctor'}`];",
    "export const a = (() => 1)[String.fromCharCode(99, 111, 110, 115, 116, 114, 117, 99, 116, 111, 114)];",
  ]) {
    assert.deepEqual(rules(CORE, text), [], text);
  }
});

// SPEC-002 section 2.3 closed three former residuals: bin.ts may no longer pass process.stdout to
// arbitrary functions (only to runMain), local-time Date methods are P-DATELOCAL and Buffer is
// P-IDENT.
test("former residual (closed by SPEC-002): process.stdout handed to a local function in bin.ts", () => {
  assert.deepEqual(
    rules(
      BIN,
      "function g(s: Record<string, unknown>) { return s['_hand' + 'le']; }\ng(process.stdout);",
    ),
    ["P-PROCESS"],
  );
});

test("former residual (closed by SPEC-002): local-time Date methods are P-DATELOCAL", () => {
  assert.deepEqual(
    rules(CORE, "export const a = new Date(0).getHours() + new Date(0).toString().length;"),
    ["P-DATELOCAL"],
  );
});

test("former residual (closed by SPEC-002): Buffer is in the P-IDENT list", () => {
  assert.deepEqual(rules(CORE, "export const a = Buffer.allocUnsafe(8);"), ["P-IDENT"]);
});

test("RF5: a tree with src but no dist/src (or dist with only .d.ts/.map) is P-MISSING, not silent", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-qa-policy-"));
  try {
    baseline(root);
    assert.deepEqual(scanTree(root), []);
    rmSync(path.join(root, "packages/core/dist"), { recursive: true });
    assert.deepEqual(
      scanTree(root).map((f) => `${f.file}:${f.rule}`),
      ["packages/core/dist/src:P-MISSING"],
    );
    mkdirSync(path.join(root, "packages/core/dist/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/core/dist/src/ok.d.ts"), "export {};\n");
    writeFileSync(path.join(root, "packages/core/dist/src/ok.js.map"), "{}\n");
    assert.deepEqual(
      scanTree(root).map((f) => `${f.file}:${f.rule}`),
      ["packages/core/dist/src:P-MISSING"],
    );
    rmSync(path.join(root, "packages/cli/src/ok.ts"));
    assert.ok(scanTree(root).some((f) => f.file === "packages/cli/src" && f.rule === "P-MISSING"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree: dist/src exists and is non-empty, so the dist scan actually scanned something", async () => {
  const { readdirSync } = await import("node:fs");
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  for (const pkg of PACKAGE_NAMES) {
    const entries = readdirSync(path.join(repoRoot, "packages", pkg, "dist", "src"));
    assert.ok(
      entries.some((n) => n.endsWith(".js")),
      `${pkg}: no dist/src/*.js (run npm run build first)`,
    );
  }
});
