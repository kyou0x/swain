import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { guard } from "../src/assemble.js";
import {
  type DecodedSpan,
  decodeLogsProtobuf,
  decodeTracesJson,
  decodeTracesProtobuf,
  OtlpDecodeError,
} from "../src/index.js";
import { decodeTracesWith } from "../src/proto/decode.js";
import { enc, expectCode, nestArray, nestKv, spanReq } from "./helpers.js";
import {
  fixed32Field,
  fixed64Field,
  lenField,
  strField,
  tagBytes,
  varint,
  varintField,
} from "./proto-encoder.js";

type Bytes = number[];

const TRACE = Array.from({ length: 16 }, (_, i) => i + 1);
const SPAN = Array.from({ length: 8 }, (_, i) => i + 1);
const idFields = (): Bytes => [...lenField(1, TRACE), ...lenField(2, SPAN)];

/** Request > ResourceSpans > ScopeSpans > the given span messages. */
function tracesOf(...spans: Bytes[]): Uint8Array {
  const ss = spans.flatMap((s) => lenField(2, s));
  return new Uint8Array(lenField(1, lenField(2, ss)));
}
const oneSpan = (...extra: Bytes[]): Uint8Array => tracesOf([...idFields(), ...extra.flat()]);

function logsOf(...records: Bytes[]): Uint8Array {
  const ss = records.flatMap((s) => lenField(2, s));
  return new Uint8Array(lenField(1, lenField(2, ss)));
}

const spansOf = (b: Uint8Array): readonly DecodedSpan[] =>
  decodeTracesProtobuf(b).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));

const rejectedOf = (b: Uint8Array): { path: string; reason: string }[] =>
  decodeTracesProtobuf(b).rejected.map((r) => ({ path: r.path, reason: r.reason }));

const BAD = "invalid-structure" as const;

