import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTracesJson, partialSuccessOf } from "../src/index.js";
import {
  enc,
  expectCode,
  fixture,
  nestArray,
  nestKv,
  oneSpan,
  SPAN,
  spanReq,
  str,
  TRACE,
} from "./helpers.js";

const spansOf = (d: ReturnType<typeof decodeTracesJson>) =>
  d.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));

test("valid GenAI fixture: invoke_agent > chat + execute_tool", () => {
  const d = decodeTracesJson(fixture("traces-genai.json"));
  assert.equal(d.rejected.length, 0);
  assert.equal(partialSuccessOf(d.rejected), null);
  const spans = spansOf(d);
  assert.deepEqual(
    spans.map((s) => s.name),
    ["invoke_agent planner", "chat synthetic-model", "execute_tool search"],
  );
  assert.equal(spans[0]?.parentSpanId, null);
  assert.equal(spans[1]?.parentSpanId, SPAN);
  assert.equal(spans[2]?.parentSpanId, SPAN);
  assert.equal(spans[1]?.kind, 3);
  assert.equal(spans[2]?.status.code, 2);
  assert.equal(spans[2]?.status.message, "synthetic tool failure");
  assert.equal(spans[1]?.startTimeUnixNano, 1700000000010000000n);
  assert.equal(spans[0]?.path, "/resourceSpans/0/scopeSpans/0/spans/0");
  assert.match(spans[1]?.recordSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(spans[1]?.events.length, 1);
  assert.equal(spans[2]?.links[0]?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  const attrs = spans[1]?.attributes ?? [];
  assert.deepEqual(attrs.find((a) => a.key === "gen_ai.usage.input_tokens")?.value, {
    kind: "int",
    value: 120n,
  });
  assert.deepEqual(attrs.find((a) => a.key === "gen_ai.usage.output_tokens")?.value, {
    kind: "int",
    value: 45n,
  });
  assert.match(d.resourceSpans[0]?.resourceSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(d.resourceSpans[0]?.scopeSpans[0]?.scope.name, "synthetic.genai.instrumentation");
});

test("valid OpenInference fixture", () => {
  const d = decodeTracesJson(fixture("traces-openinference.json"));
  assert.equal(d.rejected.length, 0);
  const spans = spansOf(d);
  assert.equal(spans.length, 3);
  const kinds = spans.map(
    (s) => s.attributes.find((a) => a.key === "openinference.span.kind")?.value,
  );
  assert.deepEqual(kinds, [
    { kind: "string", value: "CHAIN" },
    { kind: "string", value: "LLM" },
    { kind: "string", value: "TOOL" },
  ]);
});

test("empty request and absent arrays are valid and empty", () => {
  for (const body of [{}, { resourceSpans: [] }, { resourceSpans: null }]) {
    const d = decodeTracesJson(enc(body));
    assert.equal(d.resourceSpans.length, 0);
    assert.equal(d.rejected.length, 0);
  }
});

test("hex ids: uppercase is normalized to lowercase", () => {
  const d = decodeTracesJson(
    oneSpan({
      traceId: TRACE.toUpperCase(),
      spanId: SPAN.toUpperCase(),
      parentSpanId: "AABBCCDDEEFF0011",
    }),
  );
  const s = spansOf(d)[0];
  assert.equal(s?.traceId, TRACE);
  assert.equal(s?.spanId, SPAN);
  assert.equal(s?.parentSpanId, "aabbccddeeff0011");
});

test("hex ids: bad length, non-hex, all zero and missing are rejected per record", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ traceId: TRACE.slice(0, 31) }, "invalid-trace-id"],
    [{ traceId: `${TRACE}0` }, "invalid-trace-id"],
    [{ traceId: `zz${TRACE.slice(2)}` }, "invalid-trace-id"],
    [{ traceId: "0".repeat(32) }, "invalid-trace-id"],
    [{ traceId: "" }, "invalid-trace-id"],
    [{ traceId: 7 }, "invalid-trace-id"],
    [{ spanId: SPAN.slice(0, 15) }, "invalid-span-id"],
    [{ spanId: "0".repeat(16) }, "invalid-span-id"],
    [{ parentSpanId: "0".repeat(16) }, "invalid-parent-span-id"],
    [{ parentSpanId: "abc" }, "invalid-parent-span-id"],
    [{ links: [{ traceId: "0".repeat(32), spanId: SPAN }] }, "invalid-trace-id"],
  ];
  for (const [over, reason] of cases) {
    const d = decodeTracesJson(oneSpan(over));
    assert.equal(spansOf(d).length, 0, JSON.stringify(over));
    assert.deepEqual(d.rejected, [{ path: "/resourceSpans/0/scopeSpans/0/spans/0", reason }]);
  }
  const missing = decodeTracesJson(enc(spanReq([{ spanId: SPAN }])));
  assert.equal(missing.rejected[0]?.reason, "invalid-trace-id");
});

