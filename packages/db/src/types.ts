/**
 * Backend-agnostic data types of the Swain store (SPEC-003 section 2.3). Nothing here mentions
 * SQLite, so a Postgres implementation can satisfy the same `SwainStore`.
 */
import type { ImportResult } from "@swain/core";
import type { AgentIdentity, PolicyAppliedLog, PolicyAppliedSpan, RunRef } from "@swain/model";
import type { ImportRecord } from "@swain/report";
import type { AgtId, BatchId, KeyId, OrgId, PrjId, RunId, WspId } from "./ids.js";

/** Org-level scope: only for org-level operations (create/list projects, audit, auth lookups). */
export interface OrgScope {
  readonly orgId: OrgId;
}
/** Project scope: `projectId` is required, never optional (G0 F12). */
export interface ProjectScope {
  readonly orgId: OrgId;
  readonly projectId: PrjId;
}

export const CONTENT_POLICIES = ["hash-only", "inline"] as const;
export type ContentPolicy = (typeof CONTENT_POLICIES)[number];
export const RAW_RETENTIONS = ["hash-only", "full"] as const;
export type RawRetention = (typeof RAW_RETENTIONS)[number];
export const DERIVATIONS = ["server", "client", "migrated"] as const;
export type Derivation = (typeof DERIVATIONS)[number];
export const RUN_KINDS = ["trace", "session", "import", "logs"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const OP_CLASSES = ["llm", "tool", "agent", "handoff", "workflow", "generic"] as const;
export type OpClass = (typeof OP_CLASSES)[number];
export const SIGNALS = ["traces", "logs", "source", "events", "hooks"] as const;
export type Signal = (typeof SIGNALS)[number];
export const ENCODINGS = ["json", "protobuf", "octet", "ndjson"] as const;
export type Encoding = (typeof ENCODINGS)[number];
export const CONTENT_ENCODINGS = ["identity", "gzip"] as const;
export type ContentEncoding = (typeof CONTENT_ENCODINGS)[number];
export const BATCH_STATUSES = ["accepted", "partial", "rejected"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
/** The closed scope set of an ingest key (SPEC-003 sections 3.2 and 3.3). */
export const KEY_SCOPES = [
  "ingest:otlp",
  "ingest:native",
  "ingest:hooks",
  "ingest:replace",
  "read:status",
] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];
/** `exists`: a client-derived import for an `importId` that already has any version (ADR-0006 2). */
export type PutStatus = "added" | "unchanged" | "superseded" | "skipped-version" | "exists";

// ---- migrations ---------------------------------------------------------------------------------
export interface MigrationReport {
  /** Highest applied version before this call (0 for a new database). */
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly {
    readonly version: number;
    readonly name: string;
    readonly sha256: string;
  }[];
  /** Absolute path of the pre-migration backup, or null when none was needed. */
  readonly backupPath: string | null;
}

// ---- tenancy ------------------------------------------------------------------------------------
export interface Org {
  readonly orgId: OrgId;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}
export interface Workspace {
  readonly orgId: OrgId;
  readonly workspaceId: WspId;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}
export interface Project {
  readonly orgId: OrgId;
  readonly workspaceId: WspId;
  readonly projectId: PrjId;
  readonly slug: string;
  readonly name: string;
  readonly contentPolicy: ContentPolicy;
  readonly maxInlineBytes: number;
  readonly rawRetention: RawRetention;
  readonly createdAt: string;
}
export interface NewProject {
  readonly workspaceId: WspId;
  readonly slug: string;
  readonly name: string;
  readonly contentPolicy?: ContentPolicy;
  readonly maxInlineBytes?: number;
  readonly rawRetention?: RawRetention;
  readonly createdAt: string;
}

// ---- keys ---------------------------------------------------------------------------------------
export interface NewKey {
  readonly label: string;
  readonly scopes: readonly KeyScope[];
  readonly agentName?: string | null;
  readonly integration?: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAtMs?: number | null;
}
/** A key as listed to administrators: never carries the secret or its hash. */
export interface KeyRecord {
  readonly keyId: KeyId;
  readonly orgId: OrgId;
  readonly projectId: PrjId;
  readonly label: string;
  readonly scopes: readonly KeyScope[];
  readonly agentName: string | null;
  readonly integration: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAtMs: number | null;
  readonly revokedAtMs: number | null;
  readonly lastUsedMs: number | null;
}
/** What authentication needs: the record plus the stored hash to compare against. */
export interface KeyAuthRecord extends KeyRecord {
  readonly secretSha256: string;
}

// ---- ingest -------------------------------------------------------------------------------------
export interface BatchInput {
  readonly batchId: BatchId;
  readonly signal: Signal;
  readonly encoding: Encoding;
  readonly contentEncoding: ContentEncoding;
  readonly bodySha256: string;
  readonly bodyBytes: number;
  readonly decodedSha256: string;
  readonly decodedBytes: number;
  readonly receivedMs: number;
  readonly status: BatchStatus;
  readonly accepted: number;
  readonly rejected: number;
  /** JSON text of the response the server sent; replayed verbatim on a duplicate. */
  readonly resultJson: string;
  readonly raw?: Uint8Array | null;
  /** Native batches: `Idempotency-Key` (<= 128 printable ASCII) scoped by route (ADR-0006 section 4). */
  readonly idempotency?: { readonly route: string; readonly key: string } | null;
}
export interface BatchRecord {
  readonly batchId: BatchId;
  readonly signal: Signal;
  readonly status: BatchStatus;
  readonly accepted: number;
  readonly rejected: number;
  readonly resultJson: string;
}
/**
 * `created`: new batch stored. `duplicate`: same `(signal, decodedSha256)` or same live idempotency
 * key and body; nothing was written and `batch` is the stored one. `idempotency-conflict`: the key
 * was seen with another body hash (HTTP 409).
 */
export type BatchOutcome =
  | { readonly outcome: "created"; readonly batch: BatchRecord }
  | { readonly outcome: "duplicate"; readonly batch: BatchRecord }
  | { readonly outcome: "idempotency-conflict" };

/** The row form of an agent, built by the store from a stamped `AgentIdentity`; never caller input. */
export interface AgentUpsert {
  readonly agentId: AgtId;
  readonly agentKey: string;
  readonly keyBasis: string;
  readonly displayName: string;
}
/** The row form of a run, built by the store from a stamped `RunRef`; never caller input. */
export interface RunUpsert {
  readonly runId: RunId;
  readonly kind: RunKind;
  readonly primaryAgentId: AgtId;
  readonly traceId: string | null;
  readonly adrSessionId: string | null;
  readonly sessionKey: string | null;
  readonly legacyImportId: string | null;
  readonly derivation: Derivation;
}
export interface ResourceInput {
  readonly sha256: string;
  readonly attributesJson: string;
  readonly schemaUrl: string | null;
}

/**
 * What the caller hands the store for one span: the `PolicyAppliedSpan` that `applyContentPolicy`
 * (`@swain/model`) produced, plus the agent identity and run that `@swain/model` derived (stamped,
 * frozen; copies are refused). The store re-checks both against the span and the key: an agent must
 * be the identity the model derives from the key's pin or from the span's own attributes, and a run
 * must be the trace run of the span's trace ID (SPEC-003 "Hard condition"). Display name, agent key,
 * session facts and the operation class are derived or read from those stamped outputs, never from
 * caller text. A forged or copied object is refused with `db-constraint`.
 */
/** The schema URLs exactly as received (before the content policy): the dedup evidence uses these. */
export interface ReceivedSchemaUrls {
  readonly resourceSchemaUrl: string;
  readonly scopeSchemaUrl: string;
}
export interface SpanPut {
  readonly span: PolicyAppliedSpan;
  readonly received: ReceivedSchemaUrls;
  readonly run: RunRef;
  readonly agent: AgentIdentity;
  readonly receivedMs: number;
  /** Set by the caller when the run already had end evidence (ADR-0006 section 5). */
  readonly late: boolean;
}
export interface LogPut {
  readonly log: PolicyAppliedLog;
  readonly received: ReceivedSchemaUrls;
  /** Index among identical records (same `recordSha256`) within its batch. */
  readonly occurrence: number;
  /** `run` and `agent` are both set or both null. */
  readonly run: RunRef | null;
  readonly agent: AgentIdentity | null;
  readonly projectedImportId: string | null;
  readonly receivedMs: number;
}

/**
 * The row form of a span, derived from a `SpanPut` by the store (the store API does not accept it).
 * Times are int64 nanoseconds; unset is null. JSON columns hold the post-policy forms.
 */
export interface NormalizedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly run: RunUpsert;
  readonly agent: AgentUpsert;
  readonly resource: ResourceInput;
  /** JSON text: a metadata string or a ContentRef. */
  readonly nameJson: string;
  readonly kind: number;
  readonly startNs: bigint | null;
  readonly endNs: bigint | null;
  readonly statusCode: number;
  readonly statusMessageJson: string | null;
  /** `PolicyText` JSON. */
  readonly traceStateJson: string | null;
  readonly flags: number | null;
  readonly attributesJson: string;
  readonly droppedAttributes: number;
  readonly eventsJson: string;
  readonly linksJson: string;
  readonly scopeJson: string;
  readonly opClass: OpClass;
  readonly opJson: string;
  readonly recordPath: string;
  /** The bare SPEC-003 3.4 record hash (`record_sha256`). */
  readonly recordSha256: string;
  /**
   * The span evidence digest (`spanEvidenceSha256`, `evidence_sha256`): the record hash together
   * with the resource hash, scope hash and both RECEIVED schema URLs, domain-separated. A resend of
   * the same record under another resource or scope is different evidence (otlp README F4).
   */
  readonly evidenceSha256: string;
  readonly receivedMs: number;
  /** Set by the caller when the run already had end evidence (ADR-0006 section 5). */
  readonly late: boolean;
}
/** A record refused on its own (F13); the batch is never aborted for it. */
export interface RecordRejection {
  readonly index: number;
  /** `constraint`: the store refused this record's facts or sizes (N1.5 G3 F2); the batch goes on. */
  readonly code: "ns-out-of-range" | "constraint";
}
export interface SpanPutStats {
  readonly inserted: number;
  /** Identical re-sightings from the same key (rows in `span_conflicts`, relation `identical-same-key`). */
  readonly seenAgain: number;
  /** Identical records first sent by another key (`identical-other-key`). */
  readonly identicalOtherKey: number;
  /** Different records with the same IDs (`conflicting`). */
  readonly conflicts: number;
  readonly rejected: number;
  readonly rejections: readonly RecordRejection[];
}
export interface NormalizedLog {
  /** Index among identical records (same `recordSha256`) within its batch. */
  readonly occurrence: number;
  readonly run: RunUpsert | null;
  readonly agent: AgentUpsert | null;
  readonly resource: ResourceInput;
  readonly timeNs: bigint | null;
  readonly observedNs: bigint | null;
  readonly severityNumber: number | null;
  /** `PolicyText` JSON. */
  readonly severityTextJson: string | null;
  readonly eventNameJson: string | null;
  readonly bodyJson: string | null;
  readonly attributesJson: string;
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly scopeJson: string;
  readonly recordPath: string;
  /** The bare record hash (the `record_sha256` column of `log_records`). */
  readonly recordSha256: string;
  /** Hash of the scope as received and both schema URLs as received: the dedup tuple (F4). */
  readonly scopeSha256: string;
  readonly receivedResourceSchemaUrl: string;
  readonly receivedScopeSchemaUrl: string;
  readonly projectedImportId: string | null;
  readonly receivedMs: number;
}
export interface LogPutStats {
  readonly inserted: number;
  /** Same `(recordSha256, occurrence)` already stored in this project: not stored twice. */
  readonly duplicates: number;
  /** Subset of `duplicates`: identical records first sent by another key (own row, `dup_of` set). */
  readonly identicalOtherKey: number;
  readonly rejected: number;
  readonly rejections: readonly RecordRejection[];
}

