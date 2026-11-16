import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CapabilityValue } from "@swain/core";
import { registrations } from "../src/index.js";
import { rolloutAdapter } from "../src/rollout.js";
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

const A = rolloutAdapter;

function ofKind(d: Driven, kind: string) {
  return d.drafts.filter((x) => x.draft.kind === kind);
}

test("manifest: undocumented, experimental, every capability unknown (surface not in the matrix)", () => {
  assert.equal(A.manifest.id, "codex-cli.rollout-jsonl");
  assert.equal(A.manifest.sourceStability, "undocumented");
  assert.equal(A.manifest.experimental, true);
  assert.deepEqual(A.manifest.testedProviderVersions, []);
  assert.deepEqual(A.manifest.framing, { kind: "jsonl" });
  assert.ok(registrations.some((r) => r.adapter === A));
  const matrix = JSON.parse(
    readFileSync(repoPath("docs/architecture/capability-matrix.json"), "utf8"),
  );
  // the surface row exists (p0Use not-used) but no capability cell lists it, so M12 caps it at unknown
  for (const cell of Object.values(matrix.providers["codex-cli"].cells) as {
    surfaces: string[];
  }[]) {
    assert.equal(cell.surfaces.includes(A.manifest.id), false);
  }
  for (const v of Object.values(A.manifest.capabilities))
    assert.equal(v, "unknown" satisfies CapabilityValue);
});

test("paginated golden: detect, accounting, validator, adapter-level golden", () => {
  const text = readFixture("codex-cli", "rollout-paginated-golden.jsonl");
  const d = drive(A, text);
  assert.equal(d.providerVersionSeen, "0.169.0");
  assert.equal(d.nativeSessionId, "00000000-0000-4000-8000-000000000001");
  assert.deepEqual(unaccounted(d), []);
  const asm = assemble(A, text, d);
  assert.deepEqual(asm.unresolvedRefs, []);
  checkGolden("codex-cli", "rollout-paginated-golden.adapter.json", goldenText(A, d));
});

test("paginated: native to canonical mapping", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-paginated-golden.jsonl"));
  const s = ofKind(d, "session.started")[0];
  assert.equal(s?.draft.attributes["codex-cli.history-mode"], "paginated");
  assert.equal(s?.draft.attributes["codex-cli.cwd"], "/home/user/project");
  assert.equal(s?.draft.providerVersion, "0.169.0");
  assert.equal(s?.draft.attributes["codex-cli.source"], "cli");
  // ordinal is carried as metadata on every line that has one
  assert.equal(ofKind(d, "turn.started")[0]?.draft.attributes["codex-cli.ordinal"], 1);
  // task_started/complete/aborted
  assert.deepEqual(
    ofKind(d, "turn.ended").map((x) => x.draft.status),
    ["success", "interrupted"],
  );
  assert.equal(
    ofKind(d, "turn.ended")[1]?.draft.attributes["codex-cli.abort-reason"],
    "interrupted",
  );
  assert.equal(
    ofKind(d, "turn.started")[0]?.draft.nativeTurnKey,
    "00000000-0000-4000-8000-0000000000a1",
  );
  // tools: exec_command x2, local_shell, apply_patch
  const reqs = ofKind(d, "tool.requested").map((x) => x.draft.payload["toolName"]);
  assert.deepEqual(reqs, ["exec_command", "exec_command", "local_shell", "apply_patch"]);
  // function_call arguments is a JSON string: hashed as jcs-json of the parsed object
  const input = ofKind(d, "tool.requested")[0]?.draft.payload["input"] as { encoding: string };
  assert.equal(input.encoding, "jcs-json");
  // custom_tool_call input is raw text
  const patchInput = ofKind(d, "tool.requested")[3]?.draft.payload["input"] as { encoding: string };
  assert.equal(patchInput.encoding, "utf8");
  // exit code from the output header: 0 -> completed/success, 1 -> failed/failure
  const failed = ofKind(d, "tool.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.draft.payload["exitCode"], 1);
  assert.equal(failed[0]?.draft.attributes["codex-cli.exit-code-source"], "output-header");
  // function_call_output(0) + CommandExecution(0) + apply_patch output (no code -> unknown)
  const completed = ofKind(d, "tool.completed").map((x) => x.draft.status);
  assert.deepEqual(completed, ["success", "success", "unknown"]);
  // the structured CommandExecution result links to the known call id
  const structured = ofKind(d, "tool.completed")[1]?.draft;
  assert.deepEqual(structured?.correlation?.refs, [{ rel: "result-of", key: "call_fake_1" }]);
  // FileChange item: provider-reported file.changed, via the apply_patch call
  const fc = ofKind(d, "file.changed");
  assert.equal(fc.length, 1);
  assert.deepEqual(
    [
      fc[0]?.draft.payload["path"],
      fc[0]?.draft.payload["changeKind"],
      fc[0]?.draft.payload["basis"],
      fc[0]?.draft.payload["viaToolCallId"],
    ],
    ["/home/user/project/a.txt", "update", "provider-reported", "call_fake_3"],
  );
  assert.equal(fc[0]?.draft.status, "success");
});

