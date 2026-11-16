import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Bounds, FramedRecord } from "../../src/adapter/contract.js";
import { DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { frameSource } from "../../src/ingest/frame/index.js";
import { fixtureBytes } from "../pipeline/ref-adapter.js";

const enc = new TextEncoder();
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const jsonl = { kind: "jsonl" } as const;
const frame = (s: string | Uint8Array, b: Partial<Bounds> = {}) =>
  frameSource(typeof s === "string" ? enc.encode(s) : s, jsonl, { ...DEFAULT_BOUNDS, ...b });
const doc = (s: string | Uint8Array, arrays: string[] = ["/messages"], b: Partial<Bounds> = {}) =>
  frameSource(
    typeof s === "string" ? enc.encode(s) : s,
    { kind: "json-document", recordArrays: arrays },
    {
      ...DEFAULT_BOUNDS,
      ...b,
    },
  );
const failure = (r: FramedRecord | undefined): string =>
  r === undefined ? "missing" : r.parse.ok ? "ok" : r.parse.failure;
const codes = (r: { warnings: readonly { code: string }[] }): string[] =>
  r.warnings.map((w) => w.code);

test("P0-PLAN S2 vector: three records, one blank line, CR kept, truncated final line", () => {
  const r = frame('a\n{"x":1}\r\n\n{"y":');
  assert.equal(r.records.length, 3);
  assert.equal(r.blankLines, 1);
  const [a, b, c] = r.records;
  assert.deepEqual([a?.line, a?.sourceSequence, failure(a)], [1, 0, "malformed"]);
  assert.deepEqual([b?.line, b?.sourceSequence, b?.parse.ok], [2, 1, true]);
  assert.equal(b?.byteLength, 8); // {"x":1}\r
  assert.equal(b?.finalWithoutNewline, false);
  assert.deepEqual(
    [c?.line, c?.sourceSequence, c?.finalWithoutNewline, failure(c)],
    [4, 2, true, "malformed"],
  );
});

test("ADR-0002 section 6 hash vectors", () => {
  const r = frame('{"type":"turn.started"}\n');
  assert.equal(
    r.records[0]?.sha256,
    "7306b54975174c6eb5111d663a47de795d167520e43cf66ee2923218b19fdb75",
  );
  assert.equal(r.records[0]?.byteLength, 24 - 1);
  assert.equal(
    sha(enc.encode('{"type":"turn.started"}\n')),
    "cf515a4acc6e41e0f111f01c78b13ba4253f611de9374474864f01e69a90c08f",
  );
});

test("empty input, newline only, and whitespace-only lines have no records", () => {
  assert.equal(frame("").records.length, 0);
  const r = frame("\n  \n\t\r\n");
  assert.equal(r.records.length, 0);
  assert.equal(r.blankLines, 3);
});

test("BOM stays in the first record bytes, warns, and parses", () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('{"a":1}\n')]);
  const r = frame(bytes);
  assert.equal(r.records[0]?.parse.ok, true);
  assert.equal(r.records[0]?.byteLength, 3 + 7);
  assert.equal(r.records[0]?.sha256, sha(bytes.subarray(0, 10)));
  assert.deepEqual(codes(r), ["utf8-bom"]);
});

test("record hash covers the exact span; offsets locate it", () => {
  const text = '{"a":1}\n\n  {"b":[1,2]}  \r\n{"c":3}';
  const bytes = enc.encode(text);
  const r = frame(bytes);
  assert.equal(r.records.length, 3);
  for (const rec of r.records) {
    const span = bytes.subarray(rec.byteOffset, rec.byteOffset + rec.byteLength);
    assert.equal(sha(span), rec.sha256);
  }
  assert.equal(r.records[1]?.line, 3);
  assert.equal(r.records[2]?.finalWithoutNewline, true);
});

