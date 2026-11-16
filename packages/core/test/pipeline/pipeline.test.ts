import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AdapterRegistration, Bounds } from "../../src/adapter/contract.js";
import { DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { canonicalJson } from "../../src/content/index.js";
import { deriveId } from "../../src/ids/index.js";
import { runImport } from "../../src/pipeline/run.js";
import type { CanonicalEvent, ImportResult } from "../../src/schema/types.js";
import { validateEvents } from "../../src/validate/index.js";
import {
  docRegistration,
  FIXTURES,
  fixtureBytes,
  refRegistration,
  sourceFrom,
} from "./ref-adapter.js";

type Policy = { retention: "hash-only" | "inline"; maxInlineBytes: number };
const HASH_ONLY: Policy = { retention: "hash-only", maxInlineBytes: 65_536 };
const INLINE: Policy = { retention: "inline", maxInlineBytes: 65_536 };

function run(
  input: string | Uint8Array,
  o: { reg?: AdapterRegistration; bounds?: Partial<Bounds>; policy?: Policy } = {},
): ImportResult {
  const reg = o.reg ?? refRegistration();
  const src = sourceFrom(input);
  return runImport(
    src,
    reg,
    {
      verdict: "match",
      providerVersionSeen: "9.9.9",
      nativeSessionId: "S-1",
      reasons: [],
    },
    { bounds: { ...DEFAULT_BOUNDS, ...o.bounds }, contentPolicy: o.policy ?? HASH_ONLY },
  );
}
const lines = (...l: string[]): string => `${l.join("\n")}\n`;
const SESSION = '{"t":"session","id":"S-1","v":"9.9.9"}';
const kinds = (r: ImportResult): string[] => r.events.map((e) => e.kind);
const wcodes = (r: ImportResult): string[] => r.warnings.map((w) => w.code);
const gaps = (r: ImportResult) =>
  r.events.flatMap((e) => (e.kind === "capture.gap" ? [e.payload.reason] : []));
function valid(r: ImportResult): void {
  const v = validateEvents(r.events);
  assert.ok(v.ok, JSON.stringify(v.ok ? [] : v.issues));
}

// ---- reference fixture ----

test("reference fixture: events, accounting, derived gaps, unknown and dispositions", () => {
  const r = run(fixtureBytes("reference/ref-basic.ref.jsonl"));
  valid(r);
  assert.equal(r.outcome, "partial");
  assert.equal(r.source.recordCount, 9);
  assert.deepEqual(kinds(r), [
    "session.started",
    "turn.started",
    "tool.requested",
    "tool.completed",
    "tool.requested",
    "tool.failed", // orphan result
    "source.unknown", // mystery record (record 7; meta record 6 is a disposition)
    "turn.ended",
    "capture.gap", // missing-start for the orphan result
    "capture.gap", // missing-result for C2
  ]);
  assert.equal(r.stats.folded, 1);
  assert.equal(r.stats.unknowns, 1);
  assert.equal(r.stats.gaps, 2);
  assert.equal(r.stats.derived, 2);
  // Every non-blank record is covered by an event or a disposition.
  const covered = new Set(
    r.events.flatMap((e) => (e.provenance.type === "record" ? [e.sourceSequence] : [])),
  );
  assert.deepEqual(
    [...covered].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 7, 8],
  );
  // Source descriptor.
  assert.equal(r.source.sourceStability, "undocumented");
  assert.equal(r.source.displayName, "ref.jsonl");
});

test("reference fixture: golden ImportResult is byte-equal", () => {
  const r = run(fixtureBytes("reference/ref-basic.ref.jsonl"));
  const golden = readFileSync(
    new URL("reference/expected/ref-basic.result.json", FIXTURES),
    "utf8",
  );
  assert.equal(`${canonicalJson(r)}\n`, golden);
});

test("same bytes, same options: byte-identical canonical JSON (idempotence)", () => {
  const b = fixtureBytes("reference/ref-basic.ref.jsonl");
  assert.equal(canonicalJson(run(b)), canonicalJson(run(b)));
  assert.equal(
    canonicalJson(run(b, { policy: INLINE })),
    canonicalJson(run(b, { policy: INLINE })),
  );
});

