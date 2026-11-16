import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../src/content/index.js";
import { AtmError, type AtmErrorCode } from "../src/errors.js";

function code(fn: () => unknown): AtmErrorCode | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AtmError ? e.code : undefined;
  }
  return undefined;
}

test("F5: non-enumerable properties and hidden accessors are rejected, in objects and arrays", () => {
  const hiddenGetter = { a: 1 };
  Object.defineProperty(hiddenGetter, "h", { get: () => 2, enumerable: false });
  assert.equal(
    code(() => canonicalJson(hiddenGetter)),
    "json-unsupported-type",
  );
  const hiddenValue = { a: 1 };
  Object.defineProperty(hiddenValue, "h", { value: 2, enumerable: false });
  assert.equal(
    code(() => canonicalJson(hiddenValue)),
    "json-unsupported-type",
  );
  const arr = [1, 2];
  Object.defineProperty(arr, "extra", { value: 3, enumerable: false });
  assert.equal(
    code(() => canonicalJson(arr)),
    "json-unsupported-type",
  );
  assert.equal(canonicalJson({ b: 1, a: [1] }), '{"a":[1],"b":1}');
});

test("F6: maxDepth must be an integer in 1..64, else invalid-option", () => {
  for (const d of [0, -1, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000]) {
    assert.equal(
      code(() => canonicalJson(1, { maxDepth: d })),
      "invalid-option",
      String(d),
    );
  }
  assert.equal(canonicalJson([1], { maxDepth: 1 }), "[1]");
  assert.equal(
    code(() => canonicalJson([[1]], { maxDepth: 1 })),
    "json-depth-exceeded",
  );
  assert.equal(canonicalJson(1, { maxDepth: 64 }), "1");
});