test("paginated: mirrored user/assistant/reasoning text is emitted once, mirrors are superseded", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-paginated-golden.jsonl"));
  const msgs = ofKind(d, "message.observed").map((x) => [
    x.draft.payload["role"],
    x.draft.payload["channel"],
  ]);
  assert.deepEqual(msgs, [
    ["system", "text"], // developer instructions
    ["user", "text"],
    ["assistant", "reasoning"],
    ["assistant", "text"],
    ["system", "notification"], // compacted
  ]);
  const sup = d.dispositions.filter((x) => x.kind === "superseded");
  assert.equal(sup.length, 3);
  for (const x of sup) {
    assert.notEqual(x.into, null);
    assert.ok((x.into ?? 99) < x.sourceSequence);
  }
});

test("token_count: cumulative totals are reported as given, never summed", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-paginated-golden.jsonl"));
  const u = ofKind(d, "model.usage");
  assert.equal(u.length, 2);
  assert.deepEqual(
    u.map((x) => [
      x.draft.payload["scope"],
      x.draft.payload["inputTokens"],
      x.draft.payload["totalTokens"],
    ]),
    [
      ["session", 1200, 1350],
      ["session", 2500, 2800],
    ],
  );
  assert.equal(u[0]?.draft.payload["model"], "fake-model");
  assert.equal(u[0]?.draft.payload["cachedInputTokens"], 800);
  assert.equal(u[0]?.draft.payload["cacheWriteInputTokens"], 0);
  assert.equal(u[0]?.draft.payload["reasoningOutputTokens"], 40);
  // token_count with info:null is metadata, not an event
  assert.ok(d.dispositions.some((x) => x.kind === "metadata"));
});

test("paginated: control/metadata records and unknown types are accounted", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-paginated-golden.jsonl"));
  const unk = ofKind(d, "source.unknown").map((x) => x.draft.payload["nativeType"]);
  assert.deepEqual(unk, ["future_type_xyz", "event_msg.future_event_xyz"]);
  assert.ok(
    d.dispositions.some((x) => x.kind === "control"),
    "thread_rolled_back",
  );
  assert.ok(d.warnings.some((w) => w.code === "unknown-record-type"));
  // timestamps come from the line
  assert.equal(ofKind(d, "session.started")[0]?.draft.time.value, "2026-11-15T09:00:00.000Z");
});

test("legacy golden: detect, accounting, validator, golden", () => {
  const text = readFixture("codex-cli", "rollout-legacy-golden.jsonl");
  const d = drive(A, text);
  assert.equal(d.providerVersionSeen, "0.167.0");
  assert.deepEqual(unaccounted(d), []);
  assert.deepEqual(assemble(A, text, d).unresolvedRefs, []);
  checkGolden("codex-cli", "rollout-legacy-golden.adapter.json", goldenText(A, d));
});

