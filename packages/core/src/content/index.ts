import { AtmError } from "../errors.js";
import { sha256Hex } from "../ids/index.js";
import type { ContentRef } from "../schema/types.js";
import { truncateUtf8 } from "../text/index.js";

export const MAX_INLINE_BYTES_LIMIT = 1_048_576;
const DEFAULT_MAX_INLINE_BYTES = 65_536;
const encoder = new TextEncoder();

export interface CanonicalJsonOptions {
  readonly maxDepth?: number;
}

function checkString(s: string): void {
  if (!s.isWellFormed()) throw new AtmError("json-ill-formed-string");
}

function unsupported(): never {
  throw new AtmError("json-unsupported-type");
}

function serialize(v: unknown, depth: number, maxDepth: number, active: WeakSet<object>): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new AtmError("json-non-finite");
      return String(v);
    case "string":
      checkString(v);
      return JSON.stringify(v);
    case "object":
      break;
    default:
      return unsupported();
  }
  const obj: object = v;
  if (active.has(obj)) throw new AtmError("json-cycle");
  if (depth + 1 > maxDepth) throw new AtmError("json-depth-exceeded");
  active.add(obj);
  try {
    if (Array.isArray(obj)) {
      if (Object.getPrototypeOf(obj) !== Array.prototype) return unsupported();
      const names = Object.getOwnPropertyNames(obj);
      if (names.length !== obj.length + 1) return unsupported();
      const items: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        const d = Object.getOwnPropertyDescriptor(obj, String(i));
        if (d === undefined || Object.hasOwn(d, "get") || Object.hasOwn(d, "set")) {
          return unsupported();
        }
        items.push(serialize(d.value, depth + 1, maxDepth, active));
      }
      return `[${items.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return unsupported();
    const keys = Object.getOwnPropertyNames(obj).sort();
    const members: string[] = [];
    for (const k of keys) {
      checkString(k);
      const d = Object.getOwnPropertyDescriptor(obj, k);
      if (
        d === undefined ||
        d.enumerable !== true ||
        Object.hasOwn(d, "get") ||
        Object.hasOwn(d, "set")
      ) {
        return unsupported();
      }
      members.push(`${JSON.stringify(k)}:${serialize(d.value, depth + 1, maxDepth, active)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    active.delete(obj);
  }
}

/**
 * RFC 8785 (JCS) serialization of JSON-parsed plain data. Object keys are
 * sorted by UTF-16 code units (default sort, no comparator, no locale).
 * Throws a typed AtmError for depth, cycles, non-finite numbers, unsupported
 * types (including accessors and non-plain objects) and ill-formed strings.
 */
export function canonicalJson(v: unknown, options: CanonicalJsonOptions = {}): string {
  const maxDepth = options.maxDepth ?? 64;
  if (
    typeof maxDepth !== "number" ||
    !Number.isInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > 64
  ) {
    throw new AtmError("invalid-option");
  }
  return serialize(v, 0, maxDepth, new WeakSet());
}

export interface MakeContentRefOptions {
  readonly retention?: "hash-only" | "inline";
  readonly maxInlineBytes?: number;
}

/**
 * Build a ContentRef (ADR-0002 section 10).
 *
 * NOTE (M6, projection): for `jcs-json` the hash covers the JSON.parse
 * PROJECTION of the source value (duplicate keys collapsed, numbers
 * re-serialized, escapes normalized). It is NOT a hash of the source text.
 * Exact source bytes are bound only by `provenance.sha256` (ADR-0002 section 10).
 */
export function makeContentRef(v: unknown, options: MakeContentRefOptions = {}): ContentRef {
  const retention = options.retention ?? "hash-only";
  if (retention !== "hash-only" && retention !== "inline") {
    throw new AtmError("invalid-option");
  }
  let maxInline = DEFAULT_MAX_INLINE_BYTES;
  if (options.maxInlineBytes !== undefined) {
    const n = options.maxInlineBytes;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_INLINE_BYTES_LIMIT) {
      throw new AtmError("invalid-option");
    }
    maxInline = n;
  }
  const isString = typeof v === "string";
  let text: string;
  if (isString) {
    checkString(v);
    text = v;
  } else {
    text = canonicalJson(v);
  }
  const bytes = encoder.encode(text);
  const base = {
    sha256: sha256Hex(bytes),
    byteLength: bytes.length,
    encoding: isString ? ("utf8" as const) : ("jcs-json" as const),
  };
  if (retention === "hash-only") return { ...base, retention: "hash-only" };
  if (bytes.length <= maxInline) return { ...base, retention: "inline", inline: text };
  return { ...base, retention: "inline-truncated", inline: truncateUtf8(text, maxInline).text };
}
