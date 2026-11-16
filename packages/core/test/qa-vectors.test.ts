// Independent G2 (QA) vector and table checks. Expected values are typed in from ADR-0002 /
// SPEC-001 text and recomputed here with node:crypto, NOT copied from the implementation or
// from its tests.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  ACTOR_ROLES,
  AtmError,
  COMPLETENESS_REASONS,
  COMPLETENESS_STATES,
  canonicalJson,
  deriveId,
  EVENT_KINDS,
  EVENT_STATUSES,
  FACETS,
  GAP_REASONS,
  KIND_ALLOWED_STATUS,
  LINK_RELS,
  makeContentRef,
  normalizeTimestamp,
  PROVIDERS,
  REQUIRED_FACETS_BY_KIND,
  STRING_BOUNDS,
  sha256Hex,
  WARNING_CODES,
} from "../src/index.js";

const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** Reference implementation of ADR-0002 section 6, written from the prose. */
function refId(type: string, comps: readonly (string | number)[]): string {
  const parts: Buffer[] = [Buffer.from(`atm:v0:${type}\n`, "utf8")];
  for (const c of comps) {
    const body = Buffer.from(String(c), "utf8");
    parts.push(Buffer.from(`${body.length}:`, "ascii"), body);
  }
  return `${type}_${sha(Buffer.concat(parts)).slice(0, 32)}`;
}

const FILE_SHA = "cf515a4acc6e41e0f111f01c78b13ba4253f611de9374474864f01e69a90c08f";

test("ADR-0002 section 6 vectors (literals typed from the ADR)", () => {
  assert.equal(
    sha256Hex(new TextEncoder().encode('{"type":"turn.started"}')),
    "7306b54975174c6eb5111d663a47de795d167520e43cf66ee2923218b19fdb75",
  );
  assert.equal(sha256Hex(new TextEncoder().encode('{"type":"turn.started"}\n')), FILE_SHA);
  const src = deriveId("src", ["codex-cli", "codex-cli.exec-jsonl", `sha256:${FILE_SHA}`]);
  assert.equal(src, "src_20810c77e61076b845483cdd6effd831");
  assert.equal(
    deriveId("evt", ["codex-cli", src, "r", 0, 0]),
    "evt_e28e3b07981adc5141264668ec4d699d",
  );
  assert.equal(
    deriveId("evt", ["codex-cli", src, "r", 0, 1]),
    "evt_8bb4f1c2c226b6c4edd0c526e291ea9b",
  );
  assert.equal(
    deriveId("evt", ["codex-cli", src, "r", 1, 0]),
    "evt_edd241c839d58eacf25615e3da6c3ede",
  );
  assert.equal(
    deriveId("ses", ["claude-code", "native", "00000000-0000-4000-8000-000000000000"]),
    "ses_0456910418276e33cd8c5ce46affbe8d",
  );
  assert.equal(
    deriveId("tc", ["claude-code", src, "toolu_é\u{1F600}"]),
    "tc_9df36bfdeb9fd87cd3ea8c32ff21453a",
  );
  assert.equal(deriveId("evt", ["ab", "c"]), "evt_979219cea6e2cbbda23016f9aa5c7ddd");
  assert.equal(deriveId("evt", ["a", "bc"]), "evt_6fb5845637d0f29bf9de939efcc5390a");
});

test("deriveId equals an independent reference over varied inputs", () => {
  const types = ["src", "ses", "trn", "evt", "act", "tc"] as const;
  const comps: (readonly (string | number)[])[] = [
    ["a"],
    ["a", 0],
    ["é", "\u{1F600}", 9007199254740991],
    ["x".repeat(4096)],
    ["€".repeat(1365)], // 4095 bytes
    ["€".repeat(1366)], // 4098 bytes -> must reject, handled below
    ["1:a", "2:bc"],
    Array.from({ length: 70 }, (_, i) => `c${i}`),
  ];
  for (const t of types) {
    for (const c of comps) {
      const bytes = c.reduce<number>((n, x) => n + Buffer.byteLength(String(x)), 0);
      const tooBig = c.some((x) => typeof x === "string" && Buffer.byteLength(x) > 4096);
      if (tooBig) {
        assert.throws(
          () => deriveId(t, c),
          (e: unknown) => e instanceof AtmError,
        );
        continue;
      }
      assert.ok(bytes >= 0);
      assert.equal(deriveId(t, c), refId(t, c));
    }
  }
});

