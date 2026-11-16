import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "@swain/core";
import { sessionExport } from "../src/index.js";
import {
  accounting,
  attributeProblems,
  detect,
  frameDocument,
  matchesGolden,
  readFixture,
  run,
  snapshotOf,
  validated,
} from "./helpers.js";

const CASES: readonly { file: string; golden: string; expect: "match" | "no-match" }[] = [
  { file: "export-golden.json", golden: "export-golden", expect: "match" },
  { file: "export-empty.json", golden: "export-empty", expect: "match" },
  { file: "export-sanitized.json", golden: "export-sanitized", expect: "match" },
  { file: "hostile-content.json", golden: "hostile-content", expect: "no-match" },
  { file: "hostile-missing-messages.json", golden: "hostile-missing-messages", expect: "match" },
  {
    file: "hostile-messages-wrong-type.json",
    golden: "hostile-messages-wrong-type",
    expect: "no-match",
  },
];

const load = (file: string) => frameDocument(readFixture(`opencode/synthetic-mvp/${file}`));

for (const c of CASES) {
  test(`golden (draft level): ${c.file}`, () => {
    const recs = load(c.file);
    const d = detect(sessionExport, recs);
    assert.equal(d.verdict, c.expect);
    const r = run(sessionExport, recs, { version: d.providerVersionSeen });
    // WP-A's runImport is not on this branch: goldens hold the AdapterOutput (drafts, warnings,
    // dispositions) over push and end, not the ImportResult.
    const g = matchesGolden(`expected/opencode/mvp/${c.golden}.drafts.json`, r);
    assert.ok(
      g.ok,
      `golden mismatch for ${c.file}; rerun with UPDATE_GOLDEN=1 and review the diff`,
    );
    assert.deepEqual(accounting(recs, r), []);
    assert.deepEqual(attributeProblems(sessionExport, r), []);
    validated(sessionExport, recs, r, "ses_fake01");
  });
}

test("idempotence: the same bytes give a byte-identical output twice", () => {
  for (const c of CASES) {
    const recs = load(c.file);
    assert.equal(
      snapshotOf(run(sessionExport, recs)),
      snapshotOf(run(sessionExport, recs)),
      c.file,
    );
  }
});

test("hash-only: no inline text or secret-shaped value survives into the drafts", () => {
  for (const c of CASES) {
    const out = JSON.stringify(run(sessionExport, load(c.file)).drafts.map((d) => d.draft));
    assert.ok(!out.includes('"inline"'), c.file);
    for (const needle of [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789",
      "PRIVATE KEY",
      "ignore previous instructions",
      "Fix the typo",
    ]) {
      assert.ok(!out.includes(needle), `${c.file} leaks ${needle}`);
    }
  }
});

test("inline retention: refs carry text that matches its hash and byte length", () => {
  const recs = load("export-golden.json");
  const r = run(sessionExport, recs, { retention: "inline" });
  validated(sessionExport, recs, r, "ses_fake01");
  let n = 0;
  const walk = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["retention"] === "inline" && typeof o["inline"] === "string") {
        n++;
        const b = new TextEncoder().encode(o["inline"]);
        assert.equal(o["byteLength"], b.length);
        assert.equal(o["sha256"], sha256Hex(b));
      }
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const d of r.drafts) walk(d.draft.payload);
  assert.ok(n > 8);
});

test("a pretty-printed export (2-space indent) and its compact form map identically", () => {
  const bytes = readFixture("opencode/synthetic-mvp/export-golden.json");
  const compact = JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)));
  const a = run(sessionExport, frameDocument(bytes));
  const b = run(sessionExport, frameDocument(compact));
  assert.equal(snapshotOf(a), snapshotOf(b));
});

test("manifest lists no tested provider versions, so the core always warns", () => {
  assert.deepEqual(sessionExport.manifest.testedProviderVersions, []);
});
