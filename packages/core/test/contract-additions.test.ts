import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AdapterManifest,
  AdapterOutput,
  AdapterRegistration,
  DiscoveryRoot,
  DraftEvent,
  Framing,
  RecordDisposition,
  RecordRef,
} from "../src/index.js";
import { ABSOLUTE_MAX_FILE_BYTES, DEFAULT_BOUNDS, WARNING_CODES } from "../src/index.js";

test("SPEC-002 bounds defaults are set, ordered sensibly and frozen", () => {
  assert.equal(DEFAULT_BOUNDS.maxDocumentBytes, 67_108_864);
  assert.equal(DEFAULT_BOUNDS.maxEvents, 1_000_000);
  assert.equal(DEFAULT_BOUNDS.maxTotalInlineBytes, 67_108_864);
  assert.equal(DEFAULT_BOUNDS.maxOutputBytes, 268_435_456);
  assert.equal(ABSOLUTE_MAX_FILE_BYTES, 1_073_741_824);
  assert.ok(DEFAULT_BOUNDS.maxFileBytes <= ABSOLUTE_MAX_FILE_BYTES);
  assert.ok(DEFAULT_BOUNDS.maxDocumentBytes <= DEFAULT_BOUNDS.maxFileBytes);
  assert.ok(Object.isFrozen(DEFAULT_BOUNDS));
  for (const v of Object.values(DEFAULT_BOUNDS)) assert.ok(Number.isSafeInteger(v) && v > 0);
});

test("SPEC-002 warning codes are appended without reordering", () => {
  assert.deepEqual(WARNING_CODES.slice(-4), [
    "duplicate-json-key",
    "record-array-missing",
    "folded-records",
    "attribute-not-allowed",
  ]);
});

test("contract types compile as specified (type-level usage)", () => {
  const framing: Framing = { kind: "json-document", recordArrays: ["/messages"] };
  const ref: RecordRef = { order: 1, evidence: 2 };
  const disp: RecordDisposition = { sourceSequence: 3, kind: "rewound", into: null };
  const root: DiscoveryRoot = { base: "xdg-data", segments: ["opencode"] };
  const out: AdapterOutput = { drafts: [], warnings: [], dispositions: [disp] };
  const reg: Pick<AdapterRegistration, "discovery"> = {
    discovery: { roots: [root], fileNamePattern: "^x\\.json$" },
  };
  const manifestExtras: Pick<AdapterManifest, "framing" | "experimental" | "attributeKeys"> = {
    framing,
    experimental: true,
    attributeKeys: ["claude-code.cwd"],
  };
  const draftExtras: Pick<DraftEvent, "recordRef" | "correlation"> = {
    recordRef: ref,
    correlation: { anchor: "a", refs: [{ rel: "result-of", key: "k" }] },
  };
  assert.equal(out.dispositions?.length, 1);
  assert.equal(reg.discovery.roots.length, 1);
  assert.equal(manifestExtras.experimental, true);
  assert.equal(draftExtras.recordRef?.order, 1);
});

test("G3-2: maxJsonValues default", () => {
  assert.equal(DEFAULT_BOUNDS.maxJsonValues, 8_000_000);
});