test("deriveId boundary rejections: 70 ok / 71 reject, 4096 ok / 4097 reject, bytes not chars", () => {
  assert.doesNotThrow(() =>
    deriveId(
      "evt",
      Array.from({ length: 70 }, () => "a"),
    ),
  );
  for (const bad of [
    Array.from({ length: 71 }, () => "a"),
    ["a".repeat(4097)],
    ["é".repeat(2049)], // 4098 bytes, 2049 UTF-16 units
    [""],
    ["\ud800"],
    ["\udc00x"],
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [2 ** 53],
    [-0.5],
    [],
  ] as (string | number)[][]) {
    assert.throws(
      () => deriveId("evt", bad),
      (e: unknown) => e instanceof AtmError && e.code === "invalid-id-component",
    );
  }
  // -0 is a safe integer and encodes as "0" (documented; not negative).
  assert.equal(deriveId("evt", [-0]), deriveId("evt", ["0"]));
  assert.throws(
    () => deriveId("bad" as never, ["a"]),
    (e: unknown) => e instanceof AtmError && e.code === "invalid-id-component",
  );
  assert.throws(
    () => deriveId("evt", [null as never]),
    (e: unknown) => e instanceof AtmError && e.code === "invalid-id-component",
  );
  assert.throws(
    () => deriveId("evt", [10n as never]),
    (e: unknown) => e instanceof AtmError && e.code === "invalid-id-component",
  );
});

test("JCS vectors recomputed independently", () => {
  const a = canonicalJson({ b: 1, a: [true, null, "é"], A: { z: 0.5, y: -0 } });
  assert.equal(a, '{"A":{"y":0,"z":0.5},"a":[true,null,"é"],"b":1}');
  assert.equal(sha(a), "9d9dcb48b1f930c438ccef1b8dd7f3e01e97c09bd8a60a6dda7ec51af6918ccb");
  const b = canonicalJson(JSON.parse('{"\\uffff":1,"\\ud83d\\ude00":2}'));
  assert.equal(b, '{"\u{1F600}":2,"￿":1}');
  assert.equal(sha(b), "48c5d098713870a7b88be7fc0ffc0a79e912d20f80ea8a4a5604426f49add103");
  const c = canonicalJson(JSON.parse('{"n":1e21,"m":1E-7,"s":"line\\nbreak"}'));
  assert.equal(c, '{"m":1e-7,"n":1e+21,"s":"line\\nbreak"}');
  assert.equal(sha(c), "a62863009499e8a7dfd95aacc9eedca5ceddbadcf3685a3c905c454e92cbe380");
});

test("JCS extra cases: control chars lowercase-escaped, U+2028 raw, key order by UTF-16 units", () => {
  assert.equal(canonicalJson("\u0000\u001f\u007f "), '"\\u0000\\u001f\u007f "');
  assert.equal(canonicalJson('\b\t\n\f\r"\\/'), '"\\b\\t\\n\\f\\r\\"\\\\/"');
  assert.equal(
    canonicalJson({ b: 1, a: 2, "": 3, B: 4, "10": 5, "9": 6 }),
    '{"":3,"10":5,"9":6,"B":4,"a":2,"b":1}',
  );
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson(1e-7), "1e-7");
  assert.equal(canonicalJson(123456789012345680000), "123456789012345680000");
  assert.equal(canonicalJson(1e21), "1e+21");
  assert.equal(canonicalJson(5e-324), "5e-324");
  assert.equal(canonicalJson([]), "[]");
  assert.equal(canonicalJson({}), "{}");
  // JSON.parse of a "__proto__" own key must serialize as an ordinary key.
  assert.equal(canonicalJson(JSON.parse('{"__proto__":1,"a":2}')), '{"__proto__":1,"a":2}');
});

