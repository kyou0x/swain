/**
 * Adapter contract, ADR-0002 section 12. TYPES AND CONSTANTS ONLY in S1;
 * behavior arrives in S3. Adapters depend on `core` contracts only.
 */
import type { WARNING_CODES } from "../schema/constants.js";
import type {
  ActorRole,
  Attributes,
  CaptureMode,
  Completeness,
  EventKind,
  EventTime,
  LinkRel,
  Provider,
  SourceStability,
} from "../schema/types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ProviderId = Provider;
export type WarningCode = (typeof WARNING_CODES)[number];

/** Static reason codes only, never untrusted text. The code list is defined by S3. */
export type DetectReasonCode = string;

export type CapabilityRow =
  | "sessionLifecycle"
  | "toolCallInputs"
  | "toolCallOutputs"
  | "llmMetadata"
  | "filePatches"
  | "subagents"
  | "permissions"
  | "failures"
  | "timestamps"
  | "tokens";
export type CapabilityValue = "available" | "partial" | "unknown" | "unsupported";
/** Must not exceed capability-matrix.json (checked per surface by a contract test, S3/S4). */
export type ProviderCapabilities = Readonly<Record<CapabilityRow, CapabilityValue>>;

export interface AdapterManifest {
  readonly id: string;
  readonly adapterVersion: string;
  readonly provider: ProviderId;
  readonly sourceKind: string;
  readonly sourceStability: SourceStability;
  /** P0: ["import-file"] only. */
  readonly captureModes: readonly CaptureMode[];
  readonly testedProviderVersions: readonly string[];
  readonly capabilities: ProviderCapabilities;
  /** How the core frames the source bytes (SPEC-002 M-6). */
  readonly framing: Framing;
  /** True for undocumented or internal surfaces (SPEC-002 M-17). Shown in every output. */
  readonly experimental: boolean;
  /** PA-3 allowlist: the exact `attributes` keys this adapter may emit. */
  readonly attributeKeys: readonly string[];
}

/** SPEC-002 M-6. `recordArrays` are RFC 6901 pointers to object keys, 1..4 entries. */
export type Framing =
  | { readonly kind: "jsonl" }
  | { readonly kind: "json-document"; readonly recordArrays: readonly string[] };

/** Produced by the core reader, never by adapters. */
export interface FramedRecord {
  readonly sourceSequence: number;
  readonly line: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly finalWithoutNewline: boolean;
  readonly parse:
    | { readonly ok: true; readonly value: JsonValue }
    | {
        readonly ok: false;
        readonly failure: "malformed" | "too-large" | "depth" | "invalid-utf8";
      };
}

export interface DetectResult {
  readonly verdict: "match" | "no-match" | "unsupported";
  readonly providerVersionSeen: string | null;
  readonly nativeSessionId: string | null;
  readonly reasons: readonly DetectReasonCode[];
}

export interface AdapterWarning {
  readonly code: WarningCode;
  readonly severity: "info" | "warn" | "error";
  readonly sourceSequence: number | null;
  /** At most 8 entries, bounded. */
  readonly detail: Readonly<Record<string, string | number>>;
}

/** `sourceSequence` values of records already pushed (SPEC-002 M-7). */
export interface RecordRef {
  readonly order: number;
  readonly evidence: number;
}

/**
 * ADR-0002 section 12: envelope minus {schemaVersion, eventId, provider, sourceKind,
 * sessionId, turnId, sourceSequence, subIndex, provenance, links}; plus {pointer,
 * nativeSessionId?, nativeTurnKey?, actorKey, correlation?}. The envelope's `actor`
 * carries only the role (the core derives `actorId` from `actorKey`), and payload
 * IDs are native keys (the core derives `tc_` and `act_` IDs).
 */
export interface DraftEvent {
  readonly kind: EventKind;
  readonly providerVersion: string | null;
  readonly time: EventTime;
  readonly actor: { readonly role: ActorRole };
  readonly status: string;
  readonly payload: { readonly [key: string]: JsonValue };
  readonly completeness: Completeness;
  readonly attributes: Attributes;
  readonly pointer: string | null;
  readonly nativeSessionId?: string | null;
  readonly nativeTurnKey?: string;
  readonly actorKey: string;
  /** Required for drafts returned by `end()`; optional in `push` (default: the current record). */
  readonly recordRef?: RecordRef;
  /** `anchor` registers this event; `refs` (at most 4) link to earlier anchors. */
  readonly correlation?: {
    readonly anchor?: string;
    readonly refs?: readonly { readonly rel: LinkRel; readonly key: string }[];
  };
}

