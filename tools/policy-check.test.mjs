import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkFile,
  escapePath,
  LEGACY_PACKAGE_NAMES,
  PACKAGE_NAMES,
  PACKAGE_RULES,
  rulesFor,
  SWAIN_IMPORTS,
  SWAIN_PACKAGE_NAMES,
  scanTree,
} from "./policy-check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function loadFixtures(kind) {
  const dir = path.join(here, "policy-fixtures", kind);
  return readdirSync(dir)
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") }));
}

function virtualPath(name, text) {
  const m = /\/\/ as: (\S+)/.exec(text);
  assert.ok(m, `${name}: missing "// as:" header`);
  return m[1];
}

test("every bad fixture line reports its annotated rule IDs", () => {
  const seen = new Set();
  for (const { name, text } of loadFixtures("bad")) {
    const file = virtualPath(name, text);
    const pkg = rulesFor(file);
    assert.ok(pkg, `${name}: virtual path not under a scanned package`);
    const findings = checkFile(file, text, pkg);
    const lines = text.split("\n");
    let annotated = 0;
    lines.forEach((line, i) => {
      const m = /\/\/ expect: ([A-Z -]+?)\s*$/.exec(line);
      if (!m) return;
      annotated++;
      for (const rule of m[1].trim().split(/\s+/)) {
        seen.add(rule);
        assert.ok(
          findings.some((f) => f.line === i + 1 && f.rule === rule),
          `${name}:${i + 1}: expected ${rule}; got ${JSON.stringify(findings.filter((f) => f.line === i + 1).map((f) => f.rule))}`,
        );
      }
    });
    assert.ok(annotated > 0, `${name}: no expectations`);
    // lines without an annotation must produce no findings (no false positives in bad fixtures)
    for (const f of findings) {
      const line = lines[f.line - 1] ?? "";
      assert.ok(/\/\/ expect:/.test(line), `${name}:${f.line}: unexpected ${f.rule}`);
    }
  }
  for (const rule of [
    "P-EXT",
    "P-IMPORT",
    "P-DYNIMPORT",
    "P-RELATIVE",
    "P-IMPORTMETA",
    "P-IDENT",
    "P-PROCESS",
    "P-CTOR",
    "P-DATE",
    "P-RANDOM",
    "P-LOCALE",
    "P-DATELOCAL",
    "P-NET",
    "P-SQL",
  ]) {
    assert.ok(seen.has(rule), `no bad fixture exercises ${rule}`);
  }
});

test("good fixtures report zero findings", () => {
  const goods = loadFixtures("good");
  assert.ok(goods.length >= 2);
  for (const { name, text } of goods) {
    const file = virtualPath(name, text);
    const findings = checkFile(file, text, rulesFor(file));
    assert.deepEqual(findings, [], name);
  }
});

test("the real tree passes (after a clean build)", () => {
  assert.deepEqual(scanTree(repoRoot), []);
});

function makeTree(root, distCoreJs = "export const a = 1;\n") {
  for (const pkg of PACKAGE_NAMES) {
    mkdirSync(path.join(root, `packages/${pkg}/src`), { recursive: true });
    mkdirSync(path.join(root, `packages/${pkg}/dist/src`), { recursive: true });
    writeFileSync(path.join(root, `packages/${pkg}/src/a.ts`), "export const a = 1;\n");
    writeFileSync(
      path.join(root, `packages/${pkg}/dist/src/a.js`),
      pkg === "core" ? distCoreJs : "export const a = 1;\n",
    );
  }
}

