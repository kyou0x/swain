// Independent G2 (QA) re-verification of the canonicalJson fixes (F5, F6): variant inputs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AtmError, canonicalJson, makeContentRef } from "../src/index.js";

const isCode =
  (code: string) =>
  (e: unknown): boolean =>
    e instanceof AtmError && e.code === code;

const nest = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};

test("F5: hidden data property, hidden accessor, hidden setter, in nested position, are all unsupported", () => {
  const hiddenData = { a: 1 };
  Object.defineProperty(hiddenData, "h", { value: 2, enumerable: false });
  const hiddenGet = { a: 1 };
  Object.defineProperty(hiddenGet, "h", { get: () => 2, enumerable: false });
  const hiddenSet = { a: 1 };
  Object.defineProperty(hiddenSet, "h", { set: () => undefined, enumerable: false });
  for (const bad of [hiddenData, hiddenGet, hiddenSet, [hiddenGet], { k: { j: hiddenGet } }]) {
    assert.throws(() => canonicalJson(bad), isCode("json-unsupported-type"));
    assert.throws(() => makeContentRef(bad), isCode("json-unsupported-type"));
  }
});

test("F5: symbol keys are ignored (as in JSON); enumerable data props still serialize", () => {
  const o: Record<string | symbol, unknown> = { b: 1, a: 2 };
  o[Symbol("s")] = 3;
  assert.equal(canonicalJson(o), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson(Object.create(null, { x: { value: 1, enumerable: true } })),
    '{"x":1}',
  );
});

test("F5: a lone-surrogate hidden key is still a typed error (not a crash)", () => {
  const o = {};
  Object.defineProperty(o, "\ud800", { value: 1, enumerable: false });
  assert.throws(
    () => canonicalJson(o),
    (e: unknown) => e instanceof AtmError,
  );
});

test("F6: maxDepth outside 1..64 or not an integer is invalid-option; 1 and 64 work", () => {
  for (const bad of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    65,
    1e9,
    1.5,
    "5",
    {},
    10n,
  ]) {
    assert.throws(
      () => canonicalJson(1, { maxDepth: bad as number }),
      isCode("invalid-option"),
      String(bad),
    );
  }
  assert.equal(canonicalJson(1, { maxDepth: 1 }), "1");
  assert.equal(canonicalJson([1], { maxDepth: 1 }), "[1]");
  assert.throws(() => canonicalJson([[1]], { maxDepth: 1 }), isCode("json-depth-exceeded"));
  assert.doesNotThrow(() => canonicalJson(nest(64), { maxDepth: 64 }));
  assert.throws(() => canonicalJson(nest(65), { maxDepth: 64 }), isCode("json-depth-exceeded"));
  // undefined option means default
  assert.doesNotThrow(() => canonicalJson(nest(64), {} as { maxDepth?: number }));
  assert.throws(() => canonicalJson(nest(200_000)), isCode("json-depth-exceeded"));
});
