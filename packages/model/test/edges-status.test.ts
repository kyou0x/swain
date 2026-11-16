import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeRunStatus,
  deriveParentOfEdges,
  deriveSameSessionEdges,
  type RunEvidence,
  type SpanFact,
  type SpanStatusFact,
  traceRunEvidence,
} from "../src/index.js";
import { id, PRJ, PRJ2, TRACE } from "./helpers.js";

const f = (
  spanId: string,
  parentSpanId: string | null,
  keyId: string,
  ref = `b1#${spanId}`,
): SpanFact => ({
  traceId: TRACE,
  spanId,
  parentSpanId,
  keyId,
  ref,
});

test("parent-of: asserted edge from the parent span to the child, with evidence and keyIds", () => {
  const r = deriveParentOfEdges(PRJ, [
    f("aa", null, "key_1"),
    f("bb", "aa", "key_1"),
    f("cc", "bb", "key_1"),
  ]);
  assert.equal(r.missingParents.length, 0);
  assert.equal(r.edges.length, 2);
  const e = r.edges.find((x) => x.to.id === `${TRACE}/bb`);
  assert.ok(e);
  assert.equal(e.kind, "parent-of");
  assert.equal(e.basis, "otlp.parentSpanId");
  assert.equal(e.confidence, "asserted");
  assert.deepEqual(e.from, { type: "span", id: `${TRACE}/aa` });
  assert.deepEqual(e.keyIds, ["key_1"]);
  assert.equal(e.crossCredential, false);
  assert.ok(e.evidence.length >= 1 && e.evidence.length <= 64);
  assert.ok(e.evidence.every((x) => x.layer === "L1" && x.keyId === "key_1"));
  assert.match(e.edgeId, /^edg_[0-9a-f]{32}$/);
  assert.ok(!("rule" in e));
});

test("parent-of: crossCredential when the parent and the child came from different keys", () => {
  const r = deriveParentOfEdges(PRJ, [f("aa", null, "key_1"), f("bb", "aa", "key_2")]);
  const e = r.edges[0];
  assert.ok(e);
  assert.deepEqual(e.keyIds, ["key_1", "key_2"]);
  assert.equal(e.crossCredential, true);
  assert.deepEqual(new Set(e.evidence.map((x) => x.keyId)), new Set(["key_1", "key_2"]));
});

test("parent-of: a conflicting duplicate from another key makes the edge cross-credential", () => {
  const r = deriveParentOfEdges(PRJ, [
    f("aa", null, "key_1"),
    f("bb", "aa", "key_1"),
    f("bb", "aa", "key_2", "b2#bb"),
  ]);
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0]?.crossCredential, true);
});

test("parent-of: missing parent gives no edge, only a report; later arrival creates the edge", () => {
  const first = deriveParentOfEdges(PRJ, [f("bb", "aa", "key_1")]);
  assert.equal(first.edges.length, 0);
  assert.deepEqual(first.missingParents, [{ traceId: TRACE, spanId: "bb" }]);
  const later = deriveParentOfEdges(PRJ, [f("bb", "aa", "key_1"), f("aa", null, "key_1")]);
  assert.equal(later.edges.length, 1);
});

test("parent-of: self-parent and cross-trace parents are not edges; IDs are project-scoped and stable", () => {
  assert.equal(deriveParentOfEdges(PRJ, [f("aa", "aa", "k")]).edges.length, 0);
  const other: SpanFact = { ...f("aa", null, "k"), traceId: "6b8efff798038103d269b633813fc60c" };
  assert.equal(deriveParentOfEdges(PRJ, [other, f("bb", "aa", "k")]).edges.length, 0);
  const a = deriveParentOfEdges(PRJ, [f("aa", null, "k"), f("bb", "aa", "k")]);
  const b = deriveParentOfEdges(PRJ, [f("bb", "aa", "k"), f("aa", null, "k")]);
  const c = deriveParentOfEdges(PRJ2, [f("aa", null, "k"), f("bb", "aa", "k")]);
  assert.deepEqual(a.edges, b.edges);
  assert.notEqual(a.edges[0]?.edgeId, c.edges[0]?.edgeId);
});

test("parent-of: evidence is capped at 64 entries", () => {
  const facts = [f("aa", null, "k")];
  for (let i = 0; i < 100; i++) facts.push(f("bb", "aa", `key_${i}`, `b#${i}`));
  const e = deriveParentOfEdges(PRJ, facts).edges[0];
  assert.equal(e?.evidence.length, 64);
  assert.equal(e?.crossCredential, true);
  assert.equal(e?.keyIds.length, 101);
});

