import {
  buildLogs,
  buildTraces,
  finishLog,
  finishSpan,
  guard,
  type ResourceGroup,
  type ScopeGroup,
  truncateResource,
  truncateScope,
  type Walked,
} from "../assemble.js";
import { resourceSha256, scopeSha256 } from "../canonical.js";
import { OtlpDecodeError } from "../errors.js";
import { INT64_MAX, RecordReject } from "../json/fields.js";
import { type DecodeLimits, resolveLimits } from "../limits.js";
import type {
  AnyValue,
  DecodedLogRecord,
  DecodedLogs,
  DecodedSpan,
  DecodedTraces,
  DecodeWarning,
  InstrumentationScope,
  KeyValue,
  LogRecordData,
  RejectedRecord,
  RejectReason,
  Resource,
  SpanData,
  SpanEvent,
  SpanKindInt,
  SpanLink,
  StatusCodeInt,
} from "../model.js";
import { type Budget, bigOf, type Field, type Slots, scan, split } from "./wire.js";

/**
 * Hand-written OTLP/HTTP protobuf decoder (SPEC-003 N1.3, ADR-0006 section 3). It produces the
 * same decoded model as the JSON decoder by mirroring its structure: the same two passes, the
 * same whole-request versus per-record versus per-group error levels, the same reason codes and
 * the same shared assembly (`assemble.ts`: hash before truncation, then truncate). See README.md
 * for every design decision and PIN.md for the field numbers.
 */

/** Hard cap on message nesting (G0 F13). Internal: tests lower it to reach the check. */
export const MAX_MESSAGE_DEPTH = 32;

interface PCtx {
  readonly limits: DecodeLimits;
  readonly warnings: DecodeWarning[];
  readonly budget: Budget;
  readonly buf: Uint8Array;
  readonly maxMessageDepth: number;
}

// ---- field numbers (PIN.md) -------------------------------------------------------------------
const SPAN_ONE = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 15, 16] as const;
const SPAN_REP = [9, 11, 13] as const;
const EVENT_ONE = [1, 2, 4] as const;
const EVENT_REP = [3] as const;
const LINK_ONE = [1, 2, 3, 5, 6] as const;
const LINK_REP = [4] as const;
const STATUS_ONE = [2, 3] as const;
const LOG_ONE = [1, 2, 3, 5, 7, 8, 9, 10, 11, 12] as const;
const LOG_REP = [6] as const;
const RESOURCE_ONE = [2] as const;
const RESOURCE_REP = [1] as const;
const SCOPE_ONE = [1, 2, 4] as const;
const SCOPE_REP = [3] as const;
const KV_ONE = [1, 2] as const;
const ANY_ONE = [1, 2, 3, 4, 5, 6, 7] as const;
const LIST_REP = [1] as const;
const NONE: readonly number[] = [];

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const dupRecord = (): never => {
  throw new RecordReject("duplicate-key");
};
const structure = (): never => {
  throw new OtlpDecodeError("invalid-structure");
};

function reject(reason: RejectReason): never {
  throw new RecordReject(reason);
}

// ---- scalar readers (each mirrors the JSON reader of the same type) ----------------------------

function str(p: PCtx, f: Field | undefined, max: number, tooLong: RejectReason): string {
  if (f === undefined) return "";
  if (f.wt !== 2) return reject("invalid-type");
  if (f.a === f.b) return "";
  // Length first: an over-long string is never decoded (no work proportional to a hostile
  // size before the check). JSON checks validity first; only a string that is both invalid and
  // over-long can therefore get a different reason here.
  if (f.b - f.a > max) return reject(tooLong);
  let s: string;
  try {
    s = strictUtf8.decode(p.buf.subarray(f.a, f.b));
  } catch {
    return reject("invalid-string");
  }
  return s;
}

const text = (p: PCtx, f: Field | undefined): string =>
  str(p, f, p.limits.maxStringBytes, "string-too-long");

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/** Exactly `len` bytes as lowercase hex, never all zero. */
function idHex(p: PCtx, f: Field, len: number, reason: RejectReason): string {
  if (f.b - f.a !== len) return reject(reason);
  let out = "";
  let any = 0;
  for (let i = f.a; i < f.b; i++) {
    const byte = p.buf[i] as number;
    any |= byte;
    out += HEX[byte] as string;
  }
  if (any === 0) return reject(reason);
  return out;
}

function requiredId(p: PCtx, f: Field | undefined, len: number, reason: RejectReason): string {
  if (f === undefined || f.wt !== 2) return reject(reason);
  return idHex(p, f, len, reason); // empty has the wrong length
}