test("missing result: one derived gap with gap-for, status of the request unchanged", () => {
  const r = run(lines(SESSION, '{"t":"tool.call","call":"X","name":"Bash"}'));
  valid(r);
  const req = r.events.find((e) => e.kind === "tool.requested");
  const gap = r.events.find((e) => e.kind === "capture.gap");
  assert.ok(req && gap);
  assert.equal(req.status, "none");
  assert.equal(gap.provenance.type, "derived");
  assert.deepEqual(gap.links, [{ rel: "gap-for", target: req.eventId }]);
  assert.equal(gap.sourceSequence, 2);
  assert.equal(gap.subIndex, 0);
  assert.equal(gap.payload.reason, "missing-result");
  assert.ok(wcodes(r).includes("missing-result"));
  if (gap.provenance.type === "derived")
    assert.deepEqual(gap.provenance.basisEventIds, [req.eventId]);
});

test("orphan result: causality absent, missing-start gap, nothing fabricated", () => {
  const r = run(lines(SESSION, '{"t":"tool.result","call":"Z","ok":true}'));
  valid(r);
  const res = r.events.find((e) => e.kind === "tool.completed");
  assert.ok(res);
  assert.deepEqual(res.completeness.causality, { state: "absent", reason: "correlation-missing" });
  assert.deepEqual(res.links, []);
  assert.deepEqual(gaps(r), ["missing-start"]);
  assert.ok(wcodes(r).includes("orphan-result"));
  assert.equal(kinds(r).filter((k) => k === "tool.requested").length, 0);
});

test("result links to its request and gets a captured causality facet", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"tool.call","call":"A","name":"Read"}',
      '{"t":"tool.result","call":"A","ok":true}',
    ),
  );
  valid(r);
  const [, req, res] = r.events;
  assert.deepEqual(res?.links, [{ rel: "result-of", target: req?.eventId }]);
  assert.deepEqual(res?.completeness.causality, { state: "captured" });
  assert.deepEqual(gaps(r), []);
  assert.equal(r.outcome, "complete");
});

test("duplicate anchor: duplicate-of link and warning; the later duplicate gets the result", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"tool.call","call":"A","name":"Read"}',
      '{"t":"tool.call","call":"A","name":"Read"}',
      '{"t":"tool.result","call":"A","ok":true}',
    ),
  );
  valid(r);
  const [, first, second, res] = r.events;
  assert.deepEqual(second?.links, [{ rel: "duplicate-of", target: first?.eventId }]);
  assert.deepEqual(res?.links, [{ rel: "result-of", target: second?.eventId }]);
  assert.ok(wcodes(r).includes("duplicate-native-record"));
  assert.deepEqual(gaps(r), []);
});

test("turn tracking: open turn applies until turn.ended; native keys win", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"turn.start","turn":"T1"}',
      '{"t":"tool.call","call":"A","name":"Read"}',
      '{"t":"turn.end","turn":"T1"}',
      '{"t":"tool.call","call":"B","name":"Read"}',
      '{"t":"tool.result","call":"A","ok":true}',
      '{"t":"tool.result","call":"B","ok":true}',
    ),
  );
  valid(r);
  const turn = deriveId("trn", ["opencode", r.source.sourceId, "native:T1"]);
  const turnIds = r.events.slice(0, 6).map((e) => e.turnId);
  assert.deepEqual(turnIds, [null, turn, turn, turn, null, null]);
  const ended = r.events.find((e) => e.kind === "turn.ended");
  assert.deepEqual(ended?.links[0]?.rel, "ends");
});

