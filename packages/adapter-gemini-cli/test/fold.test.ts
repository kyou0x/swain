import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftEvent, JsonValue } from "@swain/core";
import { sha256Hex } from "@swain/core";
import { chatJson } from "../src/json.js";
import { chatJsonl } from "../src/jsonl.js";
import {
  accounting,
  attributeProblems,
  frameDocument,
  frameJsonl,
  kinds,
  ofKind,
  type Run,
  run,
  shaOf,
  validated,
} from "./helpers.js";

const PH = "0".repeat(64);
const H = { sessionId: "s-1", projectHash: PH, startTime: "2026-11-15T10:30:00.000Z" };
const T = (n: number): string => `2026-11-15T10:30:${String(n).padStart(2, "0")}.000Z`;
const lines = (...o: unknown[]): string => `${o.map((x) => JSON.stringify(x)).join("\n")}\n`;
const user = (id: string, content: unknown, n = 1) => ({
  id,
  timestamp: T(n),
  type: "user",
  content,
});
const gem = (id: string, content: unknown, extra: Record<string, unknown> = {}, n = 2) => ({
  id,
  timestamp: T(n),
  type: "gemini",
  content,
  ...extra,
});
const call = (
  id: string,
  name: string,
  status: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  args: { file_path: "/p/a.txt", content: "x" },
  ...(status === undefined ? {} : { status }),
  timestamp: T(9),
  ...extra,
});
const resp = (id: string, name: string, response: unknown) => [
  { functionResponse: { id, name, response } },
];

function go(text: string, o: Parameters<typeof run>[2] = {}): { r: Run; ok: boolean } {
  const recs = frameJsonl(text);
  const r = run(chatJsonl, recs, o);
  assert.deepEqual(accounting(recs, r), []);
  assert.deepEqual(attributeProblems(chatJsonl, r), []);
  validated(chatJsonl, recs, r, "s-1");
  return { r, ok: true };
}

const by = (r: Run, kind: string): DraftEvent[] => ofKind(r, kind);

test("every end() draft names its records; push drafts only for unknown records", () => {
  const recs = frameJsonl(lines(H, user("a", "hi"), { type: "alien" }));
  const r = run(chatJsonl, recs);
  assert.ok(r.raw.length === 4);
  const end = r.raw[r.raw.length - 1];
  assert.ok(end !== undefined && end.drafts.length > 0);
  for (const d of end.drafts) assert.ok(d.recordRef !== undefined);
  assert.deepEqual(r.raw[1]?.drafts, []);
  assert.deepEqual(
    r.raw[2]?.drafts.map((d) => d.kind),
    ["source.unknown"],
  );
});

test("re-appended id keeps its first position; evidence is the last full write; middle writes are superseded", () => {
  const { r } = go(
    lines(H, user("a", "v1", 1), gem("b", "second", {}, 2), user("a", "v2", 3), user("a", "v3", 4)),
  );
  const turn = r.drafts.find((d) => d.draft.kind === "turn.started");
  assert.deepEqual([turn?.order, turn?.evidence], [1, 4]);
  const text = r.drafts.find((d) => d.draft.kind === "message.observed");
  assert.deepEqual([text?.order, text?.evidence], [2, 2]);
  assert.deepEqual(r.dispositions, [{ sourceSequence: 3, kind: "superseded", into: 1 }]);
  // The hash is of the LAST write.
  const ref = turn?.draft.payload["prompt"] as { sha256: string };
  assert.equal(ref.sha256, sha256Hex(new TextEncoder().encode("v3")));
  assert.equal(turn?.draft.time.value, T(4));
});

test("$set and repeated header records are metadata into the header", () => {
  const { r } = go(lines(H, { $set: { lastUpdated: T(1), summary: "s" } }, H, user("a", "x")));
  assert.deepEqual(r.dispositions, [
    { sourceSequence: 1, kind: "metadata", into: 0 },
    { sourceSequence: 2, kind: "metadata", into: 0 },
  ]);
  assert.deepEqual(kinds(r), ["session.started", "turn.started"]);
});

