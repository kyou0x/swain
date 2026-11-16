import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@swain/core";
import { sessionExport } from "../src/index.js";
import {
  accounting,
  attributeProblems,
  detect,
  frameDocument,
  ofKind,
  readFixture,
  run,
  validated,
} from "./helpers.js";

const ESC = "\u001b";
const load = (f: string) => frameDocument(readFixture(`opencode/synthetic-mvp/${f}`));

test("HTML, ANSI and bidi in content never reach canonical data except in names and paths", () => {
  const recs = load("hostile-content.json");
  const r = run(sessionExport, recs);
  assert.deepEqual(accounting(recs, r), []);
  const tools = ofKind(r, "tool.requested");
  assert.ok(String(tools[0]?.payload["toolName"]).includes(`${ESC}[31m`));
  assert.ok(String(tools[0]?.payload["toolName"]).includes("<script>"));
  const stripped = JSON.stringify(
    r.drafts.map((d) => {
      const {
        toolName: _t,
        path: _p,
        topLevelKeys: _k,
        nativeType: _n,
        nativeSessionId: _s,
        model: _m,
        ...rest
      } = d.draft.payload as Record<string, JsonValue>;
      const { "opencode.cwd": _c, ...attrs } = d.draft.attributes;
      // The native session id is an identifier channel (bounded to 256 bytes) like tool names.
      const { nativeSessionId: _id, ...draft } = d.draft;
      return { ...draft, payload: rest, attributes: attrs };
    }),
  );
  assert.ok(!stripped.includes("<script") && !stripped.includes("onerror"), "markup leaked");
  assert.ok(!stripped.includes(ESC) && !stripped.includes("\\u001b"), "ANSI leaked");
  assert.ok(
    !stripped.includes("‮") && !stripped.includes(" ") && !stripped.includes("evil.example"),
  );
});

test("path traversal and NUL paths are inert text: kept as given or dropped, never resolved", () => {
  const r = run(sessionExport, load("hostile-content.json"));
  const paths = ofKind(r, "file.changed").map((d) => d.payload["path"]);
  assert.deepEqual(paths, ["../../etc/passwd", "/etc/shadow", "../../x"]);
});

test("__proto__ keys are neither followed nor polluting", () => {
  const recs = load("hostile-content.json");
  const r = run(sessionExport, recs);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(({} as Record<string, unknown>)["x"], undefined);
  // The element with an own `__proto__` key still maps normally (a text part under an invalid time).
  const el = r.drafts.filter((d) => d.order === 3);
  assert.deepEqual(
    el.map((d) => d.draft.kind),
    ["message.observed"],
  );
  assert.equal(el[0]?.draft.time.status, "invalid");
});

test("wrong types everywhere: no throw, valid events, malformed parts are source.unknown", () => {
  const recs = load("hostile-content.json");
  const r = run(sessionExport, recs);
  assert.deepEqual(attributeProblems(sessionExport, r), []);
  validated(sessionExport, recs, r, "ses_<script>alert(1)</script>");
  assert.ok(ofKind(r, "source.unknown").length >= 8);
  // Non-numeric counters are dropped, not coerced; negative cost is dropped.
  const usage = ofKind(r, "model.usage").find((d) => d.payload["scope"] === "message");
  assert.deepEqual(usage?.payload, { scope: "message", model: "m<b>" });
  assert.equal(usage?.attributes["opencode.finish_reason"], "other");
});

test("missing /messages, and /messages that is not an array: envelope only", () => {
  for (const [f, verdict] of [
    ["hostile-missing-messages.json", "match"],
    ["hostile-messages-wrong-type.json", "no-match"],
  ] as const) {
    const recs = load(f);
    assert.equal(recs.length, 1);
    assert.equal(detect(sessionExport, recs).verdict, verdict);
    const r = run(sessionExport, recs);
    assert.deepEqual(
      r.drafts.map((d) => d.draft.kind),
      ["session.started", "model.usage"],
    );
    assert.deepEqual(accounting(recs, r), []);
  }
  const odd = frameDocument("[1]");
  assert.deepEqual(
    run(sessionExport, odd).drafts.map((d) => d.draft.kind),
    ["source.unknown"],
  );
  const info = frameDocument(JSON.stringify({ info: "x" }));
  assert.deepEqual(
    run(sessionExport, info).drafts.map((d) => d.draft.kind),
    ["source.unknown"],
  );
});

