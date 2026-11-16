import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type DecodedSpan,
  decodeLogsJson,
  decodeLogsProtobuf,
  decodeTracesJson,
  decodeTracesProtobuf,
} from "../src/index.js";
import { enc, expectCode, spanReq, str } from "./helpers.js";
import {
  fixed32Field,
  fixed64Field,
  lenField,
  strField,
  tagBytes,
  varintField,
} from "./proto-encoder.js";

type Bytes = number[];

const TRACE = Array.from({ length: 16 }, (_, i) => i + 1);
const SPAN = Array.from({ length: 8 }, (_, i) => i + 1);
const idFields = (): Bytes => [...lenField(1, TRACE), ...lenField(2, SPAN)];
const TRACE_HEX = "0102030405060708090a0b0c0d0e0f10";
const SPAN_HEX = "0102030405060708";

function tracesOf(...spans: Bytes[]): Uint8Array {
  return new Uint8Array(
    lenField(
      1,
      lenField(
        2,
        spans.flatMap((s) => lenField(2, s)),
      ),
    ),
  );
}
const oneSpan = (...extra: Bytes[]): Uint8Array => tracesOf([...idFields(), ...extra.flat()]);
const logOf = (...f: Bytes[]): Uint8Array =>
  new Uint8Array(lenField(1, lenField(2, lenField(2, f.flat()))));

const spansOf = (
  b: Uint8Array,
  o?: Parameters<typeof decodeTracesProtobuf>[1],
): readonly DecodedSpan[] =>
  decodeTracesProtobuf(b, o).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
const reasons = (b: Uint8Array, o?: Parameters<typeof decodeTracesProtobuf>[1]): string[] =>
  decodeTracesProtobuf(b, o).rejected.map((r) => r.reason);

const attr = (key: string, value: Bytes): Bytes =>
  lenField(9, [...strField(1, key), ...lenField(2, value)]);
const sattr = (key: string, value: string): Bytes => attr(key, strField(1, value));