test("empty and absent parentSpanId both give null", () => {
  assert.equal(spansOf(decodeTracesJson(oneSpan({ parentSpanId: "" })))[0]?.parentSpanId, null);
  assert.equal(spansOf(decodeTracesJson(oneSpan()))[0]?.parentSpanId, null);
});

test("int64 as a decimal string and as a safe JSON number", () => {
  const d = decodeTracesJson(
    oneSpan({ startTimeUnixNano: "1700000000000000001", endTimeUnixNano: 9007199254740991 }),
  );
  const s = spansOf(d)[0];
  assert.equal(s?.startTimeUnixNano, 1700000000000000001n);
  assert.equal(s?.endTimeUnixNano, 9007199254740991n);
});

test("int64 as a JSON number above 2^53 is rejected (no silent precision loss)", () => {
  for (const raw of [
    "9007199254740992",
    "9007199254740993",
    "1700000000000000000",
    "1.5",
    "1e30",
  ]) {
    const body = new TextEncoder().encode(
      `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}","startTimeUnixNano":${raw}}]}]}]}`,
    );
    const d = decodeTracesJson(body);
    assert.equal(d.rejected[0]?.reason, "invalid-int64", raw);
  }
  // The same value as a string is exact.
  const ok = decodeTracesJson(oneSpan({ startTimeUnixNano: "9007199254740993" }));
  assert.equal(spansOf(ok)[0]?.startTimeUnixNano, 9007199254740993n);
});

test("int64 syntax: junk strings, signs, leading zeros and objects are rejected", () => {
  for (const v of ["abc", "", "01", "+5", "1_0", " 5", "5 ", "1".repeat(21), {}, [], true]) {
    const d = decodeTracesJson(oneSpan({ startTimeUnixNano: v }));
    assert.equal(d.rejected[0]?.reason, "invalid-int64", JSON.stringify(v));
  }
});

test("times: negative and above 2^63-1 are rejected, 2^63-1 is accepted", () => {
  assert.equal(
    decodeTracesJson(oneSpan({ startTimeUnixNano: "9223372036854775808" })).rejected[0]?.reason,
    "time-out-of-range",
  );
  assert.equal(
    decodeTracesJson(oneSpan({ startTimeUnixNano: "-1" })).rejected[0]?.reason,
    "time-out-of-range",
  );
  const ok = decodeTracesJson(oneSpan({ startTimeUnixNano: "9223372036854775807" }));
  assert.equal(spansOf(ok)[0]?.startTimeUnixNano, 9223372036854775807n);
});

test("start after end is accepted with a time-inverted warning", () => {
  const d = decodeTracesJson(oneSpan({ startTimeUnixNano: "2000", endTimeUnixNano: "1000" }));
  assert.equal(spansOf(d).length, 1);
  assert.deepEqual(d.warnings, [
    { path: "/resourceSpans/0/scopeSpans/0/spans/0", code: "time-inverted" },
  ]);
  const open = decodeTracesJson(oneSpan({ startTimeUnixNano: "2000" }));
  assert.equal(open.warnings.length, 0);
  assert.equal(spansOf(open)[0]?.endTimeUnixNano, 0n);
});

