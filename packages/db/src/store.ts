/**
 * The storage interface (SPEC-003 r2 section 2.3). No method accepts SQL; every tenant method
 * takes a scope, and project-scoped methods take a `ProjectScope` whose `projectId` is required.
 */
import type { AgtId, BatchId, KeyId, OrgId, PrjId, RunId } from "./ids.js";
import type {
  Actor,
  AgentDetail,
  AuditEntryInput,
  AuditVerifyResult,
  BatchInput,
  BatchOutcome,
  BatchRecord,
  FleetPage,
  FleetQuery,
  ImportPutResult,
  KeyAuthRecord,
  KeyList,
  KeyRecord,
  LoginResult,
  LogPut,
  LogPutStats,
  MigrationReport,
  NewKey,
  NewLoginCode,
  NewProject,
  NewSession,
  Org,
  OrgScope,
  PolicyAppliedImport,
  Project,
  ProjectList,
  ProjectPolicyPatch,
  ProjectScope,
  RecordRejection,
  ResolvedRef,
  RunDetail,
  RunEvents,
  RunsPage,
  RunsQuery,
  Session,
  Signal,
  SpanPut,
  SpanPutStats,
  SpanRunData,
  StoreStatus,
  Workspace,
} from "./types.js";

export interface SwainStore {
  migrate(deps: { nowIso: () => string }): MigrationReport;

  // tenancy (local mode bootstrap)
  ensureLocalTenancy(nowIso: string): { org: Org; workspace: Workspace; project: Project };
  /** The local org if it exists; read-only, never creates tenancy. */
  findLocalOrg(): Org | null;
  createProject(s: OrgScope, p: NewProject): Project;
  getProject(s: ProjectScope): Project | null;
  listProjects(s: OrgScope): ProjectList;
  /** Audited (`project.policy.change`) in the same transaction. */
  setProjectPolicy(s: ProjectScope, p: ProjectPolicyPatch, actor: Actor): Project;

  // keys
  /** `secret` is returned once; only its SHA-256 is stored. `serverProofKey` goes to the credential file. */
  createKey(s: ProjectScope, k: NewKey): { key: KeyRecord; secret: string; serverProofKey: string };
  /** An unscoped lookup (pinned in the registry): returns the scope for authentication. */
  findKey(keyId: string): KeyAuthRecord | null;
  revokeKey(s: ProjectScope, keyId: string, atMs: number): boolean;
  listKeys(s: ProjectScope): KeyList;
  /** HMAC proof that this server holds the key's proof key; null for an unknown or revoked key (ADR-0006 8). */
  serverProof(keyId: string, origin: string, instanceId: string, challenge: string): string | null;
  /**
   * The owner proof key (hex) for whoever holds the database file: `HMAC(client_proof,
   * lp("swain:v1:owner-proof-key"))`. Created with the server secret on first use. It never leaves
   * the machine; the CLI uses it to check that a listener shares this database before it writes a
   * login code (G3-auth B2).
   */
  ownerProofKey(nowIso: string): string;
  /**
   * The server's answer to an owner challenge: `HMAC(ownerKey, lp("swain:v1:owner-proof") ||
   * lp(origin) || lp(instanceId) || lp(challenge))` as hex; null when no server secret exists yet.
   */
  ownerProof(origin: string, instanceId: string, challenge: string): string | null;

  // ingest (each call is one transaction; every row carries the scope and the key)
  recordBatch(s: ProjectScope, keyId: KeyId, b: BatchInput): BatchOutcome;
  /** The stored batch for `(key, signal, decodedSha256)`, or null (dedup before decoding). */
  findBatch(
    s: ProjectScope,
    keyId: KeyId,
    signal: Signal,
    decodedSha256: string,
  ): BatchRecord | null;
  /** Per-record refusals `putOtelTraces` would make (see the implementation); never writes. */
  precheckSpans(
    s: ProjectScope,
    keyId: KeyId,
    spans: readonly SpanPut[],
  ): readonly RecordRejection[];
  /** The logs twin of `precheckSpans`. */
  precheckLogs(s: ProjectScope, keyId: KeyId, logs: readonly LogPut[]): readonly RecordRejection[];
  /** `recordBatch` + `putOtelTraces` in one transaction (all or nothing). */
  ingestTraces(
    s: ProjectScope,
    keyId: KeyId,
    b: BatchInput,
    spans: readonly SpanPut[],
  ): { readonly batch: BatchOutcome; readonly stats: SpanPutStats | null };
  /** `recordBatch` + `putOtelLogs` in one transaction (all or nothing). */
  ingestLogs(
    s: ProjectScope,
    keyId: KeyId,
    b: BatchInput,
    logs: readonly LogPut[],
  ): { readonly batch: BatchOutcome; readonly stats: LogPutStats | null };
  putOtelTraces(
    s: ProjectScope,
    keyId: KeyId,
    batchId: BatchId,
    spans: readonly SpanPut[],
  ): SpanPutStats;
  putOtelLogs(
    s: ProjectScope,
    keyId: KeyId,
    batchId: BatchId,
    logs: readonly LogPut[],
  ): LogPutStats;
  /**
   * `mode: "supersede"` needs the `ingest:replace` scope on the key. `local-cli` and migrated
   * imports go through `putMigratedImport` only.
   */
  putImport(
    s: ProjectScope,
    keyId: KeyId,
    r: PolicyAppliedImport,
    mode: "add" | "supersede",
  ): ImportPutResult;
  /** `swain db import-store`: credential `local-cli`, derivation `migrated`, no batch. */
  putMigratedImport(
    s: ProjectScope,
    r: PolicyAppliedImport,
    mode: "add" | "supersede",
  ): ImportPutResult;

  // reads
  fleet(s: ProjectScope, q: FleetQuery): FleetPage;
  agent(s: ProjectScope, id: AgtId): AgentDetail | null;
  runs(s: ProjectScope, q: RunsQuery): RunsPage;
  run(s: ProjectScope, id: RunId): RunDetail | null;
  /** Current versions, in order, each re-validated with `validateEvents`. */
  runEvents(s: ProjectScope, id: RunId): RunEvents;
  runSpans(s: ProjectScope, id: RunId, limit: number): SpanRunData;
  resolveId(s: OrgScope, allowedProjects: readonly PrjId[], q: string): readonly ResolvedRef[];
  status(s: OrgScope, allowedProjects: readonly PrjId[]): StoreStatus;

  // auth: lookups by credential hash are unscoped and return the org
  putLoginCode(c: NewLoginCode): void;
  /** Atomic single use (one UPDATE ... RETURNING); every failure looks the same. */
  consumeLoginCode(codeSha256: string, nowMs: number): LoginResult | null;
  putSession(orgId: OrgId, s: NewSession): void;
  /** Enforces 12 h idle and 7 d absolute expiry and revocation; refreshes `lastSeenMs`. */
  findSession(tokenSha256: string, nowMs: number): Session | null;
  revokeSession(tokenSha256: string, atMs: number): void;

  // audit
  appendAudit(orgId: OrgId, e: AuditEntryInput): void;
  verifyAudit(orgId: OrgId): AuditVerifyResult;

  close(): void;
}
