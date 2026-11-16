import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdapterRegistration, DetectResult } from "../../src/adapter/contract.js";
import { DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { selectAdapter } from "../../src/ingest/select.js";
import {
  docRegistration,
  fixtureBytes,
  refRegistration,
  sourceFrom,
} from "../pipeline/ref-adapter.js";

function withDetect(
  reg: AdapterRegistration,
  id: string,
  sourceKind: string,
  detect: (n: number) => DetectResult,
): AdapterRegistration {
  return {
    ...reg,
    adapter: {
      ...reg.adapter,
      manifest: { ...reg.adapter.manifest, id, sourceKind },
      detect: (sample) => detect(sample.length),
    },
  };
}
const verdict = (v: DetectResult["verdict"]): DetectResult => ({
  verdict: v,
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [],
});

const src = sourceFrom(fixtureBytes("reference/ref-basic.ref.jsonl"));

test("exactly one match is selected", () => {
  const r = selectAdapter(src, [refRegistration(), docRegistration()], {}, DEFAULT_BOUNDS);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.registration.adapter.manifest.framing.kind, "jsonl");
    assert.equal(r.detect.nativeSessionId, "S-0001");
  }
});

test("two matches are ambiguous, never a guess; selection narrows it", () => {
  const base = refRegistration();
  const a = withDetect(base, "opencode.alpha", "opencode.alpha", () => verdict("match"));
  const b = withDetect(base, "opencode.beta", "opencode.beta", () => verdict("match"));
  const r = selectAdapter(src, [a, b], {}, DEFAULT_BOUNDS);
  assert.deepEqual(r, {
    ok: false,
    reason: "ambiguous",
    candidates: ["opencode.alpha", "opencode.beta"],
  });
  const narrowed = selectAdapter(src, [a, b], { sourceKind: "opencode.beta" }, DEFAULT_BOUNDS);
  assert.ok(narrowed.ok);
  const byProvider = selectAdapter(src, [a, b], { provider: "codex-cli" }, DEFAULT_BOUNDS);
  assert.deepEqual(byProvider, { ok: false, reason: "no-match", candidates: [] });
});

test("no match, and unsupported when none matches but one reports unsupported", () => {
  const base = refRegistration();
  const no = withDetect(base, "opencode.no", "opencode.no", () => verdict("no-match"));
  const un = withDetect(base, "opencode.un", "opencode.un", () => verdict("unsupported"));
  assert.deepEqual(selectAdapter(src, [no], {}, DEFAULT_BOUNDS), {
    ok: false,
    reason: "no-match",
    candidates: [],
  });
  assert.deepEqual(selectAdapter(src, [no, un], {}, DEFAULT_BOUNDS), {
    ok: false,
    reason: "unsupported",
    candidates: ["opencode.un"],
  });
});

test("a throwing or malformed detect counts as no-match", () => {
  const base = refRegistration();
  const throws = withDetect(base, "opencode.t", "opencode.t", () => {
    throw new Error("boom");
  });
  const junk = withDetect(base, "opencode.j", "opencode.j", () => ({ verdict: "yes" }) as never);
  const nul = withDetect(base, "opencode.n", "opencode.n", () => null as never);
  assert.equal(selectAdapter(src, [throws, junk, nul], {}, DEFAULT_BOUNDS).ok, false);
  const ok = selectAdapter(src, [throws, refRegistration()], {}, DEFAULT_BOUNDS);
  assert.ok(ok.ok);
});

test("detect sees at most detectSampleRecords records, per framing group", () => {
  const lines = `${Array.from({ length: 200 }, (_, i) => `{"t":"x","i":${i}}`).join("\n")}\n`;
  const seen: number[] = [];
  const base = refRegistration();
  const probe = withDetect(base, "opencode.probe", "opencode.probe", (n) => {
    seen.push(n);
    return verdict("no-match");
  });
  selectAdapter(sourceFrom(lines), [probe], {}, { ...DEFAULT_BOUNDS, detectSampleRecords: 5 });
  assert.deepEqual(seen, [5]);
});

test("a JSON document sample is the envelope plus elements", () => {
  const seen: number[] = [];
  const probe = withDetect(docRegistration(), "opencode.docprobe", "opencode.docprobe", (n) => {
    seen.push(n);
    return verdict("match");
  });
  const r = selectAdapter(
    sourceFrom(fixtureBytes("reference/ref-doc.json")),
    [probe],
    {},
    DEFAULT_BOUNDS,
  );
  assert.ok(r.ok);
  assert.deepEqual(seen, [3]);
});

test("selection is deterministic", () => {
  const regs = [refRegistration(), docRegistration()];
  assert.deepEqual(
    selectAdapter(src, regs, {}, DEFAULT_BOUNDS),
    selectAdapter(src, regs, {}, DEFAULT_BOUNDS),
  );
});
