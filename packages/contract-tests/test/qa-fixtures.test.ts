// Independent G2 (QA) checks over fixtures/canonical: stronger than INDEX.json (which stores only
// issue CODES). These pin the issue PATH too, so a fixture cannot start failing for a different
// reason with the same code, and they check that fixtures are synthetic.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateEvent, validateEvents } from "@swain/core";

const dir = fileURLToPath(new URL("../../../../fixtures/canonical/", import.meta.url));

function load(rel: string): unknown {
  return JSON.parse(readFileSync(`${dir}${rel}`, "utf8"));
}
function issuesOf(v: unknown): { path: string; code: string }[] {
  const r = Array.isArray(v) ? validateEvents(v) : validateEvent(v);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.issues.map((i) => ({ path: i.path, code: i.code }));
}

// [file, path, code] - typed from ADR-0002 section 1a/3/7 and SPEC-001 section 6 test 8.
const EXPECT: [string, string, string][] = [
  ["attribute-float", "/attributes/codex-cli.f", "not-integer"],
  ["attributes-33", "/attributes", "too-many-keys"],
  ["bound-adapterId-65", "/provenance/adapter/id", "too-long"],
  ["bound-adapterVersion-33", "/provenance/adapter/version", "too-long"],
  ["bound-attributeKey-97", "", "too-long"],
  ["bound-attributeString-257", "/attributes/codex-cli.s", "too-long"],
  ["bound-bounded256-257", "/payload/toolName", "too-long"],
  ["bound-bounded512-513", "/payload/detail", "too-long"],
  ["bound-bounded512-multibyte-514", "/payload/detail", "too-long"],
  ["bound-filePath-4097", "/payload/path", "too-long"],
  ["bound-id-37", "/eventId", "wrong-length"],
  ["bound-inline-1048577", "/payload/input/inline", "too-long"],
  ["bound-pointer-513", "/provenance/pointer", "too-long"],
  ["bound-providerVersion-65", "/providerVersion", "too-long"],
  ["bound-rule-65", "/provenance/rule", "too-long"],
  ["bound-schemaVersion-17", "/schemaVersion", "too-long"],
  ["bound-sha256-65", "/provenance/sha256", "wrong-length"],
  ["bound-sourceKind-65", "/sourceKind", "too-long"],
  ["bound-tcId-36", "/payload/toolCallId", "wrong-length"],
  ["bound-timeValue-25", "/time/value", "wrong-length"],
  ["float-token-count", "/payload/inputTokens", "not-integer"],
  ["hash-only-with-inline", "/payload/input/inline", "inline-with-hash-only"],
  ["hash-uppercase", "/provenance/sha256", "bad-pattern"],
  ["id-bad-format", "/eventId", "bad-pattern"],
  ["id-wrong-prefix", "/sessionId", "bad-pattern"],
  ["links-17", "/links", "too-many-items"],
  ["lone-surrogate", "/payload/toolName", "ill-formed-string"],
  ["missing-required-facet", "/completeness/inputs", "missing-facet"],
  ["payload-missing-toolname", "/payload/toolName", "missing-key"],
  ["payload-unknown-key", "/payload/surprise", "unknown-key"],
  ["proto-key", "/__proto__", "unknown-key"],
  ["schema-version-0.2.0", "/schemaVersion", "unsupported-schema-version"],
  ["schema-version-1.0.0", "/schemaVersion", "unsupported-schema-version"],
  ["sequence-negative", "/sourceSequence", "out-of-range"],
  ["sequence-string", "/sourceSequence", "wrong-type"],
  ["set-dangling-link", "/1/links/0/target", "dangling-link"],
  ["set-derived-missing-basis", "/2/provenance/basisEventIds/0", "dangling-basis"],
  ["set-duplicate-event-id", "/1/eventId", "duplicate-event-id"],
  ["set-out-of-order-sequence", "/1/sourceSequence", "out-of-order"],
  ["status-success-on-request", "/status", "status-not-allowed"],
  ["subindex-1024", "/subIndex", "out-of-range"],
  ["time-origin-receipt", "/time/origin", "bad-enum"],
  ["time-valid-null-value", "/time", "bad-time"],
  ["time-value-out-of-calendar", "/time", "bad-time"],
  ["unknown-key", "/extra", "unknown-key"],
  ["unknown-kind", "/kind", "bad-enum"],
  // QA-authored fixtures
  ["qa-adapter-version-two-parts", "/provenance/adapter/version", "bad-pattern"],
  ["qa-attribute-key-no-namespace", "/attributes/nodot", "bad-pattern"],
  ["qa-attribute-unsafe-int", "/attributes/codex-cli.big", "not-integer"],
  ["qa-derived-empty-basis", "/provenance/basisEventIds", "too-few-items"],
  ["qa-filepath-nul", "/payload/path", "forbidden-char"],
  ["qa-missing-turnid-key", "/turnId", "missing-key"],
  ["qa-pointer-bad-tilde-escape", "/provenance/pointer", "bad-pattern"],
  ["qa-pointer-no-leading-slash", "/provenance/pointer", "bad-pattern"],
  ["qa-provenance-type-unknown", "/provenance/type", "bad-enum"],
  ["qa-provider-unknown", "/provider", "bad-enum"],
  ["qa-providerversion-space", "/providerVersion", "bad-pattern"],
  ["qa-result-of-without-causality", "/completeness/causality", "missing-facet"],
  ["qa-sequence-unsafe-integer", "/sourceSequence", "not-integer"],
  ["qa-set-interleaved-sources", "/2/sourceSequence", "out-of-order"],
  ["qa-source-unknown-unsorted", "/payload/topLevelKeys", "not-sorted"],
  ["qa-sourcekind-uppercase", "/sourceKind", "bad-pattern"],
  ["qa-status-failure-on-completed", "/status", "status-not-allowed"],
  ["qa-status-success-on-failed", "/status", "status-not-allowed"],
  ["qa-tcid-uppercase-hex", "/payload/toolCallId", "bad-pattern"],
  ["qa-time-hour-24", "/time", "bad-time"],
  ["qa-time-lowercase-z", "/time/value", "bad-pattern"],
  ["qa-time-missing-with-value", "/time", "bad-time"],
  ["qa-time-valid-origin-none", "/time", "bad-time"],
  ["qa-time-year-3000", "/time", "bad-time"],
  ["qa-toolnamespace-case", "/payload/toolNamespace", "bad-enum"],
  ["qa-usage-negative-cost", "/payload/costUsdEstimate", "out-of-range"],
  ["qa-usage-negative-tokens", "/payload/outputTokens", "out-of-range"],
];

