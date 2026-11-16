// G2 (QA) regression tests for findings F5/F6. They failed on the pre-fix commit and pass after
// the fix round. Keep them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { AtmError, canonicalJson } from "../src/index.js";

test("QA-F5: canonicalJson with a non-enumerable accessor throws json-unsupported-type (SPEC section 4: same plain-data rule as the validator, which rejects hidden accessors)", () => {
  const o = { a: 1 };
  Object.defineProperty(o, "hidden", {
    get: () => 2,
    enumerable: false,
  });
  assert.throws(
    () => canonicalJson(o),
    (e: unknown) => e instanceof AtmError && e.code === "json-unsupported-type",
  );
});

test("QA-F6: canonicalJson with an invalid maxDepth (NaN/Infinity/huge) throws a typed AtmError, never RangeError", () => {
  let v: unknown = 1;
  for (let i = 0; i < 200_000; i++) v = [v];
  for (const maxDepth of [Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000]) {
    assert.throws(
      () => canonicalJson(v, { maxDepth }),
      (e: unknown) => e instanceof AtmError,
      `maxDepth=${maxDepth}`,
    );
  }
});
