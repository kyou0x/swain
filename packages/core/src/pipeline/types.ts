import type { AdapterManifest, Bounds, FramedRecord, ProviderId } from "../adapter/contract.js";
import type { Attributes, Completeness, EventKind, EventTime, LinkRel } from "../schema/types.js";

/** Fixed context for one import. */
export interface Env {
  readonly manifest: AdapterManifest;
  readonly provider: ProviderId;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sessionId: string;
  readonly recs: readonly FramedRecord[];
  readonly recordBase: readonly (string | null)[];
  readonly bounds: Bounds;
  readonly policy: { readonly retention: "hash-only" | "inline"; readonly maxInlineBytes: number };
  readonly attributeKeys: ReadonlySet<string>;
}

export type Role = "user" | "agent" | "subagent" | "runtime" | "unknown";

/** A validated draft waiting for IDs, links and ordering. Field values are fresh copies. */
export interface Pending {
  order: number;
  evidence: number;
  emit: number;
  kind: EventKind;
  providerVersion: string | null;
  time: EventTime;
  role: Role;
  actorId: string;
  status: string;
  payload: Record<string, unknown>;
  completeness: Completeness;
  attributes: Attributes;
  /** Final provenance pointer (record base applied, 512-byte cap applied). */
  pointer: string | null;
  nativeTurnKey: string | undefined;
  anchor: string | undefined;
  refs: readonly { readonly rel: LinkRel; readonly key: string }[];
}

/** Closed reasons for `adapter-output-invalid` (static, never untrusted text). */
export type InvalidReason =
  | "not-object"
  | "unknown-field"
  | "bad-kind"
  | "bad-record-ref"
  | "bad-id-key"
  | "bad-pointer"
  | "bad-correlation"
  | "bad-attributes"
  | "bad-output"
  | "bad-disposition"
  | "bad-warning"
  | "inline-under-hash-only"
  | "inline-too-large"
  | "invalid-event"
  | "unaccounted-record"
  | "too-many-events-per-record";