/** Absent or empty means absent. */
function optionalId(
  p: PCtx,
  f: Field | undefined,
  len: number,
  reason: RejectReason,
): string | null {
  if (f === undefined) return null;
  if (f.wt !== 2) return reject(reason);
  if (f.a === f.b) return null;
  return idHex(p, f, len, reason);
}

/** fixed64 nanoseconds, unsigned; 0 .. 2^63-1. */
function time(f: Field | undefined): bigint {
  if (f === undefined) return 0n;
  if (f.wt !== 1) return reject("invalid-int64");
  const v = bigOf(f);
  if (v > INT64_MAX) return reject("time-out-of-range");
  return v;
}

/** uint32 varint (dropped counts). */
function uint32(f: Field | undefined): number {
  if (f === undefined) return 0;
  if (f.wt !== 0 || f.n < 0 || f.n > 0xffff_ffff) return reject("invalid-uint32");
  return f.n;
}

/** fixed32 (`flags`). */
function flags32(f: Field | undefined): number {
  if (f === undefined) return 0;
  if (f.wt !== 5) return reject("invalid-uint32");
  return f.n;
}

function enumv(f: Field | undefined, max: number): number {
  if (f === undefined) return 0;
  if (f.wt !== 0 || f.n < 0 || f.n > max) return reject("invalid-enum");
  return f.n;
}

// ---- messages ---------------------------------------------------------------------------------

/** Open a nested message for record-level decoding; wrong wire type is `onWrongType`. */
function open(
  p: PCtx,
  f: Field,
  one: readonly number[],
  rep: readonly number[],
  onWrongType: RejectReason,
): Slots {
  if (f.wt !== 2) return reject(onWrongType);
  return split(scan(p.buf, f.a, f.b, p.budget), one, rep, dupRecord);
}

function readKey(p: PCtx, f: Field | undefined): string {
  return str(p, f, p.limits.maxKeyBytes, "key-too-long");
}

/**
 * One AnyValue. `depth` is the AnyValue nesting (1 for an attribute value; 16 is accepted, 17 is
 * rejected). `base` is the structural message depth above the AnyValue chain; AnyValue levels
 * charge one message level each (ArrayValue, KeyValueList and KeyValue wrappers are charged to
 * their AnyValue level). Recursion is bounded by `maxAnyValueDepth`, checked before descending.
 */
function readAnyValue(p: PCtx, f: Field | undefined, depth: number, base: number): AnyValue {
  if (depth > p.limits.maxAnyValueDepth) return reject("any-value-too-deep");
  if (base + depth > p.maxMessageDepth) throw new OtlpDecodeError("invalid-structure");
  if (f === undefined || f.wt !== 2) return reject("invalid-any-value");
  const s = split(scan(p.buf, f.a, f.b, p.budget), ANY_ONE, NONE, dupRecord);
  if (s.one.size !== 1) return reject("invalid-any-value");
  const m = s.one.first();
  if (m === undefined) return reject("invalid-any-value");
  switch (m.num) {
    case 1:
      if (m.wt !== 2) return reject("invalid-type");
      return { kind: "string", value: text(p, m) };
    case 2:
      if (m.wt !== 0) return reject("invalid-type");
      return { kind: "bool", value: m.n !== 0 };
    case 3:
      if (m.wt !== 0) return reject("invalid-int64");
      return { kind: "int", value: BigInt.asIntN(64, bigOf(m)) };
    case 4: {
      if (m.wt !== 1) return reject("invalid-double");
      const dv = new DataView(p.buf.buffer, p.buf.byteOffset + m.a, 8);
      const d = dv.getFloat64(0, true);
      if (!Number.isFinite(d)) return reject("invalid-double");
      return { kind: "double", value: d };
    }
    case 7:
      if (m.wt !== 2) return reject("invalid-type");
      if (m.b - m.a > p.limits.maxStringBytes) return reject("string-too-long");
      // Explicit Uint8Array slice: always a fresh copy, whatever subclass the caller passed.
      return { kind: "bytes", value: Uint8Array.prototype.slice.call(p.buf, m.a, m.b) };
    case 5: {
      if (m.wt !== 2) return reject("invalid-any-value");
      const items =
        split(scan(p.buf, m.a, m.b, p.budget), NONE, LIST_REP, dupRecord).rep.get(1) ?? [];
      if (items.length > p.limits.maxAnyValueEntries) return reject("too-many-entries");
      return { kind: "array", values: items.map((it) => readAnyValue(p, it, depth + 1, base)) };
    }
    default: {
      // 6: kvlist
      if (m.wt !== 2) return reject("invalid-any-value");
      const items =
        split(scan(p.buf, m.a, m.b, p.budget), NONE, LIST_REP, dupRecord).rep.get(1) ?? [];
      if (items.length > p.limits.maxAnyValueEntries) return reject("too-many-entries");
      return { kind: "kvlist", values: items.map((it) => readKeyValue(p, it, depth + 1, base)) };
    }
  }
}