describe("wire level: whole-request errors", () => {
  test("an 11-byte varint is rejected (as a field value, a tag and a length)", () => {
    const eleven = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
    expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(10, 0), ...eleven])), BAD);
    expectCode(() => decodeTracesProtobuf(new Uint8Array([...eleven, 0x00])), BAD);
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x0a, ...eleven])), BAD);
    // an 11th byte even when the continuation chain would otherwise be a valid number
    expectCode(
      () => decodeTracesProtobuf(new Uint8Array([0x08, ...new Array(10).fill(0xff), 0x01])),
      BAD,
    );
  });

  test("a 10-byte varint that overflows 64 bits is rejected; 2^64-1 is accepted", () => {
    const overflow = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02];
    expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(10, 0), ...overflow])), BAD);
    const max = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01];
    // as an unknown field it is skipped
    assert.equal(spansOf(oneSpan([...tagBytes(99, 0), ...max])).length, 1);
    // as the AnyValue int it is -1
    const body = logsOf([...lenField(5, varintField(3, -1n))]);
    const d = decodeLogsProtobuf(body);
    assert.deepEqual(d.resourceLogs[0]?.scopeLogs[0]?.logRecords[0]?.body, {
      kind: "int",
      value: -1n,
    });
  });

  test("non-minimal varints are accepted (they are legal protobuf)", () => {
    const padded = [0x85, 0x80, 0x00]; // 5 in three bytes
    const d = spansOf(oneSpan([...tagBytes(10, 0), ...padded]));
    assert.equal(d[0]?.droppedAttributesCount, 5);
  });

  test("truncated input of every kind is rejected", () => {
    const whole = oneSpan(fixed64Field(7, 5n), fixed32Field(16, 7), strField(5, "name"));
    for (let n = 1; n < whole.length; n++) {
      // Cutting the request anywhere leaves the outer LEN pointing past the end.
      expectCode(() => decodeTracesProtobuf(whole.subarray(0, n)), BAD);
    }
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x80])), BAD); // truncated tag
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x0a])), BAD); // missing length
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x09, 1, 2, 3, 4, 5, 6, 7])), BAD); // i64
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x0d, 1, 2, 3])), BAD); // i32
    // truncation INSIDE a nested message whose parent length is consistent
    expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(7, 1), 1, 2, 3])), BAD);
    expectCode(() => decodeTracesProtobuf(oneSpan([0x80])), BAD);
  });

  test("a length larger than the remaining bytes is rejected", () => {
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x0a, 0x05, 1, 2])), BAD);
    expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(3, 2), 0x20, 0x41])), BAD);
    // exact fit is fine
    assert.equal(spansOf(oneSpan(strField(3, "ok"))).length, 1);
  });

  test("lengths above 2^31 are rejected before any conversion or allocation", () => {
    for (const len of [
      0x8000_0001n,
      0xffff_ffffn,
      0x1_0000_0000n,
      (1n << 63n) - 1n,
      (1n << 64n) - 1n,
    ]) {
      expectCode(() => decodeTracesProtobuf(new Uint8Array([0x0a, ...varint(len)])), BAD);
      expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(5, 2), ...varint(len)])), BAD);
    }
  });

  test("group wire types (3, 4) and reserved wire types (6, 7) are rejected", () => {
    for (const wt of [3, 4, 6, 7]) {
      expectCode(() => decodeTracesProtobuf(new Uint8Array([...tagBytes(1, wt), 0])), BAD);
      expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(99, wt), 0])), BAD);
      expectCode(() => decodeLogsProtobuf(logsOf([...tagBytes(99, wt), 0])), BAD);
    }
    // a well-formed group (start .. end) is still rejected: groups are not supported at all
    expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(50, 3), ...tagBytes(50, 4)])), BAD);
  });

  test("field number 0 and numbers above 2^29-1 are rejected; 2^29-1 is accepted", () => {
    expectCode(() => decodeTracesProtobuf(new Uint8Array([0x00, 0x00])), BAD); // tag 0
    expectCode(() => decodeTracesProtobuf(oneSpan([0x02, 0x01])), BAD); // field 0, wire type 2
    expectCode(() => decodeTracesProtobuf(oneSpan([0x00, 0x01])), BAD); // field 0, varint
    for (const num of [0x2000_0000, 0x2000_0001, 2 ** 31, 2 ** 32]) {
      expectCode(() => decodeTracesProtobuf(oneSpan([...tagBytes(num, 0), 1])), BAD);
    }
    // tag varint wider than 32 bits
    expectCode(() => decodeTracesProtobuf(oneSpan([...varint((1n << 40n) | 0n), 1])), BAD);
    assert.equal(spansOf(oneSpan([...tagBytes(0x1fff_ffff, 0), 1])).length, 1);
  });

  test("the field budget bounds the work: too-many-values for a flood of empty unknown fields", () => {
    const n = 1_000_001;
    const flood = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      flood[i * 2] = 0x7a; // field 15, LEN
      flood[i * 2 + 1] = 0x00;
    }
    const t0 = performance.now();
    expectCode(() => decodeTracesProtobuf(flood), "too-many-values");
    assert.ok(performance.now() - t0 < 5_000);
    // and an option can lower it
    expectCode(
      () => decodeTracesProtobuf(oneSpan(strField(5, "x"), strField(3, "y")), { maxValues: 4 }),
      "too-many-values",
    );
  });

  test("an empty body is an empty request; a non-Uint8Array is a typed error", () => {
    const d = decodeTracesProtobuf(new Uint8Array(0));
    assert.deepEqual(d, { signal: "traces", resourceSpans: [], rejected: [], warnings: [] });
    expectCode(() => decodeTracesProtobuf("x" as unknown as Uint8Array), BAD);
    expectCode(
      () => decodeTracesProtobuf(new Uint8Array(10), { maxBodyBytes: 9 }),
      "body-too-large",
    );
    expectCode(() => decodeTracesProtobuf(new Uint8Array(0), { maxRecords: 0 }), "invalid-option");
  });

  test("only OtlpDecodeError escapes: any other failure maps to internal", () => {
    expectCode(
      () =>
        guard(() => {
          throw new RangeError("boom");
        }),
      "internal",
    );
    const original = new OtlpDecodeError("too-many-values");
    assert.throws(
      () =>
        guard(() => {
          throw original;
        }),
      (e: unknown) => e === original,
    );
  });
});

