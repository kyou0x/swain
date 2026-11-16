import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CapabilityValue } from "@swain/core";
import { DEFAULT_BOUNDS } from "@swain/core";
import { registrations } from "../src/index.js";
import { streamJsonAdapter } from "../src/stream-json.js";
import {
  assemble,
  checkGolden,
  type Driven,
  drive,
  frame,
  goldenText,
  kinds,
  readFixture,
  repoPath,
  unaccounted,
} from "./harness.js";

const A = streamJsonAdapter;
const RANK: Record<CapabilityValue, number> = {
  unsupported: 0,
  unknown: 1,
  partial: 2,
  available: 3,
};

function ofKind(d: Driven, kind: string) {
  return d.drafts.filter((x) => x.draft.kind === kind);
}

test("manifest: conservative declarations", () => {
  assert.equal(A.manifest.id, "claude-code.stream-json");
  assert.equal(A.manifest.sourceKind, "claude-code.stream-json");
  assert.equal(A.manifest.sourceStability, "documented-interface");
  assert.equal(A.manifest.experimental, false);
  assert.deepEqual(A.manifest.testedProviderVersions, []);
  assert.deepEqual(A.manifest.framing, { kind: "jsonl" });
  assert.deepEqual(A.manifest.captureModes, ["import-file"]);
  assert.ok(registrations.some((r) => r.adapter === A));
});

test("manifest: capabilities never exceed capability-matrix.json (M12 per-surface rule)", () => {
  const matrix = JSON.parse(
    readFileSync(repoPath("docs/architecture/capability-matrix.json"), "utf8"),
  );
  const cells = matrix.providers["claude-code"].cells;
  for (const [row, value] of Object.entries(A.manifest.capabilities)) {
    const cell = cells[row];
    const listed = cell.surfaces.includes(A.manifest.id);
    const ceiling: CapabilityValue = listed ? cell.value : "unknown";
    assert.ok(RANK[value] <= RANK[ceiling], `${row}: ${value} exceeds ${ceiling}`);
  }
});

test("golden: detect, accounting, validator and adapter-level golden", () => {
  const text = readFixture("claude-code", "stream-json-golden.jsonl");
  const d = drive(A, text);
  assert.equal(d.providerVersionSeen, "0.0.0-example");
  assert.equal(d.nativeSessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(unaccounted(d), []);
  const asm = assemble(A, text, d);
  assert.deepEqual(asm.unresolvedRefs, [], "every correlation ref resolves in the golden");
  checkGolden("claude-code", "stream-json-golden.adapter.json", goldenText(A, d));
});

test("golden: native to canonical mapping", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-golden.jsonl"));
  const k = kinds(d);
  assert.equal(k.filter((x) => x === "session.started").length, 1);
  assert.equal(k.filter((x) => x === "session.ended").length, 1);
  // prompt echo is a human turn start with a hash-only prompt
  const turn = ofKind(d, "turn.started")[0];
  assert.ok(turn);
  const prompt = turn.draft.payload["prompt"] as { retention: string; inline?: string };
  assert.equal(prompt.retention, "hash-only");
  assert.equal("inline" in prompt, false);
  // tool requests: Bash, Edit, Write, Agent, subagent Edit
  const reqs = ofKind(d, "tool.requested").map((x) => x.draft.payload["toolName"]);
  assert.deepEqual(reqs, ["Bash", "Edit", "Write", "Agent", "Edit"]);
  // success -> tool.completed, error -> tool.failed
  assert.equal(ofKind(d, "tool.completed").length, 4);
  const failed = ofKind(d, "tool.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.draft.status, "failure");
  assert.equal(failed[0]?.draft.payload["errorClass"], "error");
  // file.changed: Write (add) and the subagent Edit; NOT the failed Edit, NOT Bash
  const fc = ofKind(d, "file.changed").map((x) => x.draft.payload);
  assert.deepEqual(
    fc.map((p) => [p["path"], p["changeKind"], p["basis"]]),
    [
      ["/home/user/project/NOTES.md", "add", "derived-from-tool-result"],
      ["/home/user/project/NOTES.md", "update", "derived-from-tool-result"],
    ],
  );
  // thinking is provider-exposed reasoning text
  const reasoning = ofKind(d, "message.observed").filter(
    (x) => x.draft.payload["channel"] === "reasoning",
  );
  assert.equal(reasoning.length, 1);
  assert.deepEqual(reasoning[0]?.draft.completeness.internalReasoning, {
    state: "unavailable",
    reason: "provider-does-not-expose",
  });
});

test("multi-line turns sharing message.id: usage is emitted once, at end(), with last-line evidence", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-golden.jsonl"));
  const usage = ofKind(d, "model.usage").filter((x) => x.draft.payload["scope"] === "message");
  // msg_example01 .. msg_example05 plus the subagent message
  assert.equal(usage.length, 6);
  const first = usage.find((x) => x.draft.payload["inputTokens"] === 10);
  assert.ok(first, "msg_example01 usage present once");
  assert.equal(usage.filter((x) => x.draft.payload["inputTokens"] === 10).length, 1);
  // msg_example01 spans records 2 and 3 (sequence 0 is init): evidence is the last line
  assert.equal(first.evidence, 3);
  assert.equal(first.order, 3);
  assert.ok(first.draft.recordRef, "end() drafts carry recordRef");
  const w = usage.find((x) => x.draft.payload["inputTokens"] === 35);
  assert.equal(w?.draft.payload["cachedInputTokens"], 5);
  assert.equal(w?.draft.payload["cacheWriteInputTokens"], 0);
});

