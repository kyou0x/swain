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
import { type DecodeLimits, resolveLimits } from "../limits.js";
import type {
  DecodedLogRecord,
  DecodedLogs,
  DecodedSpan,
  DecodedTraces,
  DecodeWarning,
  InstrumentationScope,
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
import {
  aliasList,
  type Ctx,
  get,
  isObj,
  type Obj,
  RecordReject,
  readAnyValue,
  readArray,
  readAttributes,
  readEnum,
  readOptionalId,
  readRequiredId,
  readResource,
  readScope,
  readString,
  readTime,
  readUint32,
  rejectAliases,
} from "./fields.js";
import { type ParsedJson, parseJson } from "./parse.js";

// ignoreBOM: true keeps a leading U+FEFF in the text, where the JSON grammar then rejects it.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Bytes to a parsed JSON root object, with every whole-request bound applied. */
function parseRequest(body: unknown, limits: DecodeLimits): ParsedJson & { readonly root: Obj } {
  if (!(body instanceof Uint8Array)) throw new OtlpDecodeError("malformed-json");
  if (body.length > limits.maxBodyBytes) throw new OtlpDecodeError("body-too-large");
  let text: string;
  try {
    text = strictUtf8.decode(body);
  } catch {
    throw new OtlpDecodeError("invalid-utf8");
  }
  const parsed = parseJson(text, limits.maxJsonDepth, limits.maxValues);
  if (!isObj(parsed.root)) throw new OtlpDecodeError("invalid-structure");
  return { root: parsed.root, subtree: parsed.subtree, direct: parsed.direct };
}

function wireArray(o: Obj, name: string): readonly unknown[] {
  const v = get(o, name);
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new OtlpDecodeError("invalid-structure");
  return v as readonly unknown[];
}

interface SignalNames {
  readonly resources: string;
  readonly scopes: string;
  readonly records: string;
}

/**
 * Shared request walk. Container-level shape errors and count bounds are whole-request errors.
 * A bad record is rejected alone; a bad resource or scope rejects every record below it.
 */
function walk<D>(
  req: ParsedJson & { readonly root: Obj },
  names: SignalNames,
  limits: DecodeLimits,
  decodeRecord: (o: Obj, path: string, ctx: Ctx) => D,
): Walked<D> {
  const root = req.root;
  const structural = (o: Obj, aliases: readonly string[]): void => {
    if (req.direct.has(o)) throw new OtlpDecodeError("invalid-structure");
    // proto-name aliases of the container fields would otherwise silently decode to nothing
    for (const a of aliases)
      if (Object.hasOwn(o, a)) throw new OtlpDecodeError("invalid-structure");
  };
  const rootAliases = aliasList([names.resources]);
  const groupAliases = aliasList([names.scopes, "schemaUrl"]);
  const scopeAliases = aliasList([names.records, "schemaUrl"]);
  structural(root, rootAliases);
  const resources = wireArray(root, names.resources);
  if (resources.length > limits.maxResourceGroups) {
    throw new OtlpDecodeError("too-many-resource-groups");
  }
  // Pass 1: shape and counts only, so bounds errors do not depend on record contents.
  let total = 0;
  for (const rg of resources) {
    if (!isObj(rg)) throw new OtlpDecodeError("invalid-structure");
    structural(rg, groupAliases);
    const scopes = wireArray(rg, names.scopes);
    if (scopes.length > limits.maxScopeGroups) throw new OtlpDecodeError("too-many-scope-groups");
    for (const sg of scopes) {
      if (!isObj(sg)) throw new OtlpDecodeError("invalid-structure");
      structural(sg, scopeAliases);
      total += wireArray(sg, names.records).length;
      if (total > limits.maxRecords) throw new OtlpDecodeError("too-many-records");
    }
  }

  const warnings: DecodeWarning[] = [];
  const rejected: RejectedRecord[] = [];
  const ctx: Ctx = { limits, warnings };
  const groups: ResourceGroup<D>[] = [];

  resources.forEach((rgRaw, ri) => {
    const rg = rgRaw as Obj;
    const rgPath = `/${names.resources}/${ri}`;
    const scopes = wireArray(rg, names.scopes);
    let resource: Resource | undefined;
    let resHash: string | null = null;
    let schemaUrl = "";
    let groupReason: RejectReason | undefined;
    try {
      const resRaw = get(rg, "resource");
      if (isObj(resRaw) && req.subtree.has(resRaw)) {
        throw new RecordReject("duplicate-key");
      }
      const full = readResource(resRaw, ctx);
      schemaUrl = readString(rg, "schemaUrl", ctx);
      resHash = resourceSha256(full);
      if (resHash === null) throw new RecordReject("any-value-too-deep");
      resource = truncateResource(full, `${rgPath}/resource`, ctx);
    } catch (e) {
      if (!(e instanceof RecordReject)) throw e;
      groupReason = e.reason;
    }
    const scopeGroups: ScopeGroup<D>[] = [];
    scopes.forEach((sgRaw, si) => {
      const sg = sgRaw as Obj;
      const sgPath = `${rgPath}/${names.scopes}/${si}`;
      const records = wireArray(sg, names.records);
      let scope: InstrumentationScope | undefined;
      let scopeHash: string | null = null;
      let sgSchemaUrl = "";
      let reason = groupReason;
      if (reason === undefined) {
        try {
          const scopeRaw = get(sg, "scope");
          if (isObj(scopeRaw) && req.subtree.has(scopeRaw)) {
            throw new RecordReject("duplicate-key");
          }
          const full = readScope(scopeRaw, ctx);
          sgSchemaUrl = readString(sg, "schemaUrl", ctx);
          scopeHash = scopeSha256(full);
          if (scopeHash === null) throw new RecordReject("any-value-too-deep");
          scope = truncateScope(full, `${sgPath}/scope`, ctx);
        } catch (e) {
          if (!(e instanceof RecordReject)) throw e;
          reason = e.reason;
        }
      }
      const decoded: D[] = [];
      records.forEach((recRaw, k) => {
        const path = `${sgPath}/${names.records}/${k}`;
        if (reason !== undefined) {
          rejected.push({ path, reason });
          return;
        }
        const local: DecodeWarning[] = [];
        try {
          if (!isObj(recRaw)) throw new RecordReject("invalid-type");
          if (req.subtree.has(recRaw)) throw new RecordReject("duplicate-key");
          decoded.push(decodeRecord(recRaw, path, { limits, warnings: local }));
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

const EVENT_ALIASES = aliasList(["timeUnixNano", "droppedAttributesCount"]);
const LINK_ALIASES = aliasList(["traceId", "spanId", "traceState", "droppedAttributesCount"]);
const SPAN_ALIASES = aliasList([
  "traceId",
  "spanId",
  "parentSpanId",
  "traceState",
  "startTimeUnixNano",
  "endTimeUnixNano",
  "droppedAttributesCount",
  "droppedEventsCount",
  "droppedLinksCount",
]);
const LOG_ALIASES = aliasList([
  "timeUnixNano",
  "observedTimeUnixNano",
  "severityNumber",
  "severityText",
  "droppedAttributesCount",
  "traceId",
  "spanId",
  "eventName",
]);

function readEvent(v: unknown, ctx: Ctx): SpanEvent {
  if (!isObj(v)) throw new RecordReject("invalid-type");
  rejectAliases(v, EVENT_ALIASES);
  return {
    timeUnixNano: readTime(v, "timeUnixNano"),
    name: readString(v, "name", ctx),
    attributes: readAttributes(v, "attributes", ctx),
    droppedAttributesCount: readUint32(v, "droppedAttributesCount"),
  };
}

function readLink(v: unknown, ctx: Ctx): SpanLink {
  if (!isObj(v)) throw new RecordReject("invalid-type");
  rejectAliases(v, LINK_ALIASES);
  return {
    traceId: readRequiredId(v, "traceId", 32, "invalid-trace-id"),
    spanId: readRequiredId(v, "spanId", 16, "invalid-span-id"),
    traceState: readString(v, "traceState", ctx),
    attributes: readAttributes(v, "attributes", ctx),
    droppedAttributesCount: readUint32(v, "droppedAttributesCount"),
    flags: readUint32(v, "flags"),
  };
}

function readSpan(o: Obj, path: string, ctx: Ctx): DecodedSpan {
  rejectAliases(o, SPAN_ALIASES);
  const traceId = readRequiredId(o, "traceId", 32, "invalid-trace-id");
  const spanId = readRequiredId(o, "spanId", 16, "invalid-span-id");
  const parentSpanId = readOptionalId(o, "parentSpanId", 16, "invalid-parent-span-id");
  const traceState = readString(o, "traceState", ctx);
  const flags = readUint32(o, "flags");
  const name = readString(o, "name", ctx);
  const kind = readEnum(o, "kind", 5) as SpanKindInt;
  const startTimeUnixNano = readTime(o, "startTimeUnixNano");
  const endTimeUnixNano = readTime(o, "endTimeUnixNano");
  const attributes = readAttributes(o, "attributes", ctx);
  const droppedAttributesCount = readUint32(o, "droppedAttributesCount");
  const events = readArray(o, "events").map((e) => readEvent(e, ctx));
  const droppedEventsCount = readUint32(o, "droppedEventsCount");
  const links = readArray(o, "links").map((l) => readLink(l, ctx));
  const droppedLinksCount = readUint32(o, "droppedLinksCount");

  let status = { code: 0 as StatusCodeInt, message: "" };
  const stRaw = get(o, "status");
  if (stRaw !== undefined) {
    if (!isObj(stRaw)) throw new RecordReject("invalid-type");
    status = {
      code: readEnum(stRaw, "code", 2) as StatusCodeInt,
      message: readString(stRaw, "message", ctx),
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
  return finishSpan(full, path, ctx);
}

function readLogRecord(o: Obj, path: string, ctx: Ctx): DecodedLogRecord {
  rejectAliases(o, LOG_ALIASES);
  const bodyRaw = get(o, "body");
  const full: LogRecordData = {
    timeUnixNano: readTime(o, "timeUnixNano"),
    observedTimeUnixNano: readTime(o, "observedTimeUnixNano"),
    severityNumber: readEnum(o, "severityNumber", 24),
    severityText: readString(o, "severityText", ctx),
    body: bodyRaw === undefined ? null : readAnyValue(bodyRaw, 1, ctx),
    attributes: readAttributes(o, "attributes", ctx),
    droppedAttributesCount: readUint32(o, "droppedAttributesCount"),
    flags: readUint32(o, "flags"),
    traceId: readOptionalId(o, "traceId", 32, "invalid-trace-id"),
    spanId: readOptionalId(o, "spanId", 16, "invalid-span-id"),
    eventName: readString(o, "eventName", ctx),
  };
  return finishLog(full, path, ctx);
}

/**
 * Decode an OTLP/JSON `ExportTraceServiceRequest` (decoded body bytes, after gzip).
 * Throws only `OtlpDecodeError`. Rejected spans are listed in `rejected`; the rest are returned.
 */
export function decodeTracesJson(body: Uint8Array, options?: Partial<DecodeLimits>): DecodedTraces {
  return guard(() => {
    const limits = resolveLimits(options);
    const req = parseRequest(body, limits);
    const w = walk<DecodedSpan>(
      req,
      { resources: "resourceSpans", scopes: "scopeSpans", records: "spans" },
      limits,
      readSpan,
    );
    return buildTraces(w);
  });
}

/** Decode an OTLP/JSON `ExportLogsServiceRequest`. Same contract as `decodeTracesJson`. */
export function decodeLogsJson(body: Uint8Array, options?: Partial<DecodeLimits>): DecodedLogs {
  return guard(() => {
    const limits = resolveLimits(options);
    const req = parseRequest(body, limits);
    const w = walk<DecodedLogRecord>(
      req,
      { resources: "resourceLogs", scopes: "scopeLogs", records: "logRecords" },
      limits,
      readLogRecord,
    );
    return buildLogs(w);
  });
}