describe("IDs", () => {
  const withIds = (
    trace: Bytes | undefined,
    span: Bytes | undefined,
    extra: Bytes = [],
  ): Uint8Array =>
    tracesOf([
      ...(trace === undefined ? [] : lenField(1, trace)),
      ...(span === undefined ? [] : lenField(2, span)),
      ...extra,
    ]);

  test("trace and span IDs must be exactly 16 and 8 bytes", () => {
    const good = withIds(TRACE, SPAN);
    assert.equal(spansOf(good)[0]?.traceId, "0102030405060708090a0b0c0d0e0f10");
    assert.equal(spansOf(good)[0]?.spanId, "0102030405060708");
    for (const t of [[], TRACE.slice(1), [...TRACE, 1], new Array(32).fill(1)]) {
      assert.deepEqual(rejectedOf(withIds(t, SPAN)), [
        { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "invalid-trace-id" },
      ]);
    }
    for (const s of [[], SPAN.slice(1), [...SPAN, 1], new Array(16).fill(1)]) {
      assert.deepEqual(
        rejectedOf(withIds(TRACE, s)).map((r) => r.reason),
        ["invalid-span-id"],
      );
    }
    // absent
    assert.deepEqual(
      rejectedOf(withIds(undefined, SPAN)).map((r) => r.reason),
      ["invalid-trace-id"],
    );
    assert.deepEqual(
      rejectedOf(withIds(TRACE, undefined)).map((r) => r.reason),
      ["invalid-span-id"],
    );
  });

  test("all-zero IDs are rejected", () => {
    assert.deepEqual(
      rejectedOf(withIds(new Array(16).fill(0), SPAN)).map((r) => r.reason),
      ["invalid-trace-id"],
    );
    assert.deepEqual(
      rejectedOf(withIds(TRACE, new Array(8).fill(0))).map((r) => r.reason),
      ["invalid-span-id"],
    );
    const lastByteOnly = [...new Array(15).fill(0), 1];
    assert.equal(
      spansOf(withIds(lastByteOnly, SPAN))[0]?.traceId,
      "00000000000000000000000000000001",
    );
  });

  test("a parent span ID is absent when empty or missing, rejected when malformed", () => {
    assert.equal(spansOf(withIds(TRACE, SPAN))[0]?.parentSpanId, null);
    assert.equal(spansOf(withIds(TRACE, SPAN, lenField(4, [])))[0]?.parentSpanId, null);
    assert.equal(
      spansOf(withIds(TRACE, SPAN, lenField(4, [0xab, 0xcd, 0xef, 1, 2, 3, 4, 5])))[0]
        ?.parentSpanId,
      "abcdef0102030405",
    );
    for (const p of [[1], new Array(7).fill(1), new Array(9).fill(1), new Array(8).fill(0)]) {
      assert.deepEqual(
        rejectedOf(withIds(TRACE, SPAN, lenField(4, p))).map((r) => r.reason),
        ["invalid-parent-span-id"],
      );
    }
  });

  test("log trace and span IDs are optional (empty means absent) but validated when present", () => {
    const rec = (...f: Bytes[]): Uint8Array => logsOf([...f.flat()]);
    const get = (b: Uint8Array) =>
      decodeLogsProtobuf(b).resourceLogs[0]?.scopeLogs[0]?.logRecords[0];
    assert.equal(get(rec(lenField(9, []), lenField(10, [])))?.traceId, null);
    assert.equal(get(rec())?.spanId, null);
    assert.equal(get(rec(lenField(9, TRACE)))?.traceId, "0102030405060708090a0b0c0d0e0f10");
    assert.deepEqual(
      decodeLogsProtobuf(rec(lenField(9, [1, 2]))).rejected.map((r) => r.reason),
      ["invalid-trace-id"],
    );
    assert.deepEqual(
      decodeLogsProtobuf(rec(lenField(10, new Array(8).fill(0)))).rejected.map((r) => r.reason),
      ["invalid-span-id"],
    );
  });

  test("link IDs are required, with the same rules", () => {
    const link = (t: Bytes, s: Bytes): Bytes =>
      lenField(13, [...lenField(1, t), ...lenField(2, s)]);
    assert.equal(spansOf(oneSpan(link(TRACE, SPAN)))[0]?.links.length, 1);
    assert.deepEqual(
      rejectedOf(oneSpan(link(TRACE.slice(1), SPAN))).map((r) => r.reason),
      ["invalid-trace-id"],
    );
    assert.deepEqual(
      rejectedOf(oneSpan(link(TRACE, [0, 0, 0, 0, 0, 0, 0, 0]))).map((r) => r.reason),
      ["invalid-span-id"],
    );
  });
});