test("ids: eventId, sourceId, sessionId and tool call ids follow ADR-0002 section 6", () => {
  const r = run(lines(SESSION, '{"t":"tool.call","call":"A","name":"Read"}'));
  const sourceId = deriveId("src", [
    "opencode",
    "opencode.reference-log",
    `sha256:${r.source.sha256}`,
  ]);
  assert.equal(r.source.sourceId, sourceId);
  const [s, t] = r.events;
  assert.equal(s?.sessionId, deriveId("ses", ["opencode", "native", "S-1"]));
  assert.equal(s?.eventId, deriveId("evt", ["opencode", sourceId, "r", 0, 0]));
  assert.equal(t?.eventId, deriveId("evt", ["opencode", sourceId, "r", 1, 0]));
  assert.equal(
    t?.payload && "toolCallId" in t.payload ? t.payload.toolCallId : null,
    deriveId("tc", ["opencode", sourceId, "A"]),
  );
  assert.equal(s?.actor.actorId, deriveId("act", ["opencode", s?.sessionId ?? "", "runtime"]));
});

test("session id falls back to the source when the adapter reports none", () => {
  const reg = refRegistration();
  const r = runImport(
    sourceFrom(lines(SESSION)),
    reg,
    {
      verdict: "match",
      providerVersionSeen: null,
      nativeSessionId: null,
      reasons: [],
    },
    { bounds: DEFAULT_BOUNDS, contentPolicy: HASH_ONLY },
  );
  assert.equal(r.events[0]?.sessionId, deriveId("ses", ["opencode", "source", r.source.sourceId]));
  assert.ok(
    r.warnings.some(
      (w) => w.code === "untested-provider-version" && w.detail["versionObserved"] === 0,
    ),
  );
});

test("two sources sharing a first line have disjoint source and event ids", () => {
  const a = run(lines(SESSION, '{"t":"turn.start","turn":"T1"}'));
  const b = run(lines(SESSION, '{"t":"turn.start","turn":"T2"}'));
  assert.notEqual(a.source.sourceId, b.source.sourceId);
  const ids = new Set(a.events.map((e) => e.eventId));
  for (const e of b.events) assert.equal(ids.has(e.eventId), false);
});

// ---- failures become gaps ----

test("parse failures: malformed, truncated final, invalid UTF-8, depth", () => {
  const r = run(fixtureBytes("hostile-mvp/malformed.jsonl"));
  valid(r);
  assert.deepEqual(gaps(r), ["malformed-record", "malformed-record"]);
  assert.deepEqual(wcodes(r).filter((c) => c === "malformed-record").length, 2);
  assert.equal(r.outcome, "partial");

  const t = run(fixtureBytes("hostile-mvp/truncated-final.jsonl"));
  valid(t);
  assert.deepEqual(gaps(t), ["truncated-final-record"]);
  assert.ok(wcodes(t).includes("truncated-final-record"));

  const u = run(fixtureBytes("hostile-mvp/invalid-utf8.jsonl"));
  valid(u);
  assert.deepEqual(gaps(u), ["invalid-utf8"]);

  const d = run(fixtureBytes("hostile-mvp/deep-65.jsonl"));
  valid(d);
  assert.deepEqual(gaps(d), ["depth-exceeded"]);
  assert.deepEqual(gaps(run(fixtureBytes("hostile-mvp/deep-64.jsonl"))), []);
});

test("duplicate JSON keys: warning, record still mapped (as unknown here)", () => {
  const r = run(fixtureBytes("hostile-mvp/duplicate-keys.jsonl"));
  valid(r);
  assert.ok(wcodes(r).includes("duplicate-json-key"));
});

test("huge line (17 MiB) becomes a record-too-large gap", () => {
  const head = new TextEncoder().encode(`${SESSION}\n`);
  const huge = new Uint8Array(17 * 1024 * 1024).fill(0x61);
  const bytes = new Uint8Array(head.length + huge.length + 1);
  bytes.set(head, 0);
  bytes.set(huge, head.length);
  bytes[bytes.length - 1] = 0x0a;
  const r = run(bytes);
  valid(r);
  assert.deepEqual(gaps(r), ["record-too-large"]);
  assert.equal(
    r.events[1]?.provenance.type === "record" && r.events[1].provenance.byteLength,
    huge.length,
  );
});

