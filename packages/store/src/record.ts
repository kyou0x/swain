/** Strict boundary validation for persisted `ImportRecord`s (store files are untrusted input). */
import {
  EVENT_KINDS,
  IMPORT_OUTCOMES,
  PROVIDERS,
  SOURCE_STABILITIES,
  WARNING_CODES,
} from "@swain/core";
import type { ImportRecord } from "@swain/report";

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exact(o: Obj, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
}

function str(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max && v.isWellFormed();
}

function nat(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function oneOf<T extends string>(v: unknown, set: readonly T[]): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
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
  if (!str(v["sourceKind"], 128)) return null;
  if (!oneOf(v["contentRetention"], ["hash-only", "inline"] as const)) return null;
  if (!oneOf(v["outcome"], IMPORT_OUTCOMES)) return null;
  if (!nullableTime(v["firstEventTime"]) || !nullableTime(v["lastEventTime"])) return null;
  if (!str(v["importedAt"], 40)) return null;
  if (!isObj(adapter) || !exact(adapter, ["id", "version", "sourceStability", "experimental"])) {
    return null;
  }
  if (!str(adapter["id"], 128) || !str(adapter["version"], 64)) return null;
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
  if (!str(source["displayName"], 1024) || !str(source["displayPath"], 4096)) return null;
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
