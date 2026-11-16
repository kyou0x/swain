import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CapabilityValue } from "@swain/core";
import { execAdapter } from "../src/exec.js";
import { registrations } from "../src/index.js";
import {
  assemble,
  checkGolden,
  type Driven,
  drive,
  goldenText,
  readFixture,
  repoPath,
  unaccounted,
} from "./harness.js";

const A = execAdapter;
const RANK: Record<CapabilityValue, number> = {
  unsupported: 0,
  unknown: 1,
  partial: 2,
  available: 3,
};

function ofKind(d: Driven, kind: string) {
  return d.drafts.filter((x) => x.draft.kind === kind);
}

test("manifest: documented, stable, capabilities within the matrix", () => {
  assert.equal(A.manifest.id, "codex-cli.exec-jsonl");
  assert.equal(A.manifest.sourceStability, "documented-interface");
  assert.equal(A.manifest.experimental, false);
  assert.deepEqual(A.manifest.testedProviderVersions, []);
  assert.deepEqual(A.manifest.attributeKeys, []);
  assert.ok(registrations.some((r) => r.adapter === A));
  const matrix = JSON.parse(
    readFileSync(repoPath("docs/architecture/capability-matrix.json"), "utf8"),
  );
  const cells = matrix.providers["codex-cli"].cells;
  for (const [row, value] of Object.entries(A.manifest.capabilities)) {
    const cell = cells[row];
    const ceiling: CapabilityValue = cell.surfaces.includes(A.manifest.id) ? cell.value : "unknown";
    assert.ok(RANK[value] <= RANK[ceiling], `${row}: ${value} exceeds ${ceiling}`);
  }
});

test("golden: detect, accounting, validator, adapter-level golden", () => {
  const text = readFixture("codex-cli", "exec-golden.jsonl");
  const d = drive(A, text);
  assert.equal(d.nativeSessionId, "00000000-0000-4000-8000-000000000001");
  assert.equal(d.providerVersionSeen, null, "exec streams carry no CLI version");
  assert.deepEqual(unaccounted(d), []);
  assert.deepEqual(assemble(A, text, d).unresolvedRefs, []);
  checkGolden("codex-cli", "exec-golden.adapter.json", goldenText(A, d));
});

test("golden: native to canonical mapping", () => {
  const d = drive(A, readFixture("codex-cli", "exec-golden.jsonl"));
  assert.equal(ofKind(d, "session.started").length, 1);
  assert.deepEqual(
    ofKind(d, "turn.ended").map((x) => x.draft.status),
    ["success", "failure"],
  );
  // timestamps are absent by design
  const s = ofKind(d, "session.started")[0];
  assert.deepEqual(s?.draft.completeness.timestamp, {
    state: "unavailable",
    reason: "provider-does-not-expose",
  });
  assert.equal(s?.draft.time.status, "missing");
  // command_execution: ok -> completed/success, exit 1 -> failed, declined -> failed/denied
  const done = ofKind(d, "tool.completed").map((x) => [
    x.draft.payload["toolName"],
    x.draft.status,
    x.draft.payload["exitCode"],
  ]);
  assert.deepEqual(done, [
    ["command_execution", "success", 0],
    ["search", "success", undefined],
    ["spawn_agent", "success", undefined],
    ["web_search", "unknown", undefined],
  ]);
  const failed = ofKind(d, "tool.failed").map((x) => [
    x.draft.payload["toolName"],
    x.draft.status,
    x.draft.payload["errorClass"],
  ]);
  assert.deepEqual(failed, [
    ["command_execution", "failure", "error"],
    ["command_execution", "denied", "declined"],
    ["fetch", "failure", "error"],
  ]);
  // started + completed share one request: item_0, item_2, item_5 anchored once
  const anchors = ofKind(d, "tool.requested").map((x) => x.draft.correlation?.anchor);
  assert.deepEqual(anchors, ["item_0", "item_2", "item_3", "item_5", "item_6", "item_7", "ws_1"]);
  // mcp: namespace and server
  const mcp = ofKind(d, "tool.requested").find((x) => x.draft.payload["toolNamespace"] === "mcp");
  assert.equal(mcp?.draft.payload["mcpServer"], "docs");
  // file_change: provider-reported, one event per change, never via a tool call
  const fc = ofKind(d, "file.changed");
  assert.deepEqual(
    fc.map((x) => [
      x.draft.payload["path"],
      x.draft.payload["changeKind"],
      x.draft.payload["basis"],
      x.draft.payload["viaToolCallId"],
    ]),
    [
      ["/home/user/project/a.txt", "update", "provider-reported", null],
      ["/home/user/project/new.txt", "add", "provider-reported", null],
    ],
  );
  // reasoning / agent_message / errors
  assert.deepEqual(
    ofKind(d, "message.observed").map((x) => [x.draft.payload["role"], x.draft.payload["channel"]]),
    [
      ["assistant", "reasoning"],
      ["system", "notification"],
      ["assistant", "text"],
      ["system", "notification"],
      ["system", "notification"],
    ],
  );
  // item.updated and todo_list are control/metadata dispositions
  assert.ok(d.dispositions.some((x) => x.kind === "control"));
  assert.ok(d.dispositions.some((x) => x.kind === "metadata"));
});

