import type { DecodeLimits } from "../limits.js";
import type {
  AnyValue,
  DecodeWarning,
  InstrumentationScope,
  KeyValue,
  RejectReason,
  Resource,
} from "../model.js";
import { FloatLiteral } from "./parse.js";

/** Thrown inside a record decode; caught per record (or per group) and turned into a rejection. */
export class RecordReject extends Error {
  readonly reason: RejectReason;

  constructor(reason: RejectReason) {
    super(reason);
    this.name = "RecordReject";
    this.reason = reason;
  }
}

export type Obj = { readonly [k: string]: unknown };

export interface Ctx {
  readonly limits: DecodeLimits;
  readonly warnings: DecodeWarning[];
}

export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;
const UINT32_MAX = 4_294_967_295;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof FloatLiteral);
}

/** `parentSpanId` -> `parent_span_id`. */
const snake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The protobuf field names (snake_case) of the camelCase JSON names that differ from them. */
export function aliasList(names: readonly string[]): readonly string[] {
  return names.map(snake).filter((s, i) => s !== names[i]);
}

/**
 * Fail closed on proto-name aliases (`parent_span_id`, `trace_id`, `time_unix_nano`): proto3 JSON
 * parsers accept both spellings, this decoder reads only lowerCamelCase, so a record carrying
 * the snake_case spelling would silently lose that field. It is rejected instead, as
 * `invalid-type` (the frozen reason union has no better member).
 */
export function rejectAliases(o: Obj, list: readonly string[]): void {
  for (const a of list) if (Object.hasOwn(o, a)) throw new RecordReject("invalid-type");
}

const ANY_ALIASES = aliasList([
  "stringValue",
  "boolValue",
  "intValue",
  "doubleValue",
  "bytesValue",
  "arrayValue",
  "kvlistValue",
]);
const DROPPED_ALIASES = aliasList(["droppedAttributesCount"]);

/** Own-property read; JSON `null` counts as absent (proto3 JSON). Never touches the prototype. */
export function get(o: Obj, name: string): unknown {
  if (!Object.hasOwn(o, name)) return undefined;
  const v = o[name];
  return v === null ? undefined : v;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function checkedString(s: string, maxBytes: number): string {
  if (!s.isWellFormed()) throw new RecordReject("invalid-string");
  // A UTF-16 code unit is at most 3 bytes, so short strings need no exact count.
  if (s.length * 3 > maxBytes && utf8Length(s) > maxBytes)
    throw new RecordReject("string-too-long");
  return s;
}

export function readString(o: Obj, name: string, ctx: Ctx): string {
  const v = get(o, name);
  if (v === undefined) return "";
  if (typeof v !== "string") throw new RecordReject("invalid-type");
  return checkedString(v, ctx.limits.maxStringBytes);
}

function readKey(o: Obj, ctx: Ctx): string {
  const v = get(o, "key");
  if (v === undefined) return "";
  if (typeof v !== "string") throw new RecordReject("invalid-type");
  if (!v.isWellFormed()) throw new RecordReject("invalid-string");
  if (v.length * 3 > ctx.limits.maxKeyBytes && utf8Length(v) > ctx.limits.maxKeyBytes) {
    throw new RecordReject("key-too-long");
  }
  return v;
}

/** int64/fixed64: a decimal string, or a JSON number that is a safe integer (|n| <= 2^53 - 1). */
export function parseInt64(v: unknown): bigint {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RecordReject("invalid-int64");
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (v.length > 20 || !/^-?(0|[1-9][0-9]*)$/.test(v)) throw new RecordReject("invalid-int64");
    return BigInt(v);
  }
  throw new RecordReject("invalid-int64");
}

/** A nanosecond time: int64 syntax, range 0 .. 2^63-1. Absent is `0n`. */
export function readTime(o: Obj, name: string): bigint {
  const v = get(o, name);
  if (v === undefined) return 0n;
  const n = parseInt64(v);
  if (n < 0n || n > INT64_MAX) throw new RecordReject("time-out-of-range");
  return n;
}

export function readUint32(o: Obj, name: string): number {
  const v = get(o, name);
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > UINT32_MAX) {
    throw new RecordReject("invalid-uint32");
  }
  return v === 0 ? 0 : v; // a literal -0 is 0
}

/** Enums are integers; names (strings) and out-of-range values are rejected. */
export function readEnum(o: Obj, name: string, max: number): number {
  const v = get(o, name);
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) {
    throw new RecordReject("invalid-enum");
  }
  return v === 0 ? 0 : v; // a literal -0 is 0
}

/** Hex ID of exactly `length` characters, normalized to lowercase, never all zero. */
export function parseHexId(v: unknown, length: number, reason: RejectReason): string {
  if (typeof v !== "string" || v.length !== length || !/^[0-9a-fA-F]+$/.test(v)) {
    throw new RecordReject(reason);
  }
  const id = v.toLowerCase();
  if (/^0+$/.test(id)) throw new RecordReject(reason);
  return id;
}

/** Optional ID: absent or empty gives `null`. */
export function readOptionalId(
  o: Obj,
  name: string,
  length: number,
  reason: RejectReason,
): string | null {
  const v = get(o, name);
  if (v === undefined || v === "") return null;
  return parseHexId(v, length, reason);
}

export function readRequiredId(o: Obj, name: string, length: number, reason: RejectReason): string {
  return parseHexId(get(o, name), length, reason);
}

/** Wire-array reader: `[]` when absent, `invalid-type` when not an array. */
export function readArray(o: Obj, name: string): readonly unknown[] {
  const v = get(o, name);
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new RecordReject("invalid-type");
  return v as readonly unknown[];
}

const B64_VALUE: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  return t;
})();

