import assert from "node:assert/strict";
import { test } from "node:test";

// C3 canary: fails unless `--disallow-code-generation-from-strings` is really active in
// this test process. This is the one allowed `eval` in the repository.
test("code generation from strings is disabled in the test process", () => {
  assert.throws(
    // biome-ignore lint/security/noGlobalEval: canary for C3; must call eval to prove the flag is active
    // biome-ignore lint/complexity/noCommaOperator: indirect eval `(0, eval)` is the global-eval form the canary must exercise
    () => (0, eval)("1"),
    (e: unknown) => e instanceof EvalError,
  );
  assert.throws(
    () => new Function("return 1"),
    (e: unknown) => e instanceof EvalError,
  );
});
