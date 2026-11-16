/**
 * Boundary validation for everything that enters or leaves the store. Database contents are
 * untrusted input (a DB file can be edited), exactly like store files are today. `@swain/db` may not
 * import `@swain/store`, so `parseImportRecord` is mirrored here (a contract test in the server
 * slice should keep both in step).
 */
import {
  EVENT_KINDS,
  IMPORT_OUTCOMES,
  PROVIDERS,
  SOURCE_STABILITIES,
  WARNING_CODES,
} from "@swain/core";
import type { ImportRecord } from "@swain/report";
import { DbError } from "./errors.js";

type Obj = Record<string, unknown>;

export const MAX_JSON_BYTES = 4_194_304;
/** Largest value of a nanosecond column: SQLite INTEGER is signed 64 bit. */
export const INT64_MAX = 9_223_372_036_854_775_807n;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function bad(): never {
  throw new DbError("db-constraint");
}

function exact(o: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

/** A well-formed string of at most `max` UTF-16 units without control characters. */
export function text(v: unknown, max: number, min = 1): v is string {
  return (
    typeof v === "string" &&
    v.length >= min &&
    v.length <= max &&
    v.isWellFormed() &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\x00-\x1f\x7f]/.test(v)
  );
}

export function nat(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function oneOf<T extends string>(v: unknown, set: readonly T[]): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}

/** JSON text whose top level is one of the given shapes; bounded in size. */
export function jsonText(
  v: unknown,
  shapes: readonly ("object" | "array" | "string")[],
  max = MAX_JSON_BYTES,
): v is string {
  if (typeof v !== "string" || v.length > max || !v.isWellFormed()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return shapes.includes("array");
  if (isObj(parsed)) return shapes.includes("object");
  return typeof parsed === "string" && shapes.includes("string");
}

/** True when `n` is a legal nanosecond column value: 0 <= n <= 2^63 - 1. */
export function nsInRange(n: bigint | null): boolean {
  return n === null || (n >= 0n && n <= INT64_MAX);
}

function nullableTime(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && v.length <= 40);
}

/** Returns the record when `v` is exactly an `ImportRecord`; otherwise null. */
export function parseImportRecord(v: unknown): ImportRecord | null {
  if (!isObj(v)) return null;
  if (
    !exact(v, [
      "importId",
      "sessionId",
      "provider",
      "sourceKind",
      "adapter",
      "source",
      "contentRetention",
      "outcome",
      "counts",
      "warningCodes",
      "firstEventTime",
      "lastEventTime",
      "importedAt",
    ])
  ) {
    return null;
  }
  const { adapter, source, counts, warningCodes } = v;
  if (typeof v["importId"] !== "string" || !/^imp_[0-9a-f]{32}$/.test(v["importId"])) return null;
  if (typeof v["sessionId"] !== "string" || !/^ses_[0-9a-f]{32}$/.test(v["sessionId"])) return null;
  if (!oneOf(v["provider"], PROVIDERS)) return null;
  if (typeof v["sourceKind"] !== "string" || v["sourceKind"].length > 128) return null;
  if (!oneOf(v["contentRetention"], ["hash-only", "inline"] as const)) return null;
  if (!oneOf(v["outcome"], IMPORT_OUTCOMES)) return null;
  if (!nullableTime(v["firstEventTime"]) || !nullableTime(v["lastEventTime"])) return null;
  if (typeof v["importedAt"] !== "string" || v["importedAt"].length > 40) return null;
  if (!isObj(adapter) || !exact(adapter, ["id", "version", "sourceStability", "experimental"])) {
    return null;
  }
  if (typeof adapter["id"] !== "string" || adapter["id"].length > 128) return null;
  if (typeof adapter["version"] !== "string" || adapter["version"].length > 64) return null;
  if (!oneOf(adapter["sourceStability"], SOURCE_STABILITIES)) return null;
  if (typeof adapter["experimental"] !== "boolean") return null;
  if (
    !isObj(source) ||
    !exact(source, ["sha256", "byteLength", "container", "displayName", "displayPath"])
  ) {
    return null;
  }
  if (typeof source["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(source["sha256"])) return null;
  if (!nat(source["byteLength"])) return null;
  if (!oneOf(source["container"], ["none", "zstd"] as const)) return null;
  if (typeof source["displayName"] !== "string" || source["displayName"].length > 1024) return null;
  if (typeof source["displayPath"] !== "string" || source["displayPath"].length > 4096) return null;
  if (
    !isObj(counts) ||
    !exact(counts, ["events", "records", "gaps", "unknowns", "folded", "warnings", "byKind"])
  ) {
    return null;
  }
  for (const k of ["events", "records", "gaps", "unknowns", "folded", "warnings"]) {
    if (!nat(counts[k])) return null;
  }
  const byKind = counts["byKind"];
  if (!isObj(byKind)) return null;
  for (const [k, n] of Object.entries(byKind)) {
    if (!oneOf(k, EVENT_KINDS) || !nat(n)) return null;
  }
  if (!Array.isArray(warningCodes) || warningCodes.length > WARNING_CODES.length) return null;
  if (!warningCodes.every((c) => oneOf(c, WARNING_CODES))) return null;
  return v as unknown as ImportRecord;
}

/** A same-origin relative path (login `next`): one leading `/`, printable ASCII, at most 512 bytes. */
export function isSafeNextPath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 512 && /^\/(?![/\\])[\x21-\x7e]*$/.test(v);
}

/** 1 to `max` printable ASCII characters. */
export function printable(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= max && /^[\x20-\x7e]+$/.test(v);
}
