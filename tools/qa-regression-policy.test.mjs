// G2 (QA) regression tests for findings F1-F7. They failed on the pre-fix commit and pass after
// the fix round. Keep them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFile, rulesFor } from "./policy-check.mjs";

const CORE = "packages/core/src/x.ts";

function findings(text) {
  return checkFile(CORE, text, rulesFor(CORE)).map((f) => f.rule);
}

test("QA-F1 P-IDENT/P-PROCESS: instantiation expressions hide banned identifiers (eval<string>, Function<string>, process<string>)", () => {
  // `ExpressionWithTypeArguments` is treated as a type position, so the identifier is skipped.
  // TypeScript erases the type arguments, so the emitted JS references the real global.
  assert.ok(findings("export const e = eval<string>;").includes("P-IDENT"), "eval<string>");
  assert.ok(findings("export const F = Function<string>;").includes("P-IDENT"), "Function<string>");
  assert.ok(findings("export const p = process<string>;").includes("P-PROCESS"), "process<string>");
  assert.ok(
    findings("export const g = globalThis<string>;").includes("P-IDENT"),
    "globalThis<string>",
  );
  assert.ok(findings("export const d = Date<string>;").includes("P-DATE"), "Date<string>");
});

test("QA-F2 P-DATE: new Date(...spread) reads the clock when the spread is empty", () => {
  // `new Date(...[])` is `new Date()` at runtime = current time. The rule only counts arguments.
  assert.ok(findings("export const d = new Date(...[]);").includes("P-DATE"));
  assert.ok(
    findings("const a: number[] = []; export const d = new Date(...a);").includes("P-DATE"),
  );
});

test("QA-F3 P-RANDOM: Math.random hidden by parentheses, aliasing or destructuring", () => {
  assert.ok(findings("export const r = (Math).random();").includes("P-RANDOM"), "(Math).random()");
  assert.ok(findings("const M = Math; export const r = M.random();").includes("P-RANDOM"), "alias");
  assert.ok(
    findings("const { random } = Math; export const r = random();").includes("P-RANDOM"),
    "destructure",
  );
  assert.ok(
    findings("export const r = (Math as { random(): number }).random();").includes("P-RANDOM"),
    "as-cast",
  );
  assert.ok(findings("export const r = Math!.random();").includes("P-RANDOM"), "non-null");
});

test("QA-F4 P-LOCALE: locale methods reached by destructuring", () => {
  assert.ok(
    findings("const { localeCompare } = 'a'; export const r = localeCompare;").includes("P-LOCALE"),
  );
});

test("QA-F7 checkFile must not throw on string-literal import specifiers (ES2022 module export names)", () => {
  // idText() is called on a StringLiteral and the check crashes with a TypeError instead of
  // reporting a finding. It fails closed (npm run policy exits non-zero) but loses the report.
  let f;
  assert.doesNotThrow(() => {
    f = findings("import { 'randomUUID' as r } from 'node:crypto'; export const a = r;");
  });
  assert.ok(f?.includes("P-RANDOM"));
});