describe("duplicates and oneof", () => {
  test("a duplicated singular field rejects that record only (duplicate-key)", () => {
    const good = [...idFields(), ...strField(5, "ok")];
    const dup = [...idFields(), ...strField(5, "a"), ...strField(5, "b")];
    const b = tracesOf(good, dup, good);
    assert.deepEqual(rejectedOf(b), [
      { path: "/resourceSpans/0/scopeSpans/0/spans/1", reason: "duplicate-key" },
    ]);
    assert.equal(spansOf(b).length, 2);
    // even when the two values are identical, and for scalar wire types
    assert.equal(rejectedOf(oneSpan(varintField(6, 1), varintField(6, 1))).length, 1);
    assert.equal(rejectedOf(oneSpan(fixed64Field(7, 1n), fixed64Field(7, 2n))).length, 1);
    assert.equal(rejectedOf(oneSpan(fixed32Field(16, 1), fixed32Field(16, 1))).length, 1);
    assert.equal(rejectedOf(oneSpan(lenField(15, []), lenField(15, []))).length, 1);
  });

  test("a duplicate nested anywhere in a record rejects the record", () => {
    const kv = (v: Bytes): Bytes => lenField(9, [...strField(1, "k"), ...lenField(2, v)]);
    assert.deepEqual(
      rejectedOf(oneSpan(kv([...strField(1, "a"), ...strField(1, "b")]))).map((r) => r.reason),
      ["duplicate-key"],
    );
    const dupKey = lenField(9, [
      ...strField(1, "k"),
      ...strField(1, "k2"),
      ...lenField(2, strField(1, "v")),
    ]);
    assert.deepEqual(
      rejectedOf(oneSpan(dupKey)).map((r) => r.reason),
      ["duplicate-key"],
    );
    const event = lenField(11, [...strField(2, "e"), ...strField(2, "f")]);
    assert.deepEqual(
      rejectedOf(oneSpan(event)).map((r) => r.reason),
      ["duplicate-key"],
    );
  });

  test("an AnyValue with more than one member, or none, is invalid-any-value", () => {
    const attr = (v: Bytes): Bytes => lenField(9, [...strField(1, "k"), ...lenField(2, v)]);
    assert.deepEqual(
      rejectedOf(oneSpan(attr([...strField(1, "a"), ...varintField(2, 1)]))).map((r) => r.reason),
      ["invalid-any-value"],
    );
    assert.deepEqual(
      rejectedOf(oneSpan(attr([...varintField(3, 1), ...lenField(5, [])]))).map((r) => r.reason),
      ["invalid-any-value"],
    );
    assert.deepEqual(
      rejectedOf(oneSpan(attr([]))).map((r) => r.reason),
      ["invalid-any-value"],
    );
    // only unknown fields inside the AnyValue is still "no member"
    assert.deepEqual(
      rejectedOf(oneSpan(attr(varintField(99, 1)))).map((r) => r.reason),
      ["invalid-any-value"],
    );
    // a KeyValue without a value
    assert.deepEqual(
      rejectedOf(oneSpan(lenField(9, strField(1, "k")))).map((r) => r.reason),
      ["invalid-any-value"],
    );
    // ... and the log body
    assert.deepEqual(
      decodeLogsProtobuf(logsOf(lenField(5, []))).rejected.map((r) => r.reason),
      ["invalid-any-value"],
    );
  });

  test("ResourceSpans / ScopeSpans singular duplicates are whole-request errors", () => {
    const rs = (inner: Bytes): Uint8Array => new Uint8Array(lenField(1, inner));
    expectCode(() => decodeTracesProtobuf(rs([...lenField(1, []), ...lenField(1, [])])), BAD);
    expectCode(() => decodeTracesProtobuf(rs([...strField(3, "a"), ...strField(3, "b")])), BAD);
    expectCode(
      () => decodeTracesProtobuf(rs(lenField(2, [...lenField(1, []), ...lenField(1, [])]))),
      BAD,
    );
    expectCode(
      () =>
        decodeLogsProtobuf(
          new Uint8Array(lenField(1, lenField(2, [...strField(3, "a"), ...strField(3, "b")]))),
        ),
      BAD,
    );
  });

  test("a duplicate inside a resource or scope rejects every record below it (duplicate-key)", () => {
    const span = [...idFields()];
    const dupResource = lenField(1, [...varintField(2, 1), ...varintField(2, 1)]);
    const b = new Uint8Array(lenField(1, [...dupResource, ...lenField(2, lenField(2, span))]));
    const d = decodeTracesProtobuf(b);
    assert.deepEqual(d.rejected, [
      { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "duplicate-key" },
    ]);
    assert.equal(d.resourceSpans.length, 0);
    const dupScope = lenField(1, [...strField(1, "n"), ...strField(1, "m")]);
    const b2 = new Uint8Array(lenField(1, lenField(2, [...dupScope, ...lenField(2, span)])));
    assert.deepEqual(
      decodeTracesProtobuf(b2).rejected.map((r) => r.reason),
      ["duplicate-key"],
    );
  });
});

