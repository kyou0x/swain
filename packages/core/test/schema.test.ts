import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BOUNDS } from "../src/adapter/contract.js";
import {
  ACTOR_ROLES,
  COMPLETENESS_REASONS,
  COMPLETENESS_STATES,
  EVENT_KINDS,
  EVENT_STATUSES,
  FACETS,
  GAP_REASONS,
  KIND_ALLOWED_STATUS,
  LINK_RELS,
  PROVIDERS,
  REQUIRED_FACETS_BY_KIND,
  SCHEMA_VERSION,
  STRING_BOUNDS,
  WARNING_CODES,
} from "../src/schema/constants.js";

test("schema version", () => {
  assert.equal(SCHEMA_VERSION, "0.1.0");
});

test("enums equal ADR-0002 (order matters for EVENT_KINDS)", () => {
  assert.deepEqual(
    [...EVENT_KINDS],
    [
      "session.started",
      "session.ended",
      "turn.started",
      "turn.ended",
      "message.observed",
      "tool.requested",
      "tool.completed",
      "tool.failed",
      "agent.started",
      "agent.ended",
      "file.changed",
      "permission.requested",
      "permission.decided",
      "model.usage",
      "capture.gap",
      "source.unknown",
    ],
  );
  assert.equal(EVENT_KINDS.length, 16);
  assert.deepEqual([...PROVIDERS], ["claude-code", "codex-cli", "gemini-cli", "opencode"]);
  assert.deepEqual(
    [...EVENT_STATUSES],
    ["none", "success", "failure", "denied", "interrupted", "unknown"],
  );
  assert.deepEqual([...ACTOR_ROLES], ["user", "agent", "subagent", "runtime", "unknown"]);
  assert.deepEqual(
    [...FACETS],
    [
      "content",
      "inputs",
      "outputs",
      "timestamp",
      "actor",
      "model",
      "tokens",
      "causality",
      "internalReasoning",
    ],
  );
  assert.deepEqual(
    [...COMPLETENESS_STATES],
    ["captured", "partial", "absent", "unavailable", "unknown"],
  );
  assert.deepEqual(
    [...COMPLETENESS_REASONS],
    [
      "provider-does-not-expose",
      "missing-in-record",
      "exceeded-bounds",
      "malformed-value",
      "correlation-missing",
      "adapter-unsupported",
    ],
  );
  assert.deepEqual(
    [...LINK_RELS],
    ["result-of", "decides", "spawned-by", "ends", "gap-for", "duplicate-of"],
  );
  assert.deepEqual(
    [...GAP_REASONS],
    [
      "malformed-record",
      "truncated-final-record",
      "record-too-large",
      "depth-exceeded",
      "invalid-utf8",
      "missing-result",
      "missing-start",
      "bounds-reached",
      "adapter-error",
      "adapter-output-invalid",
    ],
  );
  assert.deepEqual(
    [...WARNING_CODES],
    [
      "untested-provider-version",
      "unknown-record-type",
      "unmapped-field",
      "malformed-record",
      "record-too-large",
      "depth-exceeded",
      "invalid-utf8",
      "truncated-final-record",
      "utf8-bom",
      "timestamp-invalid",
      "timestamp-regression",
      "duplicate-native-record",
      "missing-result",
      "orphan-result",
      "bounds-reached",
      "adapter-output-invalid",
      "adapter-error",
      "empty-source",
      "blank-lines",
      "warnings-aggregated",
      "duplicate-json-key",
      "record-array-missing",
      "folded-records",
      "attribute-not-allowed",
    ],
  );
});

test("KIND_ALLOWED_STATUS equals ADR-0002 section 3", () => {
  const end = ["success", "failure", "interrupted", "unknown"];
  const expected: Record<string, string[]> = {};
  for (const k of EVENT_KINDS) expected[k] = ["none"];
  expected["tool.completed"] = ["success", "unknown"];
  expected["tool.failed"] = ["failure", "denied", "interrupted", "unknown"];
  expected["turn.ended"] = end;
  expected["agent.ended"] = end;
  expected["session.ended"] = end;
  expected["file.changed"] = ["success", "failure", "unknown"];
  assert.deepEqual(JSON.parse(JSON.stringify(KIND_ALLOWED_STATUS)), expected);
});