test("empty source and blank lines are reported", () => {
  const r = run("");
  assert.deepEqual(r.events, []);
  assert.ok(wcodes(r).includes("empty-source"));
  assert.equal(r.outcome, "complete");
  assert.ok(wcodes(run(`\n${SESSION}\n\n`)).includes("blank-lines"));
});

test("untested-provider-version is emitted while the tested list is empty, and only then", () => {
  assert.ok(wcodes(run(lines(SESSION))).includes("untested-provider-version"));
  const tested = run(lines(SESSION), { reg: refRegistration({ testedVersions: ["9.9.9"] }) });
  assert.equal(wcodes(tested).includes("untested-provider-version"), false);
});

// ---- adapter misbehavior ----

test("adapter throws in push: adapter-error gap for that record, later records still imported", () => {
  const r = run(lines(SESSION, '{"t":"throw"}', '{"t":"turn.start","turn":"T1"}'));
  valid(r);
  assert.deepEqual(kinds(r), ["session.started", "capture.gap", "turn.started"]);
  assert.deepEqual(gaps(r), ["adapter-error"]);
  assert.equal(r.outcome, "partial");
  // The thrown message never reaches the output.
  assert.equal(canonicalJson(r).includes("secret-detail"), false);
});

test("adapter throws in end: one derived adapter-error gap at sourceSequence = recordCount", () => {
  const r = run(lines(SESSION, '{"t":"end-throw"}'));
  valid(r);
  const gap = r.events.at(-1);
  assert.equal(gap?.kind, "capture.gap");
  assert.equal(gap?.provenance.type, "derived");
  assert.equal(gap?.sourceSequence, 2);
  assert.ok(wcodes(r).includes("adapter-error"));
  assert.equal(r.outcome, "partial");
});

test("draft with an unknown field is replaced by an adapter-output-invalid gap", () => {
  const r = run(lines(SESSION, '{"t":"extra-field"}'));
  valid(r);
  assert.deepEqual(gaps(r), ["adapter-output-invalid"]);
  assert.ok(
    r.warnings.some(
      (w) => w.code === "adapter-output-invalid" && w.detail["reason"] === "unknown-field",
    ),
  );
});

test("attribute outside the manifest allowlist: gap plus attribute-not-allowed", () => {
  const r = run(lines(SESSION, '{"t":"attr","key":"opencode.leak"}'));
  valid(r);
  assert.deepEqual(gaps(r), ["adapter-output-invalid"]);
  assert.ok(wcodes(r).includes("attribute-not-allowed"));
  const ok = run(lines(SESSION, '{"t":"attr","key":"opencode.cwd"}'));
  assert.deepEqual(gaps(ok), []);
  assert.deepEqual(ok.events[1]?.attributes, { "opencode.cwd": 1 });
});

test("recordRef pointing forward is adapter-output-invalid", () => {
  const r = run(lines(SESSION, '{"t":"fwd"}'));
  valid(r);
  assert.deepEqual(gaps(r), ["adapter-output-invalid"]);
  assert.ok(r.warnings.some((w) => w.detail["reason"] === "bad-record-ref"));
});

test("an inline ContentRef under the hash-only policy is rejected", () => {
  const r = run(lines(SESSION, '{"t":"inline","text":"secret text"}'));
  valid(r);
  assert.deepEqual(gaps(r), ["adapter-output-invalid"]);
  assert.ok(r.warnings.some((w) => w.detail["reason"] === "inline-under-hash-only"));
});

test("invalid adapter warnings and dispositions are reported, not trusted", () => {
  const r = run(lines(SESSION, '{"t":"bad-warn"}', '{"t":"bad-disp"}'));
  valid(r);
  assert.equal(r.warnings.filter((w) => w.detail["reason"] === "bad-warning").length, 1);
  assert.equal(r.warnings.filter((w) => w.detail["reason"] === "bad-disposition").length, 1);
  // The record with the invalid disposition is not accounted, so it becomes source.unknown.
  assert.deepEqual(
    r.events.filter((e) => e.kind === "source.unknown").map((e) => e.sourceSequence),
    [2],
  );
});