describe("nesting", () => {
  /** An AnyValue array nested `n` levels (n = 1 is a scalar): protobuf bytes. */
  function nested(n: number): Bytes {
    let v: Bytes = strField(1, "x");
    for (let i = 1; i < n; i++) v = lenField(5, lenField(1, v));
    return v;
  }
  const attrOf = (v: Bytes): Bytes => lenField(9, [...strField(1, "k"), ...lenField(2, v)]);

  test("AnyValue depth 16 is accepted and 17, 33 and 100 are rejected (record only)", () => {
    const sibling = [...idFields(), ...strField(5, "sibling")];
    for (const [n, ok] of [
      [16, true],
      [17, false],
      [33, false],
      [100, false],
      [5000, false],
    ] as const) {
      const b = tracesOf([...idFields(), ...attrOf(nested(n))], sibling);
      if (ok) assert.equal(rejectedOf(b).length, 0, `depth ${n}`);
      else {
        assert.deepEqual(rejectedOf(b), [
          { path: "/resourceSpans/0/scopeSpans/0/spans/0", reason: "any-value-too-deep" },
        ]);
        assert.equal(spansOf(b).length, 1, "the sibling survives");
      }
    }
  });

  test("the same holds for kvlist chains and the log body", () => {
    let kv: Bytes = strField(1, "x");
    for (let i = 1; i < 40; i++)
      kv = lenField(6, lenField(1, [...strField(1, "k"), ...lenField(2, kv)]));
    assert.deepEqual(
      decodeLogsProtobuf(logsOf(lenField(5, kv))).rejected.map((r) => r.reason),
      ["any-value-too-deep"],
    );
    let ok: Bytes = strField(1, "x");
    for (let i = 1; i < 16; i++)
      ok = lenField(6, lenField(1, [...strField(1, "k"), ...lenField(2, ok)]));
    assert.equal(decodeLogsProtobuf(logsOf(lenField(5, ok))).rejected.length, 0);
  });

  test("the message-depth cap (32) is enforced; an AnyValue chain of 16 needs 21 levels in a span attribute", () => {
    const b = tracesOf([...idFields(), ...attrOf(nested(16))]);
    const count = (cap: number): number =>
      decodeTracesWith(b, undefined, cap).resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0;
    assert.equal(count(32), 1);
    assert.equal(count(21), 1);
    expectCode(() => decodeTracesWith(b, undefined, 20), BAD);
    expectCode(() => decodeTracesWith(b, undefined, 5), BAD);
  });

  test("agrees with the JSON decoder on the depth boundary", () => {
    for (const n of [15, 16, 17, 20]) {
      const j = decodeTracesJson(
        enc(
          spanReq([
            {
              traceId: "5b8efff798038103d269b633813fc60c",
              spanId: "00f067aa0ba902b7",
              attributes: [{ key: "k", value: nestArray(n) }],
            },
          ]),
        ),
      );
      const p = rejectedOf(tracesOf([...idFields(), ...attrOf(nested(n))]));
      assert.deepEqual(
        p.map((r) => r.reason),
        j.rejected.map((r) => r.reason),
        `array depth ${n}`,
      );
    }
    const jk = decodeTracesJson(
      enc(
        spanReq([
          {
            traceId: "5b8efff798038103d269b633813fc60c",
            spanId: "00f067aa0ba902b7",
            attributes: [{ key: "k", value: nestKv(17) }],
          },
        ]),
      ),
    );
    assert.deepEqual(
      jk.rejected.map((r) => r.reason),
      ["any-value-too-deep"],
    );
  });
});
