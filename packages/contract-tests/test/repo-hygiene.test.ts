import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function git(args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

// Test 19 (R5): LICENSE is lead-supplied; this slice only verifies it.
test("LICENSE is the verbatim Apache-2.0 text", () => {
  const bytes = readFileSync(`${root}LICENSE`);
  assert.equal(bytes.length, 11358);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  );
  const first = bytes
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  assert.equal(first, "Apache License");
});

test("every package.json declares Apache-2.0", () => {
  const files = [
    "package.json",
    ...readdirSync(`${root}packages`).map((p) => `packages/${p}/package.json`),
  ];
  assert.ok(files.length >= 4);
  for (const f of files) {
    const pkg = JSON.parse(readFileSync(`${root}${f}`, "utf8")) as { license?: string };
    assert.equal(pkg.license, "Apache-2.0", f);
  }
});

test("LICENSE has no diff against the committed version", () => {
  const r = git(["diff", "--exit-code", "--", "LICENSE"]);
  assert.equal(r.status, 0);
});

// Test 17 (C9, R4)
test(".gitattributes equals the SPEC-001 section 1 text byte-for-byte", () => {
  assert.equal(
    readFileSync(`${root}.gitattributes`, "utf8"),
    "* text=auto eol=lf\nfixtures/** -text\nfixtures/hostile/** -text -diff\ntools/policy-fixtures/** -text\n",
  );
});

test("git check-attr: canonical fixtures are -text but diffable; hostile are -text -diff", () => {
  const a = git(["check-attr", "text", "diff", "--", "fixtures/canonical/INDEX.json"]);
  assert.equal(
    a.stdout,
    "fixtures/canonical/INDEX.json: text: unset\nfixtures/canonical/INDEX.json: diff: unspecified\n",
  );
  const b = git(["check-attr", "text", "diff", "--", "fixtures/hostile/x.jsonl"]);
  assert.equal(
    b.stdout,
    "fixtures/hostile/x.jsonl: text: unset\nfixtures/hostile/x.jsonl: diff: unset\n",
  );
});

test("npm lifecycle scripts are disabled for installs", () => {
  const npmrc = readFileSync(`${root}.npmrc`, "utf8");
  assert.ok(npmrc.split("\n").includes("ignore-scripts=true"));
});