describe("count caps (ADR-0006 section 6)", () => {
  test("records per request: 10,000 accepted, 10,001 is too-many-records; the cap is an option", () => {
    const rec = idFields();
    assert.equal(spansOf(tracesOf(...Array.from({ length: 10_000 }, () => rec))).length, 10_000);
    expectCode(
      () => decodeTracesProtobuf(tracesOf(...Array.from({ length: 10_001 }, () => rec))),
      "too-many-records",
    );
    const big = Array.from({ length: 50_001 }, () => rec);
    expectCode(
      () => decodeTracesProtobuf(tracesOf(...big), { maxRecords: 50_000 }),
      "too-many-records",
    );
    assert.equal(spansOf(tracesOf(...big.slice(1)), { maxRecords: 50_000 }).length, 50_000);
    expectCode(
      () => decodeTracesProtobuf(tracesOf(rec, rec, rec), { maxRecords: 2 }),
      "too-many-records",
    );
  });

  test("resource groups and scope groups are bounded before any record is decoded", () => {
    const rg = lenField(1, lenField(2, lenField(2, idFields())));
    expectCode(
      () => decodeTracesProtobuf(new Uint8Array([...rg, ...rg, ...rg]), { maxResourceGroups: 2 }),
      "too-many-resource-groups",
    );
    assert.equal(
      decodeTracesProtobuf(new Uint8Array([...rg, ...rg]), { maxResourceGroups: 2 }).resourceSpans
        .length,
      2,
    );
    const sg = lenField(2, lenField(2, idFields()));
    const rg3 = new Uint8Array(lenField(1, [...sg, ...sg, ...sg]));
    expectCode(() => decodeTracesProtobuf(rg3, { maxScopeGroups: 2 }), "too-many-scope-groups");
    // a bad record does not hide the count error: the bounds pass comes first
    const junk = new Uint8Array(
      lenField(1, [...sg, ...sg, ...sg, ...lenField(2, lenField(2, [0xff]))]),
    );
    expectCode(() => decodeTracesProtobuf(junk, { maxScopeGroups: 2 }), "too-many-scope-groups");
  });

  test("attributes: all decoded and hashed, then truncated to 128 with dropped count and a warning", () => {
    const n = 200;
    const protoAttrs = Array.from({ length: n }, (_, i) => sattr(`k${i}`, `v${i}`)).flat();
    const d = spansOf(oneSpan(protoAttrs, varintField(10, 5)));
    assert.equal(d[0]?.attributes.length, 128);
    assert.equal(d[0]?.droppedAttributesCount, 5 + 72);
    const w = decodeTracesProtobuf(oneSpan(protoAttrs)).warnings;
    assert.deepEqual(w, [{ path: "/resourceSpans/0/scopeSpans/0/spans/0", code: "over-bounds" }]);
    // The hash covers the 200 attributes: identical to the JSON decoder's, different from a 128 span
    const json = decodeTracesJson(
      enc(
        spanReq([
          {
            traceId: TRACE_HEX,
            spanId: SPAN_HEX,
            droppedAttributesCount: 5,
            attributes: Array.from({ length: n }, (_, i) => str(`k${i}`, `v${i}`)),
          },
        ]),
      ),
    ).resourceSpans[0]?.scopeSpans[0]?.spans[0];
    const viaProto = spansOf(oneSpan(protoAttrs, varintField(10, 5)))[0];
    assert.equal(viaProto?.recordSha256, json?.recordSha256);
    const short = spansOf(
      oneSpan(
        ...Array.from({ length: 128 }, (_, i) => sattr(`k${i}`, `v${i}`)),
        varintField(10, 77),
      ),
    )[0];
    assert.notEqual(short?.recordSha256, viaProto?.recordSha256);
  });

  test("events and links over 128 are truncated with dropped counts; their attributes too", () => {
    const events = Array.from({ length: 130 }, (_, i) => lenField(11, strField(2, `e${i}`))).flat();
    const links = Array.from({ length: 131 }, () => lenField(13, idFields())).flat();
    const s = spansOf(oneSpan(events, links, varintField(12, 1), varintField(14, 2)))[0];
    assert.equal(s?.events.length, 128);
    assert.equal(s?.droppedEventsCount, 3);
    assert.equal(s?.links.length, 128);
    assert.equal(s?.droppedLinksCount, 5);
    const evAttrs = Array.from({ length: 130 }, (_, k) =>
      lenField(3, [...strField(1, `a${k}`), ...lenField(2, strField(1, "v"))]),
    ).flat();
    const ev = lenField(11, [...strField(2, "e"), ...evAttrs]);
    const t = spansOf(oneSpan(ev))[0];
    assert.equal(t?.events[0]?.attributes.length, 128);
    assert.equal(t?.events[0]?.droppedAttributesCount, 2);
  });

  test("dropped counts saturate at 2^32-1", () => {
    const attrs = Array.from({ length: 129 }, (_, i) => sattr(`k${i}`, "v")).flat();
    assert.equal(
      spansOf(oneSpan(attrs, varintField(10, 4_294_967_295)))[0]?.droppedAttributesCount,
      4_294_967_295,
    );
  });

  test("array and kvlist entries: 1,024 accepted, 1,025 rejects the record", () => {
    const arr = (n: number): Bytes =>
      lenField(5, Array.from({ length: n }, () => lenField(1, strField(1, "x"))).flat());
    assert.equal(reasons(oneSpan(attr("k", arr(1024)))).length, 0);
    assert.deepEqual(reasons(oneSpan(attr("k", arr(1025)))), ["too-many-entries"]);
    const kvl = (n: number): Bytes =>
      lenField(
        6,
        Array.from({ length: n }, () =>
          lenField(1, [...strField(1, "k"), ...lenField(2, strField(1, "v"))]),
        ).flat(),
      );
    assert.equal(reasons(oneSpan(attr("k", kvl(1024)))).length, 0);
    assert.deepEqual(reasons(oneSpan(attr("k", kvl(1025)))), ["too-many-entries"]);
  });
});

