import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_BOUNDS } from "@swain/core";
import { execAdapter } from "../src/exec.js";
import { rolloutAdapter } from "../src/rollout.js";
import { frame, repoPath } from "./harness.js";

function verdicts(text: string) {
  const sample = frame(text).slice(0, DEFAULT_BOUNDS.detectSampleRecords);
  return {
    rollout: rolloutAdapter.detect(sample).verdict,
    exec: execAdapter.detect(sample).verdict,
  };
}

function files(provider: string): string[] {
  return readdirSync(repoPath("fixtures", provider, "synthetic-mvp"))
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
}

function read(provider: string, f: string): string {
  return readFileSync(repoPath("fixtures", provider, "synthetic-mvp", f), "utf8");
}

test("each Codex fixture matches exactly its own surface (never both)", () => {
  for (const f of files("codex-cli")) {
    if (f === "rollout-unsupported-history-mode.jsonl") continue;
    const v = verdicts(read("codex-cli", f));
    const expected = f.startsWith("exec") ? "exec" : "rollout";
    const other = expected === "exec" ? "rollout" : "exec";
    assert.equal(v[expected], "match", `${f} should match ${expected}`);
    assert.equal(v[other], "no-match", `${f} must not match ${other}`);
  }
});

test("legacy and paginated rollouts are both matched by the rollout surface", () => {
  const p = rolloutAdapter.detect(frame(read("codex-cli", "rollout-paginated-golden.jsonl")));
  const l = rolloutAdapter.detect(frame(read("codex-cli", "rollout-legacy-golden.jsonl")));
  assert.equal(p.verdict, "match");
  assert.equal(l.verdict, "match");
  assert.equal(p.providerVersionSeen, "0.169.0");
  assert.equal(l.providerVersionSeen, "0.167.0");
  assert.equal(p.nativeSessionId, "00000000-0000-4000-8000-000000000001");
});

test("no Claude fixture matches any Codex surface (four surfaces never all match one file)", () => {
  const claude = files("claude-code");
  assert.ok(claude.length >= 5);
  for (const f of claude) {
    const v = verdicts(read("claude-code", f));
    assert.notEqual(v.rollout, "match", f);
    assert.notEqual(v.exec, "match", f);
  }
});

test("the unsupported history_mode fixture is unsupported for rollout and no-match for exec", () => {
  const v = verdicts(read("codex-cli", "rollout-unsupported-history-mode.jsonl"));
  assert.equal(v.rollout, "unsupported");
  assert.equal(v.exec, "no-match");
});

test("detect is conservative on thin or hostile samples", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["only malformed", "{nope\n"],
    ["scalars", "1\n[]\nnull\n"],
    ["bare type", '{"type":"event_msg"}\n'],
    ["rollout type without payload", '{"timestamp":"t","type":"session_meta"}\n'],
    ["rollout payload without timestamp", '{"type":"session_meta","payload":{"id":"x"}}\n'],
    ["unknown history mode shape only", '{"timestamp":"t","type":"future_type","payload":{}}\n'],
    ["dotted type but not exec", '{"type":"foo.bar"}\n'],
    [
      "claude stream init",
      '{"type":"system","subtype":"init","session_id":"s","claude_code_version":"1"}\n',
    ],
    ["claude transcript", '{"type":"user","uuid":"u","sessionId":"s","message":{}}\n'],
    ["markup", '{"type":"<script>alert(1)</script>","payload":{"type":"x"},"timestamp":"t"}\n'],
  ];
  for (const [name, text] of cases) {
    const v = verdicts(text);
    assert.notEqual(v.rollout, "match", `rollout: ${name}`);
    assert.notEqual(v.exec, "match", `exec: ${name}`);
  }
});

test("exec: a rollout-shaped or camelCase line vetoes the match even next to a thread.started", () => {
  const mixed =
    '{"type":"thread.started","thread_id":"t"}\n{"timestamp":"t","type":"event_msg","payload":{"type":"x"}}\n';
  assert.equal(execAdapter.detect(frame(mixed)).verdict, "no-match");
  assert.equal(rolloutAdapter.detect(frame(mixed)).verdict, "no-match");
});