test("huge line: too-large without parsing; hash still covers the whole line", () => {
  const huge = new Uint8Array(17 * 1024 * 1024).fill(0x61);
  const bytes = new Uint8Array(huge.length + 13);
  bytes.set(enc.encode('{"ok":true}\n'), 0);
  bytes.set(huge, 12);
  bytes[12 + huge.length] = 0x0a;
  const r = frame(bytes);
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0]?.parse.ok, true);
  assert.equal(failure(r.records[1]), "too-large");
  assert.equal(r.records[1]?.byteLength, huge.length);
  assert.equal(r.records[1]?.sha256, sha(huge));
});

test("depth: 64 ok, 65 depth failure; brackets in strings do not count", () => {
  assert.equal(frame(`${"[".repeat(64)}${"]".repeat(64)}`).records[0]?.parse.ok, true);
  assert.equal(failure(frame(`${"[".repeat(65)}${"]".repeat(65)}`).records[0]), "depth");
  assert.equal(failure(frame("[".repeat(65)).records[0]), "depth");
  assert.equal(frame(`["${"[".repeat(500)}"]`).records[0]?.parse.ok, true);
  assert.equal(failure(frame("[".repeat(200_000)).records[0]), "depth");
});

test("invalid UTF-8 is its own failure; lone continuation bytes too", () => {
  const bad = new Uint8Array([...enc.encode('{"x":"'), 0xc3, 0x28, ...enc.encode('"}')]);
  assert.equal(failure(frame(bad).records[0]), "invalid-utf8");
  assert.equal(failure(frame(new Uint8Array([0xff, 0x0a, 0x7b, 0x7d])).records[0]), "invalid-utf8");
});

test("malformed JSON shapes are rejected by the scanner", () => {
  for (const s of [
    "{",
    "}",
    '{"a":}',
    '{"a":1,}',
    "[1,]",
    "[01]",
    "[1.]",
    "[.5]",
    "[+1]",
    '{"a" 1}',
    "{a:1}",
    "'x'",
    '"\\x"',
    '"\\u12G4"',
    '"a\tb"',
    "nul",
    "tru",
    "[1 2]",
    '{"a":1} {"b":2}',
    "1 2",
  ]) {
    assert.equal(failure(frame(s).records[0]), "malformed", s);
  }
  for (const s of [
    "0",
    "-0",
    "1e5",
    "-1.5E+3",
    "true",
    "null",
    '"\\u00e9\\n"',
    "[]",
    "{}",
    '{"a":[{}]}',
  ]) {
    assert.equal(frame(s).records[0]?.parse.ok, true, s);
  }
});

test("duplicate keys at depth 3: warning, last value mapped", () => {
  const r = frame('{"a":{"b":{"c":1,"c":2}}}\n');
  const rec = r.records[0];
  assert.equal(rec?.parse.ok, true);
  assert.deepEqual(rec?.parse.ok ? rec.parse.value : null, { a: { b: { c: 2 } } });
  assert.equal(r.warnings.filter((w) => w.code === "duplicate-json-key").length, 1);
  assert.equal(r.warnings[0]?.sourceSequence, 0);
});

test("duplicate keys: escaped and raw forms are the same key; distinct objects do not collide", () => {
  assert.equal(codes(frame('{"a":1,"\\u0061":2}')).join(), "duplicate-json-key");
  assert.equal(codes(frame('{"a":{"x":1},"b":{"x":2}}')).length, 0);
  assert.equal(codes(frame('{"é":1,"\\u00e9":2}')).join(), "duplicate-json-key");
  assert.equal(codes(frame('{"a":1,"A":2}')).length, 0);
});

test("__proto__ keys are data, not prototype pollution", () => {
  const r = frame('{"__proto__":{"polluted":1},"constructor":{"prototype":{"p":1}}}');
  assert.equal(r.records[0]?.parse.ok, true);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  const v = r.records[0]?.parse.ok ? r.records[0].parse.value : null;
  assert.ok(v !== null && typeof v === "object" && Object.hasOwn(v, "__proto__"));
});