test("a stale file copied into dist/src is reported as P-EXT", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
  try {
    makeTree(root);
    assert.deepEqual(scanTree(root), []);
    writeFileSync(path.join(root, "packages/core/dist/src/stale.js"), "export const s = 1;\n");
    assert.deepEqual(
      scanTree(root).map((f) => [f.file, f.rule]),
      [["packages/core/dist/src/stale.js", "P-EXT"]],
    );
    writeFileSync(path.join(root, "packages/core/src/b.js"), "export const b = 1;\n");
    assert.ok(
      scanTree(root).some((f) => f.file === "packages/core/src/b.js" && f.rule === "P-EXT"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dist output is scanned with the same rules", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
  try {
    makeTree(root, "export const a = eval('1');\n");
    assert.deepEqual(
      scanTree(root).map((f) => f.rule),
      ["P-IDENT"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RF5: missing or empty src/dist is a P-MISSING finding, not a silent pass", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
  try {
    assert.deepEqual(
      scanTree(root).map((f) => [f.file, f.rule]),
      PACKAGE_NAMES.flatMap((n) => [
        [`packages/${n}/src`, "P-MISSING"],
        [`packages/${n}/dist/src`, "P-MISSING"],
      ]),
    );
    // SPEC-002 section 2.3 (eight packages) plus SPEC-003 N0 (five Swain packages).
    assert.equal(LEGACY_PACKAGE_NAMES.length, 8);
    assert.equal(SWAIN_PACKAGE_NAMES.length, 5);
    assert.equal(PACKAGE_NAMES.length, 13);
    makeTree(root);
    assert.deepEqual(scanTree(root), []);
    rmSync(path.join(root, "packages/cli/dist/src/a.js"));
    assert.deepEqual(
      scanTree(root).map((f) => [f.file, f.rule]),
      [["packages/cli/dist/src", "P-MISSING"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RF5: non-ENOENT directory errors propagate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
  try {
    mkdirSync(path.join(root, "packages/core"), { recursive: true });
    writeFileSync(path.join(root, "packages/core/src"), "i am a file, not a directory");
    assert.throws(() => scanTree(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const CORE = "packages/core/src/x.ts";
const rules = (text) => checkFile(CORE, text, rulesFor(CORE)).map((f) => f.rule);

test("RF1: spread arguments to new Date are violations", () => {
  assert.ok(rules("new Date(...[]);").includes("P-DATE"));
  assert.ok(rules("declare const a: number[]; new Date(...a);").includes("P-DATE"));
  assert.deepEqual(rules("new Date(5);"), []);
});

test("RF2: Math references other than Math.<non-random> are violations", () => {
  for (const src of [
    "(Math).random();",
    "((Math as any)).random();",
    "(Math satisfies object).random();",
    "Math!.random();",
    "(<any>Math).random();",
    "const M = Math; M.max(1);",
    "const { random } = Math;",
    "const { max } = Math;",
    "Math[k];",
    "(Math)[k]();",
    "Math['random']();",
    "f(Math);",
  ]) {
    assert.ok(rules(src).includes("P-RANDOM"), src);
  }
  for (const src of [
    "Math.max(1, 2);",
    "Math.floor(1.5);",
    "(Math).floor(1);",
    "Math['max'](1);",
  ]) {
    assert.deepEqual(rules(src), [], src);
  }
});

test("RF3: locale names via destructuring and string-literal import names", () => {
  assert.ok(rules("const { localeCompare } = 'a';").includes("P-LOCALE"));
  assert.ok(rules("const { localeCompare: lc } = 'a';").includes("P-LOCALE"));
  assert.ok(rules("const { toLocaleString: t } = 1;").includes("P-LOCALE"));
  assert.ok(rules("const { random } = Math;").includes("P-RANDOM"));
  assert.doesNotThrow(() => rules("export { 'a' as 'b' } from './y.js';"));
  assert.ok(rules("import { 'randomUUID' as r } from 'node:crypto'; r;").includes("P-RANDOM"));
  assert.deepEqual(rules("import { 'createHash' as h } from 'node:crypto'; h;"), []);
});

test("RF4: instantiation expressions are value positions; implements/interface heritage are types", () => {
  assert.ok(rules("const f = Function<string>;").includes("P-IDENT"));
  assert.ok(rules("const e = eval<string>;").includes("P-IDENT"));
  assert.ok(rules("const p = process<string>;").includes("P-PROCESS"));
  assert.ok(rules("const d = Date<string>;").includes("P-DATE"));
  assert.ok(rules("const g = globalThis<string>;").includes("P-IDENT"));
  assert.deepEqual(rules("class A implements Function {}"), []);
  assert.deepEqual(rules("interface I extends Function {}"), []);
  assert.ok(rules("class A extends Function {}").includes("P-IDENT"));
});

test("finding paths are control-escaped", () => {
  assert.equal(escapePath("a\u001b[2Jb\\"), "a\\u001B[2Jb\\\\");
});

test("unicode-escaped identifiers are normalized", () => {
  const f = checkFile(
    "packages/core/src/x.ts",
    "\\u0065val('1');",
    rulesFor("packages/core/src/x.ts"),
  );
  assert.deepEqual(
    f.map((x) => x.rule),
    ["P-IDENT"],
  );
});

// ---- SPEC-002 section 2.3: per-package rules -------------------------------------------------
const NEW_PACKAGES = LEGACY_PACKAGE_NAMES.filter((n) => n !== "core" && n !== "cli");
const fileIn = (pkg, rel = "x.ts") => `packages/${pkg}/src/${rel}`;
const rulesIn = (pkg, text, rel) => {
  const f = fileIn(pkg, rel);
  return checkFile(f, text, rulesFor(f)).map((x) => x.rule);
};

test("rulesFor covers every listed package, src and dist/src, and nothing else", () => {
  assert.equal(PACKAGE_NAMES.length, 13);
  for (const n of PACKAGE_NAMES) {
    assert.deepEqual(rulesFor(`packages/${n}/src/a.ts`), {
      name: n,
      srcRoot: `packages/${n}/src`,
    });
    assert.deepEqual(rulesFor(`packages/${n}/dist/src/a.js`), {
      name: n,
      srcRoot: `packages/${n}/dist/src`,
    });
  }
  assert.equal(rulesFor("packages/contract-tests/src/a.ts"), null);
  assert.equal(rulesFor("packages/evil/src/a.ts"), null);
  assert.equal(rulesFor("packages/core/test/a.ts"), null);
});

test("every package: an unlisted cross-@swain import and a non-allowlisted builtin are both caught", () => {
  for (const pkg of PACKAGE_NAMES) {
    const allowed = Object.keys(SWAIN_IMPORTS[pkg]);
    const forbidden = PACKAGE_NAMES.map((n) => `@swain/${n}`).find((s) => !allowed.includes(s));
    assert.ok(forbidden, pkg);
    assert.ok(
      rulesIn(pkg, `import { a } from "${forbidden}"; export { a };`).includes("P-IMPORT"),
      `${pkg} -> ${forbidden}`,
    );
    for (const spec of [
      "node:child_process",
      "node:net",
      "node:os",
      "node:vm",
      "node:fs/promises",
    ]) {
      assert.ok(
        rulesIn(pkg, `import { a } from "${spec}"; export { a };`).includes("P-IMPORT"),
        `${pkg} ${spec}`,
      );
    }
    // writeFileSync is on nobody's list.
    assert.ok(
      rulesIn(pkg, 'import { writeFileSync } from "node:fs"; export { writeFileSync };').includes(
        "P-IMPORT",
      ),
      pkg,
    );
  }
});

test("adapters and report may import @swain/core and nothing else; core imports no @swain package", () => {
  for (const pkg of ["core", ...NEW_PACKAGES.filter((n) => n !== "store")]) {
    for (const other of PACKAGE_NAMES.filter((n) => n !== "core")) {
      const text = `import { a } from "@swain/${other}"; export { a };`;
      assert.deepEqual(rulesIn(pkg, text), ["P-IMPORT"], `${pkg} -> ${other}`);
    }
    const viaCore = 'import { a } from "@swain/core"; export { a };';
    assert.deepEqual(rulesIn(pkg, viaCore), pkg === "core" ? ["P-IMPORT"] : [], pkg);
  }
});

test("adapters and cli use no builtins at all, not even node:crypto createHash", () => {
  for (const pkg of ["cli", ...NEW_PACKAGES.filter((n) => n.startsWith("adapter-"))]) {
    assert.deepEqual(rulesIn(pkg, 'import { createHash } from "node:crypto"; createHash;'), [
      "P-IMPORT",
    ]);
  }
  assert.deepEqual(rulesIn("report", 'import { createHash } from "node:crypto"; createHash;'), []);
});

test("store may import @swain/report only as a type", () => {
  assert.deepEqual(
    rulesIn("store", 'import type { R } from "@swain/report"; export type X = R;'),
    [],
  );
  for (const t of [
    'import { r } from "@swain/report"; export { r };',
    'import { type R } from "@swain/report"; export type X = R;',
    'import "@swain/report";',
    'export { r } from "@swain/report";',
    'export * from "@swain/report";',
    'import r = require("@swain/report"); export { r };',
  ]) {
    assert.deepEqual(rulesIn("store", t), ["P-IMPORT"], t);
  }
  // report may not import store in either form (no cycle)
  assert.deepEqual(rulesIn("report", 'import type { S } from "@swain/store"; export type X = S;'), [
    "P-IMPORT",
  ]);
  // in compiled output the type import is erased, so any @swain/report import in store dist is bad
  const dist = "packages/store/dist/src/x.js";
  assert.deepEqual(
    checkFile(dist, 'import { r } from "@swain/report"; export { r };', rulesFor(dist)).map(
      (f) => f.rule,
    ),
    ["P-IMPORT"],
  );
});

test("builtin allowlist tables match SPEC-002 section 2.3 exactly", () => {
  const sorted = (a) => [...a].sort();
  const core = Object.fromEntries(PACKAGE_RULES.core);
  assert.deepEqual(core[""], { "node:crypto": ["createHash"] });
  assert.deepEqual(sorted(core["ingest/fs/"]["node:fs"]), [
    "closeSync",
    "constants",
    "fstatSync",
    "lstatSync",
    "openSync",
    "readSync",
    "readdirSync",
    "realpathSync",
  ]);
  assert.deepEqual(sorted(core["ingest/fs/"]["node:zlib"]), ["constants", "zstdDecompressSync"]);
  const pathNames = ["basename", "dirname", "isAbsolute", "join", "relative", "resolve", "sep"];
  assert.deepEqual(sorted(core["ingest/fs/"]["node:path"]), pathNames);
  assert.deepEqual(Object.keys(core["ingest/fs/"]).sort(), ["node:fs", "node:path", "node:zlib"]);
  const store = Object.fromEntries(PACKAGE_RULES.store)[""];
  assert.deepEqual(Object.keys(store).sort(), ["node:crypto", "node:fs", "node:path"]);
  assert.deepEqual(store["node:crypto"], ["createHash"]);
  assert.deepEqual(sorted(store["node:path"]), pathNames);
  assert.deepEqual(sorted(store["node:fs"]), [
    "closeSync",
    "constants",
    "fstatSync",
    "fsyncSync",
    "lstatSync",
    "mkdirSync",
    "openSync",
    "readSync",
    "readdirSync",
    "realpathSync",
    "renameSync",
    "rmdirSync",
    "unlinkSync",
    "writeSync",
  ]);
  assert.deepEqual(PACKAGE_RULES.report, [["", { "node:crypto": ["createHash"] }]]);
  for (const n of ["cli", ...NEW_PACKAGES.filter((x) => x.startsWith("adapter-"))]) {
    assert.deepEqual(PACKAGE_RULES[n], []);
  }
});

test("each allowlisted name passes where allowed and fails one directory away", () => {
  for (const [pkg, entries] of Object.entries(PACKAGE_RULES)) {
    for (const [prefix, table] of entries) {
      for (const [spec, names] of Object.entries(table)) {
        for (const name of names) {
          const text = `import { ${name} } from "${spec}"; export { ${name} };`;
          assert.deepEqual(
            rulesIn(pkg, text, `${prefix}x.ts`),
            [],
            `${pkg}/${prefix} ${spec} ${name}`,
          );
          if (prefix !== "") {
            // P-NET / P-SQL accompany P-IMPORT for the socket, process and sqlite builtins.
            const outside =
              /^node:(?:http|https|net|tls|dgram|http2|child_process|worker_threads)$/.test(spec)
                ? ["P-IMPORT", "P-NET"]
                : spec === "node:sqlite"
                  ? ["P-IMPORT", "P-SQL"]
                  : ["P-IMPORT"];
            // node:timers names are also P-IDENT outside their scope (setTimeout is banned).
            const check =
              spec === "node:timers"
                ? (got, msg) => assert.ok(got.includes("P-IMPORT") && !got.includes("P-NET"), msg)
                : (got, msg) => assert.deepEqual(got, outside, msg);
            check(rulesIn(pkg, text, "x.ts"), `${pkg} root ${spec}`);
            check(
              rulesIn(pkg, text, `${prefix.slice(0, -1)}x/y.ts`),
              `${pkg} lookalike ${spec} ${name}`,
            );
          }
        }
        // Default, namespace, bare, re-export and require forms are rejected everywhere.
        const at = `${prefix}x.ts`;
        for (const t of [
          `import d from "${spec}"; export { d };`,
          `import * as ns from "${spec}"; export { ns };`,
          `import "${spec}";`,
          `export * from "${spec}";`,
          `export { a } from "${spec}";`,
          `import e = require("${spec}"); export { e };`,
          `import d, { ${names[0]} } from "${spec}"; export { d, ${names[0]} };`,
        ]) {
          assert.ok(rulesIn(pkg, t, at).includes("P-IMPORT"), `${pkg} ${t}`);
        }
        const extra = `import { zzzNotAllowed } from "${spec}"; export { zzzNotAllowed };`;
        assert.ok(
          rulesIn(pkg, extra, at).some((r) => r === "P-IMPORT" || r === "P-RANDOM"),
          `${pkg} ${spec} extra name`,
        );
      }
    }
  }
});

function fullTree(root, mutate) {
  for (const p of PACKAGE_NAMES) {
    mkdirSync(path.join(root, `packages/${p}/src`), { recursive: true });
    mkdirSync(path.join(root, `packages/${p}/dist/src`), { recursive: true });
    writeFileSync(path.join(root, `packages/${p}/src/a.ts`), "export const a = 1;\n");
    writeFileSync(
      path.join(root, `packages/${p}/dist/src/a.js`),
      mutate?.(p) ?? "export const a = 1;\n",
    );
  }
}

test("P-PACKAGE: an unlisted package directory fails closed; contract-tests is exempt", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
  try {
    fullTree(root);
    mkdirSync(path.join(root, "packages/contract-tests/src"), { recursive: true });
    writeFileSync(path.join(root, "packages/contract-tests/src/a.ts"), "eval('1');\n");
    assert.deepEqual(scanTree(root), []);
    mkdirSync(path.join(root, "packages/rogue/src"), { recursive: true });
    assert.deepEqual(
      scanTree(root).map((f) => [f.file, f.rule]),
      [["packages/rogue", "P-PACKAGE"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P-MISSING is reported individually for each new package", () => {
  for (const missing of PACKAGE_NAMES.filter((x) => x !== "core" && x !== "cli")) {
    const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
    try {
      fullTree(root);
      rmSync(path.join(root, `packages/${missing}/src`), { recursive: true });
      rmSync(path.join(root, `packages/${missing}/dist`), { recursive: true });
      assert.deepEqual(
        scanTree(root).map((f) => [f.file, f.rule]),
        [
          [`packages/${missing}/src`, "P-MISSING"],
          [`packages/${missing}/dist/src`, "P-MISSING"],
        ],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a hostile file in each new package's dist is found", () => {
  for (const n of PACKAGE_NAMES.filter((x) => x !== "core" && x !== "cli")) {
    const root = mkdtempSync(path.join(tmpdir(), "atm-policy-"));
    try {
      fullTree(root, (p) => (p === n ? "export const a = eval('1');\n" : undefined));
      assert.deepEqual(
        scanTree(root).map((f) => [f.file, f.rule]),
        [[`packages/${n}/dist/src/a.js`, "P-IDENT"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ---- bin.ts allowance (dist shape) -----------------------------------------------------------
const BIN_JS = "packages/cli/dist/src/bin.js";
const binRules = (text, file = BIN_JS) => checkFile(file, text, rulesFor(file)).map((f) => f.rule);

test("bin.js: the compiled runMain shape passes, and each deviation is a finding", () => {
  const ok =
    "process.exitCode = runMain({ argv: process.argv.slice(2), stdout: (s) => process.stdout.write(s), stderr: process.stderr, env: { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }, nowMs: Date.now });";
  assert.deepEqual(binRules(ok), []);
  assert.deepEqual(binRules(ok.replace("process.env.HOME", "process.env.PATH")), ["P-PROCESS"]);
  assert.deepEqual(binRules(ok.replace("nowMs: Date.now", "nowMs: Date.now()")), ["P-DATE"]);
  assert.deepEqual(binRules(ok.replace("nowMs: Date.now", "nowMs: () => Date.now")), ["P-DATE"]);
  assert.deepEqual(binRules(ok.replace("nowMs: Date.now", "nowMs: (Date.now)")), ["P-DATE"]);
  assert.deepEqual(binRules(ok.replace("process.stderr", "process.stdin")), ["P-PROCESS"]);
  assert.deepEqual(binRules(`${ok}\nprocess.stdout.write("late");`), ["P-PROCESS"]);
  assert.ok(binRules(`${ok}\n${ok}`).length > 0);
  assert.ok(binRules(ok.replace("runMain", "otherMain")).includes("P-PROCESS"));
});

test("the bin.ts allowance does not extend to other cli files or other packages", () => {
  const text = "export const f = Date.now; export const h = process.env.HOME;";
  assert.deepEqual(binRules(text, "packages/cli/src/main.ts"), ["P-DATE", "P-PROCESS"]);
  assert.deepEqual(binRules(text, "packages/cli/src/sub/bin.ts"), ["P-DATE", "P-PROCESS"]);
  assert.deepEqual(binRules(text, "packages/store/src/bin.ts"), ["P-DATE", "P-PROCESS"]);
});

test("P-DATELOCAL is not limited to Date receivers and has no allowlist", () => {
  for (const pkg of PACKAGE_NAMES) {
    assert.deepEqual(rulesIn(pkg, "export const a = anything.getHours();"), ["P-DATELOCAL"], pkg);
    assert.deepEqual(rulesIn(pkg, "export const a = anything.getUTCHours();"), [], pkg);
  }
});
