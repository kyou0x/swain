import type {
  ActorRole,
  AdapterWarning,
  Attributes,
  Completeness,
  ContentRef,
  DraftEvent,
  EventKind,
  EventTime,
  FacetCompleteness,
  FramedRecord,
  JsonValue,
  LinkRel,
  ParseContext,
  RecordDisposition,
  RecordRef,
  WarningCode,
} from "@swain/core";
import { makeContentRef, normalizeTimestamp } from "@swain/core";

export type Obj = { readonly [key: string]: JsonValue };

export function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isArr(v: unknown): v is readonly JsonValue[] {
  return Array.isArray(v);
}

/** Own-property read only: parsed hostile objects are never walked through their prototype. */
export function get(o: Obj, key: string): JsonValue | undefined {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

export function getStr(o: Obj, key: string): string | undefined {
  const v = get(o, key);
  return typeof v === "string" ? v : undefined;
}

export function getNonEmptyStr(o: Obj, key: string): string | undefined {
  const v = getStr(o, key);
  return v !== undefined && v.length > 0 ? v : undefined;
}

export function getObj(o: Obj, key: string): Obj | undefined {
  const v = get(o, key);
  return isObj(v) ? v : undefined;
}

/** Safe non-negative integer; `-0` is normalized to 0 (the validator rejects integer -0). */
export function safeInt(v: JsonValue | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return undefined;
  return v + 0;
}

export function safeCost(v: JsonValue | undefined): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
  return v + 0;
}

const enc = new TextEncoder();

/** Truncate to at most `max` UTF-8 bytes on a code point boundary; repairs lone surrogates. */
export function bound(s: string, max = 256): string {
  const w = s.isWellFormed() ? s : s.toWellFormed();
  if (w.length * 3 <= max) return w;
  let out = "";
  let n = 0;
  for (const ch of w) {
    const b = enc.encode(ch).length;
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

export function utf8Len(s: string): number {
  return enc.encode(s).length;
}

/** Deep well-formed copy (lone surrogates replaced), depth-bounded. */
function wf(v: JsonValue, depth: number): JsonValue {
  if (typeof v === "string") return v.toWellFormed();
  if (v === null || typeof v !== "object") return v;
  if (depth > 60) return null;
  if (isArr(v)) return v.map((x) => wf(x, depth + 1));
  const out: Record<string, JsonValue> = {};
  for (const k of Object.keys(v)) {
    Object.defineProperty(out, k.toWellFormed(), {
      value: wf(v[k] ?? null, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export interface RefResult {
  readonly ref: ContentRef | null;
  /** True when the value had to be repaired or could not be referenced. */
  readonly partial: boolean;
}

/** Content stays hash-only unless the injected policy says inline. */
export function makeRef(ctx: ParseContext, v: JsonValue): RefResult {
  const n = ctx.contentPolicy.maxInlineBytes;
  const opts = {
    retention: ctx.contentPolicy.retention,
    maxInlineBytes: Number.isInteger(n) ? Math.min(Math.max(n, 1), 1_048_576) : 65_536,
  } as const;
  try {
    return { ref: makeContentRef(v, opts), partial: false };
  } catch {
    try {
      return { ref: makeContentRef(wf(v, 0), opts), partial: true };
    } catch {
      return { ref: null, partial: true };
    }
  }
}

/** ContentRef as plain JSON for a draft payload. */
export function refJson(ref: ContentRef | null): JsonValue {
  return ref === null ? null : { ...ref };
}

export interface TimeInfo {
  readonly time: EventTime;
  readonly facet: FacetCompleteness;
}

export function timeOf(raw: JsonValue | undefined): TimeInfo {
  const time = normalizeTimestamp(raw ?? null);
  if (time.status === "valid") return { time, facet: { state: "captured" } };
  if (time.status === "missing") {
    return { time, facet: { state: "absent", reason: "missing-in-record" } };
  }
  return { time, facet: { state: "partial", reason: "malformed-value" } };
}

export const NO_TIME: TimeInfo = {
  time: { value: null, origin: "none", status: "missing" },
  facet: { state: "unknown" },
};

export const CAPTURED: FacetCompleteness = { state: "captured" };

export interface DraftOpts {
  readonly kind: EventKind;
  readonly status: string;
  readonly payload: { [key: string]: JsonValue };
  readonly role: ActorRole;
  readonly actorKey: string;
  readonly actorFacet?: FacetCompleteness;
  readonly ts: TimeInfo;
  readonly pointer: string | null;
  readonly providerVersion: string | null;
  readonly facets?: Completeness;
  readonly attrs?: Attributes;
  readonly nativeSessionId?: string | null;
  readonly nativeTurnKey?: string;
  readonly anchor?: string;
  readonly refs?: readonly { readonly rel: LinkRel; readonly key: string }[];
  readonly recordRef?: RecordRef;
}

export function draft(o: DraftOpts): DraftEvent {
  const completeness: Completeness = {
    timestamp: o.ts.facet,
    actor: o.actorFacet ?? CAPTURED,
    ...(o.facets ?? {}),
  };
  const corr: { anchor?: string; refs?: readonly { rel: LinkRel; key: string }[] } = {};
  if (o.anchor !== undefined) corr.anchor = o.anchor;
  if (o.refs !== undefined && o.refs.length > 0) corr.refs = o.refs.slice(0, 4);
  return {
    kind: o.kind,
    providerVersion: o.providerVersion,
    time: o.ts.time,
    actor: { role: o.role },
    status: o.status,
    payload: o.payload,
    completeness,
    attributes: o.attrs ?? {},
    pointer: o.pointer,
    actorKey: o.actorKey,
    ...(o.nativeSessionId !== undefined ? { nativeSessionId: o.nativeSessionId } : {}),
    ...(o.nativeTurnKey !== undefined ? { nativeTurnKey: o.nativeTurnKey } : {}),
    ...(o.recordRef !== undefined ? { recordRef: o.recordRef } : {}),
    ...(corr.anchor !== undefined || corr.refs !== undefined ? { correlation: corr } : {}),
  };
}

/** Static detail only: integers, never source text (SPEC-002 section 3.5). */
export function warn(
  code: WarningCode,
  seq: number | null,
  detail: Record<string, number> = {},
  severity: AdapterWarning["severity"] = "warn",
): AdapterWarning {
  return { code, severity, sourceSequence: seq, detail };
}

/** A parseable record the adapter does not map: one source.unknown (ADR-0002 section 9). */
export function unknownDraft(
  rec: FramedRecord,
  value: JsonValue,
  nativeType: string | null,
  pointer: string | null,
  providerVersion: string | null,
): DraftEvent {
  const keys = isObj(value)
    ? Object.keys(value)
        .map((k) => Array.from(k.toWellFormed()).slice(0, 64).join(""))
        .sort()
        .slice(0, 32)
    : [];
  return draft({
    kind: "source.unknown",
    status: "none",
    payload: {
      nativeType: nativeType === null ? null : bound(nativeType),
      topLevelKeys: keys,
      recordSha256: rec.sha256,
    },
    role: "unknown",
    actorKey: "unknown",
    actorFacet: { state: "unknown" },
    ts: NO_TIME,
    pointer,
    providerVersion,
  });
}

/** Provider versions must be printable ASCII without spaces, at most 64 bytes. */
export function versionOrNull(v: JsonValue | undefined | null): string | null {
  return typeof v === "string" && /^[!-~]{1,64}$/.test(v) ? v : null;
}

export class Out {
  readonly drafts: DraftEvent[] = [];
  readonly warnings: AdapterWarning[] = [];
  readonly dispositions: RecordDisposition[] = [];
}