/** `depth` is the depth of the KeyValue's value. */
function readKeyValue(p: PCtx, f: Field, depth: number, base: number): KeyValue {
  if (f.wt !== 2) return reject("invalid-any-value");
  const s = split(scan(p.buf, f.a, f.b, p.budget), KV_ONE, NONE, dupRecord);
  const key = readKey(p, s.one.get(1));
  return { key, value: readAnyValue(p, s.one.get(2), depth, base) };
}

/** An attribute list, complete; truncation happens after hashing (`assemble.ts`). */
function readAttributes(p: PCtx, items: readonly Field[] | undefined, base: number): KeyValue[] {
  return (items ?? []).map((it) => readKeyValue(p, it, 1, base));
}

function readResource(p: PCtx, f: Field | undefined, base: number): Resource {
  if (f === undefined) return { attributes: [], droppedAttributesCount: 0 };
  const s = open(p, f, RESOURCE_ONE, RESOURCE_REP, "invalid-type");
  return {
    attributes: readAttributes(p, s.rep.get(1), base + 1),
    droppedAttributesCount: uint32(s.one.get(2)),
  };
}

function readScope(p: PCtx, f: Field | undefined, base: number): InstrumentationScope {
  if (f === undefined) return { name: "", version: "", attributes: [], droppedAttributesCount: 0 };
  const s = open(p, f, SCOPE_ONE, SCOPE_REP, "invalid-type");
  return {
    name: text(p, s.one.get(1)),
    version: text(p, s.one.get(2)),
    attributes: readAttributes(p, s.rep.get(3), base + 1),
    droppedAttributesCount: uint32(s.one.get(4)),
  };
}

// structural message depths: request 1, resource group 2, scope group 3, record 4, then
// event / link / status / resource / scope 5, KeyValue 6.
const RECORD_DEPTH = 4;
const SCOPES_FIELD = 2; // ResourceSpans.scope_spans / ResourceLogs.scope_logs
const RECORDS_FIELD = 2; // ScopeSpans.spans / ScopeLogs.log_records

function readEvent(p: PCtx, f: Field): SpanEvent {
  const s = open(p, f, EVENT_ONE, EVENT_REP, "invalid-type");
  return {
    timeUnixNano: time(s.one.get(1)),
    name: text(p, s.one.get(2)),
    attributes: readAttributes(p, s.rep.get(3), RECORD_DEPTH + 2),
    droppedAttributesCount: uint32(s.one.get(4)),
  };
}

function readLink(p: PCtx, f: Field): SpanLink {
  const s = open(p, f, LINK_ONE, LINK_REP, "invalid-type");
  return {
    traceId: requiredId(p, s.one.get(1), 16, "invalid-trace-id"),
    spanId: requiredId(p, s.one.get(2), 8, "invalid-span-id"),
    traceState: text(p, s.one.get(3)),
    attributes: readAttributes(p, s.rep.get(4), RECORD_DEPTH + 2),
    droppedAttributesCount: uint32(s.one.get(5)),
    flags: flags32(s.one.get(6)),
  };
}

function readSpan(p: PCtx, f: Field, path: string): DecodedSpan {
  const s = open(p, f, SPAN_ONE, SPAN_REP, "invalid-type");
  const traceId = requiredId(p, s.one.get(1), 16, "invalid-trace-id");
  const spanId = requiredId(p, s.one.get(2), 8, "invalid-span-id");
  const parentSpanId = optionalId(p, s.one.get(4), 8, "invalid-parent-span-id");
  const traceState = text(p, s.one.get(3));
  const flags = flags32(s.one.get(16));
  const name = text(p, s.one.get(5));
  const kind = enumv(s.one.get(6), 5) as SpanKindInt;
  const startTimeUnixNano = time(s.one.get(7));
  const endTimeUnixNano = time(s.one.get(8));
  const attributes = readAttributes(p, s.rep.get(9), RECORD_DEPTH + 1);
  const droppedAttributesCount = uint32(s.one.get(10));
  const events = (s.rep.get(11) ?? []).map((e) => readEvent(p, e));
  const droppedEventsCount = uint32(s.one.get(12));
  const links = (s.rep.get(13) ?? []).map((l) => readLink(p, l));
  const droppedLinksCount = uint32(s.one.get(14));

  let status = { code: 0 as StatusCodeInt, message: "" };
  const stRaw = s.one.get(15);
  if (stRaw !== undefined) {
    const st = open(p, stRaw, STATUS_ONE, NONE, "invalid-type");
    status = {
      code: enumv(st.one.get(3), 2) as StatusCodeInt,
      message: text(p, st.one.get(2)),
    };
  }

  const full: SpanData = {
    traceId,
    spanId,
    parentSpanId,
    traceState,
    flags,
    name,
    kind,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    droppedAttributesCount,
    events,
    droppedEventsCount,
    links,
    droppedLinksCount,
    status,
  };
  return finishSpan(full, path, p);
}

