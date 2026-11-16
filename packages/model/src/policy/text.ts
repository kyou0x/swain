/**
 * Pure text helpers for the content policy: UTF-8 bounds, key neutralization, the URL rule
 * (ADR-0005 section 6.4) and a dependency-free base64 encoder.
 */
import { escapeControlChars, REDACTION_MARK } from "@swain/core";

const encoder = new TextEncoder();

export function utf8Len(s: string): number {
  return encoder.encode(s).length;
}

/** Truncate a well-formed string to at most `maxBytes` UTF-8 bytes at a code point boundary. */
export function truncateBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + w > maxBytes) return s.slice(0, end);
    bytes += w;
    end += ch.length;
  }
  return s;
}

const FORMAT_CHARS = /\p{Cf}|[\u2028\u2029]/gu;

/**
 * Attribute-key and agent-key neutralization: `escapeControlChars` (control, bidi, lone
 * surrogates, backslash) extended to the whole `\p{Cf}` set plus U+2028/U+2029 (ADR-0005 s.6.2;
 * the core function covers the subset it covered before S13).
 */
export function neutralizeText(s: string): string {
  return escapeControlChars(s).replace(FORMAT_CHARS, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    const hex = cp.toString(16).toUpperCase();
    return cp > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, "0")}`;
  });
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    const rem = bytes.length - i;
    parts.push(
      B64.charAt((n >> 18) & 63),
      B64.charAt((n >> 12) & 63),
      rem > 1 ? B64.charAt((n >> 6) & 63) : "=",
      rem > 2 ? B64.charAt(n & 63) : "=",
    );
  }
  return parts.join("");
}

const URL_KEYS = new Set(["url.full", "url.query", "url.original", "http.url", "http.target"]);
const ABSOLUTE_URL = /^[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/\S*$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{0,30}:\/\//;

export function isUrlKey(key: string): boolean {
  return URL_KEYS.has(key.toLowerCase());
}

export function looksLikeAbsoluteUrl(s: string): boolean {
  return ABSOLUTE_URL.test(s);
}

function maskQuery(query: string, namesOnly: boolean): string {
  return query
    .split("&")
    .map((piece) => {
      const eq = piece.indexOf("=");
      if (eq < 0) return piece;
      const name = piece.slice(0, eq);
      return namesOnly ? name : `${name}=${REDACTION_MARK}`;
    })
    .join("&");
}

/**
 * URL rule (ADR-0005 section 6.4): remove userinfo, replace every query value with `[REDACTED]`
 * and keep parameter names. For `url.query` only the names are kept. Total: never throws, and a
 * string that is not URL-shaped is returned with only the query transformation (when it has `?`).
 */
export function applyUrlRule(s: string, key: string | null): string {
  if (key !== null && key.toLowerCase() === "url.query") {
    const q = s.startsWith("?") ? s.slice(1) : s;
    return maskQuery(q, true);
  }
  let rest = s;
  let head = "";
  const scheme = SCHEME.exec(s);
  if (scheme !== null) {
    const afterScheme = scheme[0].length;
    let end = s.length;
    for (let i = afterScheme; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === "/" || c === "?" || c === "#") {
        end = i;
        break;
      }
    }
    const authority = s.slice(afterScheme, end);
    const at = authority.lastIndexOf("@");
    head = `${scheme[0]}${at >= 0 ? authority.slice(at + 1) : authority}`;
    rest = s.slice(end);
  }
  const q = rest.indexOf("?");
  if (q < 0) return head + rest;
  const hash = rest.indexOf("#", q);
  const path = rest.slice(0, q);
  const query = rest.slice(q + 1, hash < 0 ? rest.length : hash);
  const fragment = hash < 0 ? "" : rest.slice(hash);
  return `${head}${path}?${maskQuery(query, false)}${fragment}`;
}