test("canonicalJson depth boundary: 64 ok, 65 rejected; custom maxDepth honoured", () => {
  const nest = (n: number): unknown => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };
  assert.doesNotThrow(() => canonicalJson(nest(64)));
  assert.throws(
    () => canonicalJson(nest(65)),
    (e: unknown) => e instanceof AtmError && e.code === "json-depth-exceeded",
  );
  assert.doesNotThrow(() => canonicalJson(nest(3), { maxDepth: 3 }));
  assert.throws(
    () => canonicalJson(nest(4), { maxDepth: 3 }),
    (e: unknown) => e instanceof AtmError && e.code === "json-depth-exceeded",
  );
  // 100000-deep input is rejected with the typed error, not a stack overflow.
  assert.throws(
    () => canonicalJson(nest(100_000)),
    (e: unknown) => e instanceof AtmError && e.code === "json-depth-exceeded",
  );
});

test("makeContentRef: exact vectors and boundaries recomputed independently", () => {
  assert.deepEqual(makeContentRef("hello"), {
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    byteLength: 5,
    encoding: "utf8",
    retention: "hash-only",
  });
  const big = "é".repeat(40000);
  const r = makeContentRef(big, { retention: "inline", maxInlineBytes: 65536 });
  assert.equal(r.retention, "inline-truncated");
  assert.equal(r.byteLength, 80000);
  assert.equal(r.sha256, sha(big));
  assert.equal(Buffer.byteLength(r.inline ?? ""), 65536);
  assert.ok((r.inline ?? "").isWellFormed());
  // Truncation must not split a 4-byte code point: 4-byte chars, limit 6 -> keeps one.
  const e = makeContentRef("\u{1F600}\u{1F600}", { retention: "inline", maxInlineBytes: 6 });
  assert.equal(e.retention, "inline-truncated");
  assert.equal(e.inline, "\u{1F600}");
  // Exactly at the limit stays "inline".
  const exact = makeContentRef("abcd", { retention: "inline", maxInlineBytes: 4 });
  assert.equal(exact.retention, "inline");
  assert.equal(exact.inline, "abcd");
  // Non-string: jcs-json, hash covers the JCS text.
  const j = makeContentRef({ b: [1, 2], a: null });
  assert.equal(j.encoding, "jcs-json");
  assert.equal(j.sha256, sha('{"a":null,"b":[1,2]}'));
  assert.equal(j.byteLength, 20);
  // String that looks like JSON is still utf8 over decoded text.
  assert.equal(makeContentRef('"x"').encoding, "utf8");
  assert.equal(makeContentRef('"x"').byteLength, 3);
  // Empty string and number/boolean/null hashes.
  assert.equal(makeContentRef("").sha256, sha(""));
  assert.equal(makeContentRef(null).sha256, sha("null"));
  assert.equal(makeContentRef(-0).sha256, sha("0"));
  assert.equal("inline" in makeContentRef("x"), false);
  for (const bad of [0, 1_048_577, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as never]) {
    assert.throws(
      () => makeContentRef("x", { maxInlineBytes: bad as number }),
      (err: unknown) => err instanceof AtmError && err.code === "invalid-option",
    );
  }
  assert.doesNotThrow(() => makeContentRef("x", { maxInlineBytes: 1 }));
  assert.doesNotThrow(() => makeContentRef("x", { maxInlineBytes: 1_048_576 }));
  assert.throws(
    () => makeContentRef("x", { retention: "inline-truncated" as never }),
    (err: unknown) => err instanceof AtmError && err.code === "invalid-option",
  );
});