function readLogRecord(p: PCtx, f: Field, path: string): DecodedLogRecord {
  const s = open(p, f, LOG_ONE, LOG_REP, "invalid-type");
  const bodyRaw = s.one.get(5);
  const full: LogRecordData = {
    timeUnixNano: time(s.one.get(1)),
    observedTimeUnixNano: time(s.one.get(11)),
    severityNumber: enumv(s.one.get(2), 24),
    severityText: text(p, s.one.get(3)),
    body: bodyRaw === undefined ? null : readAnyValue(p, bodyRaw, 1, RECORD_DEPTH),
    attributes: readAttributes(p, s.rep.get(6), RECORD_DEPTH + 1),
    droppedAttributesCount: uint32(s.one.get(7)),
    flags: flags32(s.one.get(8)),
    traceId: optionalId(p, s.one.get(9), 16, "invalid-trace-id"),
    spanId: optionalId(p, s.one.get(10), 8, "invalid-span-id"),
    eventName: text(p, s.one.get(12)),
  };
  return finishLog(full, path, p);
}

// ---- request walk (mirrors json/decode.ts `walk`) -----------------------------------------------

interface SignalNames {
  readonly resources: string;
  readonly scopes: string;
  readonly records: string;
}

interface RawScope {
  readonly scope: Field | undefined;
  readonly schemaUrl: Field | undefined;
  readonly records: readonly Field[];
}

interface RawResource {
  readonly resource: Field | undefined;
  readonly schemaUrl: Field | undefined;
  readonly scopes: readonly RawScope[];
}

function requireLen(f: Field): void {
  if (f.wt !== 2) structure();
}

function walk<D>(
  p: PCtx,
  names: SignalNames,
  decodeRecord: (p: PCtx, f: Field, path: string) => D,
): Walked<D> {
  const limits = p.limits;
  // Pass 1: shape and counts only, so bounds errors do not depend on record contents.
  const rootFields = scan(p.buf, 0, p.buf.length, p.budget);
  const rgFields = rootFields.filter((f) => f.num === 1);
  for (const f of rgFields) requireLen(f);
  if (rgFields.length > limits.maxResourceGroups) {
    throw new OtlpDecodeError("too-many-resource-groups");
  }
  let total = 0;
  const raws: RawResource[] = [];
  for (const rg of rgFields) {
    const rs = split(scan(p.buf, rg.a, rg.b, p.budget), [1, 3], [SCOPES_FIELD], structure);
    const sgFields = rs.rep.get(SCOPES_FIELD) ?? [];
    if (sgFields.length > limits.maxScopeGroups) throw new OtlpDecodeError("too-many-scope-groups");
    const scopes: RawScope[] = [];
    for (const sg of sgFields) {
      requireLen(sg);
      const ss = split(scan(p.buf, sg.a, sg.b, p.budget), [1, 3], [RECORDS_FIELD], structure);
      const records = ss.rep.get(RECORDS_FIELD) ?? [];
      total += records.length;
      if (total > limits.maxRecords) throw new OtlpDecodeError("too-many-records");
      scopes.push({ scope: ss.one.get(1), schemaUrl: ss.one.get(3), records });
    }
    raws.push({ resource: rs.one.get(1), schemaUrl: rs.one.get(3), scopes });
  }

  const warnings: DecodeWarning[] = [];
  const rejected: RejectedRecord[] = [];
  const ctx: PCtx = { ...p, warnings };
  const groups: ResourceGroup<D>[] = [];

  raws.forEach((raw, ri) => {
    const rgPath = `/${names.resources}/${ri}`;
    let resource: Resource | undefined;
    let resHash: string | null = null;
    let schemaUrl = "";
    let groupReason: RejectReason | undefined;
    try {
      const full = readResource(ctx, raw.resource, 3);
      schemaUrl = text(ctx, raw.schemaUrl);
      resHash = resourceSha256(full);
      if (resHash === null) throw new RecordReject("any-value-too-deep");
      resource = truncateResource(full, `${rgPath}/resource`, ctx);
    } catch (e) {
      if (!(e instanceof RecordReject)) throw e;
      groupReason = e.reason;
    }
    const scopeGroups: ScopeGroup<D>[] = [];
    raw.scopes.forEach((rs, si) => {
      const sgPath = `${rgPath}/${names.scopes}/${si}`;
      let scope: InstrumentationScope | undefined;
      let scopeHash: string | null = null;
      let sgSchemaUrl = "";
      let reason = groupReason;
      if (reason === undefined) {
        try {
          const full = readScope(ctx, rs.scope, 4);
          sgSchemaUrl = text(ctx, rs.schemaUrl);
          scopeHash = scopeSha256(full);
          if (scopeHash === null) throw new RecordReject("any-value-too-deep");
          scope = truncateScope(full, `${sgPath}/scope`, ctx);
        } catch (e) {
          if (!(e instanceof RecordReject)) throw e;
          reason = e.reason;
        }
      }
      const decoded: D[] = [];
      rs.records.forEach((rec, k) => {
        const path = `${sgPath}/${names.records}/${k}`;
        if (reason !== undefined) {
          rejected.push({ path, reason });
          return;
        }
        const local: DecodeWarning[] = [];
        try {
          decoded.push(decodeRecord({ ...p, warnings: local }, rec, path));
          warnings.push(...local);
        } catch (e) {
          if (!(e instanceof RecordReject)) throw e;
          rejected.push({ path, reason: e.reason });
        }
      });
      if (reason === undefined && scope !== undefined && scopeHash !== null) {
        scopeGroups.push({
          path: sgPath,
          scope,
          scopeSha256: scopeHash,
          schemaUrl: sgSchemaUrl,
          records: decoded,
        });
      }
    });
    if (groupReason === undefined && resource !== undefined && resHash !== null) {
      groups.push({
        path: rgPath,
        resource,
        resourceSha256: resHash,
        schemaUrl,
        scopes: scopeGroups,
      });
    }
  });
  return { groups, rejected, warnings };
}

