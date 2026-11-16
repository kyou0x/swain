import assert from "node:assert/strict";
import { test } from "node:test";
import type { SourceAdapter } from "@swain/core";
import { sha256Hex } from "@swain/core";
import { chatJson } from "../src/json.js";
import { chatJsonl } from "../src/jsonl.js";
import {
  accounting,
  attributeProblems,
  detect,
  frameDocument,
  frameJsonl,
  matchesGolden,
  readFixture,
  run,
  snapshotOf,
  validated,
} from "./helpers.js";

const CASES: readonly {
  file: string;
  adapter: SourceAdapter;
  golden: string;
  expect: "match" | "no-match";
}[] = [
  { file: "session-golden.jsonl", adapter: chatJsonl, golden: "session-golden", expect: "match" },
  {
    file: "session-header-only.jsonl",
    adapter: chatJsonl,
    golden: "session-header-only",
    expect: "match",
  },
  { file: "session-legacy.json", adapter: chatJson, golden: "session-legacy", expect: "match" },
  { file: "hostile-content.jsonl", adapter: chatJsonl, golden: "hostile-content", expect: "match" },
  {
    file: "hostile-rewind-unknown.jsonl",
    adapter: chatJsonl,
    golden: "hostile-rewind-unknown",
    expect: "match",
  },
  {
    file: "hostile-patch-missing.jsonl",
    adapter: chatJsonl,
    golden: "hostile-patch-missing",
    expect: "match",
  },
  {
    file: "hostile-wrong-types.jsonl",
    adapter: chatJsonl,
    golden: "hostile-wrong-types",
    expect: "match",
  },
  {
    file: "hostile-legacy-no-messages.json",
    adapter: chatJson,
    golden: "hostile-legacy-no-messages",
    expect: "no-match",
  },
  {
    file: "hostile-legacy-messages-wrong-type.json",
    adapter: chatJson,
    golden: "hostile-legacy-messages-wrong-type",
    expect: "no-match",
  },
];

function load(file: string, adapter: SourceAdapter) {
  const bytes = readFixture(`gemini-cli/synthetic-mvp/${file}`);
  return adapter.manifest.framing.kind === "jsonl" ? frameJsonl(bytes) : frameDocument(bytes);
}

for (const c of CASES) {
  test(`golden (draft level): ${c.file}`, () => {
    const recs = load(c.file, c.adapter);
    const d = detect(c.adapter, recs);
    assert.equal(d.verdict, c.expect);
    const r = run(c.adapter, recs);
    // WP-A's runImport is not on this branch: goldens hold the AdapterOutput (drafts, warnings,
    // dispositions) concatenated over push and end, not the ImportResult.
    const g = matchesGolden(`expected/gemini-cli/mvp/${c.golden}.drafts.json`, r);
    assert.ok(
      g.ok,
      `golden mismatch for ${c.file}; rerun with UPDATE_GOLDEN=1 and review the diff`,
    );
    assert.deepEqual(accounting(recs, r), []);
    assert.deepEqual(attributeProblems(c.adapter, r), []);
    validated(c.adapter, recs, r, d.nativeSessionId ?? "a1b2c3d4-0000-4000-8000-000000000001");
  });
}

test("the same bytes give a byte-identical output twice (idempotence)", () => {
  for (const c of CASES) {
    const recs = load(c.file, c.adapter);
    assert.equal(snapshotOf(run(c.adapter, recs)), snapshotOf(run(c.adapter, recs)), c.file);
  }
});

test("hash-only: no inline text or secret-shaped value survives into the drafts", () => {
  for (const c of CASES) {
    const out = JSON.stringify(run(c.adapter, load(c.file, c.adapter)).drafts.map((d) => d.draft));
    assert.ok(!out.includes('"inline"'), c.file);
    for (const needle of [
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_0123456789",
      "PRIVATE KEY",
      "ignore previous instructions",
    ]) {
      assert.ok(!out.includes(needle), `${c.file} leaks ${needle}`);
    }
  }
});

test("inline retention: refs carry text that matches its hash and byte length", () => {
  const recs = load("session-golden.jsonl", chatJsonl);
  const r = run(chatJsonl, recs, { retention: "inline" });
  validated(chatJsonl, recs, r, "a1b2c3d4-0000-4000-8000-000000000001");
  let inlineRefs = 0;
  const walk = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o["retention"] === "inline" && typeof o["inline"] === "string") {
        inlineRefs++;
        const bytes = new TextEncoder().encode(o["inline"]);
        assert.equal(o["byteLength"], bytes.length);
        assert.equal(o["sha256"], sha256Hex(bytes));
      }
      for (const x of Object.values(o)) walk(x);
    }
  };
  for (const d of r.drafts) walk(d.draft.payload);
  assert.ok(inlineRefs > 10);
});

test("untested provider version: manifest lists none, so the core always warns", () => {
  assert.deepEqual(chatJsonl.manifest.testedProviderVersions, []);
  assert.deepEqual(chatJson.manifest.testedProviderVersions, []);
});