/**
 * An already built import. The caller runs `buildImportRecord` (`@swain/store`, which `@swain/db` may
 * not import) and the content policy; the store re-validates everything it is given.
 */
export interface ImportPut {
  readonly record: ImportRecord;
  readonly result: ImportResult;
  readonly derivation: Derivation;
  readonly batchId: BatchId | null;
  readonly receivedMs: number;
}
/** The credential of an import: a key ID, or `local-cli` for a local `swain db import-store`. */
export type CredentialRef = KeyId | "local-cli";
/** The bounds of the list reads (G3 F6): a result of this size sets the `truncated` flag. */
export const MAX_LIST = 1000;
export interface ProjectList {
  readonly projects: readonly Project[];
  readonly truncated: boolean;
}
export interface KeyList {
  readonly keys: readonly KeyRecord[];
  readonly truncated: boolean;
}
/**
 * Session lifetimes per mode (ADR-0007 r2 section 4, T-N4b): local mode is shorter because other
 * web apps on loopback share the cookie jar.
 */
export const SESSION_LIFETIMES = {
  local: { idleMs: 2 * 3_600_000, absoluteMs: 24 * 3_600_000 },
  team: { idleMs: 12 * 3_600_000, absoluteMs: 7 * 86_400_000 },
} as const;
export type SessionMode = keyof typeof SESSION_LIFETIMES;
/** The longest a login code may live (G3 F10). */
export const MAX_LOGIN_CODE_MS = 60_000;
export interface ImportPutResult {
  readonly status: PutStatus;
  readonly importId: string;
  readonly runId: RunId;
  /** The version written, or the current one when nothing was written. */
  readonly version: number;
}
export interface ProjectPolicyPatch {
  readonly contentPolicy?: ContentPolicy;
  readonly maxInlineBytes?: number;
  readonly rawRetention?: RawRetention;
}
export interface Actor {
  readonly type: string;
  readonly id: string;
  readonly at: string;
}
/**
 * An import that went through the content policy. `@swain/model` does not produce this type yet
 * (ADR-0005 6.5), so it stays a structural brand here; spans and logs use the model brands.
 */
