import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeLogsJson, decodeTracesJson } from "../src/index.js";
import { enc, encText, expectCode, oneLog, oneSpan, SPAN, spanReq, TRACE } from "./helpers.js";

const reasons = (b: Uint8Array): string[] => decodeTracesJson(b).rejected.map((r) => r.reason);
const spanOf = (b: Uint8Array) => decodeTracesJson(b).resourceSpans[0]?.scopeSpans[0]?.spans[0];
const raw = (field: string): Uint8Array =>
  encText(
    `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}",${field}}]}]}]}`,
  );
const dvOf = (lit: string) =>
  spanOf(raw(`"attributes":[{"key":"k","value":{"doubleValue":${lit}}}]`))?.attributes[0]?.value;

describe("F2: duplicate-key marking is O(depth) per object", () => {
  test("95 nested arrays with ~450k duplicate keys parse in bounded time", () => {
    const dups = `{${'"a":1,'.repeat(450_000)}"a":1}`;
    const body = encText(`${"[".repeat(95)}${dups}${"]".repeat(95)}`);
    const t0 = performance.now();
    // The root is an array: invalid-structure after a complete parse.
    expectCode(() => decodeTracesJson(body), "invalid-structure");
    const ms = performance.now() - t0;
    // Before the fix this was ~47M WeakSet.add calls; now the stack is walked once.
    assert.ok(ms < 3_000, `took ${ms.toFixed(0)} ms`);
  });

  test("duplicates are still attributed to the right records", () => {
    const b = encText(
      `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}","name":"a","name":"b"},{"traceId":"${TRACE}","spanId":"${SPAN}"}]}]}]}`,
    );
    const d = decodeTracesJson(b);
    assert.deepEqual(d.rejected, [
      { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "duplicate-key" },
    ]);
    assert.equal(d.resourceSpans[0]?.scopeSpans[0]?.spans.length, 1);
  });
});

describe("F7: integer fields take integer literals only", () => {
  const BAD_INT = [
    "1.0",
    "1.0000000000000001",
    "1e-400",
    "9007199254740991.0000001",
    "1e3",
    "1E3",
    "2.5",
    "1e0",
  ];
  test("times and intValue reject fraction and exponent literals", () => {
    for (const lit of BAD_INT) {
      assert.deepEqual(reasons(raw(`"startTimeUnixNano":${lit}`)), ["invalid-int64"], lit);
      assert.deepEqual(
        reasons(raw(`"attributes":[{"key":"k","value":{"intValue":${lit}}}]`)),
        ["invalid-int64"],
        lit,
      );
    }
  });
  test("enums and uint32 reject them too", () => {
    for (const lit of BAD_INT) {
      assert.deepEqual(reasons(raw(`"kind":${lit}`)), ["invalid-enum"], lit);
      assert.deepEqual(reasons(raw(`"status":{"code":${lit}}`)), ["invalid-enum"], lit);
      assert.deepEqual(reasons(raw(`"flags":${lit}`)), ["invalid-uint32"], lit);
      assert.deepEqual(reasons(raw(`"droppedAttributesCount":${lit}`)), ["invalid-uint32"], lit);
    }
    const log = decodeLogsJson(
      encText('{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"severityNumber":9.0}]}]}]}'),
    );
    assert.deepEqual(
      log.rejected.map((r) => r.reason),
      ["invalid-enum"],
    );
  });
  test("plain integer literals still work; doubleValue takes any numeric literal", () => {
    assert.equal(spanOf(raw('"kind":3'))?.kind, 3);
    assert.equal(
      spanOf(raw('"startTimeUnixNano":9007199254740991'))?.startTimeUnixNano,
      9007199254740991n,
    );
    assert.deepEqual(dvOf("1.0"), { kind: "double", value: 1 });
    assert.deepEqual(dvOf("1e3"), { kind: "double", value: 1000 });
    assert.deepEqual(dvOf("5"), { kind: "double", value: 5 });
    assert.deepEqual(dvOf("1e-400"), { kind: "double", value: 0 });
    assert.deepEqual(reasons(raw('"attributes":[{"key":"k","value":{"doubleValue":1e999}}]')), [
      "invalid-double",
    ]);
  });
  test("a float literal is never mistaken for an object", () => {
    assert.deepEqual(reasons(raw('"status":1.5')), ["invalid-type"]);
    assert.deepEqual(reasons(encText('{"resourceSpans":[{"scopeSpans":[{"spans":[1.5]}]}]}')), [
      "invalid-type",
    ]);
    expectCode(() => decodeTracesJson(encText('{"resourceSpans":[1.5]}')), "invalid-structure");
  });
});