function context(
  body: unknown,
  options: Partial<DecodeLimits> | undefined,
  maxMessageDepth: number,
): PCtx {
  const limits = resolveLimits(options);
  if (!(body instanceof Uint8Array)) throw new OtlpDecodeError("invalid-structure");
  if (body.length > limits.maxBodyBytes) throw new OtlpDecodeError("body-too-large");
  // A Node Buffer (a Uint8Array subclass) would make `slice` return a shared view; decode over a
  // plain Uint8Array view of the same memory so that every copy below is a real copy.
  const buf = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return { limits, warnings: [], budget: { left: limits.maxValues }, buf, maxMessageDepth };
}

/** Internal entry points; `maxMessageDepth` is lowered by tests to exercise the depth cap. */
export function decodeTracesWith(
  body: Uint8Array,
  options: Partial<DecodeLimits> | undefined,
  maxMessageDepth: number,
): DecodedTraces {
  return guard(() => {
    const p = context(body, options, maxMessageDepth);
    return buildTraces(
      walk<DecodedSpan>(
        p,
        {
          resources: "resourceSpans",
          scopes: "scopeSpans",
          records: "spans",
        },
        readSpan,
      ),
    );
  });
}

export function decodeLogsWith(
  body: Uint8Array,
  options: Partial<DecodeLimits> | undefined,
  maxMessageDepth: number,
): DecodedLogs {
  return guard(() => {
    const p = context(body, options, maxMessageDepth);
    return buildLogs(
      walk<DecodedLogRecord>(
        p,
        {
          resources: "resourceLogs",
          scopes: "scopeLogs",
          records: "logRecords",
        },
        readLogRecord,
      ),
    );
  });
}

/**
 * Decode an OTLP/HTTP protobuf `ExportTraceServiceRequest` (decoded body bytes, after gzip).
 * Throws only `OtlpDecodeError`. Rejected spans are listed in `rejected`; the rest are returned.
 */
export function decodeTracesProtobuf(
  body: Uint8Array,
  options?: Partial<DecodeLimits>,
): DecodedTraces {
  return decodeTracesWith(body, options, MAX_MESSAGE_DEPTH);
}

/** Decode an OTLP/HTTP protobuf `ExportLogsServiceRequest`. Same contract. */
export function decodeLogsProtobuf(body: Uint8Array, options?: Partial<DecodeLimits>): DecodedLogs {
  return decodeLogsWith(body, options, MAX_MESSAGE_DEPTH);
}
