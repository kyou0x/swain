/**
 * Escaping for untrusted text (SPEC-002 section 6). Pure.
 * L1 neutralization turns invisible and control characters into visible `\u{HEX}` text; CR/LF become
 * the two-character literal `\n`.
 */

// C0/C1/DEL, every format character (bidi controls, tag characters U+E0000-E007F, zero-width and
// joiner characters), lone surrogates, line/paragraph separators and the Hangul fillers.
const L1_RE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\u115F\u3164]/u;

/** L1 neutralization only. A backslash is left as is (callers add their own escaping). */
export function neutralizeL1(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a || cp === 0x0d) out += "\\n";
    else if (L1_RE.test(ch)) out += `\\u{${cp.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return out;
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/** L1, then a backslash before every ASCII punctuation character (Markdown text context). */
export function escapeMarkdownText(s: string): string {
  let out = "";
  for (const ch of neutralizeL1(s)) out += ASCII_PUNCT.test(ch) ? `\\${ch}` : ch;
  return out;
}

/** Entity-escape `& < > " '`, then L1 (HTML text context; never used for attribute values). */
export function escapeHtmlText(s: string): string {
  let out = "";
  for (const ch of neutralizeL1(s)) {
    switch (ch) {
      case "&":
        out += "&amp;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case "'":
        out += "&#39;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}