test("turn.completed.usage is cumulative: scope session, no total_tokens invented", () => {
  const d = drive(A, readFixture("codex-cli", "exec-golden.jsonl"));
  const u = ofKind(d, "model.usage");
  assert.equal(u.length, 1);
  assert.deepEqual(u[0]?.draft.payload, {
    scope: "session",
    model: null,
    inputTokens: 1200,
    cachedInputTokens: 800,
    cacheWriteInputTokens: 0,
    outputTokens: 150,
    reasoningOutputTokens: 40,
  });
  assert.deepEqual(u[0]?.draft.completeness.model, {
    state: "absent",
    reason: "missing-in-record",
  });
});

test("resume stream: same adapter, separate source", () => {
  const text = readFixture("codex-cli", "exec-resume-golden.jsonl");
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
  checkGolden("codex-cli", "exec-resume-golden.adapter.json", goldenText(A, d));
});

test("hostile: accounting, validator and golden hold", () => {
  const text = readFixture("codex-cli", "exec-hostile.jsonl");
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
  checkGolden("codex-cli", "exec-hostile.adapter.json", goldenText(A, d));
});

test("hostile: markup/ANSI inert, hash-only, missing result and orphan completion", () => {
  const text = readFixture("codex-cli", "exec-hostile.jsonl");
  const d = drive(A, text);
  const json = JSON.stringify(d.drafts);
  assert.equal(json.includes("onerror"), false);
  assert.equal(json.includes('"inline"'), false);
  // item_1 started and never completed: anchored, never referenced
  const refs = new Set(
    d.drafts.flatMap((x) => (x.draft.correlation?.refs ?? []).map((r) => r.key)),
  );
  assert.ok(d.drafts.some((x) => x.draft.correlation?.anchor === "item_1"));
  assert.equal(refs.has("item_1"), false);
  // item_0 completed with no item.started: request synthesized from the same record, then result
  const first = d.drafts.filter((x) => x.order === 2).map((x) => x.draft.kind);
  assert.deepEqual(first, ["tool.requested", "tool.completed"]);
  // wrong-typed command/exit_code/status: result is unknown, never success
  const odd = d.drafts.find((x) => x.draft.correlation?.refs?.[0]?.key === "item_2");
  assert.equal(odd?.draft.kind, "tool.completed");
  assert.equal(odd?.draft.status, "unknown");
  assert.equal("exitCode" in (odd?.draft.payload ?? {}), false);
  assert.equal(odd?.draft.completeness.outputs?.state, "absent");
});

test("hostile: wrong types, unknown records and paths", () => {
  const d = drive(A, readFixture("codex-cli", "exec-hostile.jsonl"));
  const unk = ofKind(d, "source.unknown").map((x) => x.draft.payload["nativeType"]);
  assert.ok(unk.includes("item.future_item"));
  assert.ok(unk.includes("thread.future"));
  assert.ok(unk.length >= 9, `got ${unk.length}`);
  // the NUL path and the non-object / path-less changes are skipped; traversal text is inert metadata
  assert.deepEqual(
    ofKind(d, "file.changed").map((x) => x.draft.payload["path"]),
    ["../../etc/passwd"],
  );
  // all-zero usage is not asserted as a captured fact; negative/string counters never emitted
  const usage = ofKind(d, "model.usage");
  assert.deepEqual(usage[0]?.draft.completeness.tokens, {
    state: "partial",
    reason: "missing-in-record",
  });
  for (const u of usage) {
    for (const v of Object.values(u.draft.payload)) {
      if (typeof v === "number") assert.ok(v >= 0);
    }
  }
  // hostile server/tool names are bounded data
  const mcp = ofKind(d, "tool.requested").find((x) => x.draft.payload["toolNamespace"] === "mcp");
  assert.equal(mcp?.draft.payload["mcpServer"], 'm"><svg onload=1>'.replace("m", "s"));
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  for (const w of d.warnings)
    for (const v of Object.values(w.detail)) assert.equal(typeof v, "number");
});

test("hash-only default; inline only on request and still validates", () => {
  const text = readFixture("codex-cli", "exec-golden.jsonl");
  assert.equal(JSON.stringify(drive(A, text).drafts).includes("a.txt\\n"), false);
  const inline = drive(A, text, "inline");
  assert.ok(JSON.stringify(inline.drafts).includes("a.txt"));
  assemble(A, text, inline);
});

test("push never throws on arbitrary parsed values", () => {
  const values = [
    "null",
    "1",
    '"s"',
    "[]",
    "{}",
    '{"type":"item.completed"}',
    '{"type":"item.started","item":1}',
    '{"type":"turn.completed"}',
    '{"type":"thread.started"}',
    '{"type":"turn.failed"}',
  ];
  const text = `${values.join("\n")}\n`;
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
});
