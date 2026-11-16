import { logRecordSha256, spanRecordSha256 } from "./canonical.js";
import { OtlpDecodeError } from "./errors.js";
import { type Ctx, RecordReject } from "./json/fields.js";
import type {
  DecodedLogRecord,
  DecodedLogs,
  DecodedResourceLogs,
  DecodedResourceSpans,
  DecodedScopeLogs,
  DecodedScopeSpans,
  DecodedSpan,
  DecodedTraces,
  DecodeWarning,
  InstrumentationScope,
  KeyValue,
  LogRecordData,
  RejectedRecord,
  Resource,
  SpanData,
} from "./model.js";

/**
 * Wire-independent assembly shared by the JSON (N1.2) and protobuf (N1.3) decoders: hashing
 * before truncation, truncation with dropped counts (ADR-0006 section 6), warnings and the
 * final model shape. Sharing this code, instead of mirroring it, keeps both decoders identical
 * in their output for the same fully decoded record.
 */

const UINT32_MAX = 4_294_967_295;

function capped(
  attrs: readonly KeyValue[],
  dropped: number,
  max: number,
  path: string,
  ctx: Ctx,
): { readonly attributes: readonly KeyValue[]; readonly dropped: number } {
  if (attrs.length <= max) return { attributes: attrs, dropped };
  ctx.warnings.push({ path, code: "over-bounds" });
  return {
    attributes: attrs.slice(0, max),
    dropped: Math.min(UINT32_MAX, dropped + attrs.length - max),
  };
}

function cappedList<T>(
  items: readonly T[],
  dropped: number,
  max: number,
  path: string,
  ctx: Ctx,
): { readonly items: readonly T[]; readonly dropped: number } {
  if (items.length <= max) return { items, dropped };
  ctx.warnings.push({ path, code: "over-bounds" });
  return {
    items: items.slice(0, max),
    dropped: Math.min(UINT32_MAX, dropped + items.length - max),
  };
}

export function truncateResource(r: Resource, path: string, ctx: Ctx): Resource {
  const c = capped(r.attributes, r.droppedAttributesCount, ctx.limits.maxAttributes, path, ctx);
  return { attributes: c.attributes, droppedAttributesCount: c.dropped };
}

export function truncateScope(
  s: InstrumentationScope,
  path: string,
  ctx: Ctx,
): InstrumentationScope {
  const c = capped(s.attributes, s.droppedAttributesCount, ctx.limits.maxAttributes, path, ctx);
  return { ...s, attributes: c.attributes, droppedAttributesCount: c.dropped };
}

/** Truncate a fully validated and hashed span view to the bounds (ADR-0006 section 6). */
function truncateSpan(d: SpanData, path: string, ctx: Ctx): SpanData {
  const max = ctx.limits.maxAttributes;
  const a = capped(d.attributes, d.droppedAttributesCount, max, path, ctx);
  const ev = cappedList(d.events, d.droppedEventsCount, ctx.limits.maxEvents, path, ctx);
  const ln = cappedList(d.links, d.droppedLinksCount, ctx.limits.maxLinks, path, ctx);
  const events = ev.items.map((e, i) => {
    const c = capped(e.attributes, e.droppedAttributesCount, max, `${path}/events/${i}`, ctx);
    return { ...e, attributes: c.attributes, droppedAttributesCount: c.dropped };
  });
  const links = ln.items.map((l, i) => {
    const c = capped(l.attributes, l.droppedAttributesCount, max, `${path}/links/${i}`, ctx);
    return { ...l, attributes: c.attributes, droppedAttributesCount: c.dropped };
  });
  return {
    ...d,
    attributes: a.attributes,
    droppedAttributesCount: a.dropped,
    events,
    droppedEventsCount: ev.dropped,
    links,
    droppedLinksCount: ln.dropped,
  };
}

function truncateLog(d: LogRecordData, path: string, ctx: Ctx): LogRecordData {
  const a = capped(d.attributes, d.droppedAttributesCount, ctx.limits.maxAttributes, path, ctx);
  return { ...d, attributes: a.attributes, droppedAttributesCount: a.dropped };
}

/** Hash the span as decoded, then truncate. Rejects when the canonical form is too deep. */
export function finishSpan(full: SpanData, path: string, ctx: Ctx): DecodedSpan {
  const recordSha256 = spanRecordSha256(full);
  if (recordSha256 === null) throw new RecordReject("any-value-too-deep");
  if (full.endTimeUnixNano !== 0n && full.startTimeUnixNano > full.endTimeUnixNano) {
    ctx.warnings.push({ path, code: "time-inverted" });
  }
  return { ...truncateSpan(full, path, ctx), path, recordSha256 };
}

export function finishLog(full: LogRecordData, path: string, ctx: Ctx): DecodedLogRecord {
  const recordSha256 = logRecordSha256(full);
  if (recordSha256 === null) throw new RecordReject("any-value-too-deep");
  return { ...truncateLog(full, path, ctx), path, recordSha256 };
}

export interface ScopeGroup<D> {
  readonly path: string;
  readonly scope: InstrumentationScope;
  readonly scopeSha256: string;
  readonly schemaUrl: string;
  readonly records: readonly D[];
}

export interface ResourceGroup<D> {
  readonly path: string;
  readonly resource: Resource;
  readonly resourceSha256: string;
  readonly schemaUrl: string;
  readonly scopes: readonly ScopeGroup<D>[];
}

export interface Walked<D> {
  readonly groups: readonly ResourceGroup<D>[];
  readonly rejected: readonly RejectedRecord[];
  readonly warnings: readonly DecodeWarning[];
}

export function buildTraces(w: Walked<DecodedSpan>): DecodedTraces {
  const resourceSpans: DecodedResourceSpans[] = w.groups.map((g) => ({
    path: g.path,
    resource: g.resource,
    resourceSha256: g.resourceSha256,
    schemaUrl: g.schemaUrl,
    scopeSpans: g.scopes.map(
      (s): DecodedScopeSpans => ({
        path: s.path,
        scope: s.scope,
        scopeSha256: s.scopeSha256,
        schemaUrl: s.schemaUrl,
        spans: s.records,
      }),
    ),
  }));
  return { signal: "traces", resourceSpans, rejected: w.rejected, warnings: w.warnings };
}

export function buildLogs(w: Walked<DecodedLogRecord>): DecodedLogs {
  const resourceLogs: DecodedResourceLogs[] = w.groups.map((g) => ({
    path: g.path,
    resource: g.resource,
    resourceSha256: g.resourceSha256,
    schemaUrl: g.schemaUrl,
    scopeLogs: g.scopes.map(
      (s): DecodedScopeLogs => ({
        path: s.path,
        scope: s.scope,
        scopeSha256: s.scopeSha256,
        schemaUrl: s.schemaUrl,
        logRecords: s.records,
      }),
    ),
  }));
  return { signal: "logs", resourceLogs, rejected: w.rejected, warnings: w.warnings };
}

/** Run a decode; only `OtlpDecodeError` escapes, anything else (stack, memory) is `internal`. */
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof OtlpDecodeError) throw e;
    throw new OtlpDecodeError("internal");
  }
}