test("every invalid fixture fails with exactly one issue at the spec-mandated path and code", () => {
  const files = readdirSync(`${dir}invalid`)
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .sort();
  assert.deepEqual(
    EXPECT.map(([n]) => n).sort(),
    files,
    "EXPECT table must list every invalid fixture",
  );
  for (const [name, path, code] of EXPECT) {
    const got = issuesOf(load(`invalid/${name}.json`));
    if (name === "bound-attributeKey-97") {
      assert.equal(got.length, 1, name);
      assert.ok(got[0]?.path.startsWith("/attributes/a.a"), name);
      assert.equal(got[0]?.code, code, name);
      continue;
    }
    assert.deepEqual(got, [{ path, code }], name);
  }
});

test("every valid fixture round-trips unchanged (deepEqual, same envelope key order)", () => {
  for (const n of readdirSync(`${dir}valid`).filter((x) => x.endsWith(".json"))) {
    const v = load(`valid/${n}`);
    const r = Array.isArray(v) ? validateEvents(v) : validateEvent(v);
    assert.equal(r.ok, true, n);
    if (r.ok) {
      const out: unknown[] = "events" in r ? r.events : [r.event];
      const inn: unknown[] = Array.isArray(v) ? v : [v];
      assert.deepEqual(out, inn, n);
      // envelope field order equals the input (the fixtures are written in ADR order)
      out.forEach((o, i) => {
        assert.deepEqual(Object.keys(o as object), Object.keys(inn[i] as object), n);
      });
    }
  }
});

test("there is a valid fixture for each of the 16 kinds", () => {
  const kinds = new Set<string>();
  for (const n of readdirSync(`${dir}valid`).filter((x) => x.endsWith(".json"))) {
    const v = load(`valid/${n}`);
    for (const e of Array.isArray(v) ? v : [v]) kinds.add((e as { kind: string }).kind);
  }
  assert.equal(kinds.size, 16);
});

test("fixtures are synthetic: no home paths, tokens, e-mail addresses or URLs with credentials", () => {
  const bad = [
    /\/home\/[a-z]/i,
    /\/Users\/[A-Za-z]/,
    /C:\\Users/i,
    /\bsk-[A-Za-z0-9]{16,}/,
    /\bAKIA[0-9A-Z]{12,}/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i,
    /https?:\/\/[^\s"]*:[^\s"@]*@/,
    /BEGIN [A-Z ]*PRIVATE KEY/,
  ];
  for (const sub of ["valid", "invalid"]) {
    for (const n of readdirSync(`${dir}${sub}`)) {
      const text = readFileSync(`${dir}${sub}/${n}`, "utf8");
      // The 1 MiB inline fixture is a single repeated character; skip regex scans on huge files.
      if (text.length > 100_000) continue;
      for (const re of bad) assert.equal(re.test(text), false, `${sub}/${n}: ${re}`);
    }
  }
});

test("fixture JSON files are plain UTF-8 with LF endings and no BOM (fixtures are evidence)", () => {
  for (const sub of ["valid", "invalid"]) {
    for (const n of readdirSync(`${dir}${sub}`)) {
      const b = readFileSync(`${dir}${sub}/${n}`);
      assert.notEqual(b[0], 0xef, `${sub}/${n}: BOM`);
      assert.equal(b.includes(0x0d), false, `${sub}/${n}: CR`);
    }
  }
});