test("result: cumulative totals map to scope session and are not summed with message usage", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-golden.jsonl"));
  const sess = ofKind(d, "model.usage").filter((x) => x.draft.payload["scope"] === "session");
  assert.equal(sess.length, 1);
  const p = sess[0]?.draft.payload;
  assert.equal(p?.["model"], "example-model");
  assert.equal(p?.["inputTokens"], 120);
  assert.equal(p?.["outputTokens"], 61);
  assert.equal(p?.["costUsdEstimate"], 0.0123);
  const ended = ofKind(d, "turn.ended")[0];
  assert.equal(ended?.draft.status, "success");
  assert.equal(ended?.draft.attributes["claude-code.num-turns"], 5);
  const sessEnd = ofKind(d, "session.ended")[0];
  assert.equal(sessEnd?.draft.status, "success");
  assert.equal(sessEnd?.draft.payload["reason"], "unknown");
});

test("subagents: parent_tool_use_id yields agent.started/ended linked to the Agent tool call", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-golden.jsonl"));
  const started = ofKind(d, "agent.started");
  assert.equal(started.length, 1);
  const s = started[0]?.draft;
  assert.equal(s?.payload["agentType"], "reviewer");
  assert.equal(s?.payload["spawnedByToolCallId"], "toolu_agent01");
  assert.equal(s?.actor.role, "subagent");
  assert.deepEqual(s?.correlation?.refs, [{ rel: "spawned-by", key: "toolu_agent01" }]);
  const ended = ofKind(d, "agent.ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0]?.draft.status, "success");
  // subagent tool request is attributed to the subagent actor, not root
  const subReq = ofKind(d, "tool.requested")[4];
  assert.equal(subReq?.draft.actor.role, "subagent");
  assert.equal(subReq?.draft.actorKey, "native:toolu_agent01");
});

test("permission denials: result and system/permission_denied map to requested+decided(deny)", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-golden.jsonl"));
  assert.equal(ofKind(d, "permission.requested").length, 2);
  const dec = ofKind(d, "permission.decided");
  assert.equal(dec.length, 2);
  for (const x of dec) {
    assert.equal(x.draft.payload["decision"], "deny");
    assert.equal(x.draft.payload["decidedBy"], "unknown");
    assert.equal(x.draft.completeness.causality?.state, "captured");
  }
  // a denial does not fabricate a tool.failed
  assert.equal(ofKind(d, "tool.failed").length, 1);
});

test("control records are accounted by disposition, not events", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-golden.jsonl"));
  assert.deepEqual(
    d.dispositions.map((x) => x.kind),
    ["control", "control"],
  );
  assert.ok(d.dispositions.every((x) => x.into === null));
});

test("error stream: error result, api_retry notification, attributes in the allowlist", () => {
  const text = readFixture("claude-code", "stream-json-error.jsonl");
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
  const ended = ofKind(d, "turn.ended")[0];
  assert.equal(ended?.draft.status, "failure");
  assert.equal(ended?.draft.attributes["claude-code.terminal-reason"], "max_turns");
  const msgs = ofKind(d, "message.observed");
  assert.ok(msgs.some((x) => x.draft.payload["channel"] === "notification"));
  const text0 = ofKind(d, "message.observed").find((x) => x.draft.payload["channel"] === "text");
  assert.equal(text0?.draft.attributes["claude-code.api-error"], "rate_limit");
  checkGolden("claude-code", "stream-json-error.adapter.json", goldenText(A, d));
});

