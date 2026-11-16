/** Terminal text helpers. Everything untrusted goes through `esc` before it is written. */
import { canonicalJson, escapeControlChars } from "@swain/core";
import { neutralizeL1 } from "@swain/report";

const MAX_ECHO_CODE_POINTS = 200;

/** Control characters, bidi and format characters become visible text; backslash is doubled. */
export function esc(s: string): string {
  return neutralizeL1(escapeControlChars(s));
}

/** Truncate by code points BEFORE escaping, then escape. Used for echoing argv tokens. */
export function echoToken(t: string): string {
  let count = 0;
  let end = 0;
  let truncated = false;
  for (const ch of t) {
    if (count === MAX_ECHO_CODE_POINTS) {
      truncated = true;
      break;
    }
    count++;
    end += ch.length;
  }
  return esc(t.slice(0, end)) + (truncated ? "..." : "");
}

/** Escape, then shorten to at most `max` code points (an ASCII "..." marks the cut). */
export function clip(s: string, max: number): string {
  const e = Array.from(esc(s));
  return e.length <= max ? e.join("") : `${e.slice(0, Math.max(0, max - 3)).join("")}...`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Short display form: `imp_` plus the first 12 hex characters (a valid unique prefix input). */
export function shortImportId(id: string): string {
  return id.slice(0, 16);
}

export function shortEventId(id: string): string {
  return id.slice(0, 12);
}

/** Left-aligned columns; `cells` are already escaped. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) =>
    Math.max(Array.from(h).length, ...rows.map((r) => Array.from(r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c + " ".repeat((widths[i] ?? 0) - Array.from(c).length))
      .join("  ")
      .trimEnd();
  return `${[line(headers), ...rows.map(line)].join("\n")}\n`;
}

const JSON_UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029\u115F\u3164]/u;

/**
 * Make JSON text safe for a terminal: every invisible or control character (except the final
 * newline) becomes a `\\uXXXX` escape. Still valid JSON with the same value, because such
 * characters can only occur inside strings.
 */
export function escapeJsonText(json: string): string {
  let out = "";
  for (const ch of json) {
    if (ch === "\n" || !JSON_UNSAFE.test(ch)) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xffff) {
      const c = cp - 0x10000;
      out += `\\u${(0xd800 + (c >> 10)).toString(16)}\\u${(0xdc00 + (c & 0x3ff)).toString(16)}`;
    } else out += `\\u${cp.toString(16).padStart(4, "0")}`;
  }
  return out;
}

export function terminalJson(v: unknown): string {
  return `${escapeJsonText(canonicalJson(v))}\n`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