test("same-session: runs sharing a session value are linked; crossCredential by evidence keys", () => {
  const edges = deriveSameSessionEdges(PRJ, [
    { runId: "run_b", sessionBasis: "session.id", session: id("S"), keyId: "k1", ref: "r1" },
    { runId: "run_a", sessionBasis: "session.id", session: id("S"), keyId: "k1", ref: "r2" },
    { runId: "run_c", sessionBasis: "session.id", session: id("S"), keyId: "k2", ref: "r3" },
    { runId: "run_x", sessionBasis: "session.id", session: id("T"), keyId: "k1", ref: "r4" },
    {
      runId: "run_a",
      sessionBasis: "gen_ai.conversation.id",
      session: id("S"),
      keyId: "k1",
      ref: "r5",
    },
    {
      runId: "run_d",
      sessionBasis: "gen_ai.conversation.id",
      session: id("S"),
      keyId: "k1",
      ref: "r6",
    },
  ]);
  assert.equal(edges.length, 3); // chain a-b, b-c for session.id=S; a-d for the conversation id
  const ab = edges.find((e) => e.from.id === "run_a" && e.to.id === "run_b");
  const bc = edges.find((e) => e.from.id === "run_b" && e.to.id === "run_c");
  const ad = edges.find((e) => e.to.id === "run_d");
  assert.equal(ab?.crossCredential, false);
  assert.equal(ab?.basis, "attr:session.id");
  assert.equal(bc?.crossCredential, true);
  assert.deepEqual(bc?.keyIds, ["k1", "k2"]);
  assert.equal(ad?.basis, "attr:gen_ai.conversation.id");
  assert.ok(edges.every((e) => e.kind === "same-session" && e.confidence === "asserted"));
  assert.equal(
    deriveSameSessionEdges(PRJ, [
      {
        runId: "run_a",
        sessionBasis: "adr0002.sessionId",
        session: id("S"),
        keyId: "k",
        ref: "r",
      },
      {
        runId: "run_b",
        sessionBasis: "adr0002.sessionId",
        session: id("S"),
        keyId: "k",
        ref: "r",
      },
    ])[0]?.basis,
    "adr0002.sessionId",
  );
  assert.equal(
    deriveSameSessionEdges(PRJ, [
      { runId: "run_a", sessionBasis: "session.id", session: id("S"), keyId: "k", ref: "r" },
    ]).length,
    0,
  );
});

// ---- status ---------------------------------------------------------------------------------

const ev = (o: Partial<RunEvidence> = {}): RunEvidence => ({
  lastReceivedMs: 1_000_000,
  endEvidence: false,
  missingParents: 0,
  captureGaps: 0,
  unresolvedReferences: 0,
  errorEvidence: false,
  ...o,
});

test("status: active within the idle window, idle after it (injected clock, default 300 s)", () => {
  assert.equal(computeRunStatus(ev(), 1_000_000).status, "active");
  assert.equal(computeRunStatus(ev(), 1_300_000).status, "active");
  assert.equal(computeRunStatus(ev(), 1_300_001).status, "idle");
  assert.equal(computeRunStatus(ev(), 1_010_000, 5_000).status, "idle");
  assert.equal(computeRunStatus(ev({ lastReceivedMs: null }), 0).status, "idle");
});

test("status: ended on end evidence, incomplete when ended with gaps, missing parents or unresolved refs", () => {
  assert.equal(computeRunStatus(ev({ endEvidence: true }), 9e9).status, "ended");
  assert.equal(computeRunStatus(ev({ endEvidence: true }), 1_000_000).status, "ended");
  for (const o of [{ missingParents: 1 }, { captureGaps: 1 }, { unresolvedReferences: 1 }]) {
    assert.equal(computeRunStatus(ev({ endEvidence: true, ...o }), 1_000_000).status, "incomplete");
    // Without end evidence the same gaps do not make a run "incomplete".
    assert.equal(computeRunStatus(ev(o), 1_000_000).status, "active");
  }
});

test("status: error is a flag, and late marks data after the end", () => {
  const r = computeRunStatus(
    ev({ endEvidence: true, errorEvidence: true, endedReceivedMs: 500_000 }),
    2_000_000,
  );
  assert.deepEqual(r, { status: "ended", error: true, late: true });
  assert.equal(computeRunStatus(ev({ errorEvidence: true }), 1_000_000).error, true);
  assert.equal(
    computeRunStatus(ev({ endEvidence: true, endedReceivedMs: 1_000_000 }), 0).late,
    false,
  );
});

test("status: invalid clock inputs throw invalid-option", () => {
  for (const now of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => computeRunStatus(ev(), now),
      (e: unknown) => e instanceof Error && e.message === "invalid-option",
    );
  }
  assert.throws(() => computeRunStatus(ev(), 1, -5));
});

test("trace evidence: root spans ended, missing parents, errors, last received", () => {
  const sp = (
    spanId: string,
    parentSpanId: string | null,
    end: bigint,
    code: 0 | 1 | 2 = 0,
    receivedMs = 10,
  ): SpanStatusFact => ({
    spanId,
    parentSpanId,
    endTimeUnixNano: end,
    statusCode: code,
    receivedMs,
  });
  const ended = traceRunEvidence([sp("a", null, 5n), sp("b", "a", 0n, 2, 20)]);
  assert.equal(ended.endEvidence, true); // only ROOT spans decide
  assert.equal(ended.errorEvidence, true);
  assert.equal(ended.lastReceivedMs, 20);
  assert.equal(ended.missingParents, 0);
  assert.equal(traceRunEvidence([sp("a", null, 0n)]).endEvidence, false);
  assert.equal(traceRunEvidence([sp("a", null, 5n), sp("c", null, 0n)]).endEvidence, false);
  const orphan = traceRunEvidence([sp("b", "zz", 5n)]);
  assert.equal(orphan.endEvidence, false); // no root yet
  assert.equal(orphan.missingParents, 1);
  assert.equal(traceRunEvidence([]).lastReceivedMs, null);
  assert.equal(
    computeRunStatus(traceRunEvidence([sp("a", null, 5n), sp("b", "zz", 5n)]), 20).status,
    "incomplete",
  );
});