test("legacy: history_mode defaults to legacy, patch_apply_end is provider-reported, second session_meta is metadata", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-legacy-golden.jsonl"));
  const s = ofKind(d, "session.started");
  assert.equal(s.length, 1);
  assert.equal(s[0]?.draft.attributes["codex-cli.history-mode"], "legacy");
  assert.equal("codex-cli.ordinal" in (s[0]?.draft.attributes ?? {}), false);
  const fc = ofKind(d, "file.changed");
  assert.deepEqual(
    fc.map((x) => [
      x.draft.payload["path"],
      x.draft.payload["changeKind"],
      x.draft.payload["viaToolCallId"],
    ]),
    [["/home/user/project/b.txt", "add", "call_l2"]],
  );
  // "Exit code: 0" header (classic shell convention)
  assert.equal(ofKind(d, "tool.completed")[0]?.draft.status, "success");
  assert.equal(ofKind(d, "tool.completed")[0]?.draft.payload["exitCode"], 0);
  // mirrors: user_message after response_item user, agent_message after assistant
  assert.equal(d.dispositions.filter((x) => x.kind === "superseded").length, 2);
  // agent_reasoning event is the only reasoning source here
  assert.equal(
    ofKind(d, "message.observed").filter((x) => x.draft.payload["channel"] === "reasoning").length,
    1,
  );
  // task_complete with an error object is a failed turn
  assert.equal(ofKind(d, "turn.ended")[0]?.draft.status, "failure");
  // the later session_meta
  assert.ok(d.dispositions.some((x) => x.kind === "metadata" && x.sourceSequence === 13));
  assert.equal(ofKind(d, "model.usage")[0]?.draft.payload["model"], "fake-model");
});

test("hostile: accounting, validator and golden hold", () => {
  const text = readFixture("codex-cli", "rollout-hostile.jsonl");
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
  checkGolden("codex-cli", "rollout-hostile.adapter.json", goldenText(A, d));
});

test("hostile: markup, ANSI and malformed arguments stay inert; nothing is stored under hash-only", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-hostile.jsonl"));
  const names = ofKind(d, "tool.requested").map((x) => x.draft.payload["toolName"]);
  assert.ok(names.includes("<script>alert(1)</script>"));
  const bad = ofKind(d, "tool.requested")[0];
  assert.equal(
    bad?.draft.completeness.inputs?.state,
    "partial",
    "malformed arguments JSON is partial",
  );
  const json = JSON.stringify(d.drafts);
  assert.equal(json.includes("onerror"), false);
  assert.equal(json.includes('"inline"'), false);
  assert.equal(
    ofKind(d, "session.started")[0]?.draft.attributes["codex-cli.cwd"],
    "/home/user/<script>alert(1)</script>",
  );
  // an unlisted source value is not stored as an attribute
  assert.equal(
    "codex-cli.source" in (ofKind(d, "session.started")[0]?.draft.attributes ?? {}),
    false,
  );
});

test("hostile: wrong types become unknown/partial; no tool call is invented", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-hostile.jsonl"));
  const unknowns = ofKind(d, "source.unknown");
  assert.ok(unknowns.length >= 9, `got ${unknowns.length}`);
  const reqs = ofKind(d, "tool.requested");
  // function_call with non-string name/call_id: sentinel name, no anchor
  const noId = reqs.find(
    (x) => x.draft.payload["toolCallId"] === null && x.draft.payload["toolName"] === "unknown",
  );
  assert.ok(noId);
  assert.equal(noId.draft.correlation?.anchor, undefined);
  // custom_tool_call with non-string input: no input hash
  assert.equal(
    reqs.find((x) => x.draft.correlation?.anchor === "call_h3")?.draft.payload["input"],
    null,
  );
  // negative / string / fractional counters never reach a payload
  for (const u of ofKind(d, "model.usage")) {
    for (const v of Object.values(u.draft.payload)) {
      if (typeof v === "number") assert.ok(v >= 0 && !Object.is(v, -0));
    }
  }
  // invalid and non-string timestamps are marked, not guessed
  const invalid = d.drafts.filter((x) => x.draft.time.status === "invalid");
  assert.ok(invalid.length >= 2);
  for (const x of invalid) assert.equal(x.draft.time.value, null);
});

