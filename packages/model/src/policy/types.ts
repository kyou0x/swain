/**
 * Post-policy types (ADR-0005 section 6, SPEC-003 section 2.3).
 *
 * `PolicyAppliedTraces`, `PolicyAppliedSpan`, `PolicyAppliedLogs` and `PolicyAppliedLog` are
 * branded: the only producer is `applyContentPolicy`. The brand is a type-level unique symbol plus
 * a runtime registry (`isPolicyApplied`), so `@swain/db` can both require the type and assert at its
 * boundary that a value really came from the applier. `@swain/db` may import them from `@swain/model`
 * (its policy profile allows `@swain/model`). `PolicyAppliedImport` (SPEC-003 section 2.3, ADR-0005
 * section 6.5) is NOT produced by this slice.
 */
import type { ContentRef } from "@swain/core";

export declare const POLICY_APPLIED: unique symbol;

/** A kept short string. It is best-effort masked (ADR-0005 section 6.4); the UI says so. */
export interface PolicyKeptText {
  readonly kind: "text";
  readonly value: string;
  readonly bestEffortMasked: true;
  /** Number of masker spans replaced in this string. */
  readonly redactionCount: number;
  /**
   * Identity component, present only for identity-bearing keys (agent id and name, service name
   * and namespace, session and conversation ids). The received value itself when masking left it
   * unchanged, else `"h:" + sha256(received value)`. The masked original is never stored, and no
   * identity or grouping key is ever derived from masked text (ADR-0005 section 3 note).
   */
  readonly identity?: string;
}

/** A value nested deeper than the OTLP bound: not walked, not hashed, not kept. */
export interface PolicyOverDepth {
  readonly kind: "over-depth";
}

/** Content, oversize, `bytesValue`, non-allowlisted or over-cap: a ContentRef (hash-only or inline). */
export interface PolicyContent {
  readonly kind: "content";
  readonly ref: ContentRef;
}

export type PolicyText = PolicyKeptText | PolicyContent;

export type PolicyValue =
  | PolicyText
  | PolicyOverDepth
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "int"; readonly value: bigint }
  | { readonly kind: "double"; readonly value: number }
  | { readonly kind: "array"; readonly values: readonly PolicyValue[] }
  | { readonly kind: "kvlist"; readonly values: readonly PolicyKeyValue[] };

export interface PolicyKeyValue {
  /** Neutralized, bounded to 256 bytes and masked (unless it is a pinned normalizer key). */
  readonly key: string;
  /** True when neutralization, redaction or truncation changed the received key. */
  readonly keyAltered: boolean;
  readonly value: PolicyValue;
}

