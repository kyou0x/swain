import { AtmError, canonicalJson, sha256Hex } from "@swain/core";
import type {
  AnyValue,
  InstrumentationScope,
  KeyValue,
  LogRecordData,
  Resource,
  SpanData,
  SpanEvent,
  SpanLink,
} from "./model.js";

/**
 * Canonical JSON of a decoded OTLP record (SPEC-003 section 3.4) and its SHA-256.
 *
 * The shape is the OTLP JSON shape (lowerCamelCase) with hex IDs, decimal-string int64, integer
 * enums, `AnyValue` with exactly one member, standard base64 for bytes, default-valued scalars
 * omitted, and unknown fields absent (the decoded model has none). Serialization is RFC 8785 via
 * the core `canonicalJson`, so the output is independent of key order and of the wire encoding.
 * Only fixed key names are used as object keys; attacker keys travel as string values inside
 * `{ key, value }` pairs.
 *
 * The hash functions return `null` when the core serializer refuses the value because its JSON
 * depth would exceed 64 (a 16-level kvlist chain inside a span event or link). Decoders reject
 * such a record with `any-value-too-deep`.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
type JsonObject = { [k: string]: Json };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding. */
export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : "=";
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : "=";
  }
  return out;
}

function anyValueJson(v: AnyValue): Json {
  switch (v.kind) {
    case "string":
      return { stringValue: v.value };
    case "bool":
      return { boolValue: v.value };
    case "int":
      return { intValue: v.value.toString() };
    case "double":
      return { doubleValue: v.value };
    case "bytes":
      return { bytesValue: base64Encode(v.value) };
    case "array":
      return { arrayValue: { values: v.values.map(anyValueJson) } };
    case "kvlist":
      return { kvlistValue: { values: v.values.map(keyValueJson) } };
  }
}

function keyValueJson(kv: KeyValue): Json {
  return { key: kv.key, value: anyValueJson(kv.value) };
}

function putString(o: JsonObject, name: string, v: string): void {
  if (v !== "") o[name] = v;
}

function putCount(o: JsonObject, name: string, v: number): void {
  if (v !== 0) o[name] = v;
}

function putTime(o: JsonObject, name: string, v: bigint): void {
  if (v !== 0n) o[name] = v.toString();
}

function putAttributes(o: JsonObject, attrs: readonly KeyValue[]): void {
  if (attrs.length > 0) o["attributes"] = attrs.map(keyValueJson);
}

function eventJson(e: SpanEvent): Json {
  const o: JsonObject = {};
  putTime(o, "timeUnixNano", e.timeUnixNano);
  putString(o, "name", e.name);
  putAttributes(o, e.attributes);
  putCount(o, "droppedAttributesCount", e.droppedAttributesCount);
  return o;
}

function linkJson(l: SpanLink): Json {
  const o: JsonObject = { traceId: l.traceId, spanId: l.spanId };
  putString(o, "traceState", l.traceState);
  putAttributes(o, l.attributes);
  putCount(o, "droppedAttributesCount", l.droppedAttributesCount);
  putCount(o, "flags", l.flags);
  return o;
}

/** The canonical JSON value of a span (not yet serialized). */
export function canonicalSpanValue(s: SpanData): Json {
  const o: JsonObject = { traceId: s.traceId, spanId: s.spanId };
  putString(o, "traceState", s.traceState);
  if (s.parentSpanId !== null) o["parentSpanId"] = s.parentSpanId;
  putCount(o, "flags", s.flags);
  putString(o, "name", s.name);
  putCount(o, "kind", s.kind);
  putTime(o, "startTimeUnixNano", s.startTimeUnixNano);
  putTime(o, "endTimeUnixNano", s.endTimeUnixNano);
  putAttributes(o, s.attributes);
  putCount(o, "droppedAttributesCount", s.droppedAttributesCount);
  if (s.events.length > 0) o["events"] = s.events.map(eventJson);
  putCount(o, "droppedEventsCount", s.droppedEventsCount);
  if (s.links.length > 0) o["links"] = s.links.map(linkJson);
  putCount(o, "droppedLinksCount", s.droppedLinksCount);
  if (s.status.code !== 0 || s.status.message !== "") {
    const st: JsonObject = {};
    putString(st, "message", s.status.message);
    putCount(st, "code", s.status.code);
    o["status"] = st;
  }
  return o;
}

/** The canonical JSON value of a log record (not yet serialized). */
export function canonicalLogRecordValue(r: LogRecordData): Json {
  const o: JsonObject = {};
  putTime(o, "timeUnixNano", r.timeUnixNano);
  putCount(o, "severityNumber", r.severityNumber);
  putString(o, "severityText", r.severityText);
  if (r.body !== null) o["body"] = anyValueJson(r.body);
  putAttributes(o, r.attributes);
  putCount(o, "droppedAttributesCount", r.droppedAttributesCount);
  putCount(o, "flags", r.flags);
  if (r.traceId !== null) o["traceId"] = r.traceId;
  if (r.spanId !== null) o["spanId"] = r.spanId;
  putTime(o, "observedTimeUnixNano", r.observedTimeUnixNano);
  putString(o, "eventName", r.eventName);
  return o;
}

export function canonicalResourceValue(r: Resource): Json {
  const o: JsonObject = {};
  putAttributes(o, r.attributes);
  putCount(o, "droppedAttributesCount", r.droppedAttributesCount);
  return o;
}

export function canonicalScopeValue(s: InstrumentationScope): Json {
  const o: JsonObject = {};
  putString(o, "name", s.name);
  putString(o, "version", s.version);
  putAttributes(o, s.attributes);
  putCount(o, "droppedAttributesCount", s.droppedAttributesCount);
  return o;
}

const encoder = new TextEncoder();

/** RFC 8785 text of a canonical value, or `null` if the core serializer's depth limit is hit. */
function serialize(v: Json): string | null {
  try {
    return canonicalJson(v);
  } catch (e) {
    if (e instanceof AtmError && e.code === "json-depth-exceeded") return null;
    throw e;
  }
}

function hashOf(v: Json): string | null {
  const text = serialize(v);
  return text === null ? null : sha256Hex(encoder.encode(text));
}

/** The canonical JSON text of a span (section 3.4); `null` only for the depth case above. */
export function canonicalSpanJson(s: SpanData): string | null {
  return serialize(canonicalSpanValue(s));
}

export function canonicalLogRecordJson(r: LogRecordData): string | null {
  return serialize(canonicalLogRecordValue(r));
}

/** `recordSha256` of a span: SHA-256 hex of its canonical JSON. */
export function spanRecordSha256(s: SpanData): string | null {
  return hashOf(canonicalSpanValue(s));
}

/** `recordSha256` of a log record. */
export function logRecordSha256(r: LogRecordData): string | null {
  return hashOf(canonicalLogRecordValue(r));
}

/** `resource_sha256`: hash of the canonical JSON of the resource alone. */
export function resourceSha256(r: Resource): string | null {
  return hashOf(canonicalResourceValue(r));
}

export function scopeSha256(s: InstrumentationScope): string | null {
  return hashOf(canonicalScopeValue(s));
}