export type PolicyAppliedImport = ImportPut & { readonly __policyAppliedImport: true };

// ---- reads --------------------------------------------------------------------------------------
export interface AgentRow {
  readonly agentId: AgtId;
  readonly projectId: PrjId;
  readonly agentKey: string;
  readonly keyBasis: string;
  readonly displayName: string;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}
export interface FleetQuery {
  readonly sort: "recent" | "name";
  readonly limit: number;
  readonly offset: number;
}
export interface FleetRow extends AgentRow {
  readonly runCount: number;
  readonly lastRunId: RunId | null;
}
export interface FleetPage {
  readonly rows: readonly FleetRow[];
  readonly total: number;
}
export interface RunSummary {
  readonly runId: RunId;
  readonly projectId: PrjId;
  readonly kind: RunKind;
  readonly primaryAgentId: AgtId;
  readonly traceId: string | null;
  readonly adrSessionId: string | null;
  readonly sessionKey: string | null;
  readonly legacyImportId: string | null;
  readonly derivation: Derivation;
  readonly firstTimeNs: bigint | null;
  readonly lastTimeNs: bigint | null;
  readonly firstReceivedMs: number;
  readonly lastReceivedMs: number;
  readonly endEvidence: boolean;
  readonly counts: Readonly<Record<string, number>>;
  readonly flags: Readonly<Record<string, boolean>>;
  /** L2 cache: which credentials delivered the records of this run (G0 F6). */
  readonly credentials: readonly { readonly keyId: string; readonly records: number }[];
}
export interface AgentDetail {
  readonly agent: AgentRow;
  readonly runCount: number;
  /** Most recent first, at most 50. */
  readonly recentRuns: readonly RunSummary[];
}
export interface RunsQuery {
  readonly agentId?: AgtId;
  readonly kind?: RunKind;
  readonly limit: number;
  readonly offset: number;
}
export interface RunsPage {
  readonly rows: readonly RunSummary[];
  readonly total: number;
}
export interface ImportSummary {
  readonly importId: string;
  readonly version: number;
  readonly keyId: string;
  readonly derivation: Derivation;
  readonly batchId: BatchId | null;
  readonly receivedMs: number;
  readonly firstValidTime: string | null;
  readonly record: ImportRecord;
}
export interface RunDetail {
  readonly run: RunSummary;
  readonly agentIds: readonly AgtId[];
  readonly imports: readonly ImportSummary[];
  /** True when more agents or current imports exist than `MAX_LIST` (also bounds `runEvents`). */
  readonly truncated: { readonly agents: boolean; readonly imports: boolean };
}
/** One import of an event-backed run; `result.events` went through `validateEvents`. */
/** The current imports of a run as sessions; `truncated` when it has more than `MAX_LIST` imports. */
export interface RunEvents {
  readonly sessions: readonly SessionView[];
  readonly truncated: boolean;
}
export interface SessionView {
  readonly record: ImportRecord;
  readonly result: ImportResult;
}
export interface StoredSpan extends Omit<NormalizedSpan, "run" | "agent" | "resource" | "late"> {
  readonly runId: RunId;
  readonly agentId: AgtId;
  readonly resourceSha256: string;
  readonly batchId: BatchId;
  readonly keyId: string;
  readonly late: boolean;
  /** False when a `conflicting` record from a different key exists (neither is canonical, ADR-0006 4). */
  readonly canonical: boolean;
}
export interface StoredSpanConflict {
  readonly traceId: string;
  readonly spanId: string;
  readonly recordSha256: string;
  readonly batchId: BatchId;
  /** The key that sent the conflicting record, and the key that sent the canonical one (F6). */
  readonly keyId: string;
  readonly relation: "identical-same-key" | "identical-other-key" | "conflicting";
  readonly canonicalKeyId: string;
  readonly recordPath: string;
  readonly receivedMs: number;
  /** The conflicting record in post-content-policy form: the caller passes policed data. */
  readonly recordJson: string;
}
export interface SpanRunData {
  /** Ordered by start time (unknown last), then arrival. */
  readonly spans: readonly StoredSpan[];
  readonly conflicts: readonly StoredSpanConflict[];
  /** True when more spans exist than `limit`. */
  readonly truncated: boolean;
  /** True when more conflict rows exist than were returned (1000). */
  readonly conflictsTruncated: boolean;
}
export interface ResolvedRef {
  readonly projectId: PrjId;
  readonly type: "run" | "agent" | "import" | "event" | "span";
  readonly id: string;
  /** The run to open for this reference, when one is known. */
  readonly runId: RunId | null;
}
export interface ProjectStatus {
  readonly projectId: PrjId;
  readonly slug: string;
  readonly agents: number;
  readonly runs: number;
  readonly lastIngestMs: number | null;
  readonly batches24h: {
    readonly accepted: number;
    readonly partial: number;
    readonly rejected: number;
  };
  readonly contentPolicy: ContentPolicy;
  readonly rawRetention: RawRetention;
}
export interface StoreStatus {
  readonly schemaVersion: number;
  readonly projects: readonly ProjectStatus[];
}

