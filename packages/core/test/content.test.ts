import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, makeContentRef } from "../src/content/index.js";
import { AtmError, type AtmErrorCode } from "../src/errors.js";
import { sha256Hex } from "../src/ids/index.js";

const enc = new TextEncoder();
const h = (s: string) => sha256Hex(enc.encode(s));

test("JCS vectors", () => {
  const a = canonicalJson(JSON.parse('{"b":1,"a":[true,null,"é"],"A":{"z":0.5,"y":-0}}'));
  assert.equal(a, '{"A":{"y":0,"z":0.5},"a":[true,null,"é"],"b":1}');
  assert.equal(h(a), "9d9dcb48b1f930c438ccef1b8dd7f3e01e97c09bd8a60a6dda7ec51af6918ccb");

  const b = canonicalJson(JSON.parse('{"\\uffff":1,"\\ud83d\\ude00":2}'));
  assert.equal(b, '{"\u{1f600}":2,"￿":1}');
  assert.equal(h(b), "48c5d098713870a7b88be7fc0ffc0a79e912d20f80ea8a4a5604426f49add103");

  const c = canonicalJson(JSON.parse('{"n":1e21,"m":1E-7,"s":"line\\nbreak"}'));
  assert.equal(c, '{"m":1e-7,"n":1e+21,"s":"line\\nbreak"}');
  assert.equal(h(c), "a62863009499e8a7dfd95aacc9eedca5ceddbadcf3685a3c905c454e92cbe380");
});

function nest(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

function expectCode(fn: () => unknown, code: AtmErrorCode): void {
  assert.throws(fn, (e: unknown) => e instanceof AtmError && e.code === code);
}

class Foo {
  x = 1;
}

test("JCS rejections are typed", () => {
  expectCode(() => canonicalJson(nest(65)), "json-depth-exceeded");
  assert.equal(canonicalJson(nest(64)).length, 64 * 2 + 1);
  const cyc: Record<string, unknown> = {};
  cyc["self"] = cyc;
  expectCode(() => canonicalJson(cyc), "json-cycle");
  expectCode(() => canonicalJson(Number.NaN), "json-non-finite");
  expectCode(() => canonicalJson(Number.POSITIVE_INFINITY), "json-non-finite");
  expectCode(() => canonicalJson(undefined), "json-unsupported-type");
  expectCode(() => canonicalJson({ a: undefined }), "json-unsupported-type");
  expectCode(() => canonicalJson(() => 1), "json-unsupported-type");
  expectCode(() => canonicalJson(10n), "json-unsupported-type");
  expectCode(() => canonicalJson(Symbol("s")), "json-unsupported-type");
  expectCode(() => canonicalJson(new Date(0)), "json-unsupported-type");
  expectCode(() => canonicalJson(new Map()), "json-unsupported-type");
  expectCode(() => canonicalJson(new Foo()), "json-unsupported-type");
  expectCode(
    () =>
      canonicalJson({
        get a() {
          return 1;
        },
      }),
    "json-unsupported-type",
  );
  expectCode(() => canonicalJson({ "\ud800": 1 }), "json-ill-formed-string");
  expectCode(() => canonicalJson({ a: "\udc00" }), "json-ill-formed-string");
  expectCode(() => canonicalJson("\udc00"), "json-ill-formed-string");
  expectCode(() => canonicalJson(new Array(3)), "json-unsupported-type");
});

test("canonicalJson accepts null-prototype objects and nested plain data", () => {
  const o = Object.create(null) as Record<string, unknown>;
  o["b"] = [1, { d: 2, c: 3 }];
  o["a"] = "x";
  assert.equal(canonicalJson(o), '{"a":"x","b":[1,{"c":3,"d":2}]}');
});

test("makeContentRef hash-only", () => {
  const r = makeContentRef("hello");
  assert.deepEqual(r, {
    sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    byteLength: 5,
    encoding: "utf8",
    retention: "hash-only",
  });
  assert.equal(Object.hasOwn(r, "inline"), false);
});

test("makeContentRef jcs-json", () => {
  const r = makeContentRef({ b: 1, a: 2 });
  assert.equal(r.encoding, "jcs-json");
  assert.equal(r.byteLength, 13);
  assert.equal(r.sha256, h('{"a":2,"b":1}'));
});

test("makeContentRef inline truncation keeps hash over full value", () => {
  const big = "é".repeat(40000);
  const r = makeContentRef(big, { retention: "inline", maxInlineBytes: 65536 });
  assert.equal(r.retention, "inline-truncated");
  assert.equal(r.byteLength, 80000);
  assert.equal(r.sha256, h(big));
  assert.ok(r.inline !== undefined);
  const inline = r.inline ?? "";
  assert.ok(enc.encode(inline).length <= 65536);
  assert.ok(inline.isWellFormed());
});

test("makeContentRef truncates at a code point boundary", () => {
  const r = makeContentRef("a\u{1f600}b", { retention: "inline", maxInlineBytes: 3 });
  assert.equal(r.retention, "inline-truncated");
  assert.equal(r.inline, "a");
  const full = makeContentRef("abc", { retention: "inline", maxInlineBytes: 3 });
  assert.equal(full.retention, "inline");
  assert.equal(full.inline, "abc");
});

test("makeContentRef rejects invalid maxInlineBytes", () => {
  for (const n of [0, 1048577, 1.5, -1, Number.NaN]) {
    expectCode(
      () => makeContentRef("x", { retention: "inline", maxInlineBytes: n }),
      "invalid-option",
    );
  }
  assert.equal(
    makeContentRef("x", { retention: "inline", maxInlineBytes: 1048576 }).retention,
    "inline",
  );
});

test("makeContentRef propagates canonicalJson errors", () => {
  expectCode(() => makeContentRef(Number.NaN), "json-non-finite");
  expectCode(() => makeContentRef("\ud800"), "json-ill-formed-string");
});
