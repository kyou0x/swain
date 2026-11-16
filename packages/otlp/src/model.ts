/**
 * FROZEN CONTRACT (SPEC-003 N1.2/N1.3): the decoded OTLP model.
 *
 * Both the JSON decoder (N1.2) and the protobuf decoder (N1.3) produce exactly these types, and
 * the normalizer (@swain/model, ADR-0005) and storage (@swain/db) consume them. Nothing in this file
 * may depend on the wire format. Changing a type, a field name, a range or a documented rule here
 * is a contract change that needs an ADR; do not edit it as part of a decoder change.
 *
 * Conventions (all enforced by the decoders, not by the types):
 * - Times are `bigint` nanoseconds since the Unix epoch, range 0 .. 2^63-1. BigInt is exact for
 *   every int64 (a JS number loses precision above 2^53), compares and sorts correctly, and maps
 *   directly to a SQLite INTEGER (int64) round trip. `0n` means "unset", as in OTLP.
 * - IDs are lowercase hex: traceId 32 chars, spanId 16 chars, never all zero. An absent
 *   parent/trace/span reference is `null`, never an empty string.
 * - Enums (`kind`, `status.code`, `severityNumber`) are plain integers within the OTLP range.
 * - Strings are well-formed Unicode (no lone surrogates).
 * - Attribute lists keep wire order and are arrays of KeyValue, never objects, so attacker keys
 *   such as `__proto__` are inert data.
 * - `path` is a JSON-pointer-like locator of the record in the request, e.g.
 *   `/resourceSpans/0/scopeSpans/1/spans/3`; indexes are positions in the wire arrays, including
 *   rejected siblings. The protobuf decoder uses the same shape with repeated-field indexes.
 * - `recordSha256` is SHA-256 (lowercase hex) of the RFC 8785 canonical JSON of the record itself
 *   (SPEC-003 section 3.4) of the record as decoded and validated IN FULL: before attribute /
 *   event / link truncation (ADR-0006 section 6) and before any content policy. The model returned
 *   next to the hash may therefore be a truncated view of the hashed record (`droppedXCount`
 *   says so); the hash is never recomputed from a truncated model.
 */

export const DECODED_MODEL_VERSION = "swain.otlp-decoded/1" as const;

/** Exactly one member, as OTLP `AnyValue`. An AnyValue with no member is rejected by the decoders. */
export type AnyValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "double"; readonly value: number }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "array"; readonly values: readonly AnyValue[] }
  | { readonly kind: "kvlist"; readonly values: readonly KeyValue[] };

export interface KeyValue {
  readonly key: string;
  readonly value: AnyValue;
}

export interface Resource {
  readonly attributes: readonly KeyValue[];
  readonly droppedAttributesCount: number;
}

export interface InstrumentationScope {
  readonly name: string;
  readonly version: string;
  readonly attributes: readonly KeyValue[];
  readonly droppedAttributesCount: number;
}

/** OTLP SpanKind: 0 unspecified, 1 internal, 2 server, 3 client, 4 producer, 5 consumer. */
export type SpanKindInt = 0 | 1 | 2 | 3 | 4 | 5;
/** OTLP Status.StatusCode: 0 unset, 1 ok, 2 error. */
export type StatusCodeInt = 0 | 1 | 2;

export interface SpanEvent {
  readonly timeUnixNano: bigint;
  readonly name: string;
  readonly attributes: readonly KeyValue[];
  readonly droppedAttributesCount: number;
}

export interface SpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceState: string;
  readonly attributes: readonly KeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
}

export interface SpanStatus {
  readonly code: StatusCodeInt;
  readonly message: string;
}

/** The span itself, the input of the section 3.4 canonical form. */
export interface SpanData {
  readonly traceId: string;
  readonly spanId: string;
  /** `null` for a root span (absent or empty on the wire). */
  readonly parentSpanId: string | null;
  readonly traceState: string;
  readonly flags: number;
  readonly name: string;
  readonly kind: SpanKindInt;
  readonly startTimeUnixNano: bigint;
  /** `0n` when the span has no end (open span, ADR-0006 section 5). */
  readonly endTimeUnixNano: bigint;
  readonly attributes: readonly KeyValue[];
  readonly droppedAttributesCount: number;
  readonly events: readonly SpanEvent[];
  readonly droppedEventsCount: number;
  readonly links: readonly SpanLink[];
  readonly droppedLinksCount: number;
  readonly status: SpanStatus;
}