/** How a source record is accounted for without producing its own event (SPEC-002 M-7). */
export interface RecordDisposition {
  readonly sourceSequence: number;
  readonly kind: "superseded" | "control" | "rewound" | "metadata";
  /** Accounted sequence the record folds into, or null. */
  readonly into: number | null;
}

export interface AdapterOutput {
  readonly drafts: readonly DraftEvent[];
  readonly warnings: readonly AdapterWarning[];
  readonly dispositions?: readonly RecordDisposition[];
}

/** Where provider files are expected, resolved by the CLI from injected env. No fs access. */
export interface DiscoveryRoot {
  readonly base: "home" | "xdg-data" | "xdg-config";
  /** Path segments below the base, e.g. [".codex", "sessions"]. */
  readonly segments: readonly string[];
}

/** Each adapter package exports exactly `registrations: readonly AdapterRegistration[]`. */
export interface AdapterRegistration {
  readonly adapter: SourceAdapter;
  readonly discovery: {
    readonly roots: readonly DiscoveryRoot[];
    /** Anchored regular expression source, no backreferences. */
    readonly fileNamePattern: string;
  };
}

export interface Bounds {
  readonly maxFileBytes: number;
  readonly maxRecordBytes: number;
  readonly maxJsonDepth: number;
  readonly maxRecords: number;
  readonly maxDraftsPerRecord: number;
  readonly maxOpenCorrelations: number;
  readonly maxInlineContentBytes: number;
  /** Then aggregated by code. */
  readonly maxWarnings: number;
  readonly detectSampleRecords: number;
  /** Then abort: outcome "failed". */
  readonly maxAdapterErrors: number;
  /** Whole-buffer cap for `json-document` framing. */
  readonly maxDocumentBytes: number;
  /** Events per import; beyond it a `bounds-reached` gap and outcome `partial`. */
  readonly maxEvents: number;
  /** Sum of retained inline content; later refs are downgraded to hash-only. */
  readonly maxTotalInlineBytes: number;
  /** Rendered report/UI size; exceeding it throws `OutputTooLarge`. */
  readonly maxOutputBytes: number;
  /** Total JSON values (and object keys) parsed across one source; beyond it records fail `too-large`. */
  readonly maxJsonValues: number;
}

/** Hard ceiling that `--max-file-bytes` can never raise `maxFileBytes` above (PA-2): 1 GiB. */
export const ABSOLUTE_MAX_FILE_BYTES = 1_073_741_824;

/**
 * Defaults. New in SPEC-002 (PA-2): maxDocumentBytes 64 MiB (a JSON document is parsed whole, so
 * it is capped far below maxFileBytes), maxEvents 1,000,000, maxTotalInlineBytes 64 MiB and
 * maxOutputBytes 256 MiB (equal to the render option default).
 */
export const DEFAULT_BOUNDS: Bounds = Object.freeze({
  maxFileBytes: 268_435_456,
  maxRecordBytes: 16_777_216,
  maxJsonDepth: 64,
  maxRecords: 2_000_000,
  maxDraftsPerRecord: 1024,
  maxOpenCorrelations: 100_000,
  maxInlineContentBytes: 65_536,
  maxWarnings: 1_000,
  detectSampleRecords: 64,
  maxAdapterErrors: 100,
  maxDocumentBytes: 67_108_864,
  maxEvents: 1_000_000,
  maxTotalInlineBytes: 67_108_864,
  maxOutputBytes: 268_435_456,
  maxJsonValues: 8_000_000,
});

export interface ParseContext {
  readonly providerVersionSeen: string | null;
  readonly bounds: Bounds;
  readonly contentPolicy: {
    readonly retention: "hash-only" | "inline";
    readonly maxInlineBytes: number;
  };
}

/** Synchronous, pure with respect to inputs; no I/O, no clock, no randomness. */
export interface RecordParser {
  /** Called only for records whose parse succeeded; the core handles failures. */
  push(record: FramedRecord): AdapterOutput;
  /** Flush: unresolved correlations. */
  end(): AdapterOutput;
}

export interface SourceAdapter {
  readonly manifest: AdapterManifest;
  /** Pure; sample is at most `bounds.detectSampleRecords`. */
  detect(sample: readonly FramedRecord[]): DetectResult;
  createParser(ctx: ParseContext): RecordParser;
}
