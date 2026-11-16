/**
 * End-to-end pipeline contract: for every synthetic MVP fixture of all four providers run the real
 * `readSourceFile` -> `selectAdapter` -> `runImport` path, then `runAdapterConformance` with the
 * parsed capability matrix.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AdapterRegistration,
  type ConformanceCase,
  type ConformanceFailure,
  canonicalJson,
  DEFAULT_BOUNDS,
  frameSource,
  type ImportResult,
  readSourceFile,
  runAdapterConformance,
  runImport,
  selectAdapter,
  validateEvents,
} from "@swain/core";
import {
  CAPABILITY_MATRIX,
  EXPECTED_REFUSED,
  type FixtureFile,
  fixtureFiles,
  REGISTRATIONS,
} from "./helpers.js";

/**
 * KNOWN FINDING (tracked, not hidden): the kit's independent accounting check counts a
 * record as covered only when an event sits at its own sequence. Gemini folds a message to its
 * first position and cites the last write as evidence, so evidence-only records are "uncovered"
 * although the pipeline accounts for them (the per-fixture recount above passes). The kit is not
 * owned by this work package; once it is fixed this entry must be removed (the assertion then fails).
 */
const KNOWN_KIT_FINDINGS: Readonly<Record<string, readonly ConformanceFailure[]>> = {
  "gemini-cli.chat-jsonl": [
    {
      case: "gemini-cli/session-golden.jsonl",
      check: "record-unaccounted",
      detail: "records without events exceed folded records",
    },
  ],
};

const POLICY = { retention: "hash-only", maxInlineBytes: 0 } as const;
const FILES = fixtureFiles();

test("every fixture is either declared for an adapter or expected to be refused", () => {
  assert.ok(FILES.length >= 27, `fixture count ${FILES.length}`);
  for (const f of FILES) {
    assert.ok(f.adapter !== null || Object.hasOwn(EXPECTED_REFUSED, f.rel), f.rel);
  }
  for (const rel of Object.keys(EXPECTED_REFUSED)) {
    assert.ok(
      FILES.some((f) => f.rel === rel),
      `stale EXPECTED_REFUSED entry ${rel}`,
    );
  }
});

function importFixture(f: FixtureFile): {
  reg: AdapterRegistration;
  result: ImportResult;
  bytes: Uint8Array;
} {
  const src = readSourceFile(f.path, DEFAULT_BOUNDS);
  const sel = selectAdapter(src, REGISTRATIONS, {}, DEFAULT_BOUNDS);
  assert.ok(sel.ok, `${f.rel}: selection must succeed`);
  assert.equal(sel.registration.adapter.manifest.id, f.adapter, `${f.rel}: adapter id`);
  const result = runImport(src, sel.registration, sel.detect, {
    bounds: DEFAULT_BOUNDS,
    contentPolicy: POLICY,
  });
  return { reg: sel.registration, result, bytes: src.bytes };
}