describe("strings", () => {
  test("invalid UTF-8 rejects the record, not the batch", () => {
    const ok = [...idFields(), ...strField(5, "fine")];
    const cases: Bytes[] = [
      [0xff],
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf8, 0x88, 0x80, 0x80, 0x80],
      [0xe2, 0x82],
      [0xf4, 0x90, 0x80, 0x80],
    ];
    for (const bad of cases) {
      const b = tracesOf([...idFields(), ...lenField(5, bad)], ok);
      assert.deepEqual(decodeTracesProtobuf(b).rejected, [
        { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "invalid-string" },
      ]);
      assert.equal(spansOf(b).length, 1);
    }
    // in an attribute key, a value, a resource, a scope, a schema URL and a log body
    assert.deepEqual(
      reasons(oneSpan(lenField(9, [...lenField(1, [0xff]), ...lenField(2, strField(1, "v"))]))),
      ["invalid-string"],
    );
    assert.deepEqual(reasons(oneSpan(attr("k", lenField(1, [0xff])))), ["invalid-string"]);
    assert.deepEqual(
      decodeLogsProtobuf(logOf(lenField(5, lenField(1, [0xff])))).rejected.map((r) => r.reason),
      ["invalid-string"],
    );
    const badRes = new Uint8Array(
      lenField(1, [
        ...lenField(1, lenField(1, [...strField(1, "k"), ...lenField(2, lenField(1, [0xff]))])),
        ...lenField(2, lenField(2, idFields())),
      ]),
    );
    assert.deepEqual(reasons(badRes), ["invalid-string"]);
    const badSchema = new Uint8Array(
      lenField(1, [...lenField(3, [0xff]), ...lenField(2, lenField(2, idFields()))]),
    );
    assert.deepEqual(reasons(badSchema), ["invalid-string"]);
  });

  test("a leading BOM, NUL and non-BMP characters are preserved exactly", () => {
    const name = "﻿a\u0000\u{1f600}‮";
    assert.equal(spansOf(oneSpan(strField(5, name)))[0]?.name, name);
  });

  test("strings over the byte cap, keys over 256 bytes and oversized bytes values are rejected", () => {
    assert.deepEqual(reasons(oneSpan(strField(5, "x".repeat(11))), { maxStringBytes: 10 }), [
      "string-too-long",
    ]);
    assert.equal(reasons(oneSpan(strField(5, "x".repeat(10))), { maxStringBytes: 10 }).length, 0);
    // bytes, not characters: 4 x U+00E9 is 8 bytes
    assert.deepEqual(reasons(oneSpan(strField(5, "é".repeat(6))), { maxStringBytes: 10 }), [
      "string-too-long",
    ]);
    assert.deepEqual(reasons(oneSpan(sattr("k".repeat(257), "v"))), ["key-too-long"]);
    assert.equal(reasons(oneSpan(sattr("k".repeat(256), "v"))).length, 0);
    assert.deepEqual(
      reasons(oneSpan(attr("k", lenField(7, new Array(11).fill(1)))), { maxStringBytes: 10 }),
      ["string-too-long"],
    );
  });

  test("F10: the length is checked before any decoding; validity decides within the limit", () => {
    // over-long AND invalid: never decoded, so string-too-long (JSON would say invalid-string)
    assert.deepEqual(
      reasons(oneSpan(lenField(5, [0xff, ...new Array(20).fill(0x41)])), { maxStringBytes: 10 }),
      ["string-too-long"],
    );
    // within the limit, invalid UTF-8 is still invalid-string
    assert.deepEqual(reasons(oneSpan(lenField(5, [0xff, 0x41])), { maxStringBytes: 10 }), [
      "invalid-string",
    ]);
    // a key over the key cap is not decoded either
    assert.deepEqual(
      reasons(
        oneSpan(
          lenField(9, [
            ...lenField(1, new Array(300).fill(0xff)),
            ...lenField(2, strField(1, "v")),
          ]),
        ),
      ),
      ["key-too-long"],
    );
    // an over-long AnyValue string likewise
    assert.deepEqual(
      reasons(oneSpan(attr("k", lenField(1, new Array(11).fill(0xff)))), { maxStringBytes: 10 }),
      ["string-too-long"],
    );
  });
});