test("$patch content: evidence is the patch record, order stays with the message", () => {
  const { r } = go(lines(H, user("a", "orig"), { $patch: { id: "a", content: "patched" } }));
  const turn = r.drafts.find((d) => d.draft.kind === "turn.started");
  assert.deepEqual([turn?.order, turn?.evidence], [1, 2]);
  assert.equal(turn?.draft.pointer, "/$patch/content");
  assert.equal(
    shaOf(turn?.draft.payload["prompt"]),
    sha256Hex(new TextEncoder().encode("patched")),
  );
  assert.deepEqual(r.dispositions, []);
});

test("$patch toolCalls result replaces the result and becomes its evidence", () => {
  const m = gem("a", "", {
    toolCalls: [
      call("t1", "run_shell_command", "success", {
        result: resp("t1", "run_shell_command", { output: "old" }),
      }),
    ],
  });
  const { r } = go(
    lines(H, m, {
      $patch: {
        updates: [
          {
            id: "a",
            toolCalls: [{ id: "t1", result: resp("t1", "run_shell_command", { output: "new" }) }],
          },
        ],
      },
    }),
  );
  const done = r.drafts.find((d) => d.draft.kind === "tool.completed");
  assert.deepEqual([done?.order, done?.evidence], [1, 2]);
  assert.equal(done?.draft.pointer, "/$patch/updates/0/toolCalls/0/result");
  assert.equal(shaOf(done?.draft.payload["output"]), sha256Hex(new TextEncoder().encode("new")));
  const req = r.drafts.find((d) => d.draft.kind === "tool.requested");
  assert.equal(req?.evidence, 1);
});

test("a later full re-write discards earlier patches; the patch record becomes a control", () => {
  const { r } = go(
    lines(
      H,
      user("a", "orig"),
      { $patch: { id: "a", content: "patched" } },
      user("a", "rewritten", 5),
    ),
  );
  const turn = r.drafts.find((d) => d.draft.kind === "turn.started");
  assert.deepEqual([turn?.order, turn?.evidence], [1, 3]);
  assert.deepEqual(r.dispositions, [{ sourceSequence: 2, kind: "control", into: 1 }]);
});

test("$patch removeIds removes messages; orderIds is reported, not applied", () => {
  const { r } = go(
    lines(H, user("a", "x"), user("b", "y", 2), {
      $patch: { removeIds: ["a"], orderIds: ["b", "a"] },
    }),
  );
  assert.deepEqual(by(r, "turn.started").length, 1);
  assert.deepEqual(r.dispositions, [
    { sourceSequence: 1, kind: "rewound", into: null },
    { sourceSequence: 3, kind: "control", into: null },
  ]);
  assert.ok(
    r.warnings.some(
      (w) => w.code === "unmapped-field" && w.detail["fieldCode"] === "gm.patch-order-ids",
    ),
  );
});

test("$rewindTo removes the target and everything after it; the id can come back", () => {
  const { r } = go(
    lines(
      H,
      user("a", "1"),
      user("b", "2", 2),
      user("c", "3", 3),
      { $rewindTo: "b" },
      user("b", "again", 5),
    ),
  );
  const turns = r.drafts.filter((d) => d.draft.kind === "turn.started");
  assert.deepEqual(
    turns.map((t) => [t.order, t.evidence]),
    [
      [1, 1],
      [5, 5],
    ],
  );
  assert.deepEqual(
    r.dispositions.map((d) => [d.sourceSequence, d.kind, d.into]),
    [
      [2, "rewound", null],
      [3, "rewound", null],
      [4, "control", null],
    ],
  );
});

test("$rewindTo an unknown id clears all messages (loader semantics) and warns", () => {
  const { r } = go(
    lines(H, user("a", "1"), gem("b", "2"), { $rewindTo: "nope" }, user("c", "3", 3)),
  );
  assert.deepEqual(by(r, "turn.started").length, 1);
  assert.equal(r.drafts.find((d) => d.draft.kind === "turn.started")?.order, 4);
  assert.ok(
    r.warnings.some(
      (w) => w.detail["reasonCode"] === "gm.rewind-unknown-id" && w.severity === "warn",
    ),
  );
  assert.deepEqual(
    r.dispositions.filter((d) => d.kind === "rewound").map((d) => d.sourceSequence),
    [1, 2],
  );
});