test("hostile: out-of-order result and unanswered request", () => {
  const text = readFixture("codex-cli", "rollout-hostile.jsonl");
  const d = drive(A, text);
  const asm = assemble(A, text, d);
  assert.ok(asm.unresolvedRefs.some((r) => r.rel === "result-of"));
  const early = d.drafts.find(
    (x) => x.draft.kind === "tool.completed" && x.draft.correlation?.refs?.[0]?.key === "call_late",
  );
  assert.ok(early, "early result is still a result event (the pipeline reports orphan-result)");
  assert.equal(early.draft.payload["toolName"], null);
  assert.equal(early.draft.payload["exitCode"], 0, "array output header is parsed");
  // call_nores is anchored and never referenced
  const keys = new Set(
    d.drafts.flatMap((x) => (x.draft.correlation?.refs ?? []).map((r) => r.key)),
  );
  assert.equal(keys.has("call_nores"), false);
  assert.ok(d.drafts.some((x) => x.draft.correlation?.anchor === "call_nores"));
  // a nonzero exit code in a header is a failure; an 11-digit code is not parsed
  const failed = ofKind(d, "tool.failed").find((x) => x.draft.payload["exitCode"] === 7);
  assert.ok(failed);
  assert.equal(
    d.drafts.filter((x) => x.draft.kind === "tool.completed" && x.draft.status === "unknown")
      .length >= 1,
    true,
  );
});

test("hostile: file.changed paths are inert metadata; NUL paths skipped; request alone never changes files", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-hostile.jsonl"));
  const paths = ofKind(d, "file.changed").map((x) => x.draft.payload["path"]);
  assert.deepEqual(paths, ["../../etc/passwd", "/home/user/ok.txt", "a/b~c"]);
  // pointers built from source keys are RFC 6901-escaped
  const p = ofKind(d, "file.changed").map((x) => x.draft.pointer);
  assert.ok(p.includes("/payload/item/changes/a~1b~0c"));
  // viaToolCallId only when the id is a known call: call_h1 is a known function_call
  assert.equal(ofKind(d, "file.changed")[0]?.draft.payload["viaToolCallId"], "call_h1");
  // the apply_patch custom_tool_call with a request but no change record produced no file.changed
  assert.equal(paths.length, 3);
});

test("hostile: prototype-style keys, lone surrogates and warnings carry no source text", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-hostile.jsonl"));
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  for (const w of d.warnings)
    for (const v of Object.values(w.detail)) assert.equal(typeof v, "number");
  assert.ok(
    ofKind(d, "message.observed").some((x) => x.draft.completeness.content?.state === "partial"),
    "ill-formed text is partial/malformed-value",
  );
  for (const x of d.drafts) {
    for (const key of Object.keys(x.draft.attributes))
      assert.ok(A.manifest.attributeKeys.includes(key), key);
  }
});

test("inline retention only when the policy says so, and then validates", () => {
  const text = readFixture("codex-cli", "rollout-paginated-golden.jsonl");
  assert.equal(JSON.stringify(drive(A, text).drafts).includes("Run ls and fix"), false);
  const inline = drive(A, text, "inline");
  assert.ok(JSON.stringify(inline.drafts).includes("Run ls and fix the typo in a.txt"));
  assemble(A, text, inline);
});

test("detect: unknown history_mode is unsupported, not guessed", () => {
  const d = drive(A, readFixture("codex-cli", "rollout-unsupported-history-mode.jsonl"));
  const det = A.detect(d.records);
  assert.equal(det.verdict, "unsupported");
  assert.deepEqual(det.reasons, ["unknown-history-mode"]);
});

test("push never throws on arbitrary parsed values", () => {
  const values = [
    "null",
    "1",
    '"s"',
    "[]",
    "{}",
    '{"type":"session_meta"}',
    '{"type":"event_msg","payload":null}',
    '{"type":"response_item","payload":{}}',
    '{"type":"event_msg","payload":{"type":"item_completed"}}',
    '{"type":"compacted","payload":{"message":1}}',
    '{"type":"token_usage_record","payload":{}}',
  ];
  const text = `${values.join("\n")}\n`;
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
});