test("valid adapter warnings pass through", () => {
  const r = run(lines(SESSION, '{"t":"warn"}'));
  assert.ok(r.warnings.some((w) => w.code === "unmapped-field" && w.sourceSequence === 1));
});

test("adapter may not forge source.unknown contents", () => {
  const r = run(lines(SESSION, '{"t":"unknown-draft","k":1}'));
  valid(r);
  const u = r.events.find((e) => e.kind === "source.unknown");
  assert.ok(u && u.kind === "source.unknown");
  assert.deepEqual(u.payload.topLevelKeys, ["k", "t"]);
  assert.equal(u.payload.nativeType, "unknown-draft");
  assert.equal(u.provenance.type === "record" && u.provenance.sha256, u.payload.recordSha256);
});

// ---- accounting ----

test("unaccounted record: source.unknown plus adapter-output-invalid warning", () => {
  const r = run(lines(SESSION, '{"t":"whatever","a":1,"b":2}'));
  valid(r);
  const u = r.events[1];
  assert.equal(u?.kind, "source.unknown");
  if (u?.kind === "source.unknown") {
    assert.deepEqual(u.payload.topLevelKeys, ["a", "b", "t"]);
    assert.equal(u.payload.nativeType, null);
  }
  assert.ok(
    r.warnings.some((w) => w.detail["reason"] === "unaccounted-record" && w.sourceSequence === 1),
  );
  assert.equal(r.outcome, "partial");
});

test("dispositions account for records without events and are counted as folded", () => {
  const r = run(lines(SESSION, '{"t":"meta"}', '{"t":"ctl"}'));
  valid(r);
  assert.deepEqual(kinds(r), ["session.started"]);
  assert.equal(r.stats.folded, 2);
  assert.equal(r.outcome, "complete");
  assert.ok(
    r.warnings.some(
      (w) => w.code === "folded-records" && w.detail["metadata"] === 1 && w.detail["control"] === 1,
    ),
  );
});

test("fold: first position is the order, last write is the evidence", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"msg","id":"m1","text":"v1"}',
      '{"t":"turn.start","turn":"T1"}',
      '{"t":"msg","id":"m1","text":"v2"}',
      '{"t":"msg","id":"m2","text":"w1"}',
      '{"t":"msg","id":"m1","text":"v3"}',
    ),
  );
  valid(r);
  const msgs = r.events.filter((e) => e.kind === "message.observed");
  assert.equal(msgs.length, 2);
  // m1 sits at its first position (record 1) and cites its last write (record 5).
  const m1 = msgs[0];
  assert.equal(m1?.sourceSequence, 1);
  assert.equal(m1?.provenance.type === "record" && m1.provenance.line, 6);
  assert.equal(m1?.provenance.type === "record" && m1.provenance.pointer, "/text");
  const m2 = msgs[1];
  assert.equal(m2?.sourceSequence, 4);
  assert.equal(m2?.provenance.type === "record" && m2.provenance.line, 5);
  // Events are in (order, subIndex) sequence: ids of the whole result are valid and ordered.
  assert.deepEqual(
    r.events.map((e) => e.sourceSequence),
    [0, 1, 2, 4],
  );
  // Superseded writes (records 3) are accounted by dispositions.
  assert.equal(r.stats.folded, 1);
  assert.equal(r.stats.unknowns, 0);
});

// ---- bounds ----

test("maxDraftsPerRecord: excess dropped, bounds-reached gap for that record", () => {
  const r = run(lines(SESSION, '{"t":"many","n":5}'), { bounds: { maxDraftsPerRecord: 2 } });
  valid(r);
  assert.deepEqual(kinds(r), ["session.started", "turn.ended", "turn.ended", "capture.gap"]);
  assert.deepEqual(gaps(r), ["bounds-reached"]);
  assert.deepEqual(
    r.events.map((e) => e.subIndex),
    [0, 0, 1, 2],
  );
});