export interface PolicyResource {
  readonly attributes: readonly PolicyKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface PolicyScope {
  readonly name: PolicyText;
  readonly version: PolicyText;
  readonly attributes: readonly PolicyKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface PolicySpanEvent {
  readonly timeUnixNano: bigint;
  readonly name: PolicyText;
  readonly attributes: readonly PolicyKeyValue[];
  readonly droppedAttributesCount: number;
}

export interface PolicySpanLink {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceState: PolicyText;
  readonly attributes: readonly PolicyKeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
}

export type PolicyWarningCode = "over-bounds";

export interface PolicyWarning {
  readonly path: string;
  readonly code: PolicyWarningCode;
}

/** The effective, validated policy; stored with the batch so a reader knows what was applied. */
export interface EffectivePolicy {
  readonly contentPolicy: "hash-only" | "inline";
  readonly maxInlineBytes: number;
  readonly metadataPolicy: "masked" | "allowlist";
  readonly contentKeysVersion: string;
}

interface Hashes {
  /** SHA-256 of the canonical JSON of the record BEFORE any policy (ADR-0005 section 5). */
  readonly recordSha256: string;
  readonly resourceSha256: string;
  readonly scopeSha256: string;
}

export interface PolicySpanFields extends Hashes {
  /** The policy applied to this record, for the store to compare with the project's policy. */
  readonly policy: EffectivePolicy;
  readonly path: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceState: PolicyText;
  readonly flags: number;
  readonly name: PolicyText;
  readonly kind: 0 | 1 | 2 | 3 | 4 | 5;
  readonly startTimeUnixNano: bigint;
  readonly endTimeUnixNano: bigint;
  readonly attributes: readonly PolicyKeyValue[];
  readonly droppedAttributesCount: number;
  readonly events: readonly PolicySpanEvent[];
  readonly droppedEventsCount: number;
  readonly links: readonly PolicySpanLink[];
  readonly droppedLinksCount: number;
  readonly status: { readonly code: 0 | 1 | 2; readonly message: PolicyText };
  readonly resource: PolicyResource;
  readonly resourceSchemaUrl: PolicyText;
  readonly scope: PolicyScope;
  readonly scopeSchemaUrl: PolicyText;
  /** Sum of kept metadata string bytes in this record (cap: 16 KiB). */
  readonly metadataBytes: number;
  readonly warnings: readonly PolicyWarning[];
}

export interface PolicyLogFields extends Hashes {
  readonly policy: EffectivePolicy;
  readonly path: string;
  readonly timeUnixNano: bigint;
  readonly observedTimeUnixNano: bigint;
  readonly severityNumber: number;
  readonly severityText: PolicyText;
  /** Always content (ADR-0005 section 6.3, "Log records: body"). */
  readonly body: PolicyContent | PolicyOverDepth | null;
  readonly attributes: readonly PolicyKeyValue[];
  readonly droppedAttributesCount: number;
  readonly flags: number;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly eventName: PolicyText;
  readonly resource: PolicyResource;
  readonly resourceSchemaUrl: PolicyText;
  readonly scope: PolicyScope;
  readonly scopeSchemaUrl: PolicyText;
  readonly metadataBytes: number;
  readonly warnings: readonly PolicyWarning[];
}

export type PolicyAppliedSpan = PolicySpanFields & { readonly [POLICY_APPLIED]: "span" };
export type PolicyAppliedLog = PolicyLogFields & { readonly [POLICY_APPLIED]: "log" };

export interface PolicyTracesFields {
  readonly signal: "traces";
  readonly policy: EffectivePolicy;
  readonly spans: readonly PolicyAppliedSpan[];
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
  readonly warnings: readonly { readonly path: string; readonly code: string }[];
}

export interface PolicyLogsFields {
  readonly signal: "logs";
  readonly policy: EffectivePolicy;
  readonly logs: readonly PolicyAppliedLog[];
  readonly rejected: readonly { readonly path: string; readonly reason: string }[];
  readonly warnings: readonly { readonly path: string; readonly code: string }[];
}

export type PolicyAppliedTraces = PolicyTracesFields & { readonly [POLICY_APPLIED]: "traces" };
export type PolicyAppliedLogs = PolicyLogsFields & { readonly [POLICY_APPLIED]: "logs" };

const STAMPED = new WeakSet<object>();

/** Deep-freeze plain data (objects and arrays; `bigint` and strings are immutable already). */
export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

/**
 * Internal: deep-freeze and mark an object as produced by the applier. Not exported from the
 * package. Every output (batch, span, log) is stamped individually.
 */
export function stamp<T extends object>(o: T): T {
  deepFreeze(o);
  STAMPED.add(o);
  return o;
}

/**
 * Runtime check for `@swain/db` boundaries: true only for objects the applier produced. Outputs are
 * deep-frozen. A consumer MUST call this on EACH span and log it stores, not only on the batch:
 * the batch's `spans` array is frozen, but a forged object cast to `PolicyAppliedSpan` is only
 * caught by this check.
 */
export function isPolicyApplied(
  v: unknown,
): v is PolicyAppliedSpan | PolicyAppliedLog | PolicyAppliedTraces | PolicyAppliedLogs {
  return typeof v === "object" && v !== null && STAMPED.has(v);
}
