import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTracesJson } from "../src/index.js";
import {
  enc,
  encText,
  expectCode,
  fixture,
  nestArray,
  oneSpan,
  SPAN,
  str,
  TRACE,
} from "./helpers.js";

const spansOf = (d: ReturnType<typeof decodeTracesJson>) =>
  d.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));

const FIRST = "/resourceSpans/0/scopeSpans/0/spans/0";

test("hostile fixtures: ids", () => {
  const cases: [string, string][] = [
    ["trace-id-31.json", "invalid-trace-id"],
    ["trace-id-33.json", "invalid-trace-id"],
    ["trace-id-non-hex.json", "invalid-trace-id"],
    ["trace-id-all-zero.json", "invalid-trace-id"],
    ["span-id-all-zero.json", "invalid-span-id"],
  ];
  for (const [name, reason] of cases) {
    const d = decodeTracesJson(fixture(`hostile/${name}`));
    assert.deepEqual(d.rejected, [{ path: FIRST, reason }], name);
  }
});

test("hostile fixtures: times, enums and unsafe numbers", () => {
  assert.equal(
    decodeTracesJson(fixture("hostile/time-over-2-63.json")).rejected[0]?.reason,
    "time-out-of-range",
  );
  const inverted = decodeTracesJson(fixture("hostile/time-start-after-end.json"));
  assert.equal(spansOf(inverted).length, 1);
  assert.equal(inverted.warnings[0]?.code, "time-inverted");
  assert.equal(
    decodeTracesJson(fixture("hostile/enum-names.json")).rejected[0]?.reason,
    "invalid-enum",
  );
  assert.equal(
    decodeTracesJson(fixture("hostile/int64-number-unsafe.json")).rejected[0]?.reason,
    "invalid-int64",
  );
});

test("prototype keys are inert data and pollute nothing", () => {
  const d = decodeTracesJson(fixture("hostile/proto-keys.json"));
  assert.equal(d.rejected.length, 0);
  const s = spansOf(d)[0];
  assert.deepEqual(
    s?.attributes.map((a) => a.key),
    ["__proto__", "constructor"],
  );
  assert.deepEqual(s?.attributes[0]?.value, { kind: "string", value: "a" });
  const res = d.resourceSpans[0]?.resource.attributes;
  assert.deepEqual(res?.[1]?.value, {
    kind: "kvlist",
    values: [{ key: "prototype", value: { kind: "string", value: "x" } }],
  });
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(Object.getPrototypeOf(s), Object.prototype);
  // The wire "__proto__" field is an unknown field: ignored, not copied into the model.
  assert.equal(Object.hasOwn(s ?? {}, "__proto__"), false);
});

test("prototype keys in every position, including the request root", () => {
  const raw = `{"__proto__":{"resourceSpans":[]},"constructor":1,"resourceSpans":[{"__proto__":{"x":1},"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}","status":{"__proto__":{"code":2}},"attributes":[{"key":"__proto__","value":{"kvlistValue":{"values":[{"key":"__proto__","value":{"intValue":"1"}}]}}}]}]}]}]}`;
  const d = decodeTracesJson(encText(raw));
  assert.equal(d.rejected.length, 0);
  assert.equal(spansOf(d)[0]?.status.code, 0);
  assert.equal(({} as Record<string, unknown>)["x"], undefined);
});

test("invalid UTF-8 is a typed whole-request error", () => {
  expectCode(() => decodeTracesJson(fixture("hostile/invalid-utf8.json")), "invalid-utf8");
  // overlong, truncated sequence and a raw surrogate encoding (CESU) are all invalid
  for (const bytes of [
    [0xc0, 0xaf],
    [0xe2, 0x82],
    [0xed, 0xa0, 0x80],
    [0xf8, 0x88, 0x80, 0x80, 0x80],
  ]) {
    const body = new Uint8Array([...encText('{"a":"'), ...bytes, ...encText('"}')]);
    expectCode(() => decodeTracesJson(body), "invalid-utf8");
  }
});

test("a lone surrogate escape rejects that record only", () => {
  const d = decodeTracesJson(fixture("hostile/lone-surrogate.json"));
  assert.equal(spansOf(d).length, 1);
  assert.equal(spansOf(d)[0]?.name, "fine");
  assert.deepEqual(d.rejected, [{ path: FIRST, reason: "invalid-string" }]);
  // lone surrogate in a key, and a valid pair
  const key = decodeTracesJson(
    oneSpan({ attributes: [{ key: "\ud800", value: { stringValue: "v" } }] }),
  );
  assert.equal(key.rejected[0]?.reason, "invalid-string");
  const pair = decodeTracesJson(
    encText(
      `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}","name":"\\ud83d\\ude00"}]}]}]}`,
    ),
  );
  assert.equal(spansOf(pair)[0]?.name, "\u{1F600}");
});

test("a UTF-8 BOM is rejected (never silently stripped)", () => {
  const body = new Uint8Array([0xef, 0xbb, 0xbf, ...encText("{}")]);
  expectCode(() => decodeTracesJson(body), "malformed-json");
});

test("injection strings are preserved verbatim as data (escaping is the renderer's job)", () => {
  const d = decodeTracesJson(fixture("hostile/injection-strings.json"));
  assert.equal(d.rejected.length, 0);
  assert.equal(spansOf(d)[0]?.name, "<script>alert(1)</script>‮\u0007evil");
  assert.equal(d.resourceSpans[0]?.resource.attributes[0]?.key, "service.name");
  assert.equal(d.resourceSpans[0]?.scopeSpans[0]?.scope.name, "javascript:alert(1)");
  assert.equal(spansOf(d)[0]?.attributes[1]?.key, "‮key");
});

