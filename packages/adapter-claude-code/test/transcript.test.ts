import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CapabilityValue } from "@swain/core";
import { registrations } from "../src/index.js";
import { transcriptAdapter } from "../src/transcript.js";
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

const A = transcriptAdapter;
const RANK: Record<CapabilityValue, number> = {
  unsupported: 0,
  unknown: 1,
  partial: 2,
  available: 3,
};

function ofKind(d: Driven, kind: string) {
  return d.drafts.filter((x) => x.draft.kind === kind);
}

test("manifest: experimental, internal-unstable, nothing claimed above the matrix", () => {
  assert.equal(A.manifest.id, "claude-code.transcript-jsonl");
  assert.equal(A.manifest.experimental, true);
  assert.equal(A.manifest.sourceStability, "internal-unstable");
  assert.deepEqual(A.manifest.testedProviderVersions, []);
  assert.ok(registrations.some((r) => r.adapter === A));
  const matrix = JSON.parse(
    readFileSync(repoPath("docs/architecture/capability-matrix.json"), "utf8"),
  );
  const cells = matrix.providers["claude-code"].cells;
  for (const [row, value] of Object.entries(A.manifest.capabilities)) {
    const cell = cells[row];
    const ceiling: CapabilityValue = cell.surfaces.includes(A.manifest.id) ? cell.value : "unknown";
    assert.ok(RANK[value] <= RANK[ceiling], `${row}: ${value} exceeds ${ceiling}`);
  }
});

test("golden: COMMUNITY shape maps; unknown subtype and unlisted fields are preserved as unknown/warnings", () => {
  const text = readFixture("claude-code", "transcript-golden.jsonl");
  const d = drive(A, text);
  assert.equal(d.providerVersionSeen, "0.0.0-example");
  assert.equal(d.nativeSessionId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(unaccounted(d), []);
  const asm = assemble(A, text, d);
  assert.deepEqual(asm.unresolvedRefs, []);
  // summary + file-history-snapshot are metadata dispositions
  assert.deepEqual(
    d.dispositions.map((x) => [x.sourceSequence, x.kind]),
    [
      [0, "metadata"],
      [6, "metadata"],
    ],
  );
  // the system line with a made-up subtype is source.unknown (via adapter, accounted once)
  const unk = ofKind(d, "source.unknown");
  assert.equal(unk.length, 1);
  assert.equal(unk[0]?.draft.payload["nativeType"], "system");
  assert.ok(d.warnings.some((w) => w.code === "unknown-record-type"));
  // brand new field on a message line: unmapped-field warning, record still mapped
  assert.ok(d.warnings.some((w) => w.code === "unmapped-field" && w.sourceSequence === 8));
  // tool result of Edit -> completed + derived file.changed (update)
  const fc = ofKind(d, "file.changed");
  assert.equal(fc.length, 1);
  assert.equal(fc[0]?.draft.payload["path"], "/home/user/project/README.md");
  assert.equal(fc[0]?.draft.payload["changeKind"], "update");
  // isMeta user line is not a human turn; isSidechain actor is a subagent with unknown actor facet
  assert.equal(ofKind(d, "turn.started").length, 1);
  const side = ofKind(d, "message.observed").find((x) => x.draft.actor.role === "subagent");
  assert.ok(side);
  assert.deepEqual(side.draft.completeness.actor, { state: "unknown" });
  // no session lifecycle is invented from a transcript
  assert.equal(ofKind(d, "session.started").length, 0);
  assert.equal(ofKind(d, "session.ended").length, 0);
  // usage once per message.id with last-line evidence
  assert.equal(ofKind(d, "model.usage").length, 3);
  checkGolden("claude-code", "transcript-golden.adapter.json", goldenText(A, d));
});

test("timestamps are captured from the entries", () => {
  const d = drive(A, readFixture("claude-code", "transcript-golden.jsonl"));
  const turn = ofKind(d, "turn.started")[0];
  assert.equal(turn?.draft.time.value, "2026-01-01T00:00:01.000Z");
  assert.deepEqual(turn?.draft.completeness.timestamp, { state: "captured" });
});

test("hostile: tolerant, accounted, validated, hash-only", () => {
  const text = readFixture("claude-code", "transcript-hostile.jsonl");
  const d = drive(A, text);
  assert.deepEqual(unaccounted(d), []);
  assemble(A, text, d);
  const json = JSON.stringify(d.drafts);
  assert.equal(json.includes("<script>"), false, "content never leaks under hash-only");
  // message: 5 and `progress` type and `{}` and `[]` are all unknown, none thrown
  assert.ok(ofKind(d, "source.unknown").length >= 5);
  // two empty assistant lines of one message.id are accounted by metadata dispositions
  assert.deepEqual(
    d.dispositions.map((x) => x.sourceSequence),
    [5, 6],
  );
  // tool_result with array content and a non-object toolUseResult still completes, no file.changed
  assert.equal(ofKind(d, "tool.completed").length, 1);
  assert.equal(ofKind(d, "file.changed").length, 0);
  checkGolden("claude-code", "transcript-hostile.adapter.json", goldenText(A, d));
});

test("attribute keys are inside the transcript allowlist", () => {
  for (const f of ["transcript-golden.jsonl", "transcript-hostile.jsonl"]) {
    const d = drive(A, readFixture("claude-code", f));
    for (const x of d.drafts) {
      for (const key of Object.keys(x.draft.attributes)) {
        assert.ok(A.manifest.attributeKeys.includes(key), key);
      }
    }
  }
});

test("a stream-json `result` line is unknown to the transcript adapter", () => {
  const text = '{"type":"result","subtype":"success","session_id":"s"}\n';
  const d = drive(A, text);
  assert.equal(ofKind(d, "source.unknown").length, 1);
  assert.deepEqual(unaccounted(d), []);
});