test("maxRecords stops framing and reports the limit", () => {
  const r = frame('{"a":1}\n{"a":2}\n{"a":3}\n', { maxRecords: 2 });
  assert.equal(r.records.length, 2);
  assert.equal(r.recordLimitHit, true);
  assert.deepEqual(codes(r), ["bounds-reached"]);
});

test("maxRecordBytes boundary: exactly at the limit is accepted", () => {
  assert.equal(frame('{"a":1}', { maxRecordBytes: 7 }).records[0]?.parse.ok, true);
  assert.equal(failure(frame('{"a":1}', { maxRecordBytes: 6 }).records[0]), "too-large");
});

test("framing is deterministic", () => {
  const b = fixtureBytes("reference/ref-basic.ref.jsonl");
  assert.deepEqual(frame(b), frame(b));
});

// ---- json-document ----

const DOC =
  '{\n  "id": "D",\n  "messages": [\n    {"a": 1},\n    {\n      "b": 2\n    }\n  ],\n  "tail": 1\n}\n';

test("json-document: envelope, element spans, hashes and lines are recomputed independently", () => {
  const bytes = enc.encode(DOC);
  const r = doc(bytes);
  assert.equal(r.records.length, 3);
  assert.deepEqual(r.recordBase, ["", "/messages/0", "/messages/1"]);
  const [env, e0, e1] = r.records;
  assert.equal(env?.byteOffset, 0);
  assert.equal(env?.byteLength, bytes.length);
  assert.equal(env?.sha256, sha(bytes));
  assert.deepEqual(env?.parse.ok ? env.parse.value : null, { id: "D", tail: 1 });
  const text0 = '{"a": 1}';
  const text1 = '{\n      "b": 2\n    }';
  assert.equal(e0?.byteOffset, DOC.indexOf(text0));
  assert.equal(e0?.byteLength, text0.length);
  assert.equal(e0?.sha256, sha(enc.encode(text0)));
  assert.equal(e0?.line, 4);
  assert.equal(e1?.byteOffset, DOC.indexOf(text1));
  assert.equal(e1?.sha256, sha(enc.encode(text1)));
  assert.equal(e1?.line, 5);
  assert.deepEqual(e1?.parse.ok ? e1.parse.value : null, { b: 2 });
  assert.equal(e1?.finalWithoutNewline, false);
});

test("json-document: BOM and surrounding whitespace allowed, other trailing bytes are malformed", () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode(`  ${DOC}  \n\n`)]);
  const r = doc(withBom);
  assert.equal(r.records.length, 3);
  assert.deepEqual(codes(r), ["utf8-bom"]);
  const bad = doc(`${DOC} x`);
  assert.equal(bad.records.length, 1);
  assert.equal(failure(bad.records[0]), "malformed");
});

test("json-document: missing and non-array record arrays warn and keep the member", () => {
  const r = doc('{"id":"D","other":[1]}');
  assert.equal(r.records.length, 1);
  assert.deepEqual(codes(r), ["record-array-missing"]);
  const s = doc('{"messages":"nope"}');
  assert.deepEqual(codes(s), ["record-array-missing"]);
  assert.deepEqual(s.records[0]?.parse.ok ? s.records[0].parse.value : null, { messages: "nope" });
});

test("json-document: nested pointers, several arrays in declared order", () => {
  const text = '{"b":[{"n":"b0"}],"s":{"a":[{"n":"a0"},{"n":"a1"}]}}';
  const r = doc(text, ["/s/a", "/b"]);
  assert.deepEqual(r.recordBase, ["", "/s/a/0", "/s/a/1", "/b/0"]);
  assert.deepEqual(r.records[0]?.parse.ok ? r.records[0].parse.value : null, { s: {} });
  assert.deepEqual(
    r.records.slice(1).map((x) => (x.parse.ok ? (x.parse.value as { n: string }).n : "")),
    ["a0", "a1", "b0"],
  );
});