test("unknown fields are ignored at every level and do not change the hash", () => {
  const plain = decodeTracesJson(oneSpan({ name: "n", attributes: [str("a", "b")] }));
  const noisy = decodeTracesJson(
    enc({
      unknownTop: { a: 1 },
      resourceSpans: [
        {
          extra: [1, 2, 3],
          resource: { weird: true, attributes: [] },
          scopeSpans: [
            {
              scope: { future: 1 },
              spans: [
                {
                  traceId: TRACE,
                  spanId: SPAN,
                  name: "n",
                  futureField: "x",
                  status: { code: 0, other: 1 },
                  attributes: [{ key: "a", value: { stringValue: "b", extra: 1 }, more: 2 }],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  assert.equal(noisy.rejected.length, 0);
  assert.equal(spansOf(noisy)[0]?.recordSha256, spansOf(plain)[0]?.recordSha256);
});

test("enum names where integers are required are rejected; out of range too", () => {
  for (const [field, v] of [
    ["kind", "SPAN_KIND_SERVER"],
    ["kind", "2"],
    ["kind", 6],
    ["kind", -1],
    ["kind", 1.5],
  ] as const) {
    const d = decodeTracesJson(oneSpan({ [field]: v }));
    assert.equal(d.rejected[0]?.reason, "invalid-enum", `${field}=${String(v)}`);
  }
  const st = decodeTracesJson(oneSpan({ status: { code: "STATUS_CODE_ERROR" } }));
  assert.equal(st.rejected[0]?.reason, "invalid-enum");
  assert.equal(spansOf(decodeTracesJson(oneSpan({ kind: 5 })))[0]?.kind, 5);
  assert.equal(spansOf(decodeTracesJson(oneSpan({ status: { code: 2 } })))[0]?.status.code, 2);
});

test("AnyValue types decode to the tagged union", () => {
  const d = decodeTracesJson(
    oneSpan({
      attributes: [
        { key: "s", value: { stringValue: "v" } },
        { key: "b", value: { boolValue: false } },
        { key: "i", value: { intValue: "-9223372036854775808" } },
        { key: "d", value: { doubleValue: 1.5 } },
        { key: "y", value: { bytesValue: "AQID" } },
        { key: "a", value: { arrayValue: { values: [{ intValue: 1 }, { stringValue: "z" }] } } },
        { key: "m", value: { kvlistValue: { values: [str("k", "v")] } } },
        { key: "ea", value: { arrayValue: {} } },
      ],
    }),
  );
  const v = Object.fromEntries((spansOf(d)[0]?.attributes ?? []).map((a) => [a.key, a.value]));
  assert.deepEqual(v["s"], { kind: "string", value: "v" });
  assert.deepEqual(v["b"], { kind: "bool", value: false });
  assert.deepEqual(v["i"], { kind: "int", value: -9223372036854775808n });
  assert.deepEqual(v["d"], { kind: "double", value: 1.5 });
  assert.deepEqual(v["y"], { kind: "bytes", value: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(v["a"], {
    kind: "array",
    values: [
      { kind: "int", value: 1n },
      { kind: "string", value: "z" },
    ],
  });
  assert.deepEqual(v["m"], {
    kind: "kvlist",
    values: [{ key: "k", value: { kind: "string", value: "v" } }],
  });
  assert.deepEqual(v["ea"], { kind: "array", values: [] });
});

test("AnyValue shape errors reject the record", () => {
  const bad: [unknown, string][] = [
    [{}, "invalid-any-value"],
    [{ stringValue: "a", boolValue: true }, "invalid-any-value"],
    [{ unknownValue: 1 }, "invalid-any-value"],
    [null, "invalid-any-value"],
    [5, "invalid-any-value"],
    [{ stringValue: 5 }, "invalid-type"],
    [{ boolValue: "true" }, "invalid-type"],
    [{ intValue: "9223372036854775808" }, "invalid-int64"],
    [{ intValue: 9007199254740994 }, "invalid-int64"],
    [{ doubleValue: "NaN" }, "invalid-double"],
    [{ bytesValue: "AQI" }, "invalid-base64"],
    [{ bytesValue: "AQ!=" }, "invalid-base64"],
    [{ arrayValue: [] }, "invalid-any-value"],
  ];
  for (const [value, reason] of bad) {
    const d = decodeTracesJson(oneSpan({ attributes: [{ key: "k", value }] }));
    assert.equal(d.rejected[0]?.reason, reason, JSON.stringify(value));
  }
  // 1e999 parses to Infinity.
  const inf = decodeTracesJson(
    new TextEncoder().encode(
      `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}","attributes":[{"key":"k","value":{"doubleValue":1e999}}]}]}]}]}`,
    ),
  );
  assert.equal(inf.rejected[0]?.reason, "invalid-double");
});

test("AnyValue depth: 16 is accepted, 17 is rejected (array and kvlist chains)", () => {
  for (const nest of [nestArray, nestKv]) {
    const ok = decodeTracesJson(oneSpan({ attributes: [{ key: "k", value: nest(16) }] }));
    assert.equal(ok.rejected.length, 0, nest.name);
    assert.equal(spansOf(ok).length, 1);
    const bad = decodeTracesJson(oneSpan({ attributes: [{ key: "k", value: nest(17) }] }));
    assert.equal(bad.rejected[0]?.reason, "any-value-too-deep", nest.name);
    // 65 levels exceed the structural JSON depth cap (96) first: a whole-request error.
    expectCode(
      () => decodeTracesJson(oneSpan({ attributes: [{ key: "k", value: nest(65) }] })),
      "json-too-deep",
    );
  }
});

test("a 16-level kvlist inside a span event is rejected, not thrown (canonical depth 64)", () => {
  const d = decodeTracesJson(
    oneSpan({ events: [{ name: "e", attributes: [{ key: "k", value: nestKv(16) }] }] }),
  );
  assert.equal(d.rejected[0]?.reason, "any-value-too-deep");
});

test("JSON structural depth above the cap is a whole-request error", () => {
  let deep: unknown = "x";
  for (let i = 0; i < 200; i++) deep = [deep];
  expectCode(
    () => decodeTracesJson(enc({ resourceSpans: [], unknownDeep: deep })),
    "json-too-deep",
  );
  let ok: unknown = "x";
  for (let i = 0; i < 60; i++) ok = [ok];
  assert.equal(decodeTracesJson(enc({ resourceSpans: [], unknownDeep: ok })).rejected.length, 0);
});

test("count bounds", () => {
  const span = (i: number) => ({ traceId: TRACE, spanId: SPAN, name: `s${i}` });
  // spans per request (default 10,000)
  const many = Array.from({ length: 10_001 }, (_, i) => span(i));
  expectCode(() => decodeTracesJson(enc(spanReq(many))), "too-many-records");
  const exact = Array.from({ length: 10_000 }, (_, i) => span(i));
  assert.equal(spansOf(decodeTracesJson(enc(spanReq(exact)))).length, 10_000);
  // resource groups and scope groups
  const rs = Array.from({ length: 1_001 }, () => ({ scopeSpans: [] }));
  expectCode(() => decodeTracesJson(enc({ resourceSpans: rs })), "too-many-resource-groups");
  const ss = Array.from({ length: 1_001 }, () => ({ spans: [] }));
  expectCode(
    () => decodeTracesJson(enc({ resourceSpans: [{ scopeSpans: ss }] })),
    "too-many-scope-groups",
  );
  // records across groups are summed
  expectCode(
    () =>
      decodeTracesJson(
        enc({
          resourceSpans: [{ scopeSpans: [{ spans: [span(1), span(2)] }, { spans: [span(3)] }] }],
        }),
        { maxRecords: 2 },
      ),
    "too-many-records",
  );
});

test("hard max: 50,000 spans pass with the raised limit, 50,001 do not", () => {
  const spans = Array.from({ length: 50_001 }, (_, i) => ({
    traceId: TRACE,
    spanId: SPAN,
    name: `${i}`,
  }));
  const body = enc(spanReq(spans));
  expectCode(() => decodeTracesJson(body, { maxRecords: 50_000 }), "too-many-records");
  expectCode(() => decodeTracesJson(body, { maxRecords: 50_001 }), "invalid-option");
  expectCode(() => decodeTracesJson(body), "too-many-records");
  const ok = decodeTracesJson(enc(spanReq(spans.slice(0, 50_000))), { maxRecords: 50_000 });
  assert.equal(spansOf(ok).length, 50_000);
});

test("attributes over the cap are truncated with a dropped count and an over-bounds warning", () => {
  const attrs = Array.from({ length: 10_000 }, (_, i) => str(`k${i}`, "v"));
  const d = decodeTracesJson(oneSpan({ attributes: attrs, droppedAttributesCount: 3 }));
  const s = spansOf(d)[0];
  assert.equal(s?.attributes.length, 128);
  assert.equal(s?.droppedAttributesCount, 3 + 10_000 - 128);
  assert.equal(s?.attributes[0]?.key, "k0");
  assert.deepEqual(d.warnings, [
    { path: "/resourceSpans/0/scopeSpans/0/spans/0", code: "over-bounds" },
  ]);
  // exactly at the cap: nothing dropped
  const at = decodeTracesJson(oneSpan({ attributes: attrs.slice(0, 128) }));
  assert.equal(spansOf(at)[0]?.droppedAttributesCount, 0);
  assert.equal(at.warnings.length, 0);
  // configurable down, never above the hard max
  assert.equal(
    spansOf(decodeTracesJson(oneSpan({ attributes: attrs }), { maxAttributes: 2 }))[0]?.attributes
      .length,
    2,
  );
  expectCode(() => decodeTracesJson(oneSpan(), { maxAttributes: 1_025 }), "invalid-option");
});

test("events and links over the cap are truncated and counted", () => {
  const events = Array.from({ length: 130 }, (_, i) => ({ name: `e${i}`, timeUnixNano: "1" }));
  const links = Array.from({ length: 131 }, () => ({ traceId: TRACE, spanId: SPAN }));
  const d = decodeTracesJson(oneSpan({ events, links, droppedEventsCount: 1 }));
  const s = spansOf(d)[0];
  assert.equal(s?.events.length, 128);
  assert.equal(s?.droppedEventsCount, 3);
  assert.equal(s?.links.length, 128);
  assert.equal(s?.droppedLinksCount, 3);
  assert.equal(d.warnings.length, 2);
});

test("event and link attributes are capped independently with their own dropped counts", () => {
  const attrs = Array.from({ length: 200 }, (_, i) => str(`k${i}`, "v"));
  const d = decodeTracesJson(
    oneSpan({
      events: [{ name: "e", attributes: attrs }],
      links: [{ traceId: TRACE, spanId: SPAN, attributes: attrs }],
    }),
  );
  const s = spansOf(d)[0];
  assert.equal(s?.events[0]?.attributes.length, 128);
  assert.equal(s?.events[0]?.droppedAttributesCount, 72);
  assert.equal(s?.links[0]?.droppedAttributesCount, 72);
});

test("string and key byte caps reject the record", () => {
  const key = decodeTracesJson(oneSpan({ attributes: [str("k".repeat(257), "v")] }));
  assert.equal(key.rejected[0]?.reason, "key-too-long");
  assert.equal(
    decodeTracesJson(oneSpan({ attributes: [str("k".repeat(256), "v")] })).rejected.length,
    0,
  );
  // 86 three-byte characters = 258 bytes
  const wide = decodeTracesJson(oneSpan({ attributes: [str("€".repeat(86), "v")] }));
  assert.equal(wide.rejected[0]?.reason, "key-too-long");
  const big = decodeTracesJson(oneSpan({ name: "a".repeat(101) }), { maxStringBytes: 100 });
  assert.equal(big.rejected[0]?.reason, "string-too-long");
  const bytes = decodeTracesJson(
    oneSpan({ attributes: [{ key: "k", value: { bytesValue: "AAAAAAAA" } }] }),
    { maxStringBytes: 5 },
  );
  assert.equal(bytes.rejected[0]?.reason, "string-too-long");
  const arr = decodeTracesJson(
    oneSpan({
      attributes: [
        { key: "k", value: { arrayValue: { values: Array(1025).fill({ intValue: 1 }) } } },
      ],
    }),
  );
  assert.equal(arr.rejected[0]?.reason, "too-many-entries");
});

test("total value budget is a whole-request error", () => {
  expectCode(() => decodeTracesJson(oneSpan(), { maxValues: 10 }), "too-many-values");
  assert.equal(decodeTracesJson(oneSpan(), { maxValues: 1_000 }).rejected.length, 0);
});

test("body size cap", () => {
  expectCode(() => decodeTracesJson(oneSpan(), { maxBodyBytes: 20 }), "body-too-large");
});

test("whole-request errors are typed", () => {
  const t = (s: string) => new TextEncoder().encode(s);
  expectCode(() => decodeTracesJson(t("")), "malformed-json");
  expectCode(() => decodeTracesJson(t("{")), "malformed-json");
  expectCode(() => decodeTracesJson(t('{"a":1} x')), "malformed-json");
  expectCode(() => decodeTracesJson(t("[]")), "invalid-structure");
  expectCode(() => decodeTracesJson(t("null")), "invalid-structure");
  expectCode(() => decodeTracesJson(t('{"resourceSpans":{}}')), "invalid-structure");
  expectCode(() => decodeTracesJson(t('{"resourceSpans":[1]}')), "invalid-structure");
  expectCode(
    () => decodeTracesJson(t('{"resourceSpans":[{"scopeSpans":{}}]}')),
    "invalid-structure",
  );
  expectCode(
    () => decodeTracesJson(t('{"resourceSpans":[{"scopeSpans":["x"]}]}')),
    "invalid-structure",
  );
  expectCode(
    () => decodeTracesJson(t('{"resourceSpans":[{"scopeSpans":[{"spans":"x"}]}]}')),
    "invalid-structure",
  );
  expectCode(() => decodeTracesJson("x" as unknown as Uint8Array), "malformed-json");
  expectCode(() => decodeTracesJson(oneSpan(), { maxRecords: 0 }), "invalid-option");
  expectCode(() => decodeTracesJson(oneSpan(), { maxAttributes: 1.5 }), "invalid-option");
});

test("a non-object record is rejected alone", () => {
  const d = decodeTracesJson(
    enc({
      resourceSpans: [
        { scopeSpans: [{ spans: [1, null, "x", { traceId: TRACE, spanId: SPAN }] }] },
      ],
    }),
  );
  assert.equal(spansOf(d).length, 1);
  assert.equal(d.rejected.length, 3);
  assert.deepEqual(
    d.rejected.map((r) => r.path),
    [0, 1, 2].map((i) => `/resourceSpans/0/scopeSpans/0/spans/${i}`),
  );
  assert.equal(spansOf(d)[0]?.path, "/resourceSpans/0/scopeSpans/0/spans/3");
});

test("partial success: good records survive, bad ones are listed with a reason", () => {
  const d = decodeTracesJson(
    enc(
      spanReq([
        { traceId: TRACE, spanId: SPAN, name: "ok1" },
        { traceId: "bad", spanId: SPAN, name: "bad1" },
        { traceId: TRACE, spanId: "1111111111111111", name: "ok2", kind: "SERVER" },
        { traceId: TRACE, spanId: "2222222222222222", name: "ok3" },
      ]),
    ),
  );
  assert.deepEqual(
    spansOf(d).map((s) => s.name),
    ["ok1", "ok3"],
  );
  assert.deepEqual(d.rejected, [
    { path: "/resourceSpans/0/scopeSpans/0/spans/1", reason: "invalid-trace-id" },
    { path: "/resourceSpans/0/scopeSpans/0/spans/2", reason: "invalid-enum" },
  ]);
  assert.deepEqual(partialSuccessOf(d.rejected), { rejected: 2, errorMessage: "invalid-trace-id" });
});

test("an invalid resource or scope rejects every record below it", () => {
  const bad = decodeTracesJson(
    enc({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "k", value: {} }] },
          scopeSpans: [
            {
              spans: [
                { traceId: TRACE, spanId: SPAN },
                { traceId: TRACE, spanId: SPAN },
              ],
            },
          ],
        },
        {
          scopeSpans: [
            { scope: { name: 5 }, spans: [{ traceId: TRACE, spanId: SPAN }] },
            { spans: [{ traceId: TRACE, spanId: SPAN }] },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(bad.rejected, [
    { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "invalid-any-value" },
    { path: "/resourceSpans/0/scopeSpans/0/spans/1", reason: "invalid-any-value" },
    { path: "/resourceSpans/1/scopeSpans/0/spans/0", reason: "invalid-type" },
  ]);
  assert.equal(spansOf(bad).length, 1);
  assert.equal(spansOf(bad)[0]?.path, "/resourceSpans/1/scopeSpans/1/spans/0");
});

test("duplicate span ids with different content decode as two records with different hashes", () => {
  const d = decodeTracesJson(fixture("hostile/duplicate-span-ids.json"));
  const s = spansOf(d);
  assert.equal(s.length, 2);
  assert.equal(s[0]?.spanId, s[1]?.spanId);
  assert.notEqual(s[0]?.recordSha256, s[1]?.recordSha256);
});

test("decoding is deterministic and does not mutate the input", () => {
  const body = fixture("traces-genai.json");
  const copy = body.slice();
  const a = decodeTracesJson(body);
  const b = decodeTracesJson(body);
  assert.deepEqual(a, b);
  assert.deepEqual(body, copy);
});
