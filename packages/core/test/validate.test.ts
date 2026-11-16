import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ISSUE_CODES, validateEvent, validateEvents } from "../src/validate/index.js";

const fixture = (rel: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../../fixtures/canonical/${rel}`, import.meta.url), "utf8"),
  );

function codes(v: unknown): string[] {
  const r = validateEvent(v);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

test("valid fixtures for all 16 kinds validate", () => {
  const kinds = [
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
  ];
  for (const k of kinds) {
    const r = validateEvent(fixture(`valid/${k}.json`));
    assert.equal(r.ok, true, k);
  }
});

test("returned event key order follows ADR-0002 field order", () => {
  const src = fixture("valid/tool.requested.json") as Record<string, unknown>;
  const shuffled: Record<string, unknown> = {};
  for (const k of Object.keys(src).reverse()) shuffled[k] = src[k];
  const r = validateEvent(shuffled);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(Object.keys(r.event), [
      "schemaVersion",
      "eventId",
      "kind",
      "provider",
      "providerVersion",
      "sourceKind",
      "sessionId",
      "turnId",
      "sourceSequence",
      "subIndex",
      "time",
      "actor",
      "status",
      "payload",
      "links",
      "provenance",
      "completeness",
      "attributes",
    ]);
  }
});

test("event set with links and derived gap validates", () => {
  const r = validateEvents(fixture("valid/events-with-links.json"));
  assert.equal(r.ok, true);
});

test("set-level checks", () => {
  const base = fixture("valid/events-with-links.json") as Record<string, unknown>[];
  const dup = structuredClone(base);
  (dup[1] as { eventId: unknown }).eventId = (dup[0] as { eventId: unknown }).eventId;
  const r1 = validateEvents(dup);
  assert.ok(!r1.ok && r1.issues.some((i) => i.code === "duplicate-event-id"));
  const swapped = structuredClone(base);
  [swapped[0], swapped[1]] = [
    swapped[1] as Record<string, unknown>,
    swapped[0] as Record<string, unknown>,
  ];
  const r2 = validateEvents(swapped);
  assert.ok(!r2.ok && r2.issues.some((i) => i.code === "out-of-order"));
  assert.equal(validateEvents("x").ok, false);
  assert.equal(validateEvents([]).ok, true);
});

test("source ordering uses first appearance rank of sourceId", () => {
  const base = fixture("valid/events-with-links.json") as {
    provenance: { sourceId: string };
    sourceSequence: number;
  }[];
  const s = structuredClone(base);
  // a second source starts again at sequence 0 but is a new rank, which is allowed
  const other = structuredClone(s[0]) as unknown as Record<string, unknown>;
  other["eventId"] = `evt_${"1".repeat(32)}`;
  (other["provenance"] as { sourceId: string }).sourceId = `src_${"2".repeat(32)}`;
  const r = validateEvents([...s, other]);
  assert.equal(r.ok, true);
  const back = structuredClone(s[0]) as unknown as Record<string, unknown>;
  back["eventId"] = `evt_${"3".repeat(32)}`;
  back["sourceSequence"] = 99;
  const r2 = validateEvents([...s, other, back]);
  assert.ok(!r2.ok && r2.issues.some((i) => i.code === "out-of-order"));
});

test("required facets and causality", () => {
  const e = structuredClone(fixture("valid/tool.completed.json")) as Record<string, unknown>;
  (e["links"] as unknown[]).push({ rel: "result-of", target: `evt_${"0".repeat(32)}` });
  assert.deepEqual(codes(e), ["missing-facet"]);
});

test("time consistency", () => {
  const e = structuredClone(fixture("valid/tool.requested.json")) as Record<string, unknown>;
  e["time"] = { value: "2026-01-01T00:00:10.000Z", origin: "none", status: "valid" };
  assert.deepEqual(codes(e), ["bad-time"]);
  e["time"] = { value: null, origin: "none", status: "missing" };
  assert.deepEqual(codes(e), []);
  e["time"] = { value: null, origin: "source", status: "invalid" };
  assert.deepEqual(codes(e), []);
});

test("source.unknown topLevelKeys must be sorted", () => {
  const e = structuredClone(fixture("valid/source.unknown.json")) as {
    payload: { topLevelKeys: string[] };
  };
  e.payload.topLevelKeys = ["b", "a"];
  assert.deepEqual(codes(e), ["not-sorted"]);
});

test("schemaVersion pattern equals STRING_BOUNDS", () => {
  const e = structuredClone(fixture("valid/tool.requested.json")) as Record<string, unknown>;
  for (const v of ["0.1.0", "0.1.7", "0.1.123456"]) {
    e["schemaVersion"] = v;
    assert.deepEqual(codes(e), [], v);
  }
  for (const v of ["0.1", "0.1.1234567", "0.2.0", "1.0.0", "0.1.x", ""]) {
    e["schemaVersion"] = v;
    assert.deepEqual(codes(e), ["unsupported-schema-version"], v);
  }
});

test("issue codes form a closed set", () => {
  const e = structuredClone(fixture("valid/tool.requested.json")) as Record<string, unknown>;
  e["bogus"] = 1;
  const r = validateEvent(e);
  assert.ok(!r.ok);
  if (!r.ok)
    for (const i of r.issues) assert.ok((ISSUE_CODES as readonly string[]).includes(i.code));
});