test("tool results appear twice in the log; the functionResponse user message is deduplicated", () => {
  const out = resp("t1", "run_shell_command", { output: "ok" });
  const { r } = go(
    lines(
      H,
      user("u", "go"),
      gem("g", "", { toolCalls: [call("t1", "run_shell_command", "success", { result: out })] }, 2),
      user("carrier", out, 3),
    ),
  );
  assert.equal(by(r, "tool.completed").length, 1);
  assert.equal(by(r, "turn.started").length, 1);
  assert.deepEqual(r.dispositions, [{ sourceSequence: 3, kind: "superseded", into: 2 }]);
});

test("an orphan functionResponse yields a result event with an unresolvable result-of ref", () => {
  const { r } = go(lines(H, user("c", resp("ghost", "read_file", { output: "o" }))));
  const done = by(r, "tool.completed");
  assert.equal(done.length, 1);
  assert.equal(done[0]?.status, "unknown");
  assert.deepEqual(done[0]?.correlation?.refs, [{ rel: "result-of", key: "ghost" }]);
  assert.equal(by(r, "tool.requested").length, 0);
});

test("a call without status takes its result from the functionResponse message", () => {
  const out = resp("t1", "read_file", { output: "o" });
  const { r } = go(
    lines(H, gem("g", "", { toolCalls: [call("t1", "read_file", undefined)] }), user("c", out, 3)),
  );
  const done = r.drafts.find((d) => d.draft.kind === "tool.completed");
  assert.equal(done?.draft.status, "unknown");
  assert.deepEqual([done?.order, done?.evidence], [1, 2]);
  assert.deepEqual(r.dispositions, []);
});

test("tool statuses map to completed / failed; non-terminal statuses stay request-only", () => {
  const calls = [
    call("a", "read_file", "success", { result: resp("a", "read_file", { output: "o" }) }),
    call("b", "read_file", "error", { result: resp("b", "read_file", { error: "boom" }) }),
    call("c", "read_file", "cancelled", {
      result: resp("c", "read_file", { error: "user cancelled" }),
    }),
    call("d", "read_file", "executing"),
    call("e", "read_file", "awaiting_approval"),
    call("f", "read_file", "brand-new-status"),
    call("g", "read_file", "success"),
  ];
  const { r } = go(lines(H, gem("g", "", { toolCalls: calls })));
  const done = by(r, "tool.completed").map((d) => d.payload["toolCallId"]);
  const failed = by(r, "tool.failed").map((d) => [
    d.payload["toolCallId"],
    d.status,
    d.payload["errorClass"],
  ]);
  assert.deepEqual(done, ["a", "g"]);
  assert.deepEqual(failed, [
    ["b", "failure", "error"],
    ["c", "interrupted", "interrupted"],
  ]);
  assert.equal(by(r, "tool.requested").length, 7);
  const statuses = by(r, "tool.requested").map((d) => d.attributes["gemini-cli.tool_status"]);
  assert.deepEqual(statuses, [
    "success",
    "error",
    "cancelled",
    "executing",
    "awaiting_approval",
    "other",
    "success",
  ]);
  // Success with no result: completed, output absent.
  const g = by(r, "tool.completed")[1];
  assert.equal(g?.payload["output"], null);
  assert.equal(g?.completeness.outputs?.state, "absent");
});

test("file.changed only for successful write-type tools; requests, errors and cancels never qualify", () => {
  const diff = {
    fileDiff: "--- a\n+++ b\n",
    fileName: "a.txt",
    filePath: "/p/a.txt",
    originalContent: null,
    newContent: "x",
    isNewFile: true,
  };
  const calls = [
    call("w1", "write_file", "success", {
      resultDisplay: diff,
      result: resp("w1", "write_file", { output: "ok" }),
    }),
    call("w2", "write_file", "success", { result: resp("w2", "write_file", { output: "ok" }) }),
    call("w3", "write_file", "error", { result: resp("w3", "write_file", { error: "no" }) }),
    call("w4", "write_file", "cancelled"),
    call("w5", "write_file", undefined),
    call("w6", "write_file", "executing"),
    call("w7", "read_file", "success", { resultDisplay: diff }),
    call("w8", "replace", "success", { args: { old_string: "a" } }),
    call("w9", "replace", "success", { args: { file_path: "/p/b.txt" } }),
  ];
  const { r } = go(lines(H, gem("g", "", { toolCalls: calls })));
  const fc = by(r, "file.changed");
  assert.deepEqual(
    fc.map((d) => [
      d.payload["viaToolCallId"],
      d.payload["basis"],
      d.payload["changeKind"],
      d.payload["path"],
    ]),
    [
      ["w1", "provider-reported", "add", "/p/a.txt"],
      ["w2", "derived-from-tool-result", "unknown", "/p/a.txt"],
      ["w9", "derived-from-tool-result", "update", "/p/b.txt"],
    ],
  );
  assert.equal(shaOf(fc[0]?.payload["diff"])?.length, 64);
  assert.equal(fc[1]?.payload["diff"], null);
});