describe("F1: Node Buffer input", () => {
  test("a Buffer with a non-zero byteOffset decodes to plain, non-aliasing bytes values", () => {
    const body = logOf(lenField(5, lenField(7, [1, 2, 3, 4])));
    const backing = Buffer.alloc(body.length + 37, 0xee);
    backing.set(body, 37);
    const buf = backing.subarray(37, 37 + body.length);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.byteOffset - backing.byteOffset, 37);
    const fromBuffer = decodeLogsProtobuf(buf);
    const fromU8 = decodeLogsProtobuf(body);
    assert.deepStrictEqual(fromBuffer, fromU8);
    const v = fromBuffer.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body;
    assert.ok(v?.kind === "bytes");
    // a plain Uint8Array (not a Buffer), over its own storage
    assert.equal(Object.getPrototypeOf(v.value), Uint8Array.prototype);
    assert.ok(!Buffer.isBuffer(v.value));
    assert.notEqual(v.value.buffer, buf.buffer);
    assert.equal(v.value.byteLength, 4);
    // mutating or zeroing the input afterwards does not change the result
    backing.fill(0);
    assert.deepEqual(Array.from(v.value), [1, 2, 3, 4]);
  });

  test("traces decoded from a Buffer equal the Uint8Array result (hashes included)", () => {
    const body = oneSpan(strField(5, "n"), sattr("a", "b"));
    const backing = Buffer.concat([Buffer.alloc(11), Buffer.from(body)]);
    const buf = backing.subarray(11);
    assert.deepStrictEqual(decodeTracesProtobuf(buf), decodeTracesProtobuf(body));
  });
});