test("more than 1024 events from one record: capped with one aggregated gap", () => {
  const r = run(lines(SESSION, '{"t":"many","n":1500}'), { bounds: { maxDraftsPerRecord: 5000 } });
  valid(r);
  assert.equal(r.events.length, 1 + 1024);
  assert.deepEqual(gaps(r), ["bounds-reached"]);
  assert.equal(r.events.at(-1)?.subIndex, 1023);
});

test("maxEvents: truncated with a bounds-reached gap, outcome partial, still valid", () => {
  const r = run(lines(SESSION, '{"t":"many","n":10}'), { bounds: { maxEvents: 4 } });
  valid(r);
  assert.equal(r.events.length, 4);
  assert.equal(r.events.at(-1)?.kind, "capture.gap");
  assert.equal(r.events.at(-1)?.provenance.type, "derived");
  assert.equal(r.outcome, "partial");
  assert.ok(wcodes(r).includes("bounds-reached"));
});

test("maxAdapterErrors: abort with outcome failed", () => {
  const r = run(
    lines(
      SESSION,
      ...Array.from({ length: 5 }, () => '{"t":"throw"}'),
      '{"t":"turn.start","turn":"T"}',
    ),
    {
      bounds: { maxAdapterErrors: 2 },
    },
  );
  valid(r);
  assert.equal(r.outcome, "failed");
  assert.equal(gaps(r).filter((g) => g === "adapter-error").length, 4);
  assert.equal(kinds(r).includes("turn.started"), false);
});

test("maxOpenCorrelations: anchors beyond the cap are not tracked and a gap says so", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"tool.call","call":"A","name":"R"}',
      '{"t":"tool.call","call":"B","name":"R"}',
      '{"t":"tool.call","call":"C","name":"R"}',
    ),
    { bounds: { maxOpenCorrelations: 2 } },
  );
  valid(r);
  assert.ok(gaps(r).includes("bounds-reached"));
  assert.ok(wcodes(r).includes("bounds-reached"));
  // Only the two tracked requests report a missing result.
  assert.equal(gaps(r).filter((g) => g === "missing-result").length, 2);
});

test("maxTotalInlineBytes: later refs are downgraded to hash-only with one warning", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"turn.start","turn":"T1","text":"aaaaaaaa"}',
      '{"t":"turn.start","turn":"T2","text":"bbbbbbbb"}',
      '{"t":"turn.start","turn":"T3","text":"cc"}',
    ),
    { policy: INLINE, bounds: { maxTotalInlineBytes: 10 } },
  );
  valid(r);
  const refs = r.events.flatMap((e) => (e.kind === "turn.started" ? [e.payload.prompt] : []));
  assert.equal(refs[0]?.retention, "inline");
  assert.equal(refs[1]?.retention, "hash-only");
  assert.equal(refs[1]?.inline, undefined);
  assert.equal(refs[2]?.retention, "hash-only"); // exhausted stays exhausted
  assert.equal(wcodes(r).filter((c) => c === "bounds-reached").length, 1);
});

test("maxWarnings: the overflow is aggregated by code", () => {
  const many = Array.from({ length: 20 }, () => '{"t":"throw"}');
  const r = run(lines(SESSION, ...many), { bounds: { maxWarnings: 5 } });
  const adapterErrors = r.warnings.filter((w) => w.code === "adapter-error");
  assert.ok(r.warnings.some((w) => w.code === "warnings-aggregated"));
  const aggregated = adapterErrors.find((w) => w.sourceSequence === null);
  assert.ok(aggregated !== undefined && typeof aggregated.detail["count"] === "number");
  assert.ok(r.warnings.length <= 5 + 24 + 1);
});

// ---- time ----