test("thoughts become provider-exposed reasoning events, never hidden chain-of-thought", () => {
  const { r } = go(
    lines(
      H,
      gem(
        "g",
        [
          { text: "part thought", thought: true, thoughtSignature: "SECRETSIG" },
          { text: "answer" },
        ],
        {
          thoughts: [{ subject: "S", description: "D", timestamp: T(7) }],
        },
      ),
    ),
  );
  const reasoning = by(r, "message.observed").filter((d) => d.payload["channel"] === "reasoning");
  assert.equal(reasoning.length, 2);
  for (const d of reasoning) {
    assert.equal(d.payload["role"], "assistant");
    assert.equal(d.completeness.internalReasoning?.state, "unavailable");
    assert.equal((d.payload["content"] as { retention: string }).retention, "hash-only");
  }
  assert.equal(reasoning[0]?.time.value, T(7));
  assert.deepEqual(
    reasoning.map((d) => d.attributes["gemini-cli.thought_source"]),
    ["summary", "part"],
  );
  assert.ok(!JSON.stringify(r.drafts).includes("SECRETSIG"));
  const text = by(r, "message.observed").find((d) => d.payload["channel"] === "text");
  assert.equal(shaOf(text?.payload["content"]), sha256Hex(new TextEncoder().encode("answer")));
});

test("tokens and model map to a message-scope model.usage", () => {
  const { r } = go(
    lines(
      H,
      gem("g", "t", {
        model: "gemini-x",
        tokens: { input: 1, output: 2, cached: 3, thoughts: 4, tool: 5, total: 6 },
      }),
      gem("h", "t", { model: "gemini-y" }, 3),
      gem("i", "t", { tokens: null }, 4),
    ),
  );
  const usage = by(r, "model.usage");
  assert.deepEqual(usage[0]?.payload, {
    scope: "message",
    model: "gemini-x",
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 3,
    reasoningOutputTokens: 4,
    totalTokens: 6,
  });
  assert.ok(r.warnings.some((w) => w.detail["fieldCode"] === "gm.tokens-tool"));
  assert.deepEqual(usage[1]?.payload, { scope: "message", model: "gemini-y" });
  assert.equal(usage[1]?.completeness.tokens?.state, "absent");
  assert.equal(usage.length, 2);
});

test("info, error and warning messages are runtime notifications", () => {
  const recs = lines(
    H,
    ...(["info", "error", "warning"] as const).map((t, i) => ({
      id: t,
      timestamp: T(i),
      type: t,
      content: `${t} text`,
    })),
  );
  const { r } = go(recs);
  const obs = by(r, "message.observed");
  assert.deepEqual(
    obs.map((d) => d.attributes["gemini-cli.message_type"]),
    ["info", "error", "warning"],
  );
  for (const d of obs) {
    assert.equal(d.payload["role"], "system");
    assert.equal(d.payload["channel"], "notification");
    assert.equal(d.actor.role, "runtime");
  }
});

test("unknown message type and non-message records give one source.unknown each", () => {
  const { r } = go(
    lines(H, gem("x", "t"), { id: "y", type: "alien", timestamp: T(1) }, { weird: true }),
  );
  assert.equal(by(r, "source.unknown").length, 2);
  assert.ok(r.warnings.filter((w) => w.code === "unknown-record-type").length === 2);
});

test("a message that yields no event is accounted by a metadata disposition", () => {
  const { r } = go(lines(H, gem("e", "", {})));
  assert.deepEqual(r.dispositions, [{ sourceSequence: 1, kind: "metadata", into: 0 }]);
});

