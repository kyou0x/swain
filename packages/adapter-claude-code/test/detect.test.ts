import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_BOUNDS } from "@swain/core";
import { streamJsonAdapter } from "../src/stream-json.js";
import { transcriptAdapter } from "../src/transcript.js";
import { frame, repoPath } from "./harness.js";

function verdicts(text: string) {
  const sample = frame(text).slice(0, DEFAULT_BOUNDS.detectSampleRecords);
  return {
    stream: streamJsonAdapter.detect(sample).verdict,
    transcript: transcriptAdapter.detect(sample).verdict,
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

test("each Claude fixture matches exactly its own surface (never both)", () => {
  const seen: string[] = [];
  for (const f of files("claude-code")) {
    const v = verdicts(read("claude-code", f));
    const expected = f.startsWith("stream-json") ? "stream" : "transcript";
    assert.equal(v[expected], "match", `${f} should match ${expected}`);
    const other = expected === "stream" ? "transcript" : "stream";
    assert.equal(v[other], "no-match", `${f} must not match ${other}`);
    seen.push(f);
  }
  assert.ok(seen.length >= 5);
});

test("no Codex fixture matches any Claude surface (four surfaces never all match one file)", () => {
  const codex = files("codex-cli");
  assert.ok(codex.length >= 6);
  for (const f of codex) {
    const v = verdicts(read("codex-cli", f));
    assert.notEqual(v.stream, "match", f);
    assert.notEqual(v.transcript, "match", f);
  }
});

test("detect returns provider version and native session id only from the source", () => {
  const s = streamJsonAdapter.detect(frame(read("claude-code", "stream-json-golden.jsonl")));
  assert.equal(s.providerVersionSeen, "0.0.0-example");
  assert.equal(s.nativeSessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(s.reasons, ["stream-json-shape"]);
  const t = transcriptAdapter.detect(frame(read("claude-code", "transcript-golden.jsonl")));
  assert.equal(t.providerVersionSeen, "0.0.0-example");
  assert.deepEqual(t.reasons, ["transcript-shape"]);
});

test("detect is conservative on thin or hostile samples", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["only malformed", "{nope\nstill nope\n"],
    ["scalars and arrays", '1\n[]\n"x"\nnull\n'],
    ["bare type", '{"type":"user"}\n'],
    [
      "assistant without session_id",
      '{"type":"assistant","message":{},"parent_tool_use_id":null}\n',
    ],
    ["system init without version", '{"type":"system","subtype":"init","session_id":"s"}\n'],
    ["markup type", '{"type":"<script>alert(1)</script>","session_id":"s"}\n'],
    [
      "codex rollout line",
      '{"timestamp":"2026-01-01T00:00:00.000Z","type":"session_meta","payload":{"id":"x"}}\n',
    ],
    ["codex exec line", '{"type":"thread.started","thread_id":"t"}\n'],
    [
      "mixed camel and snake",
      '{"type":"user","sessionId":"s","uuid":"u","session_id":"s","parent_tool_use_id":null,"message":{}}\n',
    ],
  ];
  for (const [name, text] of cases) {
    const v = verdicts(text);
    assert.equal(v.stream, "no-match", `stream: ${name}`);
    assert.equal(v.transcript, "no-match", `transcript: ${name}`);
  }
});

test("detect never throws on a sample made of failed-parse and odd records", () => {
  const sample = frame(
    '{"type":"system","subtype":"init","session_id":"s","claude_code_version":"1.0.0"}\n{bad\n',
  );
  assert.equal(streamJsonAdapter.detect(sample).verdict, "match");
  assert.equal(streamJsonAdapter.detect([]).verdict, "no-match");
  assert.equal(transcriptAdapter.detect([]).verdict, "no-match");
});

test("a provider version that is not printable ASCII is not reported", () => {
  const d = streamJsonAdapter.detect(
    frame(
      '{"type":"system","subtype":"init","session_id":"s","claude_code_version":"1.0 beta\\u0000"}\n',
    ),
  );
  assert.equal(d.verdict, "match");
  assert.equal(d.providerVersionSeen, null);
});
