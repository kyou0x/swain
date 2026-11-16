import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateEvent } from "../../src/validate/index.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const ID = (p: string): string => `${p}_${"0".repeat(32)}`;

function event(payload: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "0.1.0",
    eventId: ID("evt"),
    kind: "turn.started",
    provider: "opencode",
    providerVersion: null,
    sourceKind: "opencode.x",
    sessionId: ID("ses"),
    turnId: null,
    sourceSequence: 0,
    subIndex: 0,
    time: { value: null, origin: "none", status: "missing" },
    actor: { actorId: ID("act"), role: "user" },
    status: "none",
    payload,
    links: [],
    provenance: {
      type: "record",
      sourceId: ID("src"),
      line: 1,
      byteOffset: 0,
      byteLength: 1,
      sha256: sha("x"),
      pointer: null,
      adapter: { id: "opencode.x", version: "0.0.1" },
    },
    completeness: { timestamp: { state: "unavailable" }, actor: { state: "unknown" } },
    attributes: {},
    ...overrides,
  };
}
const prompt = (ref: unknown): Record<string, unknown> => event({ prompt: ref });
const codes = (v: unknown): string[] => {
  const r = validateEvent(v);
  return r.ok ? [] : r.issues.map((i) => i.code);
};
const ref = (o: Record<string, unknown>): Record<string, unknown> => ({
  sha256: sha("hello"),
  byteLength: 5,
  encoding: "utf8",
  retention: "inline",
  inline: "hello",
  ...o,
});

test("F9: integer -0 is rejected, 0 is accepted", () => {
  const ok = event({ prompt: null }, { sourceSequence: 0 });
  assert.deepEqual(codes(ok), []);
  assert.deepEqual(codes({ ...ok, sourceSequence: -0 }), ["negative-zero"]);
  const tool = event(
    { toolCallId: null, toolName: null, output: null, exitCode: -0 },
    {
      kind: "tool.completed",
      status: "success",
      completeness: {
        timestamp: { state: "unavailable" },
        actor: { state: "unknown" },
        inputs: { state: "unknown" },
        outputs: { state: "unknown" },
      },
    },
  );
  assert.deepEqual(codes(tool), ["negative-zero"]);
});

test("F10: consistent inline content passes", () => {
  assert.deepEqual(codes(prompt(ref({}))), []);
  const json = '{"a":1}';
  assert.deepEqual(
    codes(prompt(ref({ encoding: "jcs-json", sha256: sha(json), byteLength: 7, inline: json }))),
    [],
  );
  assert.deepEqual(codes(prompt(ref({ redactionCount: 0 }))), []);
});

test("F10: inline hash or length mismatch is rejected", () => {
  assert.deepEqual(codes(prompt(ref({ inline: "hellp" }))), ["content-hash-mismatch"]);
  assert.deepEqual(codes(prompt(ref({ byteLength: 6 }))), ["content-length-mismatch"]);
  assert.deepEqual(codes(prompt(ref({ inline: "héllo", byteLength: 5 }))), [
    "content-length-mismatch",
  ]);
});

test("F10: redactionCount >= 1 skips the hash check", () => {
  assert.deepEqual(codes(prompt(ref({ inline: "[REDACTED]", redactionCount: 1 }))), []);
  assert.deepEqual(codes(prompt(ref({ inline: "x", byteLength: 99, redactionCount: 2 }))), []);
});

test("F10: hash-only forbids inline and redactionCount; inline kinds require inline", () => {
  const hashOnly = {
    sha256: sha("hello"),
    byteLength: 5,
    encoding: "utf8",
    retention: "hash-only",
  };
  assert.deepEqual(codes(prompt(hashOnly)), []);
  assert.deepEqual(codes(prompt({ ...hashOnly, inline: "hello" })), ["inline-with-hash-only"]);
  assert.deepEqual(codes(prompt({ ...hashOnly, redactionCount: 1 })), ["redaction-with-hash-only"]);
  const noInline = ref({ retention: "inline" });
  delete noInline["inline"];
  assert.deepEqual(codes(prompt(noInline)), ["content-inline-missing"]);
  const noTrunc = ref({ retention: "inline-truncated" });
  delete noTrunc["inline"];
  assert.deepEqual(codes(prompt(noTrunc)), ["content-inline-missing"]);
});

test("F10: inline-truncated must be shorter than the original", () => {
  assert.deepEqual(codes(prompt(ref({ retention: "inline-truncated", inline: "hel" }))), []);
  assert.deepEqual(codes(prompt(ref({ retention: "inline-truncated", inline: "hello" }))), [
    "content-length-mismatch",
  ]);
});
