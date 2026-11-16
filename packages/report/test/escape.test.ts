import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtmlText, escapeMarkdownText } from "../src/index.js";

const cp = (n: number): string => String.fromCodePoint(n);

test("markdown: every ASCII punctuation character is backslash-escaped", () => {
  assert.equal(
    escapeMarkdownText("[x](javascript:alert(1))"),
    "\\[x\\]\\(javascript\\:alert\\(1\\)\\)",
  );
  assert.equal(escapeMarkdownText("a|b `c` <d> !e"), "a\\|b \\`c\\` \\<d\\> \\!e");
  assert.equal(escapeMarkdownText("plain words 123"), "plain words 123");
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    const out = escapeMarkdownText(ch);
    assert.equal(out, /[0-9A-Za-z]/.test(ch) ? ch : `\\${ch}`);
  }
});

test("L1: control, bidi, format, separators, tags and fillers become visible text", () => {
  const cases: [number, string][] = [
    [0x1b, "\\\\u\\{1B\\}"],
    [0x07, "\\\\u\\{7\\}"],
    [0x00, "\\\\u\\{0\\}"],
    [0x7f, "\\\\u\\{7F\\}"],
    [0x85, "\\\\u\\{85\\}"],
    [0x202e, "\\\\u\\{202E\\}"],
    [0x2066, "\\\\u\\{2066\\}"],
    [0x200b, "\\\\u\\{200B\\}"],
    [0xfeff, "\\\\u\\{FEFF\\}"],
    [0x2028, "\\\\u\\{2028\\}"],
    [0x2029, "\\\\u\\{2029\\}"],
    [0xe0041, "\\\\u\\{E0041\\}"],
    [0x115f, "\\\\u\\{115F\\}"],
    [0x3164, "\\\\u\\{3164\\}"],
    [0xd800, "\\\\u\\{D800\\}"],
  ];
  for (const [c, expected] of cases) {
    assert.equal(escapeMarkdownText(`a${cp(c)}b`), `a${expected}b`, c.toString(16));
    assert.equal(
      escapeHtmlText(`a${cp(c)}b`),
      `a\\u{${c.toString(16).toUpperCase()}}b`,
      c.toString(16),
    );
  }
});

test("CR and LF become literal \\n", () => {
  assert.equal(escapeMarkdownText("a\r\nb\nc"), "a\\\\n\\\\nb\\\\nc");
  assert.equal(escapeHtmlText("a\r\nb"), "a\\n\\nb");
});

test("html: entities for & < > quote and apostrophe", () => {
  assert.equal(
    escapeHtmlText(`<img src="x" onerror='a&b'>`),
    "&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;",
  );
});