test("timestamp vectors (SPEC test 10) plus extra edges", () => {
  const ok = (raw: unknown, value: string): void =>
    assert.deepEqual(normalizeTimestamp(raw), { value, origin: "source", status: "valid" });
  const bad = (raw: unknown): void =>
    assert.deepEqual(
      normalizeTimestamp(raw),
      { value: null, origin: "source", status: "invalid" },
      String(raw).slice(0, 40),
    );
  ok("2026-11-15T12:00:00Z", "2026-11-15T12:00:00.000Z");
  ok("2026-11-15T13:30:00.123456+01:30", "2026-11-15T12:00:00.123Z");
  ok("2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z");
  ok("2999-12-31T23:59:59.999Z", "2999-12-31T23:59:59.999Z");
  ok("1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000Z");
  ok("1970-01-01T01:30:00+01:00", "1970-01-01T00:30:00.000Z");
  // extra valid edges
  ok("2026-11-15t12:00:00z", "2026-11-15T12:00:00.000Z");
  ok("2000-02-29T00:00:00Z", "2000-02-29T00:00:00.000Z");
  ok("2026-11-15T12:00:00.9Z", "2026-11-15T12:00:00.900Z");
  ok("2026-11-15T12:00:00.123456789Z", "2026-11-15T12:00:00.123Z");
  ok("2026-11-15T12:00:00-23:59", "2026-11-16T11:59:00.000Z");
  ok("2999-12-31T23:59:59.999999999Z", "2999-12-31T23:59:59.999Z");
  ok("2999-12-31T23:59:59-00:00", "2999-12-31T23:59:59.000Z");
  // spec-listed invalid
  for (const raw of [
    "2026-11-15T12:00:00",
    "2026-02-29T00:00:00Z",
    "1969-12-31T23:59:59Z",
    "3000-01-01T00:00:00Z",
    "2026-11-15T23:59:60Z",
    "0099-01-01T00:00:00Z",
    "1970-01-01T00:30:00+01:00",
    "2999-12-31T23:59:59-01:00",
    "2026-11-15T12:00:00+24:00",
    "2026-11-15T12:00:00.1234567891Z",
    "２０２６-11-15T12:00:00Z",
    "x".repeat(1_000_000),
    1731672000000,
    "garbage",
    {},
  ]) {
    bad(raw);
  }
  // extra invalid edges
  for (const raw of [
    "",
    " 2026-11-15T12:00:00Z",
    "2026-11-15T12:00:00Z ",
    "2026-11-15T12:00:00Z\n",
    "2026-11-15 12:00:00Z",
    "2026-11-15T12:00Z",
    "2026-11-15T12:00:00.Z",
    "2026-11-15T12:00:00+0100",
    "2026-11-15T12:00:00+01:60",
    "2026-13-01T00:00:00Z",
    "2026-00-10T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "1900-02-29T00:00:00Z",
    "2100-02-29T00:00:00Z",
    "2026-11-15T24:00:00Z",
    "2026-11-15T12:60:00Z",
    "2026-11-15T12:00:00\u0000Z",
    "2026-11-15T12:00:00Zé",
    "+2026-11-15T12:00:00Z",
    "2026-11-15T12:00:00ZZ",
    "2026-11-15T12:00:00KZ",
    true,
    false,
    Number.NaN,
    0,
    [],
    ["2026-11-15T12:00:00Z"],
    new String("2026-11-15T12:00:00Z"),
    Symbol("x"),
    10n,
    () => "2026-11-15T12:00:00Z",
  ]) {
    bad(raw);
  }
  assert.deepEqual(normalizeTimestamp(null), { value: null, origin: "none", status: "missing" });
  assert.deepEqual(normalizeTimestamp(undefined), {
    value: null,
    origin: "none",
    status: "missing",
  });
  // exactly 64 chars passes the length precheck and then fails the regex; 65 fails the precheck
  bad(`2026-11-15T12:00:00.${"1".repeat(43)}Z`);
});