describe("F8: -0 is 0", () => {
  test("integer readers normalise a negative-zero literal", () => {
    const s = spanOf(
      raw(
        '"kind":-0,"flags":-0,"droppedAttributesCount":-0,"droppedEventsCount":-0,"startTimeUnixNano":-0,"status":{"code":-0}',
      ),
    );
    assert.ok(Object.is(s?.kind, 0));
    assert.ok(Object.is(s?.flags, 0));
    assert.ok(Object.is(s?.droppedAttributesCount, 0));
    assert.ok(Object.is(s?.droppedEventsCount, 0));
    assert.equal(s?.startTimeUnixNano, 0n);
    assert.ok(Object.is(s?.status.code, 0));
    const l = decodeLogsJson(oneLog({ severityNumber: -0, flags: -0 })).resourceLogs[0]
      ?.scopeLogs[0]?.logRecords[0];
    assert.ok(Object.is(l?.severityNumber, 0));
    assert.ok(Object.is(l?.flags, 0));
  });
  test("documented: doubleValue -0.0 keeps -0 in the model but hashes like 0.0", () => {
    const a = dvOf("0.0");
    const b = dvOf("-0.0");
    assert.ok(a?.kind === "double" && Object.is(a.value, 0));
    assert.ok(b?.kind === "double" && Object.is(b.value, -0));
    const sha = (lit: string) =>
      spanOf(raw(`"attributes":[{"key":"k","value":{"doubleValue":${lit}}}]`))?.recordSha256;
    assert.equal(sha("0.0"), sha("-0.0"));
  });
});

describe("F9: proto-name (snake_case) aliases fail closed", () => {
  test("a span carrying a snake_case alias is rejected (invalid-type), siblings survive", () => {
    for (const f of [
      '"parent_span_id":"00f067aa0ba902b7"',
      '"trace_id":"00f067aa0ba902b7"',
      '"span_id":"00f067aa0ba902b7"',
      '"trace_state":"x"',
      '"start_time_unix_nano":"1"',
      '"end_time_unix_nano":"1"',
      '"dropped_attributes_count":1',
      '"dropped_events_count":1',
      '"dropped_links_count":1',
    ]) {
      const b = encText(
        `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"${SPAN}",${f}},{"traceId":"${TRACE}","spanId":"${SPAN}"}]}]}]}`,
      );
      const d = decodeTracesJson(b);
      assert.deepEqual(
        d.rejected,
        [{ path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "invalid-type" }],
        f,
      );
      assert.equal(d.resourceSpans[0]?.scopeSpans[0]?.spans.length, 1);
    }
  });
  test("events, links, attribute values, resource and scope", () => {
    assert.deepEqual(reasons(raw('"events":[{"time_unix_nano":"5"}]')), ["invalid-type"]);
    assert.deepEqual(reasons(raw('"events":[{"dropped_attributes_count":5}]')), ["invalid-type"]);
    assert.deepEqual(reasons(raw(`"links":[{"traceId":"${TRACE}","span_id":"${SPAN}"}]`)), [
      "invalid-type",
    ]);
    assert.deepEqual(reasons(raw('"attributes":[{"key":"k","value":{"string_value":"x"}}]')), [
      "invalid-type",
    ]);
    const res = enc(spanReq([{ traceId: TRACE, spanId: SPAN }], { dropped_attributes_count: 3 }));
    assert.deepEqual(reasons(res), ["invalid-type"]);
    const sc = enc(
      spanReq([{ traceId: TRACE, spanId: SPAN }], undefined, { dropped_attributes_count: 3 }),
    );
    assert.deepEqual(reasons(sc), ["invalid-type"]);
  });
  test("log records", () => {
    for (const f of [
      "time_unix_nano",
      "observed_time_unix_nano",
      "severity_number",
      "severity_text",
      "dropped_attributes_count",
      "trace_id",
      "span_id",
      "event_name",
    ]) {
      const d = decodeLogsJson(oneLog({ [f]: "1" }));
      assert.deepEqual(
        d.rejected.map((r) => r.reason),
        ["invalid-type"],
        f,
      );
    }
  });
  test("container fields are whole-request errors", () => {
    const t = (s: string) => () => decodeTracesJson(encText(s));
    const l = (s: string) => () => decodeLogsJson(encText(s));
    expectCode(t('{"resource_spans":[]}'), "invalid-structure");
    expectCode(t('{"resourceSpans":[{"scope_spans":[]}]}'), "invalid-structure");
    expectCode(t('{"resourceSpans":[{"schema_url":"x"}]}'), "invalid-structure");
    expectCode(t('{"resourceSpans":[{"scopeSpans":[{"schema_url":"x"}]}]}'), "invalid-structure");
    expectCode(l('{"resourceLogs":[{"scopeLogs":[{"log_records":[]}]}]}'), "invalid-structure");
    expectCode(l('{"resource_logs":[]}'), "invalid-structure");
  });
  test("camelCase still works", () => {
    assert.equal(
      spanOf(oneSpan({ parentSpanId: "00f067aa0ba902b8", name: "n", kind: 2 }))?.name,
      "n",
    );
  });
});
