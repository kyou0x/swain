import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalEvent, EnvelopeBase, ToolRequestedPayload } from "../src/schema/types.js";

// Compile-time assertions (test 18). `// @ts-expect-error` fails the build if the line compiles.
// Each asserted statement is kept short so that formatting cannot move the error line.

const common: EnvelopeBase = {
  schemaVersion: "0.1.0",
  eventId: "evt_00000000000000000000000000000000",
  provider: "codex-cli",
  providerVersion: null,
  sourceKind: "codex-cli.exec-jsonl",
  sessionId: "ses_00000000000000000000000000000000",
  turnId: null,
  sourceSequence: 0,
  subIndex: 0,
  time: { value: null, origin: "none", status: "missing" },
  actor: { actorId: "act_00000000000000000000000000000000", role: "agent" },
  links: [],
  provenance: {
    type: "record",
    sourceId: "src_00000000000000000000000000000000",
    line: 1,
    byteOffset: 0,
    byteLength: 1,
    sha256: "0".repeat(64),
    pointer: null,
    adapter: { id: "a.b", version: "0.0.1" },
  },
  completeness: {},
  attributes: {},
};

const payload: ToolRequestedPayload = {
  toolCallId: null,
  toolName: "t",
  toolNamespace: "builtin",
  input: null,
};
const noName = { toolCallId: null, toolNamespace: "builtin", input: null } as const;

const tr: CanonicalEvent = { ...common, kind: "tool.requested", status: "none", payload };

test("well-typed event compiles", () => {
  assert.equal(tr.kind, "tool.requested");
});

test("ill-typed events do not compile", () => {
  // @ts-expect-error tool.requested must have status "none"
  const a: CanonicalEvent = { ...tr, status: "success" };
  // @ts-expect-error payload.toolName is required
  const b: CanonicalEvent = { ...tr, payload: noName };
  // @ts-expect-error unknown kind
  const c: CanonicalEvent = { ...tr, kind: "tool.exploded" };
  assert.ok(a && b && c);
});