/** Strict standard base64 with padding (RFC 4648 section 4). */
export function base64Decode(s: string, maxBytes: number): Uint8Array {
  if (s.length % 4 !== 0 || (s.length / 4) * 3 > maxBytes + 3) {
    throw new RecordReject(s.length % 4 !== 0 ? "invalid-base64" : "string-too-long");
  }
  let pad = 0;
  if (s.endsWith("==")) pad = 2;
  else if (s.endsWith("=")) pad = 1;
  const outLen = (s.length / 4) * 3 - pad;
  if (outLen > maxBytes) throw new RecordReject("string-too-long");
  const out = new Uint8Array(outLen);
  let o = 0;
  const dataLen = s.length - pad;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const idx = i + k;
      let v = 0;
      if (idx < dataLen) {
        const c = s.charCodeAt(idx);
        v = c < 128 ? (B64_VALUE[c] ?? -1) : -1;
        if (v < 0) throw new RecordReject("invalid-base64");
      }
      n = (n << 6) | v;
    }
    if (o < outLen) out[o++] = (n >> 16) & 255;
    if (o < outLen) out[o++] = (n >> 8) & 255;
    if (o < outLen) out[o++] = n & 255;
  }
  // Non-canonical trailing bits are accepted (they carry no information in the decoded bytes).
  return out;
}

const ANY_MEMBERS = [
  "stringValue",
  "boolValue",
  "intValue",
  "doubleValue",
  "bytesValue",
  "arrayValue",
  "kvlistValue",
] as const;

/**
 * Decode one AnyValue. `depth` is 1 for the value of an attribute. Nesting of 16 is accepted;
 * a value at depth 17 is rejected (`any-value-too-deep`). Recursion is bounded by that counter.
 */
export function readAnyValue(v: unknown, depth: number, ctx: Ctx): AnyValue {
  if (depth > ctx.limits.maxAnyValueDepth) throw new RecordReject("any-value-too-deep");
  if (!isObj(v)) throw new RecordReject("invalid-any-value");
  rejectAliases(v, ANY_ALIASES);
  let member: (typeof ANY_MEMBERS)[number] | undefined;
  for (const m of ANY_MEMBERS) {
    if (get(v, m) === undefined) continue;
    if (member !== undefined) throw new RecordReject("invalid-any-value");
    member = m;
  }
  if (member === undefined) throw new RecordReject("invalid-any-value");
  const x = get(v, member);
  switch (member) {
    case "stringValue":
      if (typeof x !== "string") throw new RecordReject("invalid-type");
      return { kind: "string", value: checkedString(x, ctx.limits.maxStringBytes) };
    case "boolValue":
      if (typeof x !== "boolean") throw new RecordReject("invalid-type");
      return { kind: "bool", value: x };
    case "intValue": {
      const n = parseInt64(x);
      if (n < INT64_MIN || n > INT64_MAX) throw new RecordReject("invalid-int64");
      return { kind: "int", value: n };
    }
    case "doubleValue": {
      const d = x instanceof FloatLiteral ? x.value : x;
      if (typeof d !== "number" || !Number.isFinite(d)) throw new RecordReject("invalid-double");
      return { kind: "double", value: d };
    }
    case "bytesValue":
      if (typeof x !== "string") throw new RecordReject("invalid-type");
      return { kind: "bytes", value: base64Decode(x, ctx.limits.maxStringBytes) };
    case "arrayValue": {
      if (!isObj(x)) throw new RecordReject("invalid-any-value");
      const items = readArray(x, "values");
      if (items.length > ctx.limits.maxAnyValueEntries) throw new RecordReject("too-many-entries");
      return { kind: "array", values: items.map((it) => readAnyValue(it, depth + 1, ctx)) };
    }
    case "kvlistValue": {
      if (!isObj(x)) throw new RecordReject("invalid-any-value");
      const items = readArray(x, "values");
      if (items.length > ctx.limits.maxAnyValueEntries) throw new RecordReject("too-many-entries");
      return { kind: "kvlist", values: items.map((it) => readKeyValue(it, depth + 1, ctx)) };
    }
  }
}

/** `depth` is the depth of the KeyValue's value. */
export function readKeyValue(v: unknown, depth: number, ctx: Ctx): KeyValue {
  if (!isObj(v)) throw new RecordReject("invalid-any-value");
  const key = readKey(v, ctx);
  return { key, value: readAnyValue(get(v, "value"), depth, ctx) };
}

/**
 * An attribute list, complete. Truncation to `maxAttributes` is applied by the caller AFTER the
 * record is hashed, so `recordSha256` covers the unmodified decoded record.
 */
export function readAttributes(o: Obj, name: string, ctx: Ctx): readonly KeyValue[] {
  const items = readArray(o, name);
  return items.map((it) => readKeyValue(it, 1, ctx));
}

export function readResource(v: unknown, ctx: Ctx): Resource {
  if (v === undefined) return { attributes: [], droppedAttributesCount: 0 };
  if (!isObj(v)) throw new RecordReject("invalid-type");
  rejectAliases(v, DROPPED_ALIASES);
  return {
    attributes: readAttributes(v, "attributes", ctx),
    droppedAttributesCount: readUint32(v, "droppedAttributesCount"),
  };
}

export function readScope(v: unknown, ctx: Ctx): InstrumentationScope {
  if (v === undefined) return { name: "", version: "", attributes: [], droppedAttributesCount: 0 };
  if (!isObj(v)) throw new RecordReject("invalid-type");
  rejectAliases(v, DROPPED_ALIASES);
  return {
    name: readString(v, "name", ctx),
    version: readString(v, "version", ctx),
    attributes: readAttributes(v, "attributes", ctx),
    droppedAttributesCount: readUint32(v, "droppedAttributesCount"),
  };
}
