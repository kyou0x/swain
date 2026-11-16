function hex4(n: number): string {
  return `\\u${n.toString(16).toUpperCase().padStart(4, "0")}`;
}

function isEscapedCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    cp === 0x61c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    (cp >= 0xd800 && cp <= 0xdfff)
  );
}

/**
 * Neutralize terminal and bidi control characters in untrusted text.
 * `\` becomes `\\`; U+0000-U+001F, U+007F-U+009F, U+061C, U+200E, U+200F,
 * U+202A-U+202E, U+2066-U+2069 and lone surrogates become `\uXXXX`.
 *
 * Known gap (L1): not yet all `\p{Cf}`, tag characters or U+2028/U+2029 (S7).
 */
export function escapeControlChars(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (isEscapedCodePoint(cp)) out += hex4(cp);
    else out += ch;
  }
  return out;
}

/** UTF-8 byte length of a well-formed string, computed without allocation. */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Truncate to at most `max` code points. Returns the text and whether it was cut. */
export function truncateCodePoints(s: string, max: number): { text: string; truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const ch of s) {
    if (count === max) return { text: s.slice(0, end), truncated: true };
    count++;
    end += ch.length;
  }
  return { text: s, truncated: false };
}

/** Truncate a well-formed string to at most `maxBytes` UTF-8 bytes at a code point boundary. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + w > maxBytes) return { text: s.slice(0, end), truncated: true };
    bytes += w;
    end += ch.length;
  }
  return { text: s, truncated: false };
}