test("enums and tables equal the ADR-0002 text (typed from the ADR)", () => {
  assert.deepEqual([...PROVIDERS], ["claude-code", "codex-cli", "gemini-cli", "opencode"]);
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
  assert.equal(WARNING_CODES.length, 24);
  assert.equal(new Set(WARNING_CODES).size, 24);

  // ADR section 3 status table, expanded kind by kind.
  const expectedStatus: Record<string, string[]> = {
    "tool.completed": ["success", "unknown"],
    "tool.failed": ["failure", "denied", "interrupted", "unknown"],
    "turn.ended": ["success", "failure", "interrupted", "unknown"],
    "agent.ended": ["success", "failure", "interrupted", "unknown"],
    "session.ended": ["success", "failure", "interrupted", "unknown"],
    "file.changed": ["success", "failure", "unknown"],
  };
  for (const k of EVENT_KINDS) {
    assert.deepEqual([...KIND_ALLOWED_STATUS[k]], expectedStatus[k] ?? ["none"], k);
  }
  assert.deepEqual(Object.keys(KIND_ALLOWED_STATUS), [...EVENT_KINDS]);

  // ADR section 3 required facets (before the causality rule for links).
  const expectedFacets: Record<string, string[]> = {
    "message.observed": ["content", "internalReasoning"],
    "tool.requested": ["inputs", "outputs"],
    "tool.completed": ["inputs", "outputs"],
    "tool.failed": ["inputs", "outputs"],
    "model.usage": ["model", "tokens"],
  };
  for (const k of EVENT_KINDS) {
    const got = new Set<string>(REQUIRED_FACETS_BY_KIND[k]);
    const want = new Set<string>(["timestamp", "actor", ...(expectedFacets[k] ?? [])]);
    assert.deepEqual([...got].sort(), [...want].sort(), k);
  }
});

test("STRING_BOUNDS rows equal ADR-0002 section 1a (typed from the ADR)", () => {
  const rows: Record<string, [number, boolean]> = {
    schemaVersion: [16, false],
    evtId: [36, true],
    sesId: [36, true],
    trnId: [36, true],
    actId: [36, true],
    srcId: [36, true],
    tcId: [35, true],
    sha256: [64, true],
    providerVersion: [64, false],
    sourceKind: [64, false],
    surfaceId: [64, false],
    adapterId: [64, false],
    adapterVersion: [32, false],
    rule: [64, false],
    pointer: [512, false],
    timeValue: [24, true],
    attributeKey: [96, false],
    attributeString: [256, false],
    bounded256: [256, false],
    bounded512: [512, false],
    filePath: [4096, false],
    inlineContent: [1_048_576, false],
    displayName: [255, false],
    warningDetailKey: [32, false],
    warningDetailString: [256, false],
    issuePath: [512, false],
  };
  assert.deepEqual(Object.keys(STRING_BOUNDS).sort(), Object.keys(rows).sort());
  for (const [name, [bytes, exact]] of Object.entries(rows)) {
    const b = STRING_BOUNDS[name as keyof typeof STRING_BOUNDS];
    assert.equal(b.bytes, bytes, name);
    assert.equal(b.exact, exact, name);
  }
  const pat = (n: keyof typeof STRING_BOUNDS): string | null => STRING_BOUNDS[n].pattern;
  assert.equal(pat("providerVersion"), "^[!-~]{1,64}$");
  assert.equal(pat("attributeKey"), "^[a-z0-9-]+\\.[A-Za-z0-9_.-]{1,64}$");
  assert.equal(pat("warningDetailKey"), "^[a-zA-Z][a-zA-Z0-9]{0,31}$");
  assert.equal(
    pat("adapterVersion"),
    "^[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,16})?$",
  );
  assert.equal(
    pat("timeValue"),
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
  );
});
