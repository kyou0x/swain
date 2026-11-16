import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@swain/core";
import { chatJson } from "../src/json.js";
import { chatJsonl } from "../src/jsonl.js";
import {
  accounting,
  attributeProblems,
  detect,
  frameDocument,
  frameJsonl,
  ofKind,
  readFixture,
  run,
  validated,
} from "./helpers.js";

const PH = "0".repeat(64);
const H = { sessionId: "s-1", projectHash: PH, startTime: "2026-11-15T10:30:00.000Z" };
const ESC = "\u001b";

function fixture(name: string) {
  return frameJsonl(readFixture(`gemini-cli/synthetic-mvp/${name}`));
}

test("HTML, ANSI and bidi in content never reach canonical data except in names and paths", () => {
  const recs = fixture("hostile-content.jsonl");
  const r = run(chatJsonl, recs);
  assert.deepEqual(accounting(recs, r), []);
  const requested = ofKind(r, "tool.requested");
  // Tool names are metadata and are kept verbatim (control characters included); every exporter
  // escapes them. They are the only free-text channel besides paths and unknown-key lists.
  assert.ok(String(requested[0]?.payload["toolName"]).includes(`${ESC}[31m`));
  assert.ok(String(requested[0]?.payload["toolName"]).includes("<script>"));
  const stripped = JSON.stringify(
    r.drafts.map((d) => {
      const {
        toolName: _t,
        path: _p,
        topLevelKeys: _k,
        nativeType: _n,
        ...rest
      } = d.draft.payload as Record<string, JsonValue>;
      return { ...d.draft, payload: rest };
    }),
  );
  assert.ok(!stripped.includes("<script"), "script text leaked outside names/paths");
  assert.ok(!stripped.includes(`${ESC}`) && !stripped.includes("\\u001b"), "ANSI leaked");
  assert.ok(!stripped.includes("202e") && !stripped.includes("‮"), "bidi leaked");
  assert.ok(!stripped.includes("evil.example"));
});

test("path traversal and NUL paths are inert text: kept as given or dropped, never resolved", () => {
  const r = run(chatJsonl, fixture("hostile-content.jsonl"));
  const paths = ofKind(r, "file.changed").map((d) => d.payload["path"]);
  assert.deepEqual(paths, ["../../etc/passwd"]);
});

test("__proto__ and constructor keys do not pollute anything and are not followed", () => {
  const recs = fixture("hostile-content.jsonl");
  run(chatJsonl, recs);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(({} as Record<string, unknown>)["x"], undefined);
  const r = run(chatJsonl, recs);
  const protoMsg = r.drafts.filter((d) => d.order === 3);
  assert.equal(protoMsg.length, 1);
  assert.equal(protoMsg[0]?.draft.kind, "message.observed");
});

test("a $rewindTo to an unknown id is reported, and every record stays accounted", () => {
  const recs = fixture("hostile-rewind-unknown.jsonl");
  const r = run(chatJsonl, recs);
  assert.deepEqual(accounting(recs, r), []);
  assert.ok(r.warnings.some((w) => w.detail["reasonCode"] === "gm.rewind-unknown-id"));
  assert.deepEqual(ofKind(r, "turn.started").length, 1);
});

test("a $patch for a missing id changes nothing and is a control with no target", () => {
  const recs = fixture("hostile-patch-missing.jsonl");
  const r = run(chatJsonl, recs);
  assert.deepEqual(accounting(recs, r), []);
  const out = ofKind(r, "tool.completed");
  assert.equal(out.length, 1);
  assert.equal(r.drafts.find((d) => d.draft.kind === "tool.completed")?.evidence, 1);
  assert.equal(r.dispositions.filter((d) => d.kind === "control" && d.into === null).length, 2);
  // `$patch` for a known message but unknown tool call id: control into the message.
  assert.ok(r.dispositions.some((d) => d.sourceSequence === 4 && d.into === 1));
});

test("wrong types everywhere: no throw, valid canonical events, nothing invented", () => {
  const recs = fixture("hostile-wrong-types.jsonl");
  const r = run(chatJsonl, recs);
  assert.deepEqual(accounting(recs, r), []);
  assert.deepEqual(attributeProblems(chatJsonl, r), []);
  validated(chatJsonl, recs, r, "a1b2c3d4-0000-4000-8000-000000000001");
  assert.equal(ofKind(r, "file.changed").length, 0);
  // Out-of-range / mistyped counters are dropped rather than coerced.
  const usage = ofKind(r, "model.usage");
  assert.deepEqual(usage[0]?.payload, { scope: "message", model: "m" });
  // `$set.messages` (deprecated checkpoint) is flagged, not folded.
  assert.ok(r.warnings.some((w) => w.detail["fieldCode"] === "gm.set-messages-checkpoint"));
});