test("timestamps: regression warns and keeps order; invalid values are null with a warning", () => {
  const r = run(
    lines(
      SESSION,
      '{"t":"turn.start","turn":"T1","ts":"2026-01-01T10:00:00Z"}',
      '{"t":"turn.end","turn":"T1","ts":"2026-01-01T09:00:00Z"}',
      '{"t":"turn.start","turn":"T2","ts":"2026-13-45T10:00:00Z"}',
      '{"t":"turn.start","turn":"T3","ts":"2026-11-15T10:00:00"}',
    ),
  );
  valid(r);
  assert.deepEqual(
    r.events.map((e) => e.sourceSequence),
    [0, 1, 2, 3, 4],
  );
  assert.ok(r.warnings.some((w) => w.code === "timestamp-regression" && w.sourceSequence === 2));
  assert.equal(r.warnings.filter((w) => w.code === "timestamp-invalid").length, 2);
  assert.deepEqual(r.events[3]?.time, { value: null, origin: "source", status: "invalid" });
});

// ---- content ----

test("inline policy: secrets are masked, counted, and absent from the result", () => {
  const r = run(fixtureBytes("hostile-mvp/secrets-inline.jsonl"), { policy: INLINE });
  // Record 1 is an "inline" draft that the fake adapter builds with retention inline regardless.
  valid(r);
  const json = canonicalJson(r);
  assert.equal(json.includes("AKIAIOSFODNN7EXAMPLE"), false);
  assert.equal(json.includes("hunter2hunter2"), false);
  assert.equal(json.includes("abcdefghijklmnop"), false);
  const ref = r.events.flatMap((e) => (e.kind === "turn.started" ? [e.payload.prompt] : []))[0];
  assert.ok(ref !== null && ref !== undefined);
  assert.equal(ref.redactionCount, 3);
  assert.equal(ref.retention, "inline");
  assert.ok(ref.byteLength > (ref.inline ?? "").length - 100);
});

test("hash-only default keeps no content anywhere", () => {
  const r = run(lines(SESSION, '{"t":"turn.start","turn":"T1","text":"password=hunter2hunter2"}'));
  assert.equal(canonicalJson(r).includes("hunter2"), false);
  const ref = r.events.flatMap((e) => (e.kind === "turn.started" ? [e.payload.prompt] : []))[0];
  assert.equal(ref?.retention, "hash-only");
  assert.equal(ref !== null && ref !== undefined && "inline" in ref, false);
});

test("prompt injection text is inert: same events and warnings as a benign control", () => {
  const injected = run(fixtureBytes("hostile-mvp/prompt-injection.jsonl"));
  const benign = run(
    lines(SESSION, '{"t":"turn.start","turn":"T1","text":"hello"}', '{"t":"mystery","x":"plain"}'),
  );
  const strip = (r: ImportResult): unknown =>
    r.events.map((e) => [e.kind, e.status, e.sourceSequence, e.subIndex]);
  assert.deepEqual(strip(injected), strip(benign));
  assert.deepEqual(wcodes(injected), wcodes(benign));
});

test("__proto__ keys in a record do not pollute anything", () => {
  const r = run(fixtureBytes("hostile-mvp/proto-keys.jsonl"));
  valid(r);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  const u = r.events.find((e) => e.kind === "source.unknown");
  assert.ok(u && u.kind === "source.unknown");
  assert.deepEqual(u.payload.topLevelKeys, ["__proto__", "constructor", "t"]);
});

// ---- json-document ----

test("json-document: envelope and element records, pointer base applied, golden-stable", () => {
  const reg = docRegistration();
  const r = run(fixtureBytes("reference/ref-doc.json"), { reg });
  valid(r);
  assert.deepEqual(kinds(r), ["session.started", "message.observed", "message.observed"]);
  const prov = r.events.map((e) => (e.provenance.type === "record" ? e.provenance : null));
  assert.deepEqual(
    prov.map((p) => p?.pointer),
    ["", "/messages/0/text", "/messages/1/text"],
  );
  assert.deepEqual(
    prov.map((p) => p?.line),
    [1, 5, 6],
  );
  assert.equal(r.source.recordCount, 3);
  assert.equal(
    canonicalJson(r),
    canonicalJson(run(fixtureBytes("reference/ref-doc.json"), { reg })),
  );
});