describe("scalars", () => {
  test("times are unsigned: 2^63-1 accepted, 2^63 and 2^64-1 rejected per record", () => {
    assert.equal(
      spansOf(oneSpan(fixed64Field(7, (1n << 63n) - 1n)))[0]?.startTimeUnixNano,
      (1n << 63n) - 1n,
    );
    for (const v of [1n << 63n, (1n << 64n) - 1n, (1n << 63n) + 12345n]) {
      assert.deepEqual(reasons(oneSpan(fixed64Field(7, v))), ["time-out-of-range"]);
      assert.deepEqual(reasons(oneSpan(fixed64Field(8, v))), ["time-out-of-range"]);
      assert.deepEqual(
        decodeLogsProtobuf(logOf(fixed64Field(1, v))).rejected.map((r) => r.reason),
        ["time-out-of-range"],
      );
      assert.deepEqual(
        decodeLogsProtobuf(logOf(fixed64Field(11, v))).rejected.map((r) => r.reason),
        ["time-out-of-range"],
      );
    }
    assert.equal(spansOf(oneSpan(fixed64Field(7, 0n)))[0]?.startTimeUnixNano, 0n);
  });

  test("start after end is a warning and the span is kept", () => {
    const d = decodeTracesProtobuf(oneSpan(fixed64Field(7, 2000n), fixed64Field(8, 1000n)));
    assert.deepEqual(d.warnings, [
      { path: "/resourceSpans/0/scopeSpans/0/spans/0", code: "time-inverted" },
    ]);
    assert.equal(d.rejected.length, 0);
  });

  test("uint32 and enum ranges", () => {
    assert.equal(
      spansOf(oneSpan(varintField(10, 4_294_967_295)))[0]?.droppedAttributesCount,
      4_294_967_295,
    );
    assert.deepEqual(reasons(oneSpan(varintField(10, 4_294_967_296))), ["invalid-uint32"]);
    assert.deepEqual(reasons(oneSpan(varintField(10, -1n))), ["invalid-uint32"]);
    assert.deepEqual(reasons(oneSpan(varintField(12, 1n << 40n))), ["invalid-uint32"]);
    assert.equal(spansOf(oneSpan(fixed32Field(16, 4_294_967_295)))[0]?.flags, 4_294_967_295);
    assert.equal(
      spansOf(oneSpan(lenField(13, [...idFields(), ...fixed32Field(6, 0x300)])))[0]?.links[0]
        ?.flags,
      0x300,
    );
    assert.deepEqual(reasons(oneSpan(varintField(6, 6))), ["invalid-enum"]);
    assert.deepEqual(reasons(oneSpan(varintField(6, -1n))), ["invalid-enum"]);
    assert.deepEqual(reasons(oneSpan(varintField(6, (1n << 32n) + 2n))), ["invalid-enum"]);
    assert.equal(spansOf(oneSpan(varintField(6, 5)))[0]?.kind, 5);
    assert.deepEqual(reasons(oneSpan(lenField(15, varintField(3, 3)))), ["invalid-enum"]);
    assert.equal(
      spansOf(oneSpan(lenField(15, [...varintField(3, 2), ...strField(2, "boom")])))[0]?.status
        .code,
      2,
    );
    assert.deepEqual(
      decodeLogsProtobuf(logOf(varintField(2, 25))).rejected.map((r) => r.reason),
      ["invalid-enum"],
    );
    const d = decodeLogsProtobuf(logOf(varintField(2, 24)));
    assert.equal(d.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.severityNumber, 24);
  });

  test("a known field with the wrong wire type is rejected (invalid-type and its relatives)", () => {
    assert.deepEqual(reasons(oneSpan(varintField(5, 1))), ["invalid-type"]); // name as varint
    assert.deepEqual(reasons(oneSpan(fixed64Field(5, 1n))), ["invalid-type"]);
    assert.deepEqual(reasons(oneSpan(varintField(7, 1))), ["invalid-int64"]); // time as varint
    assert.deepEqual(reasons(oneSpan(lenField(6, [1]))), ["invalid-enum"]);
    assert.deepEqual(reasons(oneSpan(lenField(10, [1]))), ["invalid-uint32"]);
    assert.deepEqual(reasons(oneSpan(varintField(16, 1))), ["invalid-uint32"]); // flags as varint
    assert.deepEqual(reasons(oneSpan(varintField(15, 1))), ["invalid-type"]); // status as varint
    assert.deepEqual(reasons(oneSpan(varintField(11, 1))), ["invalid-type"]); // event as varint
    assert.deepEqual(reasons(oneSpan(varintField(9, 1))), ["invalid-any-value"]); // attribute as varint
    assert.deepEqual(reasons(oneSpan(varintField(4, 1))), ["invalid-parent-span-id"]);
    assert.deepEqual(
      reasons(
        new Uint8Array(
          lenField(1, [...varintField(1, 1), ...lenField(2, lenField(2, idFields()))]),
        ),
      ),
      ["invalid-type"],
    );
    // a record sent as a varint inside a scope group
    assert.deepEqual(reasons(new Uint8Array(lenField(1, lenField(2, varintField(2, 1))))), [
      "invalid-type",
    ]);
    // structural fields with a wrong wire type are whole-request errors
    expectCode(() => decodeTracesProtobuf(new Uint8Array(varintField(1, 1))), "invalid-structure");
    expectCode(
      () => decodeTracesProtobuf(new Uint8Array(lenField(1, varintField(2, 1)))),
      "invalid-structure",
    );
  });

  test("AnyValue members: bool, int64 extremes, doubles, bytes; wrong types and non-finite doubles", () => {
    const logBody = (v: Bytes) => decodeLogsProtobuf(logOf(lenField(5, v)));
    const body = (v: Bytes) => logBody(v).resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body;
    assert.deepEqual(body(varintField(2, 0)), { kind: "bool", value: false });
    assert.deepEqual(body(varintField(2, 1)), { kind: "bool", value: true });
    assert.deepEqual(body(varintField(3, 0x7fff_ffff_ffff_ffffn)), {
      kind: "int",
      value: 9223372036854775807n,
    });
    assert.deepEqual(body(varintField(3, 1n << 63n)), {
      kind: "int",
      value: -9223372036854775808n,
    });
    assert.deepEqual(body(strField(1, "")), { kind: "string", value: "" });
    const dbl = (x: number): Bytes => {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, x, true);
      return [...tagBytes(4, 1), ...new Uint8Array(dv.buffer)];
    };
    assert.deepEqual(body(dbl(-0)), { kind: "double", value: -0 });
    assert.deepEqual(body(dbl(1.5e300)), { kind: "double", value: 1.5e300 });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.deepEqual(
        logBody(dbl(bad)).rejected.map((r) => r.reason),
        ["invalid-double"],
      );
    }
    assert.deepEqual(
      logBody(varintField(1, 1)).rejected.map((r) => r.reason),
      ["invalid-type"],
    );
    assert.deepEqual(
      logBody(strField(3, "x")).rejected.map((r) => r.reason),
      ["invalid-int64"],
    );
    assert.deepEqual(
      logBody(varintField(5, 0)).rejected.map((r) => r.reason),
      ["invalid-any-value"],
    );
    assert.deepEqual(
      logBody(varintField(4, 0)).rejected.map((r) => r.reason),
      ["invalid-double"],
    );
  });

  test("a bytes value is a copy, not a view of the request buffer", () => {
    const req = logOf(lenField(5, lenField(7, [1, 2, 3])));
    const d = decodeLogsProtobuf(req);
    const v = d.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body;
    assert.ok(v?.kind === "bytes");
    req.fill(0);
    assert.deepEqual(Array.from(v.value), [1, 2, 3]);
  });

  test("LogRecord.event_name (12) and the full field set decode", () => {
    const d = decodeLogsProtobuf(
      logOf(
        fixed64Field(1, 5n),
        varintField(2, 9),
        strField(3, "INFO"),
        lenField(5, strField(1, "b")),
        lenField(6, [...strField(1, "a"), ...lenField(2, strField(1, "b"))]),
        varintField(7, 3),
        fixed32Field(8, 1),
        lenField(9, TRACE),
        lenField(10, SPAN),
        fixed64Field(11, 6n),
        strField(12, "claude_code.user_prompt"),
      ),
    );
    const r = d.resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    assert.equal(r?.eventName, "claude_code.user_prompt");
    assert.equal(r?.traceId, TRACE_HEX);
    assert.equal(r?.spanId, SPAN_HEX);
    assert.equal(r?.observedTimeUnixNano, 6n);
    assert.equal(r?.flags, 1);
    assert.equal(r?.droppedAttributesCount, 3);
    assert.equal(r?.timeUnixNano, 5n);
    assert.equal(r?.severityNumber, 9);
    assert.equal(r?.severityText, "INFO");
    assert.equal(r?.attributes.length, 1);
    // identical to the JSON decoder for the same logical record
    const j = decodeLogsJson(
      enc({
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: "5",
                    severityNumber: 9,
                    severityText: "INFO",
                    body: { stringValue: "b" },
                    attributes: [str("a", "b")],
                    droppedAttributesCount: 3,
                    flags: 1,
                    traceId: TRACE_HEX,
                    spanId: SPAN_HEX,
                    observedTimeUnixNano: "6",
                    eventName: "claude_code.user_prompt",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(d, j);
  });
});

describe("unknown fields and group-level rejection", () => {
  const unknowns = (): Bytes[] => [
    varintField(900, 123456789n),
    fixed64Field(901, 77n),
    lenField(902, [1, 2, 3, 4, 5]),
    lenField(903, []),
    fixed32Field(904, 9),
    [...tagBytes(0x1fff_ffff, 2), 2, 9, 9],
  ];

  test("unknown fields of every wire type are skipped at every level", () => {
    const u = unknowns().flat();
    const inner = [...idFields(), ...u, ...strField(5, "n")];
    const kvWithUnknown = lenField(9, [
      ...strField(1, "k"),
      ...u,
      ...lenField(2, [...strField(1, "v"), ...u]),
    ]);
    const arr = lenField(9, [
      ...strField(1, "a"),
      ...lenField(2, lenField(5, [...u, ...lenField(1, [...strField(1, "x"), ...u])])),
    ]);
    const sg = [
      ...lenField(1, [...strField(1, "scope"), ...u]),
      ...lenField(2, [
        ...inner,
        ...kvWithUnknown,
        ...arr,
        ...lenField(15, [...u, ...varintField(3, 1)]),
        ...lenField(11, [...u, ...strField(2, "e")]),
        ...lenField(13, [...idFields(), ...u]),
      ]),
      ...u,
    ];
    const rg = [...lenField(1, [...u]), ...lenField(2, sg), ...u];
    const req = new Uint8Array([...lenField(1, rg), ...u]);
    const d = decodeTracesProtobuf(req);
    assert.equal(d.rejected.length, 0);
    const s = d.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    assert.equal(s?.name, "n");
    assert.equal(s?.attributes.length, 2);
    assert.equal(s?.events.length, 1);
    assert.equal(s?.links.length, 1);
    assert.equal(s?.status.code, 1);
    assert.equal(d.resourceSpans[0]?.scopeSpans[0]?.scope.name, "scope");
  });

  test("a bad resource rejects every record below it with its reason, other groups survive", () => {
    const span = lenField(2, lenField(2, idFields()));
    const badRes = lenField(1, lenField(1, [...strField(1, "k"), ...lenField(2, [])])); // KeyValue without value
    const good = lenField(1, span);
    const bad = lenField(1, [...badRes, ...span, ...span]);
    const d = decodeTracesProtobuf(new Uint8Array([...bad, ...good]));
    assert.deepEqual(d.rejected, [
      { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "invalid-any-value" },
      { path: "/resourceSpans/0/scopeSpans/1/spans/0", reason: "invalid-any-value" },
    ]);
    assert.equal(d.resourceSpans.length, 1);
    assert.equal(d.resourceSpans[0]?.path, "/resourceSpans/1");
  });

  test("a bad scope rejects its records only; indexes are wire positions including rejected siblings", () => {
    const good = lenField(2, lenField(2, idFields()));
    const badScope = lenField(2, [...lenField(1, lenField(3, [])), ...lenField(2, idFields())]);
    const bad2 = lenField(2, [
      ...lenField(1, lenField(1, [0xff])),
      ...lenField(2, idFields()),
      ...lenField(2, idFields()),
    ]);
    const d = decodeTracesProtobuf(new Uint8Array(lenField(1, [...badScope, ...bad2, ...good])));
    assert.deepEqual(d.rejected, [
      { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "invalid-any-value" },
      { path: "/resourceSpans/0/scopeSpans/1/spans/0", reason: "invalid-string" },
      { path: "/resourceSpans/0/scopeSpans/1/spans/1", reason: "invalid-string" },
    ]);
    assert.equal(d.resourceSpans[0]?.scopeSpans.length, 1);
    assert.equal(d.resourceSpans[0]?.scopeSpans[0]?.path, "/resourceSpans/0/scopeSpans/2");
    assert.equal(
      d.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.path,
      "/resourceSpans/0/scopeSpans/2/spans/0",
    );
  });
});