// ---- auth ---------------------------------------------------------------------------------------
export interface NewLoginCode {
  readonly codeSha256: string;
  readonly orgId: OrgId;
  /** A same-origin relative path: starts with one `/`, no control characters, <= 512 bytes. */
  readonly nextPath: string;
  readonly expiresAtMs: number;
}
export interface LoginResult {
  readonly orgId: OrgId;
  readonly nextPath: string;
}
export interface NewSession {
  readonly tokenSha256: string;
  readonly principal: string;
  readonly createdMs: number;
}
export interface Session {
  readonly orgId: OrgId;
  readonly principal: string;
  readonly createdMs: number;
  readonly lastSeenMs: number;
}

// ---- audit --------------------------------------------------------------------------------------
/** The closed action list of ADR-0007 section 8. */
export const AUDIT_ACTIONS = [
  "key.create",
  "key.revoke",
  "login.success",
  "login.failure",
  "session.revoke",
  "project.create",
  "project.policy.change",
  "member.add",
  "member.role.change",
  "member.remove",
  "retention.apply",
  "db.import-store",
  "db.migrate",
  "server.start",
  "ingest.rejected",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export interface AuditEntryInput {
  readonly at: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  /** Static codes and IDs only (ADR-0007 section 8): flat, at most 32 keys. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}
export type AuditVerifyResult =
  | { readonly ok: true; readonly entries: number }
  | {
      readonly ok: false;
      readonly entries: number;
      readonly firstBadSeq: number;
      readonly reason: "gap" | "prev-hash" | "hash" | "invalid-row";
    };
