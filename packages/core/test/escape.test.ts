import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeControlChars } from "../src/text/index.js";
import { assertEqualEscaped } from "./helpers.js";

// U+202E (RIGHT-TO-LEFT OVERRIDE) is built from its code unit so no raw bidi control
// character appears in this source file.
const RLO = String.fromCharCode(0x202e);

test("escapeControlChars vector", () => {
  const out = escapeControlChars(`a\u001b[31mb\\${RLO}c\u0000`);
  assertEqualEscaped(out, "a\\u001B[31mb\\\\\\u202Ec\\u0000");
  assert.ok(!out.includes("\u001b"));
  assert.ok(!out.includes(RLO));
  assert.ok(!out.includes("\u0000"));
});

test("escapeControlChars covers the S1 set", () => {
  const cps = [
    0x00, 0x07, 0x0a, 0x1f, 0x7f, 0x85, 0x9f, 0x61c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069,
  ];
  for (const cp of cps) {
    const out = escapeControlChars(String.fromCodePoint(cp));
    assert.equal(out, `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  assert.equal(escapeControlChars("\ud800"), "\\uD800");
  assert.equal(escapeControlChars("x\udc00y"), "x\\uDC00y");
  assert.equal(escapeControlChars("\u{1f600} é ~"), "\u{1f600} é ~");
});
