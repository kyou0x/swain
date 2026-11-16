/**
 * Package-local helpers for the Gemini adapters. Pure; imports `@swain/core` only.
 * Everything parsed from a source is hostile data: values are read with `Object.hasOwn`
 * and never merged into internal objects.
 */
import type {
  ActorRole,
  Attributes,
  Completeness,
  ContentRef,
  DraftEvent,
  EventKind,
  EventTime,
  FacetCompleteness,
  JsonValue,
  ParseContext,
} from "@swain/core";
import { makeContentRef, normalizeTimestamp } from "@swain/core";

export type Obj = { readonly [key: string]: JsonValue };

export function isObj(v: JsonValue | undefined): v is Obj {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
}

export function isArr(v: JsonValue | undefined): v is readonly JsonValue[] {
  return Array.isArray(v);
}

/** Own-property read; `__proto__`, `constructor` and friends never resolve through the prototype. */
export function own(o: Obj, key: string): JsonValue | undefined {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

export function ownStr(o: Obj, key: string): string | undefined {
  const v = own(o, key);
  return typeof v === "string" ? v : undefined;
}

export function utf8Len(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes on a code point boundary. */
export function truncBytes(s: string, maxBytes: number): string {
  const w = s.toWellFormed();
  let bytes = 0;
  let end = 0;
  for (const ch of w) {
    const cp = ch.codePointAt(0) ?? 0;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > maxBytes) return w.slice(0, end);
    bytes += n;
    end += ch.length;
  }
  return w;
}

/** A native correlation or session key: non-empty, well formed, at most 1024 UTF-8 bytes. */
export function nativeKey(v: JsonValue | undefined): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 1024) return null;
  if (!v.isWellFormed() || utf8Len(v) > 1024) return null;
  return v;
}

/** Bounded256 session key for payloads. */
export function boundedId(v: JsonValue | undefined): string | null {
  const k = nativeKey(v);
  return k !== null && utf8Len(k) <= 256 ? k : null;
}

/** RFC 6901 pointer from segments. */
export function ptr(...segs: readonly (string | number)[]): string {
  let out = "";
  for (const s of segs) {
    out += `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`;
  }
  return out;
}

/** Non-negative safe integer, else undefined. */
export function count(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0)
    ? v
    : undefined;
}

export function timeFacet(t: EventTime): FacetCompleteness {
  if (t.status === "valid") return { state: "captured" };
  if (t.status === "missing") return { state: "absent", reason: "missing-in-record" };
  return { state: "partial", reason: "malformed-value" };
}

/** Sorted, bounded top-level key list of an object (for `source.unknown`). */
export function topKeys(v: JsonValue | undefined): string[] {
  if (!isObj(v)) return [];
  const keys = Object.keys(v).map((k) => truncCodePoints(k.toWellFormed(), 64));
  keys.sort();
  return keys.slice(0, 32);
}

function truncCodePoints(s: string, max: number): string {
  let n = 0;
  let end = 0;
  for (const ch of s) {
    if (n === max) return s.slice(0, end);
    n++;
    end += ch.length;
  }
  return s;
}

/** Per-parser content builder honoring the content policy. */
export class Refs {
  readonly #retention: "hash-only" | "inline";
  readonly #max: number;
  constructor(ctx: ParseContext) {
    this.#retention = ctx.contentPolicy.retention;
    this.#max = Math.max(
      1,
      Math.min(ctx.contentPolicy.maxInlineBytes, ctx.bounds.maxInlineContentBytes, 1_048_576),
    );
  }
  /** `null` when the value cannot be canonicalized (non-finite number, deep nesting). */
  make(v: JsonValue): ContentRef | null {
    try {
      const value = typeof v === "string" ? v.toWellFormed() : v;
      return makeContentRef(value, { retention: this.#retention, maxInlineBytes: this.#max });
    } catch {
      return null;
    }
  }
}

/** Aggregates "known but not mapped" counters, flushed as static-code warnings. */
export class Unmapped {
  readonly #counts = new Map<string, number>();
  note(code: string): void {
    this.#counts.set(code, (this.#counts.get(code) ?? 0) + 1);
  }
  entries(): readonly (readonly [string, number])[] {
    return [...this.#counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}

export interface DraftOpts {
  readonly time: EventTime;
  readonly role: ActorRole;
  readonly actorKey: string;
  readonly order: number;
  readonly evidence: number;
  readonly pointer: string;
  readonly version: string | null;
  readonly completeness?: Completeness;
  readonly attributes?: Attributes;
  readonly nativeSessionId?: string | null;
  readonly anchor?: string;
  readonly resultOf?: string;
}

/** Facets every kind requires, plus the caller's extras. Non-applicable facets are `unknown`. */
export function facets(
  time: EventTime,
  actor: FacetCompleteness,
  extra: Completeness = {},
): Completeness {
  return { timestamp: timeFacet(time), actor, ...extra };
}

export function mk(
  kind: EventKind,
  status: string,
  payload: { readonly [key: string]: JsonValue },
  o: DraftOpts,
): DraftEvent {
  const correlation =
    o.anchor === undefined && o.resultOf === undefined
      ? undefined
      : {
          ...(o.anchor === undefined ? {} : { anchor: o.anchor }),
          ...(o.resultOf === undefined
            ? {}
            : { refs: [{ rel: "result-of" as const, key: o.resultOf }] }),
        };
  return {
    kind,
    providerVersion: o.version,
    time: o.time,
    actor: { role: o.role },
    status,
    payload,
    completeness: o.completeness ?? facets(o.time, { state: "unknown" }),
    attributes: o.attributes ?? {},
    pointer: o.pointer,
    ...(o.nativeSessionId === undefined ? {} : { nativeSessionId: o.nativeSessionId }),
    actorKey: o.actorKey,
    recordRef: { order: o.order, evidence: o.evidence },
    ...(correlation === undefined ? {} : { correlation }),
  };
}

export function refJson(r: ContentRef | null): JsonValue {
  if (r === null) return null;
  const out: { [key: string]: JsonValue } = {
    sha256: r.sha256,
    byteLength: r.byteLength,
    encoding: r.encoding,
    retention: r.retention,
  };
  if (r.inline !== undefined) out["inline"] = r.inline;
  if (r.redactionCount !== undefined) out["redactionCount"] = r.redactionCount;
  return out;
}

/** `source.unknown` draft for a record (or a pointer inside it). */
export function unknownDraft(
  value: JsonValue | undefined,
  nativeType: string | null,
  recordSha256: string,
  o: DraftOpts,
): DraftEvent {
  return mk(
    "source.unknown",
    "none",
    {
      nativeType: nativeType === null ? null : truncBytes(nativeType, 256),
      topLevelKeys: topKeys(value),
      recordSha256,
    },
    o,
  );
}

export function normTime(raw: JsonValue | undefined): EventTime {
  return normalizeTimestamp(raw);
}