for (const f of FILES.filter((x) => x.adapter !== null)) {
  test(`pipeline: ${f.rel}`, () => {
    const { reg, result, bytes } = importFixture(f);
    const manifest = reg.adapter.manifest;

    // Correct, unambiguous selection; the provider matches the fixture directory.
    assert.equal(manifest.provider, f.provider);
    assert.equal(result.source.provider, f.provider);
    assert.equal(result.source.sourceKind, manifest.sourceKind);
    assert.equal(result.source.sourceStability, manifest.sourceStability);
    assert.equal(result.source.byteLength, bytes.length);

    // Valid events.
    const checked = validateEvents(JSON.parse(JSON.stringify(result.events)));
    assert.ok(checked.ok, `${f.rel}: events must validate`);
    assert.ok(result.events.length > 0);

    // Record accounting.
    const s = result.stats;
    assert.equal(s.records, result.source.recordCount);
    const byKind: Record<string, number> = {};
    for (const e of result.events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    assert.deepEqual(byKind, s.eventsByKind);
    assert.equal(byKind["capture.gap"] ?? 0, s.gaps);
    assert.equal(byKind["source.unknown"] ?? 0, s.unknowns);
    // Per-record accounting (SPEC-002 section 3.4 step 10): a record is accounted when an event sits
    // at its sequence, cites it as evidence (the provenance of an event is its evidence record), or
    // it is a declared disposition (`stats.folded`). Independent recount from the output alone.
    const framed = frameSource(bytes, reg.adapter.manifest.framing, DEFAULT_BOUNDS);
    assert.equal(framed.records.length, s.records);
    const bySequence = new Set<number>();
    const byEvidence = new Set<string>();
    for (const e of result.events) {
      if (e.provenance.type !== "record") continue;
      bySequence.add(e.sourceSequence);
      byEvidence.add(`${e.provenance.byteOffset}:${e.provenance.byteLength}`);
    }
    const uncovered = framed.records.filter(
      (r) =>
        !bySequence.has(r.sourceSequence) && !byEvidence.has(`${r.byteOffset}:${r.byteLength}`),
    ).length;
    assert.ok(
      uncovered <= s.folded,
      `${f.rel}: ${uncovered} records have no event or evidence link but only ${s.folded} are folded`,
    );
    for (const e of result.events) {
      if (e.provenance.type === "record") {
        assert.ok(e.provenance.byteOffset + e.provenance.byteLength <= bytes.length);
      }
    }
    assert.ok(["complete", "partial"].includes(result.outcome), `${f.rel}: ${result.outcome}`);

    // Hash-only default: no inline content anywhere.
    assert.equal(canonicalJson(result.events).includes('"inline"'), false);

    // The honest untested-provider-version status while no version is tested.
    assert.deepEqual(manifest.testedProviderVersions, []);
    assert.ok(result.warnings.some((w) => w.code === "untested-provider-version"));

    // Byte-identical re-import.
    const again = importFixture(f);
    assert.equal(canonicalJson(again.result), canonicalJson(result));
  });
}

for (const [rel, reason] of Object.entries(EXPECTED_REFUSED)) {
  test(`selection refuses ${rel} (${reason})`, () => {
    const f = FILES.find((x) => x.rel === rel);
    assert.ok(f);
    const src = readSourceFile(f.path, DEFAULT_BOUNDS);
    const sel = selectAdapter(src, REGISTRATIONS, {}, DEFAULT_BOUNDS);
    assert.equal(sel.ok, false);
    assert.equal(!sel.ok && sel.reason, reason);
  });
}

test("provider and source-kind narrowing never turns a refusal into a guess", () => {
  const codex = FILES.find((x) => x.rel === "codex-cli/rollout-legacy-golden.jsonl");
  assert.ok(codex);
  const src = readSourceFile(codex.path, DEFAULT_BOUNDS);
  const wrong = selectAdapter(src, REGISTRATIONS, { provider: "opencode" }, DEFAULT_BOUNDS);
  assert.equal(wrong.ok, false);
  const right = selectAdapter(
    src,
    REGISTRATIONS,
    { provider: "codex-cli", sourceKind: "codex-cli.rollout-jsonl" },
    DEFAULT_BOUNDS,
  );
  assert.equal(right.ok, true);
});

test("runAdapterConformance passes for every registration with the parsed capability matrix", () => {
  const byAdapter = new Map<string, ConformanceCase[]>();
  for (const f of FILES.filter((x) => x.adapter !== null)) {
    const { reg, bytes } = importFixture(f);
    const id = reg.adapter.manifest.id;
    const list = byAdapter.get(id) ?? [];
    list.push({ name: f.rel, bytes });
    byAdapter.set(id, list);
  }
  for (const reg of REGISTRATIONS) {
    const id = reg.adapter.manifest.id;
    const cases = byAdapter.get(id) ?? [];
    assert.ok(cases.length > 0, `${id}: no fixture exercises this registration`);
    const failures = runAdapterConformance(reg, cases, { capabilityMatrix: CAPABILITY_MATRIX });
    assert.deepEqual(failures, KNOWN_KIT_FINDINGS[id] ?? [], `${id}: conformance failures`);
  }
});