test("attribute keys are always inside the manifest allowlist", () => {
  for (const f of [
    "stream-json-golden.jsonl",
    "stream-json-error.jsonl",
    "stream-json-hostile.jsonl",
  ]) {
    const d = drive(A, readFixture("claude-code", f));
    for (const x of d.drafts) {
      for (const key of Object.keys(x.draft.attributes)) {
        assert.ok(A.manifest.attributeKeys.includes(key), `${f}: ${key}`);
      }
    }
  }
});

test("hash-only by default, inline only when the policy says so", () => {
  const text = readFixture("claude-code", "stream-json-golden.jsonl");
  const hashOnly = JSON.stringify(drive(A, text).drafts);
  assert.equal(hashOnly.includes('"inline"'), false);
  assert.equal(hashOnly.includes("Fix the typo"), false);
  const inline = JSON.stringify(drive(A, text, "inline").drafts);
  assert.ok(inline.includes("Fix the typo in README.md"));
});

test("inline mode still validates (hash matches inline) for the golden", () => {
  const text = readFixture("claude-code", "stream-json-golden.jsonl");
  assemble(A, text, drive(A, text, "inline"));
});

test("hostile: accounting, validator and golden hold; nothing is thrown", () => {
  const text = readFixture("claude-code", "stream-json-hostile.jsonl");
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
  checkGolden("claude-code", "stream-json-hostile.adapter.json", goldenText(A, d));
});

test("hostile: markup, ANSI and bidi in tool names and content stay inert data", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-hostile.jsonl"));
  const names = ofKind(d, "tool.requested").map((x) => x.draft.payload["toolName"]);
  assert.ok(names.includes("<script>alert(1)</script>"));
  // an mcp-looking hostile name is still namespaced mcp with a bounded server, never executed
  const mcp = ofKind(d, "tool.requested").find((x) => x.draft.payload["toolNamespace"] === "mcp");
  assert.equal(mcp?.draft.payload["mcpServer"], 'evil"><svg onload=1>');
  // cwd attribute keeps the raw text (display layers escape it)
  const sess = ofKind(d, "session.started")[0];
  assert.equal(sess?.draft.attributes["claude-code.cwd"], "/home/user/<script>alert(1)</script>");
  // content is hash-only: no hostile text is stored in any ContentRef
  assert.equal(
    JSON.stringify(d.drafts.map((x) => x.draft.payload["input"])).includes("<img"),
    false,
  );
});

test("hostile: wrong types become source.unknown or partial facets, never invented tools", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-hostile.jsonl"));
  const unknowns = ofKind(d, "source.unknown");
  assert.ok(unknowns.length >= 8, `got ${unknowns.length}`);
  for (const u of unknowns) {
    const p = u.draft.payload;
    assert.equal(typeof p["recordSha256"], "string");
    assert.ok(Array.isArray(p["topLevelKeys"]));
  }
  // tool_use with a non-string id/name: sentinel name, no anchor, no toolCallId
  const bad = ofKind(d, "tool.requested").find((x) => x.draft.payload["toolName"] === "unknown");
  assert.ok(bad);
  assert.equal(bad.draft.payload["toolCallId"], null);
  assert.equal(bad.draft.correlation?.anchor, undefined);
  // wrong usage types: no usage event for msg_h3 (all fields invalid), never a negative count
  for (const u of ofKind(d, "model.usage")) {
    for (const [k, v] of Object.entries(u.draft.payload)) {
      if (typeof v === "number") assert.ok(v >= 0 && !Object.is(v, -0), k);
    }
  }
  // unknown record types: one unknown each, with a warning, and unknown-record-type nativeType
  assert.ok(unknowns.some((u) => u.draft.payload["nativeType"] === "future_thing"));
  assert.ok(unknowns.some((u) => u.draft.payload["nativeType"] === "system.future_sub"));
  assert.ok(d.warnings.some((w) => w.code === "unknown-record-type"));
});