test("a huge messages array within bounds maps linearly", () => {
  const N = 20_000;
  const messages = Array.from({ length: N }, (_, i) =>
    i % 2
      ? {
          info: {
            id: `m${i}`,
            role: "assistant",
            time: { created: 1_790_000_000_000 + i },
            modelID: "m",
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [
            { type: "text", text: `t${i}` },
            {
              type: "tool",
              callID: `c${i}`,
              tool: "bash",
              state: { status: "pending", input: {}, raw: "" },
            },
          ],
        }
      : {
          info: { id: `m${i}`, role: "user", time: { created: 1_790_000_000_000 + i } },
          parts: [{ type: "text", text: `t${i}` }],
        },
  );
  const recs = frameDocument(
    JSON.stringify({ info: { id: "ses_big", time: { created: 1 } }, messages }),
  );
  assert.equal(recs.length, N + 1);
  const t0 = Date.now();
  const r = run(sessionExport, recs);
  assert.ok(Date.now() - t0 < 20_000);
  assert.deepEqual(accounting(recs, r), []);
  assert.ok(r.drafts.length >= N);
});

// Deterministic fuzz built from the adapter's vocabulary.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const KEYS = [
  "info",
  "parts",
  "id",
  "role",
  "type",
  "text",
  "time",
  "created",
  "completed",
  "start",
  "end",
  "tool",
  "callID",
  "state",
  "status",
  "input",
  "output",
  "error",
  "metadata",
  "exit",
  "files",
  "tokens",
  "cost",
  "cache",
  "read",
  "write",
  "reason",
  "attempt",
  "filediff",
  "file",
  "patch",
  "diff",
  "exists",
  "modelID",
  "name",
  "agent",
  "auto",
  "__proto__",
];
const ATOMS: JsonValue[] = [
  null,
  true,
  0,
  7,
  -1,
  1.5,
  1e20,
  "s",
  "",
  "user",
  "assistant",
  "text",
  "reasoning",
  "tool",
  "completed",
  "error",
  "pending",
  "running",
  "bash",
  "edit",
  "write",
  "patch",
  "step-finish",
  "step-start",
  "subtask",
  "retry",
  "compaction",
  "agent",
  "file",
  "snapshot",
  "/p/x",
];

function junk(rnd: () => number, depth: number): JsonValue {
  const pick = Math.floor(rnd() * 10);
  if (depth > 4 || pick < 3) return ATOMS[Math.floor(rnd() * ATOMS.length)] as JsonValue;
  if (pick < 5) return Array.from({ length: Math.floor(rnd() * 4) }, () => junk(rnd, depth + 1));
  const o: { [k: string]: JsonValue } = {};
  const n = Math.floor(rnd() * 7);
  for (let i = 0; i < n; i++) {
    Object.defineProperty(o, KEYS[Math.floor(rnd() * KEYS.length)] as string, {
      value: junk(rnd, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return o;
}

test("fuzz: arbitrary JSON elements never throw and always stay accounted and schema-valid", () => {
  const rnd = lcg(7);
  for (let round = 0; round < 250; round++) {
    const messages: JsonValue[] = [];
    const n = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < n; i++) {
      messages.push(
        i % 3 === 0
          ? junk(rnd, 0)
          : {
              info: junk(rnd, 1),
              parts: Array.from({ length: Math.floor(rnd() * 5) }, () => junk(rnd, 1)),
            },
      );
    }
    const recs = frameDocument(JSON.stringify({ info: junk(rnd, 1), messages }));
    const r = run(sessionExport, recs, { retention: round % 2 ? "inline" : "hash-only" });
    assert.deepEqual(accounting(recs, r), [], `round ${round}`);
    assert.deepEqual(attributeProblems(sessionExport, r), []);
    validated(sessionExport, recs, r, "ses_1");
  }
});