test("json-document: scalar and nested elements keep exact spans", () => {
  const text = '{"m":[1, "x" ,[2,3],{"k":[4]}, null]}';
  const bytes = enc.encode(text);
  const r = doc(bytes, ["/m"]);
  const spans = r.records
    .slice(1)
    .map((x) => text.slice(x.byteOffset, x.byteOffset + x.byteLength));
  assert.deepEqual(spans, ["1", '"x"', "[2,3]", '{"k":[4]}', "null"]);
});

test("json-document: depth 65 within the document, malformed, too-large", () => {
  const deep = doc(`{"messages":[${"[".repeat(63)}${"]".repeat(63)}]}`);
  assert.equal(failure(deep.records[0]), "depth");
  assert.equal(deep.records.length, 1);
  const ok = doc(`{"messages":[${"[".repeat(62)}${"]".repeat(62)}]}`);
  assert.equal(ok.records.length, 2);
  assert.equal(failure(doc('{"messages":[{"a":1},]}').records[0]), "malformed");
  const big = doc('{"messages":[]}', ["/messages"], { maxDocumentBytes: 5 });
  assert.equal(failure(big.records[0]), "too-large");
  assert.equal(big.records.length, 1);
});

test("json-document: element too-large, maxRecords, invalid UTF-8", () => {
  const r = doc('{"messages":[{"a":1},{"bbbbbbbbbb":2}]}', ["/messages"], { maxRecordBytes: 9 });
  assert.equal(r.records[1]?.parse.ok, true);
  assert.equal(failure(r.records[2]), "too-large");
  const limited = doc('{"messages":[1,2,3]}', ["/messages"], { maxRecords: 2 });
  assert.equal(limited.records.length, 3);
  assert.equal(limited.recordLimitHit, true);
  const bad = new Uint8Array([...enc.encode('{"messages":["'), 0xc3, 0x28, ...enc.encode('"]}')]);
  assert.equal(failure(doc(bad).records[0]), "invalid-utf8");
});

test("json-document: duplicate keys are attributed to their element or the envelope", () => {
  const r = doc('{"x":1,"x":2,"messages":[{"k":1},{"k":1,"k":2}]}');
  const dup = r.warnings.filter((w) => w.code === "duplicate-json-key");
  assert.deepEqual(
    dup.map((w) => w.sourceSequence),
    [0, 2],
  );
});

test("json-document: fixture file", () => {
  const r = doc(fixtureBytes("reference/ref-doc.json"));
  assert.equal(r.records.length, 3);
  assert.equal(r.records[1]?.line, 5);
  assert.equal(r.records[2]?.line, 6);
  assert.deepEqual(r.warnings, []);
});

test("G3-2: json-document retains at most maxRecords+1 spans (scan bound)", async () => {
  const { scanJson } = await import("../../src/ingest/frame/scan.js");
  const body = enc.encode(`{"messages":[${new Array(5000).fill("1").join(",")}]}`);
  const r = scanJson(body, 0, body.length, 64, [["messages"]], 1, { maxValues: 1e9, maxSpans: 11 });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.elements[0]?.length, 11);
  const f = doc(body, ["/messages"], { maxRecords: 10 });
  assert.equal(f.recordLimitHit, true);
  assert.equal(f.records.length, 11);
});

test("G3-2: JSON value budget fails too-large (document and jsonl), without crashing", () => {
  const d = doc(`{"messages":[1,2,3,4,5,6]}`, ["/messages"], { maxJsonValues: 8 });
  assert.equal(failure(d.records[0]), "too-large");
  const exact = doc(`{"messages":[1,2,3,4,5,6]}`, ["/messages"], { maxJsonValues: 9 });
  assert.equal(failure(exact.records[0]), "ok");
  const k = doc(`{"messages":[],"a":1,"b":2}`, ["/messages"], { maxJsonValues: 4 });
  assert.equal(failure(k.records[0]), "too-large");
  const j = frame("[1,2]\n[3,4]\n[5,6]\n", { maxJsonValues: 7 });
  assert.deepEqual(j.records.map(failure), ["ok", "ok", "too-large"]);
});