test("content is hash-only by default; inline only when the policy says so", () => {
  const text = lines(
    H,
    user("a", "hello inline"),
    gem("b", "", {
      toolCalls: [
        call("t", "read_file", "success", { result: resp("t", "read_file", { output: "out" }) }),
      ],
    }),
  );
  const hashOnly = go(text).r;
  assert.ok(!JSON.stringify(hashOnly.drafts).includes("hello inline"));
  assert.ok(!JSON.stringify(hashOnly.drafts).includes('"inline"'));
  const inline = go(text, { retention: "inline" }).r;
  const prompt = by(inline, "turn.started")[0]?.payload["prompt"] as {
    inline?: string;
    retention: string;
  };
  assert.equal(prompt.retention, "inline");
  assert.equal(prompt.inline, "hello inline");
  const out = by(inline, "tool.completed")[0]?.payload["output"] as { inline?: string };
  assert.equal(out.inline, "out");
});

test("providerVersion is passed through from the parse context", () => {
  const { r } = go(lines(H, user("a", "x")), { version: "0.68.0" });
  assert.ok(r.drafts.every((d) => d.draft.providerVersion === "0.68.0"));
});

test("fold state is bounded: past maxOpenCorrelations records are mapped unfolded, with a warning", () => {
  const text = lines(
    H,
    user("a", "1"),
    user("b", "2", 2),
    user("c", "3", 3),
    user("c", "3b", 4),
    user("a", "1b", 5),
  );
  const { r } = go(text, { bounds: { maxOpenCorrelations: 2 } });
  // a and b fold; c (twice) is not folded and appears as two separate turns.
  const turns = by(r, "turn.started");
  assert.equal(turns.length, 4);
  assert.ok(r.warnings.some((w) => w.code === "bounds-reached"));
});

test("per-message drafts are capped at maxDraftsPerRecord", () => {
  const calls = Array.from({ length: 20 }, (_, i) => call(`t${i}`, "read_file", undefined));
  const { r } = go(lines(H, gem("g", "", { toolCalls: calls })), {
    bounds: { maxDraftsPerRecord: 5 },
  });
  assert.equal(r.drafts.filter((d) => d.order === 1).length, 5);
  assert.ok(r.warnings.some((w) => w.code === "bounds-reached"));
});

test("legacy document: envelope is the header, elements map the same way, no fold", () => {
  const doc = JSON.stringify(
    {
      ...H,
      messages: [
        user("a", "hi"),
        gem("b", "yo", { model: "m", tokens: { input: 1, output: 1, cached: 0, total: 2 } }),
        user("c", resp("zz", "x", { output: "o" }), 3),
      ],
    },
    null,
    2,
  );
  const recs = frameDocument(doc);
  const r = run(chatJson, recs);
  assert.deepEqual(accounting(recs, r), []);
  validated(chatJson, recs, r, "s-1");
  assert.deepEqual(
    kinds(r).filter((k) => k !== "tool.completed"),
    ["session.started", "turn.started", "message.observed", "model.usage"],
  );
  assert.deepEqual(r.drafts.find((d) => d.draft.kind === "session.started")?.evidence, 0);
  // Duplicate ids are not folded in the legacy document.
  const dup = frameDocument(
    JSON.stringify({ ...H, messages: [user("a", "1"), user("a", "2", 2)] }),
  );
  const rd = run(chatJson, dup);
  assert.equal(rd.drafts.filter((d) => d.draft.kind === "turn.started").length, 2);
  assert.deepEqual(accounting(dup, rd), []);
});

test("values from the source never reach attributes except through closed vocabularies", () => {
  const { r } = go(
    lines(H, {
      id: "a",
      timestamp: T(1),
      type: "gemini",
      content: "x",
      toolCalls: [call("t", "n", "<script>")],
    }),
  );
  const attrs = r.drafts.flatMap((d) => Object.values(d.draft.attributes));
  assert.ok(attrs.every((v) => ["gemini", "other"].includes(String(v))));
});

test("JSON values are never trusted: parsed objects are read through own properties only", () => {
  const rec = JSON.parse(
    '{"id":"a","type":"user","timestamp":"x","content":"c","__proto__":{"type":"gemini"}}',
  ) as JsonValue;
  const text = `${JSON.stringify(H)}\n${JSON.stringify(rec)}\n`;
  const { r } = go(text);
  assert.equal(by(r, "turn.started").length, 1);
});