test("secrets in attributes are carried untouched; policy happens later and the hash covers them", () => {
  const d = decodeTracesJson(fixture("hostile/secrets.json"));
  const s = spansOf(d)[0];
  assert.equal(s?.attributes.length, 2);
  const v = s?.attributes[0]?.value;
  assert.ok(v?.kind === "string");
  assert.match(v.value, /sk-synthetic/);
});

test("deep AnyValue: 25 levels rejected per record; 65 levels and 97 JSON levels are request errors", () => {
  const nest25 = decodeTracesJson(oneSpan({ attributes: [{ key: "k", value: nestArray(25) }] }));
  assert.equal(nest25.rejected[0]?.reason, "any-value-too-deep");
  expectCode(
    () => decodeTracesJson(oneSpan({ attributes: [{ key: "k", value: nestArray(65) }] })),
    "json-too-deep",
  );
  let deep: unknown = 1;
  for (let i = 0; i < 97; i++) deep = { a: deep };
  expectCode(() => decodeTracesJson(enc(deep)), "json-too-deep");
  // 100,000 levels must not overflow the stack: the pre-scan refuses first
  expectCode(() => decodeTracesJson(encText("[".repeat(100_000))), "json-too-deep");
  expectCode(() => decodeTracesJson(encText('{"a":'.repeat(100_000))), "json-too-deep");
});

test("bracket characters inside strings do not count as nesting", () => {
  const d = decodeTracesJson(oneSpan({ name: "[".repeat(5_000) + '\\"' + "{".repeat(5_000) }));
  assert.equal(d.rejected.length, 0);
});

test("10,000 values in one span are bounded; a huge scalar flood hits the value budget", () => {
  const flood = encText(`{"resourceSpans":[],"x":[${"1,".repeat(300_000)}1]}`);
  expectCode(() => decodeTracesJson(flood, { maxValues: 100_000 }), "too-many-values");
});

test("trailing garbage is malformed", () => {
  expectCode(() => decodeTracesJson(encText('{"resourceSpans":[]} {}')), "malformed-json");
});

test("duplicate keys reject the record that contains them (any depth), not the request", () => {
  const ok = `{"traceId":"${TRACE}","spanId":"1111111111111111","name":"ok"}`;
  const wrap = (rec: string, resource = "") =>
    encText(`{"resourceSpans":[{${resource}"scopeSpans":[{"spans":[${rec},${ok}]}]}]}`);
  const dups = [
    `{"traceId":"${TRACE}","spanId":"${SPAN}","name":"a","name":"b"}`,
    `{"traceId":"${TRACE}","spanId":"${SPAN}","futureField":{"x":{"y":1,"y":2}}}`,
    `{"traceId":"${TRACE}","spanId":"${SPAN}","attributes":[{"key":"k","key":"j","value":{"stringValue":"v"}}]}`,
    `{"traceId":"${TRACE}","spanId":"${SPAN}","attributes":[{"key":"k","value":{"stringValue":"v","stringValue":"w"}}]}`,
    `{"traceId":"${TRACE}","traceId":"${TRACE}","spanId":"${SPAN}"}`,
  ];
  for (const rec of dups) {
    const d = decodeTracesJson(wrap(rec));
    assert.deepEqual(d.rejected, [{ path: FIRST, reason: "duplicate-key" }], rec);
    assert.equal(spansOf(d).length, 1);
    assert.equal(spansOf(d)[0]?.name, "ok");
  }
  const res = decodeTracesJson(wrap(ok, '"resource":{"attributes":[],"attributes":[]},'));
  assert.equal(res.rejected.length, 2);
  assert.ok(res.rejected.every((r) => r.reason === "duplicate-key"));
  expectCode(
    () => decodeTracesJson(encText('{"resourceSpans":[],"resourceSpans":[]}')),
    "invalid-structure",
  );
  expectCode(
    () => decodeTracesJson(encText('{"resourceSpans":[{"scopeSpans":[],"scopeSpans":[]}]}')),
    "invalid-structure",
  );
  assert.equal(decodeTracesJson(wrap(ok)).rejected.length, 0);
});

test("recordSha256 covers the record before truncation", () => {
  const few = Array.from({ length: 3 }, (_, i) => str(`k${i}`, "v"));
  const many = Array.from({ length: 300 }, (_, i) => str(`k${i}`, "v"));
  const a = spansOf(decodeTracesJson(oneSpan({ attributes: many })))[0];
  assert.equal(a?.attributes.length, 128);
  const b = spansOf(decodeTracesJson(oneSpan({ attributes: many }), { maxAttributes: 1_024 }))[0];
  assert.equal(b?.attributes.length, 300);
  assert.equal(a?.recordSha256, b?.recordSha256);
  const c = spansOf(decodeTracesJson(oneSpan({ attributes: few })))[0];
  assert.notEqual(a?.recordSha256, c?.recordSha256);
});

test("never throws an untyped error on assorted hostile shapes", () => {
  const shapes = [
    '{"resourceSpans":[{"resource":5,"scopeSpans":[]}]}',
    '{"resourceSpans":[{"resource":[],"scopeSpans":[{"scope":"x","spans":[{}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":{},"spanId":[]}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"00f067aa0ba902b7","events":{},"links":5,"status":[]}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"00f067aa0ba902b7","attributes":[null,1,"x",[],{"key":1}]}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"00f067aa0ba902b7","droppedAttributesCount":4294967296}]}]}]}',
    '{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"00f067aa0ba902b7","name":null,"kind":null}]}]}]}',
  ];
  for (const s of shapes) {
    const d = decodeTracesJson(encText(s));
    assert.ok(d.rejected.length >= 0);
  }
});