test("hostile: requested is not ran. file.changed only from a successful result of a seen write request", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-hostile.jsonl"));
  const fc = ofKind(d, "file.changed").map((x) => x.draft.payload["path"]);
  // traversal path is kept as inert metadata; the NUL path is skipped; Bash never infers a change
  assert.deepEqual(fc, ["../../etc/passwd"]);
  const w1 = ofKind(d, "file.changed")[0]?.draft.payload;
  assert.equal(w1?.["changeKind"], "update");
  assert.equal(w1?.["diff"], null, "non-array structuredPatch is not hashed as a diff");
});

test("hostile: out-of-order result precedes its request; missing result leaves the request unanswered", () => {
  const text = readFixture("claude-code", "stream-json-hostile.jsonl");
  const d = drive(A, text);
  const asm = assemble(A, text, d);
  // result-of refs that cannot resolve at that point: unknown id, then the early toolu_late
  const unresolved = asm.unresolvedRefs.filter((r) => r.rel === "result-of");
  assert.ok(unresolved.length >= 2);
  // the early result carries no tool name (request not seen yet) and no file.changed
  const early = d.drafts.find(
    (x) =>
      x.draft.kind === "tool.completed" && x.draft.correlation?.refs?.[0]?.key === "toolu_late",
  );
  assert.equal(early?.draft.payload["toolName"], null);
  // toolu_nores is requested (anchored) and never referenced by a result-of
  const refKeys = new Set(
    d.drafts.flatMap((x) => (x.draft.correlation?.refs ?? []).map((r) => r.key)),
  );
  assert.equal(refKeys.has("toolu_nores"), false);
  assert.ok(d.drafts.some((x) => x.draft.correlation?.anchor === "toolu_nores"));
});

test("hostile: __proto__/constructor keys do not pollute and do not break mapping", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-hostile.jsonl"));
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  const hello = ofKind(d, "turn.started").length;
  assert.ok(hello >= 1);
  assert.ok(d.warnings.some((w) => w.code === "unmapped-field"));
});

test("hostile: error result with weird fields maps defensively", () => {
  const d = drive(A, readFixture("claude-code", "stream-json-hostile.jsonl"));
  const ended = ofKind(d, "turn.ended").at(-1);
  assert.equal(ended?.draft.status, "interrupted", "terminal_reason aborted_* wins");
  assert.equal(
    ended?.draft.attributes["claude-code.num-turns"],
    undefined,
    "1.5 is not an integer",
  );
  assert.equal(ended?.draft.attributes["claude-code.duration-ms"], undefined, "string is rejected");
  // modelUsage: the non-object entry is skipped, the valid one is mapped
  const sess = ofKind(d, "model.usage").filter((x) => x.draft.payload["scope"] === "session");
  assert.equal(sess.length, 1);
  assert.equal(sess[0]?.draft.payload["model"], "ok-model");
  assert.equal(
    "costUsdEstimate" in (sess[0]?.draft.payload ?? {}),
    false,
    "negative cost is dropped",
  );
  // one valid denial among a non-object entry
  assert.equal(ofKind(d, "permission.decided").length, 1);
});

test("hostile: a lone surrogate is repaired, never thrown", () => {
  const text = readFixture("claude-code", "stream-json-hostile.jsonl");
  const d = drive(A, text);
  const m = ofKind(d, "message.observed").find((x) => {
    const c = x.draft.payload["content"] as { byteLength: number } | null;
    return c !== null && x.draft.completeness.content?.state === "partial";
  });
  assert.ok(m, "content with ill-formed text is marked partial/malformed-value");
});

test("warnings carry integers only (no source text)", () => {
  const text = readFixture("claude-code", "stream-json-hostile.jsonl");
  const d = drive(A, text);
  for (const w of d.warnings) {
    for (const v of Object.values(w.detail)) assert.equal(typeof v, "number");
  }
});

test("push never throws on arbitrary parsed values", () => {
  const values = [
    "null",
    "1",
    '"s"',
    "true",
    "[]",
    "{}",
    '{"type":1}',
    '{"type":"assistant"}',
    '{"type":"user","message":null}',
    '{"type":"result"}',
    '{"type":"system"}',
  ];
  const d = drive(A, `${values.join("\n")}\n`);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, `${values.join("\n")}\n`, d);
});

test("end() twice and empty input are safe", () => {
  const parser = A.createParser({
    providerVersionSeen: null,
    bounds: DEFAULT_BOUNDS,
    contentPolicy: { retention: "hash-only", maxInlineBytes: 1 },
  });
  assert.deepEqual(parser.end().drafts, []);
  assert.deepEqual(parser.end().drafts, []);
  assert.equal(frame("").length, 0);
});
