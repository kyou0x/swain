import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkWorkflowDir } from "./lockfile-check.mjs";
import { checkFile, rulesFor } from "./policy-check.mjs";

const ruleIds = (file, text) => {
  const pkg = rulesFor(file);
  assert.ok(pkg, file);
  return checkFile(file, text, pkg).map((f) => f.rule);
};

const FS_BANNED = [
  'import { readSourceFile } from "@swain/core";',
  'import { walkImportPaths } from "@swain/core";',
  'import { type Bounds, readSourceFile as r } from "@swain/core";',
  'import { "walkImportPaths" as w } from "@swain/core";',
  'import * as core from "@swain/core";',
  'import core from "@swain/core";',
  'export { readSourceFile } from "@swain/core";',
  'export { walkImportPaths as w } from "@swain/core";',
  'export * from "@swain/core";',
  'export * as core from "@swain/core";',
  'import core = require("@swain/core");',
];

for (const pkg of [
  "adapter-claude-code",
  "adapter-codex-cli",
  "adapter-gemini-cli",
  "adapter-opencode",
  "report",
]) {
  test(`G3-4: ${pkg} cannot import fs-touching exports from @swain/core`, () => {
    for (const src of FS_BANNED) {
      const rules = ruleIds(`packages/${pkg}/src/x.ts`, `${src}\n`);
      assert.ok(rules.includes("P-IMPORT"), `${pkg}: ${src} -> ${JSON.stringify(rules)}`);
    }
  });
}

test("G3-4: pure core imports and type-only imports stay allowed; cli and store may use fs exports", () => {
  const ok = [
    'import { maskHome, canonicalJson } from "@swain/core";',
    'import type { SourceBytes } from "@swain/core";',
    'import { type readSourceFile } from "@swain/core";',
    'export type { ReadHooks } from "@swain/core";',
  ];
  for (const src of ok) {
    assert.deepEqual(ruleIds("packages/report/src/x.ts", `${src}\n`), [], src);
  }
  for (const pkg of ["cli", "store"]) {
    assert.deepEqual(
      ruleIds(`packages/${pkg}/src/x.ts`, 'import { readSourceFile } from "@swain/core";\n'),
      [],
      pkg,
    );
  }
});

test("G3-5: lockfile-check covers *.yaml and rejects other file types in .github/workflows", () => {
  const root = mkdtempSync(path.join(tmpdir(), "atm-wf-"));
  try {
    const dir = path.join(root, ".github/workflows");
    mkdirSync(dir, { recursive: true });
    const bad = "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n";
    writeFileSync(path.join(dir, "ok.yml"), "name: x\n");
    assert.deepEqual(checkWorkflowDir(root), []);
    writeFileSync(path.join(dir, "evil.yaml"), bad);
    assert.ok(
      checkWorkflowDir(root).some((f) => f.code === "L-USES" && f.detail.includes("evil.yaml")),
    );
    rmSync(path.join(dir, "evil.yaml"));
    writeFileSync(path.join(dir, "notes.txt"), "x");
    assert.ok(checkWorkflowDir(root).some((f) => f.code === "L-WORKFLOW-FILE"));
    rmSync(path.join(dir, "notes.txt"));
    mkdirSync(path.join(dir, "sub"));
    assert.ok(checkWorkflowDir(root).some((f) => f.code === "L-WORKFLOW-FILE"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
