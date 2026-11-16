import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AdapterRegistration,
  AdapterWarning,
  DraftEvent,
  ProviderCapabilities,
} from "../../src/adapter/contract.js";
import { DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { type ConformanceCase, runAdapterConformance } from "../../src/conformance/index.js";
import { canonicalJson } from "../../src/content/index.js";
import { runImport } from "../../src/pipeline/run.js";
import { docRegistration, refRegistration, sourceFrom } from "../pipeline/ref-adapter.js";

const enc = new TextEncoder();
const CLEAN = [
  '{"t":"session","id":"S-C","ts":"2026-01-01T00:00:00Z","v":"9.9.9"}',
  '{"t":"turn.start","turn":"T1","ts":"2026-01-01T00:00:01Z","text":"hello"}',
  '{"t":"tool.call","call":"C1","name":"Read","ts":"2026-01-01T00:00:02Z"}',
  '{"t":"tool.result","call":"C1","ok":true,"ts":"2026-01-01T00:00:03Z"}',
  '{"t":"turn.end","turn":"T1","ts":"2026-01-01T00:00:04Z"}',
  "",
].join("\n");
const clean = (extra = ""): ConformanceCase => ({
  name: "clean",
  bytes: enc.encode(CLEAN + extra),
});
const checks = (reg: AdapterRegistration, cases: ConformanceCase[]): string[] =>
  runAdapterConformance(reg, cases).map((f) => `${f.case ?? "-"}:${f.check}`);

function golden(reg: AdapterRegistration, bytes: Uint8Array): string {
  const src = sourceFrom(bytes, "clean");
  return canonicalJson(
    runImport(
      src,
      reg,
      { verdict: "match", providerVersionSeen: "9.9.9", nativeSessionId: "S-C", reasons: [] },
      { bounds: DEFAULT_BOUNDS, contentPolicy: { retention: "hash-only", maxInlineBytes: 65_536 } },
    ),
  );
}

function wrap(
  reg: AdapterRegistration,
  mutate: (out: { drafts: readonly DraftEvent[]; warnings: readonly AdapterWarning[] }) => {
    drafts: readonly DraftEvent[];
    warnings: readonly AdapterWarning[];
  },
  manifest: Partial<AdapterRegistration["adapter"]["manifest"]> = {},
): AdapterRegistration {
  return {
    ...reg,
    adapter: {
      ...reg.adapter,
      manifest: { ...reg.adapter.manifest, ...manifest },
      createParser: (ctx) => {
        const inner = reg.adapter.createParser(ctx);
        return {
          push: (r) => mutate(inner.push(r)),
          end: () => inner.end(),
        };
      },
    },
  };
}

test("a conforming registration passes, with and without a golden", () => {
  const reg = refRegistration();
  assert.deepEqual(runAdapterConformance(reg, [clean()]), []);
  const bytes = enc.encode(CLEAN);
  assert.deepEqual(runAdapterConformance(reg, [{ ...clean(), expected: golden(reg, bytes) }]), []);
});

test("document framing registrations conform too", () => {
  const bytes = new Uint8Array(
    enc.encode('{"id":"D","messages":[{"role":"user","text":"hi"},{"role":"user","text":"yo"}]}\n'),
  );
  assert.deepEqual(runAdapterConformance(docRegistration(), [{ name: "doc", bytes }]), []);
});

test("golden mismatch is reported without echoing content", () => {
  const out = runAdapterConformance(refRegistration(), [{ ...clean(), expected: "{}" }]);
  assert.deepEqual(
    out.map((f) => f.check),
    ["golden-mismatch"],
  );
  assert.equal(out[0]?.case, "clean");
});

test("detect that does not match the case is a failure", () => {
  assert.deepEqual(checks(refRegistration(), [{ name: "bad", bytes: enc.encode('{"x":1}\n') }]), [
    "bad:detect-not-match",
  ]);
});

test("an adapter that throws on a record is reported", () => {
  const out = checks(refRegistration(), [clean('{"t":"throw"}\n')]);
  assert.ok(out.includes("clean:adapter-threw"));
});

test("an adapter that emits an invalid draft is reported", () => {
  const out = checks(refRegistration(), [clean('{"t":"extra-field"}\n')]);
  assert.ok(out.includes("clean:adapter-output-invalid"));
});

test("an adapter that skips a record without a disposition or unknown is reported", () => {
  const out = checks(refRegistration(), [clean('{"t":"mystery"}\n')]);
  assert.ok(out.includes("clean:record-unaccounted"));
});

test("an attribute outside the allowlist is reported", () => {
  const out = checks(refRegistration(), [clean('{"t":"attr","key":"opencode.leak"}\n')]);
  assert.ok(out.includes("clean:attribute-not-allowed"));
});

test("non-idempotent adapters are reported", () => {
  let n = 0;
  const reg = refRegistration({ attributeKeys: ["opencode.cwd"] });
  const flaky: AdapterRegistration = {
    ...reg,
    adapter: {
      ...reg.adapter,
      createParser: (ctx) => {
        const inner = reg.adapter.createParser(ctx);
        const run = n++;
        return {
          push: (r) => {
            const out = inner.push(r);
            return {
              ...out,
              drafts: out.drafts.map((d) => ({ ...d, attributes: { "opencode.cwd": run } })),
            };
          },
          end: () => inner.end(),
        };
      },
    },
  };
  assert.ok(checks(flaky, [clean()]).includes("clean:not-idempotent"));
});

test("warning detail that repeats source text is reported (PA-3)", () => {
  const leaky = wrap(refRegistration(), (out) => ({
    ...out,
    warnings: [
      ...out.warnings,
      { code: "unmapped-field", severity: "info", sourceSequence: 0, detail: { field: "S-C" } },
      {
        code: "unmapped-field",
        severity: "info",
        sourceSequence: 0,
        detail: { field: "hello" },
      },
      {
        code: "unmapped-field",
        severity: "info",
        sourceSequence: 0,
        detail: { field: "turn.start" },
      },
    ],
  }));
  // "turn.start" (10 chars) occurs in the fixture text; shorter values are not checked.
  assert.ok(checks(leaky, [clean()]).includes("clean:detail-leak"));
  const fine = wrap(refRegistration(), (out) => ({
    ...out,
    warnings: [
      ...out.warnings,
      {
        code: "unmapped-field",
        severity: "info",
        sourceSequence: 0,
        detail: { field: "zzqx-static" },
      },
    ],
  }));
  assert.deepEqual(runAdapterConformance(fine, [clean()]), []);
});

test("manifest and discovery problems are reported at registration level", () => {
  const base = refRegistration();
  const caps: ProviderCapabilities = {
    ...base.adapter.manifest.capabilities,
    tokens: "maybe" as never,
  };
  const bad = wrap(base, (o) => o, {
    id: "Bad Id",
    adapterVersion: "1",
    sourceKind: "other.kind",
    attributeKeys: ["nokey", "other.cwd"],
    capabilities: caps,
    framing: { kind: "json-document", recordArrays: [] },
  });
  const badDiscovery: AdapterRegistration = {
    ...bad,
    discovery: { roots: [{ base: "home", segments: ["..", "x"] }], fileNamePattern: "(a)\\1" },
  };
  const out = runAdapterConformance(badDiscovery, []);
  assert.deepEqual(
    out.map((f) => f.check),
    ["manifest-invalid", "discovery-invalid"],
  );
  assert.ok(out[0]?.detail.includes("id"));
  assert.ok(out[0]?.detail.includes("recordArrays-count"));
  assert.ok(out[0]?.detail.includes("attributeKeys"));
  assert.ok(out[0]?.detail.includes("capabilities"));
  assert.ok(out.every((f) => f.case === null));
});

test("M12: capability declarations are checked per surface against the matrix", () => {
  const base = refRegistration();
  const matrix = {
    providers: {
      opencode: {
        cells: {
          toolCallInputs: { value: "partial", surfaces: ["opencode.reference-log"] },
          toolCallOutputs: { value: "available", surfaces: ["opencode.other"] },
          tokens: { value: "partial", surfaces: ["opencode.reference-log"] },
        },
      },
    },
  };
  const declare = (caps: Partial<ProviderCapabilities>): AdapterRegistration =>
    wrap(base, (o) => o, { capabilities: { ...base.adapter.manifest.capabilities, ...caps } });
  const run = (r: AdapterRegistration): readonly string[] =>
    runAdapterConformance(r, [], { capabilityMatrix: matrix }).map((f) => `${f.check}:${f.detail}`);
  assert.deepEqual(run(declare({})), []);
  assert.deepEqual(run(declare({ toolCallInputs: "partial", tokens: "partial" })), []);
  // Above the cell value.
  assert.deepEqual(run(declare({ toolCallInputs: "available" })), [
    "capability-exceeds-matrix:capability rows: toolCallInputs",
  ]);
  // Value would allow it, but the surface is not listed.
  assert.deepEqual(run(declare({ toolCallOutputs: "partial" })), [
    "capability-exceeds-matrix:capability rows: toolCallOutputs",
  ]);
  // No cell at all.
  assert.deepEqual(run(declare({ permissions: "partial" })), [
    "capability-exceeds-matrix:capability rows: permissions",
  ]);
  // Declaring unsupported is always allowed.
  assert.deepEqual(run(declare({ permissions: "unsupported" })), []);
  // Without a matrix the check is skipped.
  assert.deepEqual(runAdapterConformance(declare({ permissions: "partial" }), []), []);
});