test("legacy document without /messages or with a non-array /messages: envelope only, no match", () => {
  for (const name of [
    "hostile-legacy-no-messages.json",
    "hostile-legacy-messages-wrong-type.json",
  ]) {
    const recs = frameDocument(readFixture(`gemini-cli/synthetic-mvp/${name}`));
    assert.equal(recs.length, 1);
    assert.equal(detect(chatJson, recs).verdict, "no-match");
    const r = run(chatJson, recs);
    assert.deepEqual(
      r.drafts.map((d) => d.draft.kind),
      ["session.started"],
    );
    assert.deepEqual(accounting(recs, r), []);
  }
  // An envelope that is not an object becomes one source.unknown.
  const odd = frameDocument("[1,2]");
  const ro = run(chatJson, odd);
  assert.deepEqual(
    ro.drafts.map((d) => d.draft.kind),
    ["source.unknown"],
  );
});

test("a huge messages array within bounds maps linearly (JSONL, re-appended ids, rewinds)", () => {
  const N = 20_000;
  const parts: string[] = [JSON.stringify(H)];
  for (let i = 0; i < N; i++) {
    parts.push(
      JSON.stringify({
        id: `m${i % 5000}`,
        timestamp: "2026-11-15T10:30:05.000Z",
        type: i % 2 ? "gemini" : "user",
        content: `c${i}`,
      }),
    );
    if (i % 1000 === 999) parts.push(JSON.stringify({ $rewindTo: `m${i % 5000}` }));
  }
  const recs = frameJsonl(`${parts.join("\n")}\n`);
  const t0 = Date.now();
  const r = run(chatJsonl, recs);
  const ms = Date.now() - t0;
  assert.deepEqual(accounting(recs, r), []);
  assert.ok(ms < 20_000, `took ${ms} ms`);
  assert.ok(r.drafts.length > 1000);
});

test("a huge legacy document within bounds", () => {
  const msgs = Array.from({ length: 30_000 }, (_, i) => ({
    id: `m${i}`,
    timestamp: "2026-11-15T10:30:05.000Z",
    type: i % 2 ? "gemini" : "user",
    content: `c${i}`,
  }));
  const recs = frameDocument(JSON.stringify({ ...H, messages: msgs }));
  assert.equal(recs.length, 30_001);
  const r = run(chatJson, recs);
  assert.deepEqual(accounting(recs, r), []);
  assert.equal(r.drafts.length, 30_001);
});

test("rewinds that do not unwind to the front stay cheap (no quadratic scans)", () => {
  const parts: string[] = [JSON.stringify(H)];
  for (let i = 0; i < 30_000; i++) {
    parts.push(
      JSON.stringify({
        id: `k${i}`,
        timestamp: "2026-11-15T10:30:05.000Z",
        type: "user",
        content: "x",
      }),
    );
    parts.push(JSON.stringify({ $rewindTo: `k${i}` }));
  }
  const recs = frameJsonl(`${parts.join("\n")}\n`);
  const t0 = Date.now();
  const r = run(chatJsonl, recs);
  assert.ok(Date.now() - t0 < 10_000);
  assert.deepEqual(accounting(recs, r), []);
});

// Deterministic fuzz: random JSON built from the adapters' own vocabulary and from junk.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function junk(rnd: () => number, depth: number): JsonValue {
  const pick = Math.floor(rnd() * 9);
  if (depth > 3 || pick < 3) {
    return [
      null,
      true,
      7,
      -1,
      1.5,
      "s",
      "",
      "2026-11-15T10:30:05.000Z",
      "user",
      "gemini",
      "success",
    ][Math.floor(rnd() * 11)] as JsonValue;
  }
  if (pick < 5) return Array.from({ length: Math.floor(rnd() * 3) }, () => junk(rnd, depth + 1));
  const keys = [
    "id",
    "type",
    "content",
    "toolCalls",
    "thoughts",
    "tokens",
    "model",
    "timestamp",
    "name",
    "args",
    "result",
    "status",
    "text",
    "thought",
    "functionResponse",
    "functionCall",
    "response",
    "output",
    "error",
    "resultDisplay",
    "filePath",
    "$set",
    "$patch",
    "$rewindTo",
    "updates",
    "removeIds",
    "messages",
    "input",
    "cached",
    "__proto__",
  ];
  const o: { [k: string]: JsonValue } = {};
  const n = Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    Object.defineProperty(o, keys[Math.floor(rnd() * keys.length)] as string, {
      value: junk(rnd, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return o;
}

test("fuzz: arbitrary JSON records never throw and always stay accounted and schema-valid", () => {
  const rnd = lcg(42);
  for (let round = 0; round < 200; round++) {
    const rows: unknown[] = [H];
    const n = 1 + Math.floor(rnd() * 25);
    for (let i = 0; i < n; i++) rows.push(junk(rnd, 0));
    const text = `${rows.map((x) => JSON.stringify(x)).join("\n")}\n`;
    for (const adapter of [chatJsonl, chatJson]) {
      const recs =
        adapter === chatJsonl
          ? frameJsonl(text)
          : frameDocument(JSON.stringify({ ...H, messages: rows.slice(1) }));
      const r = run(adapter, recs, { retention: round % 2 ? "inline" : "hash-only" });
      assert.deepEqual(accounting(recs, r), [], `round ${round}`);
      assert.deepEqual(attributeProblems(adapter, r), []);
      validated(adapter, recs, r, "s-1");
    }
  }
});