export interface DecodedSpan extends SpanData {
  readonly path: string;
  readonly recordSha256: string;
}

/** The log record itself, the input of the section 3.4 canonical form. */
export interface LogRecordData {
  readonly timeUnixNano: bigint;
  readonly observedTimeUnixNano: bigint;
  /** 0 .. 24 (OTLP SeverityNumber). */
  readonly severityNumber: number;
  readonly severityText: string;
  readonly body: AnyValue | null;
  readonly attributes: readonly KeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
  readonly traceId: string | null;
  readonly spanId: string | null;
  /** OTLP `eventName` (empty when absent). Claude Code also carries `event.name` as an attribute. */
  readonly eventName: string;
}

export interface DecodedLogRecord extends LogRecordData {
  readonly path: string;
  readonly recordSha256: string;
}

export interface DecodedScopeSpans {
  readonly path: string;
  readonly scope: InstrumentationScope;
  /** SHA-256 of the canonical JSON of `scope`. */
  readonly scopeSha256: string;
  readonly schemaUrl: string;
  readonly spans: readonly DecodedSpan[];
}

export interface DecodedResourceSpans {
  readonly path: string;
  readonly resource: Resource;
  /** SHA-256 of the canonical JSON of `resource` (`resource_sha256`, SPEC-003 section 3.4). */
  readonly resourceSha256: string;
  readonly schemaUrl: string;
  readonly scopeSpans: readonly DecodedScopeSpans[];
}

export interface DecodedScopeLogs {
  readonly path: string;
  readonly scope: InstrumentationScope;
  readonly scopeSha256: string;
  readonly schemaUrl: string;
  readonly logRecords: readonly DecodedLogRecord[];
}

export interface DecodedResourceLogs {
  readonly path: string;
  readonly resource: Resource;
  readonly resourceSha256: string;
  readonly schemaUrl: string;
  readonly scopeLogs: readonly DecodedScopeLogs[];
}

/** Why one record was rejected. Static codes only; never contains input text. */
export type RejectReason =
  | "invalid-type"
  | "invalid-trace-id"
  | "invalid-span-id"
  | "invalid-parent-span-id"
  | "invalid-int64"
  | "invalid-uint32"
  | "time-out-of-range"
  | "invalid-enum"
  | "invalid-double"
  | "invalid-base64"
  | "invalid-any-value"
  | "any-value-too-deep"
  | "too-many-entries"
  | "invalid-string"
  | "duplicate-key"
  | "string-too-long"
  | "key-too-long";

export interface RejectedRecord {
  readonly path: string;
  readonly reason: RejectReason;
}

/** A non-fatal observation. `over-bounds`: truncated, dropped count incremented (ADR-0006 s6). */
export type DecodeWarningCode = "over-bounds" | "time-inverted";

export interface DecodeWarning {
  readonly path: string;
  readonly code: DecodeWarningCode;
}

export interface DecodedTraces {
  readonly signal: "traces";
  readonly resourceSpans: readonly DecodedResourceSpans[];
  /** One entry per rejected span, in document order. Accepted + rejected = spans on the wire. */
  readonly rejected: readonly RejectedRecord[];
  readonly warnings: readonly DecodeWarning[];
}

export interface DecodedLogs {
  readonly signal: "logs";
  readonly resourceLogs: readonly DecodedResourceLogs[];
  readonly rejected: readonly RejectedRecord[];
  readonly warnings: readonly DecodeWarning[];
}

/** Whole-request failure codes (the request is answered 400/413, nothing is stored). */
export type DecodeErrorCode =
  | "body-too-large"
  | "invalid-utf8"
  | "malformed-json"
  | "json-too-deep"
  | "too-many-values"
  | "invalid-structure"
  | "too-many-resource-groups"
  | "too-many-scope-groups"
  | "too-many-records"
  | "invalid-option"
  | "internal";

/** The OTLP `partialSuccess` content for a decoded request. */
export interface PartialSuccess {
  readonly rejected: number;
  /** Static reason code of the first rejected record. */
  readonly errorMessage: RejectReason;
}