test("json-document: a document over maxDocumentBytes fails the import with a gap", () => {
  const r = run(fixtureBytes("reference/ref-doc.json"), {
    reg: docRegistration(),
    bounds: { maxDocumentBytes: 20 },
  });
  valid(r);
  assert.equal(r.outcome, "failed");
  assert.deepEqual(gaps(r), ["record-too-large"]);
});

test("json-document: malformed document is one gap; no element records", () => {
  const r = run(fixtureBytes("hostile-mvp/doc-malformed.json"), { reg: docRegistration() });
  valid(r);
  assert.deepEqual(gaps(r), ["malformed-record"]);
  assert.equal(r.events.length, 1);
  const t = run(fixtureBytes("hostile-mvp/doc-trailing-garbage.json"), { reg: docRegistration() });
  assert.deepEqual(gaps(t), ["malformed-record"]);
  const d = run(fixtureBytes("hostile-mvp/doc-deep-65.json"), { reg: docRegistration() });
  assert.deepEqual(gaps(d), ["depth-exceeded"]);
});

// ---- result shape ----

test("every event passes validateEvents and result keys are in a stable shape", () => {
  const r = run(fixtureBytes("reference/ref-basic.ref.jsonl"), { policy: INLINE });
  valid(r);
  const e: CanonicalEvent | undefined = r.events[0];
  assert.deepEqual(Object.keys(e ?? {}), [
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
  assert.deepEqual(Object.keys(r), ["source", "events", "warnings", "stats", "outcome"]);
});

test("event provenance bytes can be verified against the source", () => {
  const bytes = fixtureBytes("reference/ref-basic.ref.jsonl");
  const r = run(bytes);
  let checked = 0;
  for (const e of r.events) {
    if (e.provenance.type !== "record") continue;
    const p = e.provenance;
    const span = bytes.subarray(p.byteOffset, p.byteOffset + p.byteLength);
    assert.equal(createHash("sha256").update(span).digest("hex"), p.sha256);
    checked++;
  }
  assert.equal(checked, 8);
});

test("maxRecords: dropped records are reported with a derived bounds-reached gap", () => {
  const r = run(
    lines(SESSION, '{"t":"turn.start","turn":"T1"}', '{"t":"turn.start","turn":"T2"}'),
    {
      bounds: { maxRecords: 2 },
    },
  );
  valid(r);
  assert.equal(r.source.recordCount, 2);
  const gap = r.events.at(-1);
  assert.equal(gap?.kind, "capture.gap");
  assert.equal(gap?.provenance.type, "derived");
  assert.equal(gap?.kind === "capture.gap" && gap.payload.fromSequence, 2);
  assert.equal(r.outcome, "partial");
});

test("a disposition may only point at an accounted record", () => {
  const r = run(lines(SESSION, '{"t":"into-next"}', '{"t":"mystery"}'));
  valid(r);
  assert.ok(
    r.warnings.some((w) => w.detail["reason"] === "bad-disposition" && w.sourceSequence === 1),
  );
  // Both records end up as source.unknown; nothing is silently dropped.
  assert.deepEqual(
    r.events.filter((e) => e.kind === "source.unknown").map((e) => e.sourceSequence),
    [1, 2],
  );
});

test("redaction of truncated inline content keeps the ref consistent", () => {
  const long = `password=hunter2hunter2 ${"z".repeat(100)}`;
  const r = run(lines(SESSION, `{"t":"turn.start","turn":"T1","text":"${long}"}`), {
    policy: { retention: "inline", maxInlineBytes: 30 },
  });
  valid(r);
  const ref = r.events.flatMap((e) => (e.kind === "turn.started" ? [e.payload.prompt] : []))[0];
  assert.equal(ref?.retention, "inline-truncated");
  assert.equal(ref?.redactionCount, 1);
  assert.equal(ref?.inline?.includes("hunter2"), false);
  assert.ok((ref?.inline ?? "").startsWith("password=[REDACTED]"));
});