test("REQUIRED_FACETS_BY_KIND equals ADR-0002 section 3", () => {
  for (const k of EVENT_KINDS) {
    const base = ["timestamp", "actor"];
    let extra: string[] = [];
    if (k.startsWith("tool.")) extra = ["inputs", "outputs"];
    if (k === "message.observed") extra = ["content", "internalReasoning"];
    if (k === "model.usage") extra = ["model", "tokens"];
    assert.deepEqual([...REQUIRED_FACETS_BY_KIND[k]].sort(), [...base, ...extra].sort(), k);
  }
});

test("STRING_BOUNDS equals ADR-0002 section 1a (table-driven)", () => {
  type Row = [string, number, boolean, string | null];
  const rows: Record<string, Row> = {
    schemaVersion: ["schemaVersion", 16, false, "^0\\.1\\.[0-9]{1,6}$"],
    evtId: ["evtId", 36, true, "^evt_[0-9a-f]{32}$"],
    sesId: ["sesId", 36, true, "^ses_[0-9a-f]{32}$"],
    trnId: ["trnId", 36, true, "^trn_[0-9a-f]{32}$"],
    actId: ["actId", 36, true, "^act_[0-9a-f]{32}$"],
    srcId: ["srcId", 36, true, "^src_[0-9a-f]{32}$"],
    tcId: ["tcId", 35, true, "^tc_[0-9a-f]{32}$"],
    sha256: ["sha256", 64, true, "^[0-9a-f]{64}$"],
    providerVersion: ["providerVersion", 64, false, "^[!-~]{1,64}$"],
    sourceKind: ["sourceKind", 64, false, "^[a-z0-9-]+\\.[a-z0-9-]+$"],
    surfaceId: ["surfaceId", 64, false, "^[a-z0-9-]+\\.[a-z0-9-]+$"],
    adapterId: ["adapterId", 64, false, "^[a-z0-9-]+(\\.[a-z0-9-]+)+$"],
    adapterVersion: [
      "adapterVersion",
      32,
      false,
      "^[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,16})?$",
    ],
    rule: ["rule", 64, false, "^[a-z0-9-]+(\\.[a-z0-9-]+)+$"],
    pointer: ["pointer", 512, false, null],
    timeValue: [
      "timeValue",
      24,
      true,
      "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
    ],
    attributeKey: ["attributeKey", 96, false, "^[a-z0-9-]+\\.[A-Za-z0-9_.-]{1,64}$"],
    attributeString: ["attributeString", 256, false, null],
    bounded256: ["bounded256", 256, false, null],
    bounded512: ["bounded512", 512, false, null],
    filePath: ["filePath", 4096, false, null],
    inlineContent: ["inlineContent", 1_048_576, false, null],
    displayName: ["displayName", 255, false, null],
    warningDetailKey: ["warningDetailKey", 32, false, "^[a-zA-Z][a-zA-Z0-9]{0,31}$"],
    warningDetailString: ["warningDetailString", 256, false, null],
    issuePath: ["issuePath", 512, false, null],
  };
  assert.deepEqual(Object.keys(STRING_BOUNDS).sort(), Object.keys(rows).sort());
  for (const [name, [, bytes, exact, pattern]] of Object.entries(rows)) {
    const sb = STRING_BOUNDS[name as keyof typeof STRING_BOUNDS];
    assert.equal(sb.bytes, bytes, name);
    assert.equal(sb.exact, exact, name);
    assert.equal(sb.pattern, pattern, name);
  }
  assert.equal(STRING_BOUNDS.pointer.rule, "rfc6901");
  assert.equal(STRING_BOUNDS.filePath.rule, "no-nul");
  assert.equal(STRING_BOUNDS.displayName.rule, "display-name");
});

test("DEFAULT_BOUNDS equals ADR-0002 section 12 (r2.2)", () => {
  assert.deepEqual(DEFAULT_BOUNDS, {
    maxFileBytes: 268_435_456,
    maxRecordBytes: 16_777_216,
    maxJsonDepth: 64,
    maxRecords: 2_000_000,
    maxDraftsPerRecord: 1024,
    maxOpenCorrelations: 100_000,
    maxInlineContentBytes: 65_536,
    maxWarnings: 1_000,
    detectSampleRecords: 64,
    maxAdapterErrors: 100,
    maxDocumentBytes: 67_108_864,
    maxEvents: 1_000_000,
    maxTotalInlineBytes: 67_108_864,
    maxOutputBytes: 268_435_456,
    maxJsonValues: 8_000_000,
  });
});
