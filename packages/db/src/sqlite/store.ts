/**
 * `SqliteSwainStore`: the SQLite implementation of `SwainStore` (SPEC-003 section 2.3).
 *
 * Every statement comes from the registry (`statements.ts`) and every tenant statement is bound to
 * the scope's `org_id` and, for project data, `project_id` (r2 F12: required, never optional).
 * Rows read back are re-validated and pass `assertRowScope`: a row outside the scope is
 * `db-scope-violation`, never returned. Each public write is one transaction.
 *
 * Callers pass already validated and content-policed data (`PolicyApplied*` brands); the store
 * never sees or rewrites sender content. Evidence tables are insert-only: re-sightings, conflicts
 * and supersessions are new rows, and "current" is computed at read time.
 */

import { randomBytes as cryptoRandom } from "node:crypto";
import {
  type AdapterWarning,
  type CanonicalEvent,
  canonicalJson,
  IMPORT_OUTCOMES,
  type ImportResult,
  type ImportStats,
  sha256Hex,
  validateEvents,
} from "@swain/core";
import { deriveAgentIdentity, importRun, sessionRun } from "@swain/model";
import type { ImportRecord } from "@swain/report";
import { DbError } from "../errors.js";
import { concat, hmacSha256, lp, toHex } from "../hmac.js";
import {
  type AgtId,
  type BatchId,
  isAgtId,
  isBatchId,
  isHex64,
  isKeyId,
  isOrgId,
  isPrjId,
  isRunId,
  isSpanId,
  isTraceId,
  isWspId,
  type KeyId,
  type OrgId,
  type PrjId,
  type RunId,
} from "../ids.js";
import { MIGRATIONS, type Migration } from "../migrations/index.js";
import type { SwainStore } from "../store.js";
import {
  type Actor,
  type AgentDetail,
  type AgentRow,
  type AgentUpsert,
  AUDIT_ACTIONS,
  type AuditEntryInput,
  type AuditVerifyResult,
  BATCH_STATUSES,
  type BatchInput,
  type BatchOutcome,
  type BatchRecord,
  CONTENT_ENCODINGS,
  CONTENT_POLICIES,
  type CredentialRef,
  DERIVATIONS,
  ENCODINGS,
  type FleetPage,
  type FleetQuery,
  type FleetRow,
  type ImportPutResult,
  type ImportSummary,
  KEY_SCOPES,
  type KeyAuthRecord,
  type KeyList,
  type KeyRecord,
  type KeyScope,
  type LoginResult,
  type LogPut,
  type LogPutStats,
  MAX_LIST,
  MAX_LOGIN_CODE_MS,
  type MigrationReport,
  type NewKey,
  type NewLoginCode,
  type NewProject,
  type NewSession,
  type NormalizedLog,
  type NormalizedSpan,
  OP_CLASSES,
  type Org,
  type OrgScope,
  type PolicyAppliedImport,
  type Project,
  type ProjectList,
  type ProjectPolicyPatch,
  type ProjectScope,
  type ProjectStatus,
  type PutStatus,
  RAW_RETENTIONS,
  type RecordRejection,
  type ResolvedRef,
  type ResourceInput,
  RUN_KINDS,
  type RunDetail,
  type RunEvents,
  type RunSummary,
  type RunsPage,
  type RunsQuery,
  type RunUpsert,
  SESSION_LIFETIMES,
  type Session,
  type SessionMode,
  type SessionView,
  SIGNALS,
  type Signal,
  type SpanPut,
  type SpanPutStats,
  type SpanRunData,
  type StoredSpan,
  type StoredSpanConflict,
  type StoreStatus,
  type Workspace,
} from "../types.js";
import {
  bad,
  isObj,
  isSafeNextPath,
  jsonText,
  MAX_JSON_BYTES,
  nat,
  nsInRange,
  oneOf,
  parseImportRecord,
  printable,
  text,
} from "../validate.js";
import { int, nbig, nint, nstr, type Param, type Row, Stmts, str } from "./db.js";
import { toDbError } from "./errors.js";
import { logEvidenceSha256, logSightingSha256 } from "./evidence.js";
import {
  agentUpsertOf,
  checkAgentFacts,
  checkLogRun,
  checkProjectedImportId,
  checkSpanRun,
} from "./facts.js";
import { runMigrations, verifySchema } from "./migrate.js";
import { type OpenOptions, openDatabase } from "./open.js";
import { logRowOf, spanRowOf } from "./policy-rows.js";
import type { StatementName } from "./statements.js";

const encoder = new TextEncoder();
const ZERO_HASH = "0".repeat(64);
const MAX_RECORDS_PER_CALL = 100_000;
const IDEMPOTENCY_TTL_MS = 86_400_000;
const MAX_RESOLVE = 20;
/** Idempotency windows tried per key before the key stops deduplicating (one per expiry, G3 F8). */
const MAX_IDEM_WINDOWS = 64;
const MAX_EVENTS_PER_IMPORT = 100_000;

export interface SqliteStoreOptions extends OpenOptions {
  /**
   * Entropy for random org/workspace/project IDs only, so tests can be deterministic. Secrets
   * (key secrets, the server-proof secret, scratch file names) always use `node:crypto` (G3 F4).
   */
  readonly randomBytes?: (n: number) => Uint8Array;
  /** The clock (24 h status windows, key expiry); injected because the policy bans `Date.now`. */
  readonly nowMs: () => number;
  /** Session lifetimes: local 2 h idle / 24 h absolute, team 12 h / 7 d (G3 C3). */
  readonly sessionMode: SessionMode;
  /** Override the migration list (tests only). */
  readonly migrations?: readonly Migration[];
}

/** Any throw from a model re-derivation is a refused record, never an untyped error. */
function guarded(fn: () => void): void {
  try {
    fn();
  } catch {
    throw new DbError("db-constraint");
  }
}

function corrupt(): never {
  throw new DbError("db-corrupt");
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * `sha256("swain:v1:ingest-key\n" + secret)`, lowercase hex: what `ingest_keys.secret_sha256`
 * holds (ADR-0006 r2 section 7). The domain prefix keeps the digest from being valid in any other
 * context that hashes the same bytes.
 */
export function hashKeySecret(secret: string): string {
  return sha256Hex(encoder.encode(`swain:v1:ingest-key\n${secret}`));
}

/** The key ID inside a secret of the form `swn_<16 hex>_<64 hex>`, or null. */
export function keyIdOfSecret(secret: string): KeyId | null {
  const m = /^swn_([0-9a-f]{16})_[0-9a-f]{64}$/.exec(secret);
  return m === null ? null : (`key_${m[1]}` as KeyId);
}

function orgOf(s: OrgScope): OrgId {
  if (typeof s !== "object" || s === null || !isOrgId(s.orgId)) bad();
  return s.orgId;
}

function projectOf(s: ProjectScope): { org: OrgId; project: PrjId } {
  if (typeof s !== "object" || s === null || !isOrgId(s.orgId) || !isPrjId(s.projectId)) bad();
  return { org: s.orgId, project: s.projectId };
}

/** The runtime assertion of G0 F12: a returned row must belong to the scope it was read with. */
export function assertRowScope(r: Row, s: OrgScope | ProjectScope): void {
  if (str(r, "org_id") !== s.orgId) throw new DbError("db-scope-violation");
  if ("projectId" in s && str(r, "project_id") !== s.projectId) {
    throw new DbError("db-scope-violation");
  }
}

function inScope(r: Row, org: OrgId, project: PrjId | null): void {
  assertRowScope(r, project === null ? { orgId: org } : { orgId: org, projectId: project });
}

function jsonOf(r: Row, k: string, shapes: readonly ("object" | "array" | "string")[]): string {
  const v = str(r, k);
  if (!jsonText(v, shapes)) corrupt();
  return v;
}

function njsonOf(
  r: Row,
  k: string,
  shapes: readonly ("object" | "array" | "string")[],
): string | null {
  const v = nstr(r, k);
  if (v === null) return null;
  if (!jsonText(v, shapes)) corrupt();
  return v;
}

// ---- row mappers ----------------------------------------------------------------------------
function mapOrg(r: Row): Org {
  const orgId = str(r, "org_id");
  if (!isOrgId(orgId)) corrupt();
  return { orgId, slug: str(r, "slug"), name: str(r, "name"), createdAt: str(r, "created_at") };
}

function mapWorkspace(r: Row): Workspace {
  const orgId = str(r, "org_id");
  const workspaceId = str(r, "workspace_id");
  if (!isOrgId(orgId) || !isWspId(workspaceId)) corrupt();
  return {
    orgId,
    workspaceId,
    slug: str(r, "slug"),
    name: str(r, "name"),
    createdAt: str(r, "created_at"),
  };
}

function mapProject(r: Row, org: OrgId, project: PrjId | null): Project {
  inScope(r, org, project);
  const workspaceId = str(r, "workspace_id");
  const projectId = str(r, "project_id");
  const contentPolicy = str(r, "content_policy");
  const rawRetention = str(r, "raw_retention");
  const maxInlineBytes = int(r, "max_inline_bytes");
  if (!isWspId(workspaceId) || !isPrjId(projectId)) corrupt();
  if (!oneOf(contentPolicy, CONTENT_POLICIES) || !oneOf(rawRetention, RAW_RETENTIONS)) corrupt();
  if (maxInlineBytes < 0 || maxInlineBytes > 1_048_576) corrupt();
  return {
    orgId: org,
    workspaceId,
    projectId,
    slug: str(r, "slug"),
    name: str(r, "name"),
    contentPolicy,
    maxInlineBytes,
    rawRetention,
    createdAt: str(r, "created_at"),
  };
}

/** A free-text column: printable, bounded, no control characters (G3 C7). */
function ctext(r: Row, k: string, max: number): string {
  const v = str(r, k);
  if (!text(v, max)) corrupt();
  return v;
}

function nctext(r: Row, k: string, max: number): string | null {
  const v = nstr(r, k);
  if (v !== null && !text(v, max)) corrupt();
  return v;
}

function mapKey(r: Row): KeyRecord {
  const keyId = str(r, "key_id");
  const orgId = str(r, "org_id");
  const projectId = str(r, "project_id");
  if (!isKeyId(keyId) || !isOrgId(orgId) || !isPrjId(projectId)) corrupt();
  let scopes: unknown;
  try {
    scopes = JSON.parse(str(r, "scopes"));
  } catch {
    return corrupt();
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > KEY_SCOPES.length) corrupt();
  if (!scopes.every((x) => oneOf(x, KEY_SCOPES))) corrupt();
  return {
    keyId,
    orgId,
    projectId,
    label: ctext(r, "label", 128),
    scopes: scopes as KeyScope[],
    agentName: nctext(r, "agent_name", 128),
    integration: nctext(r, "integration", 64),
    createdAt: ctext(r, "created_at", 40),
    createdBy: ctext(r, "created_by", 128),
    expiresAtMs: nint(r, "expires_at_ms"),
    revokedAtMs: nint(r, "revoked_at_ms"),
    lastUsedMs: nint(r, "last_used_ms"),
  };
}

function mapBatch(r: Row, org: OrgId, project: PrjId): BatchRecord {
  inScope(r, org, project);
  const batchId = str(r, "batch_id");
  const signal = str(r, "signal");
  const status = str(r, "status");
  if (!isBatchId(batchId) || !oneOf(signal, SIGNALS) || !oneOf(status, BATCH_STATUSES)) corrupt();
  const resultJson = str(r, "result_json");
  if (!jsonText(resultJson, ["object"], 65_536)) corrupt();
  return {
    batchId,
    signal,
    status,
    accepted: int(r, "accepted"),
    rejected: int(r, "rejected"),
    resultJson,
  };
}

function mapAgent(r: Row, org: OrgId, project: PrjId | null): AgentRow {
  inScope(r, org, project);
  const agentId = str(r, "agent_id");
  const projectId = str(r, "project_id");
  if (!isAgtId(agentId) || !isPrjId(projectId)) corrupt();
  return {
    agentId,
    projectId,
    agentKey: ctext(r, "agent_key", 512),
    keyBasis: ctext(r, "key_basis", 128),
    displayName: ctext(r, "display_name", 256),
    firstSeenMs: int(r, "first_seen_ms"),
    lastSeenMs: int(r, "last_seen_ms"),
  };
}

function numberMap(v: unknown): Record<string, number> {
  if (!isObj(v)) return corrupt();
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!nat(n)) corrupt();
    out[k] = n;
  }
  return out;
}

function boolMap(v: unknown): Record<string, boolean> {
  if (!isObj(v)) return corrupt();
  const out: Record<string, boolean> = {};
  for (const [k, b] of Object.entries(v)) {
    if (typeof b !== "boolean") corrupt();
    out[k] = b;
  }
  return out;
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return corrupt();
  }
}

function credentialList(v: unknown): { keyId: string; records: number }[] {
  if (!Array.isArray(v)) return corrupt();
  return v.map((x) => {
    if (!isObj(x) || Object.keys(x).length !== 2) return corrupt();
    const keyId = x["keyId"];
    const records = x["records"];
    if (typeof keyId !== "string" || !(isKeyId(keyId) || keyId === "local-cli")) return corrupt();
    if (!nat(records)) return corrupt();
    return { keyId, records };
  });
}

function mapRun(r: Row, org: OrgId, project: PrjId | null): RunSummary {
  inScope(r, org, project);
  const runId = str(r, "run_id");
  const projectId = str(r, "project_id");
  const kind = str(r, "kind");
  const primary = str(r, "primary_agent_id");
  const derivation = str(r, "derivation");
  const traceId = nstr(r, "trace_id");
  if (!isRunId(runId) || !isPrjId(projectId) || !isAgtId(primary)) corrupt();
  if (!oneOf(kind, RUN_KINDS) || !oneOf(derivation, DERIVATIONS)) corrupt();
  if (traceId !== null && !isTraceId(traceId)) corrupt();
  const firstTimeNs = nbig(r, "first_time_ns");
  const lastTimeNs = nbig(r, "last_time_ns");
  if (!nsInRange(firstTimeNs) || !nsInRange(lastTimeNs)) corrupt();
  return {
    runId,
    projectId,
    kind,
    primaryAgentId: primary,
    traceId,
    adrSessionId: nstr(r, "adr_session_id"),
    sessionKey: nstr(r, "session_key"),
    legacyImportId: nstr(r, "legacy_import_id"),
    derivation,
    firstTimeNs,
    lastTimeNs,
    firstReceivedMs: int(r, "first_received_ms"),
    lastReceivedMs: int(r, "last_received_ms"),
    endEvidence: int(r, "end_evidence") === 1,
    counts: numberMap(parseJson(str(r, "counts_json"))),
    flags: boolMap(parseJson(str(r, "flags_json"))),
    credentials: credentialList(parseJson(str(r, "credentials_json"))),
  };
}

function batchOf(r: Row, k: string): string {
  const v = str(r, k);
  if (!isBatchId(v)) corrupt();
  return v;
}

function keyOf(r: Row, k: string): KeyId {
  const v = str(r, k);
  if (!isKeyId(v)) corrupt();
  return v;
}

function mapSpan(r: Row, org: OrgId, project: PrjId | null): StoredSpan {
  inScope(r, org, project);
  const runId = str(r, "run_id");
  const agentId = str(r, "agent_id");
  const traceId = str(r, "trace_id");
  const spanId = str(r, "span_id");
  const parent = nstr(r, "parent_span_id");
  const opClass = str(r, "op_class");
  const sha = str(r, "record_sha256");
  const resource = str(r, "resource_sha256");
  if (!isRunId(runId) || !isAgtId(agentId) || !isTraceId(traceId) || !isSpanId(spanId)) corrupt();
  if (parent !== null && !isSpanId(parent)) corrupt();
  if (!oneOf(opClass, OP_CLASSES) || !isHex64(sha) || !isHex64(resource)) corrupt();
  if (!isHex64(str(r, "evidence_sha256"))) corrupt();
  const startNs = nbig(r, "start_ns");
  const endNs = nbig(r, "end_ns");
  if (!nsInRange(startNs) || !nsInRange(endNs)) corrupt();
  return {
    traceId,
    spanId,
    parentSpanId: parent,
    runId,
    agentId,
    resourceSha256: resource,
    nameJson: jsonOf(r, "name_json", ["string", "object"]),
    kind: int(r, "kind"),
    startNs,
    endNs,
    statusCode: int(r, "status_code"),
    statusMessageJson: njsonOf(r, "status_message_json", ["string", "object"]),
    traceStateJson: njsonOf(r, "trace_state_json", ["object"]),
    flags: nint(r, "flags"),
    attributesJson: jsonOf(r, "attributes_json", ["array"]),
    droppedAttributes: int(r, "dropped_attributes"),
    eventsJson: jsonOf(r, "events_json", ["array"]),
    linksJson: jsonOf(r, "links_json", ["array"]),
    scopeJson: jsonOf(r, "scope_json", ["object"]),
    opClass,
    opJson: jsonOf(r, "op_json", ["object"]),
    batchId: batchOf(r, "batch_id"),
    keyId: keyOf(r, "key_id"),
    recordPath: ctext(r, "record_path", 1024),
    recordSha256: sha,
    evidenceSha256: str(r, "evidence_sha256"),
    receivedMs: int(r, "received_ms"),
    late: int(r, "late") === 1,
    canonical: int(r, "cross_key_conflict") === 0,
  };
}

function boundedJson(r: Row, k: string): string {
  const v = str(r, k);
  if (!jsonText(v, ["object"], MAX_JSON_BYTES)) corrupt();
  return v;
}

const RELATIONS = ["identical-same-key", "identical-other-key", "conflicting"] as const;

function mapConflict(r: Row, org: OrgId, project: PrjId | null): StoredSpanConflict {
  inScope(r, org, project);
  const sha = str(r, "record_sha256");
  if (!isHex64(sha) || !isTraceId(str(r, "trace_id")) || !isSpanId(str(r, "span_id"))) corrupt();
  const relation = str(r, "relation");
  if (!oneOf(relation, RELATIONS)) corrupt();
  return {
    traceId: str(r, "trace_id"),
    spanId: str(r, "span_id"),
    recordSha256: sha,
    batchId: batchOf(r, "batch_id"),
    keyId: keyOf(r, "key_id"),
    relation,
    canonicalKeyId: keyOf(r, "canonical_key_id"),
    recordPath: ctext(r, "record_path", 1024),
    receivedMs: int(r, "received_ms"),
    recordJson: boundedJson(r, "record_json"),
  };
}

// ---- input checks ----------------------------------------------------------------------------
function checkAgent(a: AgentUpsert): void {
  if (!isAgtId(a.agentId) || !text(a.agentKey, 512) || !text(a.keyBasis, 128)) bad();
  if (!text(a.displayName, 256)) bad();
}

function checkRunUpsert(r: RunUpsert): void {
  if (!isRunId(r.runId) || !isAgtId(r.primaryAgentId)) bad();
  if (!oneOf(r.kind, RUN_KINDS) || !oneOf(r.derivation, DERIVATIONS)) bad();
  if (r.traceId !== null && !isTraceId(r.traceId)) bad();
  for (const v of [r.adrSessionId, r.sessionKey, r.legacyImportId]) {
    if (v !== null && !text(v, 256)) bad();
  }
}

function checkResource(r: ResourceInput): void {
  if (!isHex64(r.sha256) || !jsonText(r.attributesJson, ["object"])) bad();
  if (r.schemaUrl !== null && !jsonText(r.schemaUrl, ["object"], 8192)) bad();
}

function checkNs(v: bigint | null): void {
  if (v !== null && typeof v !== "bigint") bad();
}

function checkSpan(sp: NormalizedSpan): void {
  if (!isTraceId(sp.traceId) || !isSpanId(sp.spanId)) bad();
  if (sp.parentSpanId !== null && !isSpanId(sp.parentSpanId)) bad();
  checkAgent(sp.agent);
  checkRunUpsert(sp.run);
  checkResource(sp.resource);
  checkNs(sp.startNs);
  checkNs(sp.endNs);
  if (!jsonText(sp.nameJson, ["string", "object"]) || !jsonText(sp.opJson, ["object"])) bad();
  if (!jsonText(sp.attributesJson, ["array"]) || !jsonText(sp.scopeJson, ["object"])) bad();
  if (!jsonText(sp.eventsJson, ["array"]) || !jsonText(sp.linksJson, ["array"])) bad();
  if (sp.statusMessageJson !== null && !jsonText(sp.statusMessageJson, ["object"])) bad();
  if (!nat(sp.kind) || !nat(sp.statusCode) || !nat(sp.droppedAttributes) || !nat(sp.receivedMs)) {
    bad();
  }
  if (sp.flags !== null && !nat(sp.flags)) bad();
  if (sp.traceStateJson !== null && !jsonText(sp.traceStateJson, ["object"])) bad();
  if (
    !oneOf(sp.opClass, OP_CLASSES) ||
    !text(sp.recordPath, 1024) ||
    !isHex64(sp.recordSha256) ||
    !isHex64(sp.evidenceSha256)
  ) {
    bad();
  }
  if (typeof sp.late !== "boolean") bad();
}

function checkLog(l: NormalizedLog): void {
  if (!nat(l.occurrence) || !isHex64(l.recordSha256) || !text(l.recordPath, 1024)) bad();
  if (l.run !== null) checkRunUpsert(l.run);
  if (l.agent !== null) checkAgent(l.agent);
  checkResource(l.resource);
  checkNs(l.timeNs);
  checkNs(l.observedNs);
  if (l.severityNumber !== null && !nat(l.severityNumber)) bad();
  if (l.severityTextJson !== null && !jsonText(l.severityTextJson, ["object"])) bad();
  if (l.eventNameJson !== null && !jsonText(l.eventNameJson, ["object"])) bad();
  if (l.bodyJson !== null && !jsonText(l.bodyJson, ["object"])) bad();
  if (!jsonText(l.attributesJson, ["array"]) || !jsonText(l.scopeJson, ["object"])) bad();
  if (l.traceId !== null && !isTraceId(l.traceId)) bad();
  if (l.spanId !== null && !isSpanId(l.spanId)) bad();
  if (l.projectedImportId !== null && !text(l.projectedImportId, 64)) bad();
  if (!nat(l.receivedMs)) bad();
}

interface RunAgg {
  readonly run: RunUpsert;
  firstMs: number;
  lastMs: number;
  firstNs: bigint | null;
  lastNs: bigint | null;
  readonly agents: Map<string, { agent: AgentUpsert; firstMs: number; lastMs: number }>;
}

function touch(
  map: Map<string, RunAgg>,
  run: RunUpsert,
  agent: AgentUpsert | null,
  ms: number,
  ns: readonly (bigint | null)[],
): void {
  let a = map.get(run.runId);
  if (a === undefined) {
    a = { run, firstMs: ms, lastMs: ms, firstNs: null, lastNs: null, agents: new Map() };
    map.set(run.runId, a);
  }
  a.firstMs = Math.min(a.firstMs, ms);
  a.lastMs = Math.max(a.lastMs, ms);
  for (const n of ns) {
    if (n === null) continue;
    if (a.firstNs === null || n < a.firstNs) a.firstNs = n;
    if (a.lastNs === null || n > a.lastNs) a.lastNs = n;
  }
  if (agent !== null) {
    const g = a.agents.get(agent.agentId);
    if (g === undefined) a.agents.set(agent.agentId, { agent, firstMs: ms, lastMs: ms });
    else {
      g.firstMs = Math.min(g.firstMs, ms);
      g.lastMs = Math.max(g.lastMs, ms);
    }
  }
}

function checkQueryPage(limit: number, offset: number, maxLimit: number): void {
  if (!nat(limit) || limit < 1 || limit > maxLimit || !nat(offset) || offset > 1_000_000) bad();
}
/** Set by the class static block below; read only by `internalOpenWithOverrides`. */
let openWithOverrides:
  | ((
      path: string,
      options: SqliteStoreOptions,
      overrides: Readonly<Partial<Record<StatementName, string>>>,
    ) => SqliteSwainStore)
  | undefined;

/**
 * TESTS ONLY, and not part of the package: `sqlite/testing.ts` wraps this for the test suite. It
 * is not exported from the package entry, the class has no such static, and tests pin both (and a
 * policy-check rule forbids importing `sqlite/testing` from any source file).
 */
export function internalOpenWithOverrides(
  path: string,
  options: SqliteStoreOptions,
  overrides: Readonly<Partial<Record<StatementName, string>>>,
): SqliteSwainStore {
  if (openWithOverrides === undefined) throw new DbError("db-io");
  return openWithOverrides(path, options, overrides);
}

export class SqliteSwainStore implements SwainStore {
  static {
    openWithOverrides = (path, options, overrides) =>
      SqliteSwainStore.#openWith(path, options, overrides);
  }

  readonly #opened: ReturnType<typeof openDatabase>;
  readonly #stmts: Stmts;
  readonly #options: SqliteStoreOptions;
  #ready = false;
  #inTx = false;
  #closed = false;

  private constructor(
    opened: ReturnType<typeof openDatabase>,
    options: SqliteStoreOptions,
    overrides: Readonly<Partial<Record<StatementName, string>>>,
  ) {
    this.#opened = opened;
    this.#stmts = new Stmts(opened.db, overrides);
    this.#options = options;
  }

  /** Opens (and creates, mode 0600) the database file. Call `migrate` before any other method. */
  static open(path: string, options: SqliteStoreOptions): SqliteSwainStore {
    return SqliteSwainStore.#openWith(path, options, {});
  }

  static #openWith(
    path: string,
    options: SqliteStoreOptions,
    overrides: Readonly<Partial<Record<StatementName, string>>>,
  ): SqliteSwainStore {
    if (
      typeof options.nowMs !== "function" ||
      typeof options.sessionMode !== "string" ||
      !Object.hasOwn(SESSION_LIFETIMES, options.sessionMode)
    ) {
      throw new DbError("db-io");
    }
    if (options.randomBytes !== undefined && typeof options.randomBytes !== "function") {
      throw new DbError("db-io");
    }
    const store = new SqliteSwainStore(openDatabase(path, options), options, overrides);
    try {
      verifySchema(store.#stmts, options.migrations ?? MIGRATIONS);
    } catch (e) {
      store.close();
      throw e;
    }
    return store;
  }

  get path(): string {
    return this.#opened.path;
  }

  /** True when `open` created the file. */
  get created(): boolean {
    return this.#opened.created;
  }

  // ---- plumbing --------------------------------------------------------------------------------
  #use(): Stmts {
    if (this.#closed || !this.#ready) throw new DbError("db-io");
    return this.#stmts;
  }

  #tx<T>(fn: (st: Stmts) => T): T {
    const st = this.#use();
    if (this.#inTx) return fn(st);
    st.run("tx.begin");
    this.#inTx = true;
    try {
      const r = fn(st);
      st.run("tx.commit");
      return r;
    } catch (e) {
      try {
        st.run("tx.rollback");
      } catch {
        // The original failure is the one to report.
      }
      throw toDbError(e);
    } finally {
      this.#inTx = false;
    }
  }

  /** Secrets and scratch names: always the OS CSPRNG, never the injected test source (G3 F4). */
  #secretBytes(n: number): Uint8Array {
    const b = cryptoRandom(n);
    if (b.length !== n) throw new DbError("db-io");
    return new Uint8Array(b);
  }

  /** Random org/workspace/project IDs; the injected source exists only to make tests deterministic. */
  #rand(prefix: string, bytes: number): string {
    const b =
      this.#options.randomBytes === undefined
        ? cryptoRandom(bytes)
        : this.#options.randomBytes(bytes);
    if (!(b instanceof Uint8Array) || b.length !== bytes) throw new DbError("db-io");
    return `${prefix}${hex(b)}`;
  }

  #requireProject(st: Stmts, org: OrgId, project: PrjId): Project {
    // A project that is not in this org is a scope error, not "not found".
    const row = st.get("prj.byId", org, project);
    if (row === undefined) throw new DbError("db-scope-violation");
    return mapProject(row, org, project);
  }

  /**
   * A record carries the policy that was applied to it. It must be the project's stored policy:
   * content policy and inline bound as stored, metadata policy `masked` (the project has no
   * other setting), and the content-key list version the model ships. A mismatch means the record
   * was masked under different rules than the project promises, so it is refused.
   */
  #requirePolicy(
    prj: Project,
    p: {
      readonly contentPolicy: string;
      readonly maxInlineBytes: number;
      readonly metadataPolicy: string;
    },
  ): void {
    if (
      p.contentPolicy !== prj.contentPolicy ||
      p.maxInlineBytes !== prj.maxInlineBytes ||
      p.metadataPolicy !== "masked"
    ) {
      bad();
    }
  }

  /**
   * The key must exist, belong to the scope (a key of another project or org is refused) and be
   * usable now: a revoked or expired key writes nothing (G3 F7).
   */
  #requireKey(st: Stmts, org: OrgId, project: PrjId, keyId: string): KeyRecord {
    if (!isKeyId(keyId)) bad();
    const row = st.get("key.byId", keyId);
    if (row === undefined) bad();
    const key = mapKey(row);
    if (key.orgId !== org || key.projectId !== project) throw new DbError("db-scope-violation");
    if (key.revokedAtMs !== null || (key.expiresAtMs !== null && key.expiresAtMs <= this.#now())) {
      bad();
    }
    return key;
  }

  #now(): number {
    const n = this.#options.nowMs();
    if (!nat(n)) throw new DbError("db-io");
    return n;
  }

  // ---- migrations -----------------------------------------------------------------------------
  migrate(deps: { nowIso: () => string }): MigrationReport {
    if (this.#closed) throw new DbError("db-io");
    if (typeof deps?.nowIso !== "function") bad();
    const migrations = this.#options.migrations ?? MIGRATIONS;
    const report = runMigrations(
      {
        db: this.#opened.db,
        stmts: this.#stmts,
        path: this.#opened.path,
        uid: this.#options.uid,
      },
      migrations,
      deps.nowIso,
    );
    verifySchema(this.#stmts, migrations);
    this.#ready = true;
    return report;
  }

  // ---- tenancy ---------------------------------------------------------------------------------
  findLocalOrg(): Org | null {
    const row = this.#use().get("org.bySlug", "local");
    return row === undefined ? null : mapOrg(row);
  }

  ensureLocalTenancy(nowIso: string): { org: Org; workspace: Workspace; project: Project } {
    if (!text(nowIso, 40)) bad();
    return this.#tx((st) => {
      let orgRow = st.get("org.bySlug", "local");
      if (orgRow === undefined) {
        st.run("org.insert", this.#rand("org_", 16), "local", "local", nowIso);
        orgRow = st.get("org.bySlug", "local");
      }
      if (orgRow === undefined) return corrupt();
      const org = mapOrg(orgRow);
      let wspRow = st.get("wsp.bySlug", org.orgId, "default");
      if (wspRow === undefined) {
        st.run("wsp.insert", org.orgId, this.#rand("wsp_", 16), "default", "default", nowIso);
        wspRow = st.get("wsp.bySlug", org.orgId, "default");
      }
      if (wspRow === undefined) return corrupt();
      const workspace = mapWorkspace(wspRow);
      if (workspace.orgId !== org.orgId) throw new DbError("db-scope-violation");
      let prjRow = st.get("prj.bySlug", org.orgId, workspace.workspaceId, "default");
      if (prjRow === undefined) {
        st.run(
          "prj.insert",
          org.orgId,
          workspace.workspaceId,
          this.#rand("prj_", 16),
          "default",
          "default",
          "hash-only",
          65536,
          "hash-only",
          nowIso,
        );
        prjRow = st.get("prj.bySlug", org.orgId, workspace.workspaceId, "default");
      }
      if (prjRow === undefined) return corrupt();
      return { org, workspace, project: mapProject(prjRow, org.orgId, null) };
    });
  }

  createProject(s: OrgScope, p: NewProject): Project {
    const org = orgOf(s);
    if (!isWspId(p.workspaceId) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(p.slug)) bad();
    if (!text(p.name, 128) || !text(p.createdAt, 40)) bad();
    const policy = p.contentPolicy ?? "hash-only";
    const retention = p.rawRetention ?? "hash-only";
    const maxInline = p.maxInlineBytes ?? 65536;
    if (!oneOf(policy, CONTENT_POLICIES) || !oneOf(retention, RAW_RETENTIONS)) bad();
    if (!nat(maxInline) || maxInline > 1_048_576) bad();
    return this.#tx((st) => {
      const projectId = this.#rand("prj_", 16);
      st.run(
        "prj.insert",
        org,
        p.workspaceId,
        projectId,
        p.slug,
        p.name,
        policy,
        maxInline,
        retention,
        p.createdAt,
      );
      const row = st.get("prj.byId", org, projectId);
      if (row === undefined) return corrupt();
      return mapProject(row, org, projectId as PrjId);
    });
  }

  listProjects(s: OrgScope): ProjectList {
    const org = orgOf(s);
    const rows = this.#use().all("prj.list", org, MAX_LIST + 1);
    return {
      projects: rows.slice(0, MAX_LIST).map((r) => mapProject(r, org, null)),
      truncated: rows.length > MAX_LIST,
    };
  }

  getProject(s: ProjectScope): Project | null {
    const { org, project } = projectOf(s);
    const row = this.#use().get("prj.byId", org, project);
    return row === undefined ? null : mapProject(row, org, project);
  }

  setProjectPolicy(s: ProjectScope, p: ProjectPolicyPatch, actor: Actor): Project {
    const { org, project } = projectOf(s);
    if (typeof p !== "object" || p === null) bad();
    if (p.contentPolicy !== undefined && !oneOf(p.contentPolicy, CONTENT_POLICIES)) bad();
    if (p.rawRetention !== undefined && !oneOf(p.rawRetention, RAW_RETENTIONS)) bad();
    if (
      p.maxInlineBytes !== undefined &&
      (!nat(p.maxInlineBytes) || p.maxInlineBytes > 1_048_576)
    ) {
      bad();
    }
    if (typeof actor !== "object" || actor === null) bad();
    return this.#tx((st) => {
      const row = st.get("prj.byId", org, project);
      if (row === undefined) throw new DbError("db-scope-violation");
      const cur = mapProject(row, org, project);
      const next = {
        contentPolicy: p.contentPolicy ?? cur.contentPolicy,
        maxInlineBytes: p.maxInlineBytes ?? cur.maxInlineBytes,
        rawRetention: p.rawRetention ?? cur.rawRetention,
      };
      st.run(
        "prj.setPolicy",
        next.contentPolicy,
        next.maxInlineBytes,
        next.rawRetention,
        org,
        project,
      );
      // Same transaction: the change and its audit entry stand or fall together.
      this.appendAudit(org, {
        at: actor.at,
        actorType: actor.type,
        actorId: actor.id,
        action: "project.policy.change",
        targetType: "project",
        targetId: project,
        detail: {
          contentPolicy: next.contentPolicy,
          maxInlineBytes: next.maxInlineBytes,
          rawRetention: next.rawRetention,
        },
      });
      const after = st.get("prj.byId", org, project);
      if (after === undefined) return corrupt();
      return mapProject(after, org, project);
    });
  }

  // ---- keys ------------------------------------------------------------------------------------
  /** The server secret behind client proof keys; created lazily on the first key (ADR-0006 8). */
  #clientProof(st: Stmts, createdAt: string | null): Uint8Array | null {
    let row = st.get("secret.get", "client_proof");
    if (row === undefined && createdAt !== null) {
      st.run("secret.insert", "client_proof", this.#secretBytes(32), createdAt);
      row = st.get("secret.get", "client_proof");
    }
    if (row === undefined) return null;
    const v = row["value"];
    if (!(v instanceof Uint8Array) || v.length !== 32) return corrupt();
    return new Uint8Array(v);
  }

  createKey(
    s: ProjectScope,
    k: NewKey,
  ): { key: KeyRecord; secret: string; serverProofKey: string } {
    const { org, project } = projectOf(s);
    if (!text(k.label, 128) || !text(k.createdBy, 128) || !text(k.createdAt, 40)) bad();
    if (!Array.isArray(k.scopes) || k.scopes.length === 0) bad();
    if (
      !k.scopes.every((x) => oneOf(x, KEY_SCOPES)) ||
      new Set(k.scopes).size !== k.scopes.length
    ) {
      bad();
    }
    const agentName = k.agentName ?? null;
    const integration = k.integration ?? null;
    const expires = k.expiresAtMs ?? null;
    if (agentName !== null && !text(agentName, 128)) bad();
    if (integration !== null && !text(integration, 64)) bad();
    if (expires !== null && !nat(expires)) bad();
    return this.#tx((st) => {
      this.#requireProject(st, org, project);
      const idHex = hex(this.#secretBytes(8));
      const secret = `swn_${idHex}_${hex(this.#secretBytes(32))}`;
      if (keyIdOfSecret(secret) === null) throw new DbError("db-io");
      const keyId = `key_${idHex}`;
      st.run(
        "key.insert",
        keyId,
        org,
        project,
        hashKeySecret(secret),
        k.label,
        canonicalJson([...k.scopes]),
        agentName,
        integration,
        k.createdAt,
        k.createdBy,
        expires,
      );
      const row = st.get("key.byId", keyId);
      if (row === undefined) return corrupt();
      const key = mapKey(row);
      if (key.orgId !== org || key.projectId !== project) throw new DbError("db-scope-violation");
      const clientProof = this.#clientProof(st, k.createdAt);
      if (clientProof === null) return corrupt();
      return { key, secret, serverProofKey: toHex(proofKeyOf(clientProof, keyId)) };
    });
  }

  findKey(keyId: string): KeyAuthRecord | null {
    if (!isKeyId(keyId)) return null;
    const row = this.#use().get("key.byId", keyId);
    if (row === undefined) return null;
    const secretSha256 = str(row, "secret_sha256");
    if (!isHex64(secretSha256)) corrupt();
    return { ...mapKey(row), secretSha256 };
  }

  revokeKey(s: ProjectScope, keyId: string, atMs: number): boolean {
    const { org, project } = projectOf(s);
    if (!isKeyId(keyId) || !nat(atMs)) bad();
    return this.#tx((st) => st.run("key.revoke", atMs, org, project, keyId) > 0);
  }

  listKeys(s: ProjectScope): KeyList {
    const { org, project } = projectOf(s);
    const rows = this.#use().all("key.list", org, project, MAX_LIST + 1);
    const keys = rows.slice(0, MAX_LIST).map((r) => {
      const key = mapKey(r);
      if (key.orgId !== org || key.projectId !== project) throw new DbError("db-scope-violation");
      return key;
    });
    return { keys, truncated: rows.length > MAX_LIST };
  }

  serverProof(keyId: string, origin: string, instanceId: string, challenge: string): string | null {
    if (!isKeyId(keyId) || !text(origin, 256)) return null;
    if (!/^[0-9a-f]{32}$/.test(instanceId) || !/^[0-9a-f]{64}$/.test(challenge)) return null;
    const st = this.#use();
    const row = st.get("key.byId", keyId);
    if (row === undefined) return null;
    const key = mapKey(row);
    if (key.revokedAtMs !== null || (key.expiresAtMs !== null && key.expiresAtMs <= this.#now())) {
      return null;
    }
    const clientProof = this.#clientProof(st, null);
    if (clientProof === null) return corrupt();
    const proof = hmacSha256(
      proofKeyOf(clientProof, keyId),
      concat(lp("swain:v1:server-proof"), lp(origin), lp(instanceId), lp(challenge)),
    );
    return toHex(proof);
  }

  ownerProofKey(nowIso: string): string {
    if (!text(nowIso, 40)) bad();
    return this.#tx((st) => {
      const clientProof = this.#clientProof(st, nowIso);
      if (clientProof === null) return corrupt();
      return toHex(ownerKeyOf(clientProof));
    });
  }

  ownerProof(origin: string, instanceId: string, challenge: string): string | null {
    if (!text(origin, 256)) return null;
    if (!/^[0-9a-f]{32}$/.test(instanceId) || !/^[0-9a-f]{64}$/.test(challenge)) return null;
    const clientProof = this.#clientProof(this.#use(), null);
    if (clientProof === null) return null;
    return toHex(
      hmacSha256(
        ownerKeyOf(clientProof),
        concat(lp("swain:v1:owner-proof"), lp(origin), lp(instanceId), lp(challenge)),
      ),
    );
  }

  // ---- ingest ----------------------------------------------------------------------------------
  recordBatch(s: ProjectScope, keyId: KeyId, b: BatchInput): BatchOutcome {
    const { org, project } = projectOf(s);
    if (!isKeyId(keyId)) bad();
    if (!isBatchId(b.batchId) || !oneOf(b.signal, SIGNALS) || !oneOf(b.encoding, ENCODINGS)) bad();
    if (!oneOf(b.contentEncoding, CONTENT_ENCODINGS) || !oneOf(b.status, BATCH_STATUSES)) bad();
    if (!isHex64(b.bodySha256) || !isHex64(b.decodedSha256)) bad();
    if (!nat(b.bodyBytes) || !nat(b.decodedBytes) || !nat(b.receivedMs)) bad();
    if (!nat(b.accepted) || !nat(b.rejected) || !jsonText(b.resultJson, ["object"], 65_536)) bad();
    if (b.raw !== undefined && b.raw !== null && !(b.raw instanceof Uint8Array)) bad();
    const idem = b.idempotency ?? null;
    if (idem !== null && (!printable(idem.route, 64) || !printable(idem.key, 128))) bad();
    const cutoff = b.receivedMs - IDEMPOTENCY_TTL_MS;
    return this.#tx((st): BatchOutcome => {
      const projectRow = st.get("prj.byId", org, project);
      if (projectRow === undefined) throw new DbError("db-scope-violation");
      const projectRec = mapProject(projectRow, org, project);
      this.#requireKey(st, org, project, keyId);
      const raw = b.raw ?? null;
      // Raw bytes are stored only when the project keeps them (raw_retention = 'full', G3 F5).
      if (raw !== null && projectRec.rawRetention !== "full") bad();
      // Idempotency window (ADR-0006 4): an entry older than 24 h no longer applies, and is never
      // updated or deleted; a later use of the same key appends a new row in the next slot
      // (`key`, `key\x1f1`, ...), so the key protects again.
      let slot: string | null = null;
      if (idem !== null) {
        let settled = false;
        for (let g = 0; g < MAX_IDEM_WINDOWS && slot === null && !settled; g++) {
          const k = g === 0 ? idem.key : `${idem.key}\x1f${g}`;
          const hit = st.get("idem.get", org, project, keyId, idem.route, k);
          if (hit === undefined) slot = k;
          else if (int(hit, "created_ms") >= cutoff) {
            inScope(hit, org, project);
            if (str(hit, "body_sha256") !== b.bodySha256)
              return { outcome: "idempotency-conflict" };
            const prior = st.get("batch.byId", org, project, str(hit, "batch_id"));
            if (prior !== undefined) {
              return { outcome: "duplicate", batch: mapBatch(prior, org, project) };
            }
            settled = true;
          }
        }
        // every window of this key is in use: fail closed, never skip the protection silently
        if (slot === null && !settled) throw new DbError("db-idempotency-exhausted");
      }
      const changes = st.run(
        "batch.insert",
        org,
        project,
        b.batchId,
        b.signal,
        b.encoding,
        b.contentEncoding,
        b.bodySha256,
        b.bodyBytes,
        b.decodedSha256,
        b.decodedBytes,
        keyId,
        b.receivedMs,
        b.status,
        b.accepted,
        b.rejected,
        b.resultJson,
        raw,
        raw === null ? null : "deflate",
      );
      const row =
        changes === 1
          ? st.get("batch.byId", org, project, b.batchId)
          : st.get("batch.bySignalSha", org, project, keyId, b.signal, b.decodedSha256);
      if (row === undefined) return corrupt();
      const batch = mapBatch(row, org, project);
      if (idem !== null && slot !== null) {
        st.run(
          "idem.put",
          org,
          project,
          keyId,
          idem.route,
          slot,
          b.bodySha256,
          batch.batchId,
          b.receivedMs,
        );
      }
      return { outcome: changes === 1 ? "created" : "duplicate", batch };
    });
  }

  /**
   * The stored batch of `(key, signal, decodedSha256)`, or null: the server checks it before it
   * decodes anything (ADR-0006 section 4), and replays the stored result of a resend.
   */
  findBatch(
    s: ProjectScope,
    keyId: KeyId,
    signal: Signal,
    decodedSha256: string,
  ): BatchRecord | null {
    const { org, project } = projectOf(s);
    if (!isKeyId(keyId) || !oneOf(signal, SIGNALS) || !isHex64(decodedSha256)) bad();
    const row = this.#use().get("batch.bySignalSha", org, project, keyId, signal, decodedSha256);
    return row === undefined ? null : mapBatch(row, org, project);
  }

  /**
   * One transaction: the batch row and its spans commit together or not at all. A batch row
   * without its records would turn a retry into a silent "duplicate" of data that was never
   * stored, so the server uses this instead of `recordBatch` followed by `putOtelTraces`.
   */
  ingestTraces(
    s: ProjectScope,
    keyId: KeyId,
    b: BatchInput,
    spans: readonly SpanPut[],
  ): { readonly batch: BatchOutcome; readonly stats: SpanPutStats | null } {
    return this.#tx(() => {
      const batch = this.recordBatch(s, keyId, b);
      if (batch.outcome !== "created") return { batch, stats: null };
      return { batch, stats: this.putOtelTraces(s, keyId, b.batchId, spans) };
    });
  }

  /** The logs twin of `ingestTraces`. */
  ingestLogs(
    s: ProjectScope,
    keyId: KeyId,
    b: BatchInput,
    logs: readonly LogPut[],
  ): { readonly batch: BatchOutcome; readonly stats: LogPutStats | null } {
    return this.#tx(() => {
      const batch = this.recordBatch(s, keyId, b);
      if (batch.outcome !== "created") return { batch, stats: null };
      return { batch, stats: this.putOtelLogs(s, keyId, b.batchId, logs) };
    });
  }

  /** The batch must exist and have been recorded by `keyId`: provenance never comes from the caller alone. */
  #requireBatch(st: Stmts, org: OrgId, project: PrjId, keyId: KeyId, batchId: BatchId): void {
    if (!isBatchId(batchId) || !isKeyId(keyId)) bad();
    const row = st.get("batch.keyById", org, project, batchId);
    if (row === undefined) bad();
    inScope(row, org, project);
    if (str(row, "key_id") !== keyId) throw new DbError("db-scope-violation");
  }

  #persistRuns(st: Stmts, org: OrgId, project: PrjId, runs: Map<string, RunAgg>): void {
    for (const a of runs.values()) {
      for (const g of a.agents.values()) {
        st.run(
          "agent.upsert",
          org,
          project,
          g.agent.agentId,
          g.agent.agentKey,
          g.agent.keyBasis,
          g.agent.displayName,
          g.firstMs,
          g.lastMs,
        );
      }
      const r = a.run;
      st.run(
        "run.upsert",
        org,
        project,
        r.runId,
        r.kind,
        r.primaryAgentId,
        r.traceId,
        r.adrSessionId,
        r.sessionKey,
        r.legacyImportId,
        r.derivation,
        a.firstNs,
        a.lastNs,
        a.firstMs,
        a.lastMs,
      );
      for (const id of a.agents.keys()) st.run("run.link", org, project, r.runId, id);
      this.#recompute(st, org, project, r.runId);
    }
  }

  /** Recompute the L2 counters of a run from the L1 rows (rebuildable, never evidence). */
  #recompute(st: Stmts, org: OrgId, project: PrjId, runId: RunId): void {
    const one = (row: Row | undefined, k: string): number => (row === undefined ? 0 : int(row, k));
    const sp = st.get("run.spanAgg", org, project, runId);
    const ev = st.get("run.eventAgg", org, org, project, runId, org, org);
    const counts = {
      conflicts: one(st.get("run.conflictCount", org, org, project, runId), "n"),
      events: one(ev, "events"),
      imports: one(ev, "imports"),
      logs: one(st.get("run.logCount", org, project, runId), "n"),
      spans: one(sp, "spans"),
    };
    const flags = { error: one(sp, "errors") > 0, late: one(sp, "late") > 0 };
    const roots = one(sp, "roots");
    const ended =
      (roots > 0 && roots === one(sp, "ended_roots")) ||
      one(st.get("run.endEvents", org, org, project, runId, org, org), "n") > 0;
    const perKey = new Map<string, number>();
    const add = (rows: Row[]): void => {
      for (const r of rows)
        perKey.set(str(r, "key_id"), (perKey.get(str(r, "key_id")) ?? 0) + int(r, "n"));
    };
    add(st.all("run.credSpans", org, project, runId));
    add(st.all("run.credLogs", org, project, runId));
    add(st.all("run.credImports", org, project, runId, org, org));
    const credentials = [...perKey.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([keyId, records]) => ({ keyId, records }));
    st.run(
      "run.refresh",
      canonicalJson(counts),
      canonicalJson(flags),
      canonicalJson(credentials),
      ended ? 1 : 0,
      org,
      project,
      runId,
    );
  }

  #resource(st: Stmts, org: OrgId, project: PrjId, r: ResourceInput): void {
    st.run("res.insert", org, project, r.sha256, r.attributesJson, r.schemaUrl);
  }

  /**
   * The records `putOtelTraces` would refuse for their own sake (facts, sizes, int64 range), as
   * per-record rejections. The server calls this before it builds the batch row so that the
   * counts and `partial_success` include them and one odd record never fails its batch (N1.5 G3
   * F2/F10). A whole-call fault (unknown key, wrong project policy) still throws.
   */
  precheckSpans(
    s: ProjectScope,
    keyId: KeyId,
    spans: readonly SpanPut[],
  ): readonly RecordRejection[] {
    const { org, project } = projectOf(s);
    if (!Array.isArray(spans) || spans.length > MAX_RECORDS_PER_CALL) bad();
    return this.#tx((st) => {
      const prj = this.#requireProject(st, org, project);
      const key = this.#requireKey(st, org, project, keyId);
      const out: RecordRejection[] = [];
      spans.forEach((src, index) => {
        let c: ReturnType<typeof spanRowOf>;
        try {
          c = spanRowOf(src);
        } catch {
          out.push({ index, code: "constraint" });
          return;
        }
        this.#requirePolicy(prj, c.policy);
        try {
          checkSpan(c.row);
          guarded(() => {
            checkAgentFacts(project, key, src.agent, src.span, false);
            checkSpanRun(project, src.run, src.span);
          });
        } catch {
          out.push({ index, code: "constraint" });
          return;
        }
        if (!nsInRange(c.row.startNs) || !nsInRange(c.row.endNs)) {
          out.push({ index, code: "ns-out-of-range" });
        }
      });
      return out;
    });
  }

  /** The logs twin of `precheckSpans`. */
  precheckLogs(s: ProjectScope, keyId: KeyId, logs: readonly LogPut[]): readonly RecordRejection[] {
    const { org, project } = projectOf(s);
    if (!Array.isArray(logs) || logs.length > MAX_RECORDS_PER_CALL) bad();
    return this.#tx((st) => {
      const prj = this.#requireProject(st, org, project);
      const key = this.#requireKey(st, org, project, keyId);
      const out: RecordRejection[] = [];
      logs.forEach((src, index) => {
        let c: ReturnType<typeof logRowOf>;
        try {
          c = logRowOf(src);
        } catch {
          out.push({ index, code: "constraint" });
          return;
        }
        this.#requirePolicy(prj, c.policy);
        try {
          checkLog(c.row);
          checkProjectedImportId(src.projectedImportId);
          guarded(() => {
            const projected = src.projectedImportId !== null;
            if (src.agent !== null) checkAgentFacts(project, key, src.agent, src.log, projected);
            if (src.run !== null && src.agent !== null) {
              checkLogRun(project, src.run, src.agent, src.log, projected);
            }
          });
        } catch {
          out.push({ index, code: "constraint" });
          return;
        }
        if (!nsInRange(c.row.timeNs) || !nsInRange(c.row.observedNs)) {
          out.push({ index, code: "ns-out-of-range" });
        }
      });
      return out;
    });
  }

  putOtelTraces(
    s: ProjectScope,
    keyId: KeyId,
    batchId: BatchId,
    spans: readonly SpanPut[],
  ): SpanPutStats {
    const { org, project } = projectOf(s);
    if (!Array.isArray(spans) || spans.length > MAX_RECORDS_PER_CALL) bad();
    // Every record must be one the applier produced (isPolicyApplied), else db-constraint.
    const converted = spans.map(spanRowOf);
    return this.#tx((st) => {
      const prj = this.#requireProject(st, org, project);
      const key = this.#requireKey(st, org, project, keyId);
      this.#requireBatch(st, org, project, keyId, batchId);
      converted.forEach((c, i) => {
        this.#requirePolicy(prj, c.policy);
        checkSpan(c.row);
        const src = spans[i] as SpanPut;
        guarded(() => {
          checkAgentFacts(project, key, src.agent, src.span, false);
          checkSpanRun(project, src.run, src.span);
        });
      });
      let inserted = 0;
      let seenAgain = 0;
      let identicalOtherKey = 0;
      let conflicts = 0;
      const rejections: RecordRejection[] = [];
      const runs = new Map<string, RunAgg>();
      converted.forEach((c, index) => {
        const sp = c.row;
        // F13: a value outside int64 rejects this record only; the batch and its transaction go on.
        if (!nsInRange(sp.startNs) || !nsInRange(sp.endNs)) {
          rejections.push({ index, code: "ns-out-of-range" });
          return;
        }
        this.#resource(st, org, project, sp.resource);
        touch(runs, sp.run, sp.agent, sp.receivedMs, [sp.startNs, sp.endNs ?? sp.startNs]);
        const changes = st.run(
          "span.insert",
          org,
          project,
          sp.traceId,
          sp.spanId,
          sp.run.runId,
          sp.parentSpanId,
          sp.nameJson,
          sp.kind,
          sp.startNs,
          sp.endNs,
          sp.statusCode,
          sp.statusMessageJson,
          sp.traceStateJson,
          sp.flags,
          sp.attributesJson,
          sp.droppedAttributes,
          sp.eventsJson,
          sp.linksJson,
          sp.resource.sha256,
          sp.scopeJson,
          sp.agent.agentId,
          sp.opClass,
          sp.opJson,
          batchId,
          keyId,
          sp.recordPath,
          sp.recordSha256,
          sp.evidenceSha256,
          sp.receivedMs,
          sp.late ? 1 : 0,
        );
        if (changes === 1) {
          inserted++;
          return;
        }
        const first = st.get("span.sha", org, project, sp.traceId, sp.spanId);
        if (first === undefined) corrupt();
        inScope(first, org, project);
        const same = str(first, "evidence_sha256") === sp.evidenceSha256;
        const sameKey = str(first, "key_id") === keyId;
        const relation = same
          ? sameKey
            ? ("identical-same-key" as const)
            : ("identical-other-key" as const)
          : ("conflicting" as const);
        const wrote = st.run(
          "span.conflictInsert",
          org,
          project,
          sp.traceId,
          sp.spanId,
          sp.recordSha256,
          sp.evidenceSha256,
          keyId,
          relation,
          batchId,
          sp.recordPath,
          sp.receivedMs,
          c.recordJson,
        );
        if (relation === "identical-same-key") seenAgain += wrote;
        else if (relation === "identical-other-key") identicalOtherKey += wrote;
        else conflicts += wrote;
      });
      this.#persistRuns(st, org, project, runs);
      return {
        inserted,
        seenAgain,
        identicalOtherKey,
        conflicts,
        rejected: rejections.length,
        rejections,
      };
    });
  }

  putOtelLogs(
    s: ProjectScope,
    keyId: KeyId,
    batchId: BatchId,
    logs: readonly LogPut[],
  ): LogPutStats {
    const { org, project } = projectOf(s);
    if (!Array.isArray(logs) || logs.length > MAX_RECORDS_PER_CALL) bad();
    const converted = logs.map(logRowOf);
    return this.#tx((st) => {
      const prj = this.#requireProject(st, org, project);
      const key = this.#requireKey(st, org, project, keyId);
      this.#requireBatch(st, org, project, keyId, batchId);
      converted.forEach((c, i) => {
        this.#requirePolicy(prj, c.policy);
        checkLog(c.row);
        const src = logs[i] as LogPut;
        checkProjectedImportId(src.projectedImportId);
        guarded(() => {
          const projected = src.projectedImportId !== null;
          if (src.agent !== null) checkAgentFacts(project, key, src.agent, src.log, projected);
          if (src.run !== null && src.agent !== null) {
            checkLogRun(project, src.run, src.agent, src.log, projected);
          }
        });
      });
      let inserted = 0;
      let duplicates = 0;
      let identicalOtherKey = 0;
      const rejections: RecordRejection[] = [];
      const runs = new Map<string, RunAgg>();
      converted.forEach((c, index) => {
        const l = c.row;
        if (!nsInRange(l.timeNs) || !nsInRange(l.observedNs)) {
          rejections.push({ index, code: "ns-out-of-range" });
          return;
        }
        this.#resource(st, org, project, l.resource);
        if (l.run !== null) touch(runs, l.run, l.agent, l.receivedMs, [l.timeNs ?? l.observedNs]);
        // The canonical row of a record has a key-independent ID; another key's identical record
        // gets its own row (own `log_id`) pointing at it through `dup_of` (F6).
        const parts = {
          recordSha256: l.recordSha256,
          resourceSha256: l.resource.sha256,
          scopeSha256: l.scopeSha256,
          resourceSchemaUrl: l.receivedResourceSchemaUrl,
          scopeSchemaUrl: l.receivedScopeSchemaUrl,
        };
        const canonicalId = `log_${logEvidenceSha256(parts, l.occurrence).slice(0, 32)}`;
        const first = st.get("log.keyById", org, project, canonicalId);
        if (first !== undefined) inScope(first, org, project);
        const otherKey = first !== undefined && str(first, "key_id") !== keyId;
        const logId = otherKey
          ? `log_${logSightingSha256(parts, l.occurrence, keyId).slice(0, 32)}`
          : canonicalId;
        const changes = st.run(
          "log.insert",
          org,
          project,
          logId,
          l.run === null ? null : l.run.runId,
          l.timeNs,
          l.observedNs,
          l.severityNumber,
          l.severityTextJson,
          l.eventNameJson,
          l.bodyJson,
          l.attributesJson,
          l.traceId,
          l.spanId,
          l.resource.sha256,
          l.scopeJson,
          batchId,
          l.recordPath,
          l.recordSha256,
          logEvidenceSha256(parts, l.occurrence),
          l.occurrence,
          otherKey ? canonicalId : null,
          l.projectedImportId,
          l.receivedMs,
          keyId,
        );
        if (changes === 1 && !otherKey) inserted++;
        else {
          duplicates++;
          if (otherKey && changes === 1) identicalOtherKey++;
        }
      });
      this.#persistRuns(st, org, project, runs);
      return { inserted, duplicates, identicalOtherKey, rejected: rejections.length, rejections };
    });
  }

  putImport(
    s: ProjectScope,
    keyId: KeyId,
    r: PolicyAppliedImport,
    mode: "add" | "supersede",
  ): ImportPutResult {
    // `local-cli` and migrated imports have their own entry point (G3 F7).
    if (!isKeyId(keyId) || (keyId as string) === "local-cli" || r.derivation === "migrated") bad();
    return this.#putImport(s, keyId, r, mode);
  }

  putMigratedImport(
    s: ProjectScope,
    r: PolicyAppliedImport,
    mode: "add" | "supersede",
  ): ImportPutResult {
    if (r.derivation !== "migrated" || r.batchId !== null) bad();
    return this.#putImport(s, "local-cli", r, mode);
  }

  #putImport(
    s: ProjectScope,
    keyId: CredentialRef,
    r: PolicyAppliedImport,
    mode: "add" | "supersede",
  ): ImportPutResult {
    const { org, project } = projectOf(s);
    if (mode !== "add" && mode !== "supersede") bad();
    const record = parseImportRecord(r.record);
    if (record === null || !oneOf(r.derivation, DERIVATIONS)) bad();
    if (!nat(r.receivedMs) || (r.batchId !== null && !isBatchId(r.batchId))) bad();
    if (keyId === "local-cli" && r.batchId !== null) bad();
    if (!Array.isArray(r.result?.events) || r.result.events.length > MAX_EVENTS_PER_IMPORT) bad();
    const result: ImportResult = r.result;
    if (!isObj(result) || !Array.isArray(result.events) || result.events.length === 0) bad();
    if (!oneOf(result.outcome, IMPORT_OUTCOMES) || result.outcome !== record.outcome) bad();
    // Same check as the file store: the events must survive the strict schema validator.
    let checked: ReturnType<typeof validateEvents>;
    try {
      checked = validateEvents(JSON.parse(JSON.stringify(result.events)));
    } catch {
      return bad();
    }
    if (!checked.ok) bad();
    const events: CanonicalEvent[] = checked.events;
    if (!events.every((e) => e.sessionId === record.sessionId)) bad();
    if (events.length !== record.counts.events) bad();
    if (!isObj(result.source) || result.source.sha256 !== record.source.sha256) bad();
    const metaJson = canonicalJson({
      source: result.source,
      warnings: result.warnings,
      stats: result.stats,
      outcome: result.outcome,
    });
    const eventRows = events.map((e) => ({ id: e.eventId, kind: e.kind, json: canonicalJson(e) }));
    const migrated = r.derivation === "migrated";
    // Agent and run come from the model (ADR-0005 sections 3 and 4), never from caller fields:
    // the record was validated above, so its provider is in the closed set and its IDs have the
    // fixed `ses_` / `imp_` formats.
    const agent: AgentUpsert = agentUpsertOf(
      deriveAgentIdentity(project, { adr0002: { provider: record.provider } }),
    );
    const modelRun = migrated
      ? importRun(project, record.importId)
      : sessionRun(project, record.sessionId);
    const runId = modelRun.runId as RunId;
    const run: RunUpsert = {
      runId,
      kind: migrated ? "import" : "session",
      primaryAgentId: agent.agentId,
      traceId: null,
      adrSessionId: record.sessionId,
      sessionKey: null,
      legacyImportId: migrated ? record.importId : null,
      derivation: r.derivation,
    };
    return this.#tx((st): ImportPutResult => {
      this.#requireProject(st, org, project);
      if (keyId !== "local-cli") {
        const key = this.#requireKey(st, org, project, keyId);
        // A supersede is a replace: it needs the explicit, never-default scope (ADR-0006 2).
        if (mode === "supersede" && !key.scopes.includes("ingest:replace")) {
          throw new DbError("db-scope-violation");
        }
        // The batch an import cites must be this key's batch in this project (provenance).
        if (r.batchId !== null) this.#requireBatch(st, org, project, keyId, r.batchId);
      }
      const sum = st.get("import.summary", org, project, record.importId);
      if (sum === undefined) return corrupt();
      const total = int(sum, "n");
      let priorRun: RunId | null = null;
      if (total > 0) {
        const cur = st.get("import.latest", org, project, record.importId);
        if (cur === undefined) return corrupt();
        inScope(cur, org, project);
        const curRun = str(cur, "run_id");
        if (!isRunId(curRun)) return corrupt();
        priorRun = curRun;
        const current = {
          status: "exists" as PutStatus,
          importId: record.importId,
          runId: curRun,
          version: int(cur, "version"),
        };
        // ADR-0006 2: a client-derived upload never touches an existing import, whatever the scope.
        if (r.derivation === "client") return current;
        const nonClient = total - int(sum, "clients");
        if (mode === "add" && nonClient > 0) {
          const same = str(cur, "adapter_version") === record.adapter.version;
          return { ...current, status: same ? "unchanged" : "skipped-version" };
        }
        // Otherwise: `supersede`, or a server/migrated version over client-only versions (server wins).
      }
      const version = total === 0 ? 1 : int(sum, "max_version") + 1;
      st.run(
        "import.insert",
        org,
        project,
        record.importId,
        version,
        runId,
        record.sessionId,
        record.provider,
        record.sourceKind,
        record.adapter.id,
        record.adapter.version,
        canonicalJson(record),
        metaJson,
        r.derivation,
        r.batchId,
        r.receivedMs,
        keyId,
        record.firstEventTime,
      );
      eventRows.forEach((e, ord) => {
        st.run(
          "event.insert",
          org,
          project,
          record.importId,
          version,
          ord,
          e.id,
          e.kind,
          e.json,
          keyId,
        );
      });
      const runs = new Map<string, RunAgg>();
      touch(runs, run, agent, r.receivedMs, []);
      this.#persistRuns(st, org, project, runs);
      // The previous current version may have belonged to another run: its counters change too.
      if (priorRun !== null && priorRun !== runId) this.#recompute(st, org, project, priorRun);
      return {
        status: total === 0 ? "added" : "superseded",
        importId: record.importId,
        runId,
        version,
      };
    });
  }

  // ---- reads -----------------------------------------------------------------------------------
  fleet(s: ProjectScope, q: FleetQuery): FleetPage {
    const { org, project } = projectOf(s);
    if (!oneOf(q.sort, ["recent", "name"] as const)) bad();
    checkQueryPage(q.limit, q.offset, 200);
    const st = this.#use();
    const name = q.sort === "recent" ? "fleet.listRecent" : "fleet.listName";
    const rows = st.all(name, org, org, org, project, q.limit, q.offset).map((r): FleetRow => {
      const lastRun = nstr(r, "last_run_id");
      if (lastRun !== null && !isRunId(lastRun)) corrupt();
      return { ...mapAgent(r, org, project), runCount: int(r, "run_count"), lastRunId: lastRun };
    });
    const total = st.get("fleet.count", org, project);
    return { rows, total: total === undefined ? 0 : int(total, "n") };
  }

  #runsFor(
    org: OrgId,
    project: PrjId,
    kind: string | null,
    agentId: string | null,
    limit: number,
    offset: number,
  ): RunsPage {
    const st = this.#use();
    const filter: Param[] = [org, project, kind, kind, agentId, org, agentId];
    const rows = st.all("run.list", ...filter, limit, offset).map((r) => mapRun(r, org, project));
    const total = st.get("run.count", ...filter);
    return { rows, total: total === undefined ? 0 : int(total, "n") };
  }

  agent(s: ProjectScope, id: AgtId): AgentDetail | null {
    const { org, project } = projectOf(s);
    if (!isAgtId(id)) return null;
    const st = this.#use();
    const row = st.get("agent.get", org, project, id);
    if (row === undefined) return null;
    const agent = mapAgent(row, org, project);
    const count = st.get("agent.runCount", org, project, id);
    const page = this.#runsFor(org, project, null, id, 50, 0);
    return {
      agent,
      runCount: count === undefined ? 0 : int(count, "n"),
      recentRuns: page.rows,
    };
  }

  runs(s: ProjectScope, q: RunsQuery): RunsPage {
    const { org, project } = projectOf(s);
    checkQueryPage(q.limit, q.offset, 200);
    if (q.agentId !== undefined && !isAgtId(q.agentId)) bad();
    if (q.kind !== undefined && !oneOf(q.kind, RUN_KINDS)) bad();
    return this.#runsFor(org, project, q.kind ?? null, q.agentId ?? null, q.limit, q.offset);
  }

  #importsOf(
    org: OrgId,
    project: PrjId,
    runId: RunId,
  ): { items: (ImportSummary & { metaJson: string })[]; truncated: boolean } {
    const rows = this.#use().all("import.byRun", org, project, runId, org, org, MAX_LIST + 1);
    const items = rows.slice(0, MAX_LIST).map((r) => {
      inScope(r, org, project);
      const record = parseImportRecord(parseJson(str(r, "record_json")));
      if (record === null || record.importId !== str(r, "import_id")) corrupt();
      const derivation = str(r, "derivation");
      const keyId = str(r, "key_id");
      if (!oneOf(derivation, DERIVATIONS)) corrupt();
      if (!(isKeyId(keyId) || keyId === "local-cli")) corrupt();
      const batchId = nstr(r, "batch_id");
      if (batchId !== null && !isBatchId(batchId)) corrupt();
      return {
        importId: record.importId,
        version: int(r, "version"),
        keyId,
        derivation,
        batchId,
        receivedMs: int(r, "received_ms"),
        firstValidTime: nstr(r, "first_valid_time"),
        record,
        // Carried for `runEvents` only.
        metaJson: str(r, "meta_json"),
      };
    });
    return { items, truncated: rows.length > MAX_LIST };
  }

  run(s: ProjectScope, id: RunId): RunDetail | null {
    const { org, project } = projectOf(s);
    if (!isRunId(id)) return null;
    const st = this.#use();
    const row = st.get("run.get", org, project, id);
    if (row === undefined) return null;
    const run = mapRun(row, org, project);
    const agentRows = st.all("run.agents", org, project, id, MAX_LIST + 1);
    const agentIds = agentRows.slice(0, MAX_LIST).map((r) => {
      inScope(r, org, project);
      const a = str(r, "agent_id");
      if (!isAgtId(a)) corrupt();
      return a;
    });
    const found = this.#importsOf(org, project, id);
    const imports = found.items.map(({ metaJson: _m, ...rest }): ImportSummary => rest);
    return {
      run,
      agentIds,
      imports,
      truncated: { agents: agentRows.length > MAX_LIST, imports: found.truncated },
    };
  }

  runEvents(s: ProjectScope, id: RunId): RunEvents {
    const { org, project } = projectOf(s);
    if (!isRunId(id)) return { sessions: [], truncated: false };
    const st = this.#use();
    const found = this.#importsOf(org, project, id);
    const sessions = found.items.map((imp): SessionView => {
      const rows = st.all(
        "event.byImport",
        org,
        project,
        imp.importId,
        imp.version,
        MAX_EVENTS_PER_IMPORT + 1,
      );
      // Writes are capped at MAX_EVENTS_PER_IMPORT, so a longer stored import was edited.
      if (rows.length > MAX_EVENTS_PER_IMPORT) corrupt();
      const parsed = rows.map((r, i) => {
        inScope(r, org, project);
        if (int(r, "ord") !== i) corrupt();
        return parseJson(str(r, "event_json"));
      });
      const checked = validateEvents(parsed);
      if (!checked.ok) return corrupt();
      const meta = parseJson(imp.metaJson);
      if (
        !isObj(meta) ||
        !isObj(meta["source"]) ||
        !Array.isArray(meta["warnings"]) ||
        !isObj(meta["stats"]) ||
        !oneOf(meta["outcome"], IMPORT_OUTCOMES)
      ) {
        return corrupt();
      }
      const source = meta["source"] as unknown as ImportResult["source"];
      if (
        source.sha256 !== imp.record.source.sha256 ||
        checked.events.length !== imp.record.counts.events ||
        imp.record.outcome !== meta["outcome"]
      ) {
        return corrupt();
      }
      return {
        record: imp.record as ImportRecord,
        result: {
          source,
          events: checked.events,
          warnings: meta["warnings"] as AdapterWarning[],
          stats: meta["stats"] as unknown as ImportStats,
          outcome: meta["outcome"],
        },
      };
    });
    return { sessions, truncated: found.truncated };
  }

  runSpans(s: ProjectScope, id: RunId, limit: number): SpanRunData {
    const { org, project } = projectOf(s);
    if (!nat(limit) || limit < 1 || limit > 10_000) bad();
    if (!isRunId(id))
      return { spans: [], conflicts: [], truncated: false, conflictsTruncated: false };
    const st = this.#use();
    const rows = st.all("span.byRun", org, org, project, id, limit + 1);
    const spans = rows.slice(0, limit).map((r) => mapSpan(r, org, project));
    const conflictRows = st.all("span.conflictsByRun", org, org, project, id);
    const conflicts = conflictRows.slice(0, 1000).map((r) => mapConflict(r, org, project));
    return {
      spans,
      conflicts,
      truncated: rows.length > limit,
      conflictsTruncated: conflictRows.length > 1000,
    };
  }

  /** The allowed projects must all belong to the org: a foreign ID is a scope error, never skipped. */
  #projectsOf(st: Stmts, org: OrgId, allowed: readonly PrjId[]): PrjId[] {
    if (!Array.isArray(allowed) || allowed.length > 1000) bad();
    const out: PrjId[] = [];
    for (const p of allowed) {
      if (!isPrjId(p)) bad();
      if (out.includes(p)) continue;
      const row = st.get("prj.byId", org, p);
      if (row === undefined) throw new DbError("db-scope-violation");
      assertRowScope(row, { orgId: org, projectId: p });
      out.push(p);
    }
    return out;
  }

  resolveId(s: OrgScope, allowedProjects: readonly PrjId[], q: string): readonly ResolvedRef[] {
    const org = orgOf(s);
    const st = this.#use();
    const projects = this.#projectsOf(st, org, allowedProjects);
    if (typeof q !== "string" || q.length > 64) return [];
    const out: ResolvedRef[] = [];
    const runRef = (r: Row): RunId => {
      const v = str(r, "run_id");
      if (!isRunId(v)) return corrupt();
      return v;
    };
    const prefixed = /^(run|agt|imp|evt)_[0-9a-f]{6,32}$/.exec(q);
    for (const project of projects) {
      const scopedAll = (name: StatementName, ...params: Param[]): Row[] => {
        const rows = st.all(name, ...params);
        for (const r of rows) inScope(r, org, project);
        return rows;
      };
      const push = (type: ResolvedRef["type"], id: string, runId: RunId | null): void => {
        out.push({ projectId: project, type, id, runId });
      };
      if (prefixed !== null) {
        const len = q.length;
        switch (prefixed[1]) {
          case "run":
            for (const r of scopedAll("resolve.runPrefix", org, project, len, q)) {
              push("run", runRef(r), runRef(r));
            }
            break;
          case "agt":
            for (const r of scopedAll("resolve.agentPrefix", org, project, len, q)) {
              push("agent", str(r, "agent_id"), null);
            }
            break;
          case "imp":
            for (const r of scopedAll("resolve.importPrefix", org, project, len, q, org, org)) {
              push("import", str(r, "import_id"), runRef(r));
            }
            break;
          default:
            for (const r of scopedAll("resolve.eventPrefix", org, org, project, len, q, org, org)) {
              push("event", str(r, "event_id"), runRef(r));
            }
        }
      } else if (/^ses_[0-9a-f]{32}$/.test(q)) {
        for (const r of scopedAll("resolve.runBySession", org, project, q))
          push("run", runRef(r), runRef(r));
      } else if (/^[0-9a-f]{32}$/.test(q)) {
        for (const r of scopedAll("resolve.runByTrace", org, project, q))
          push("run", runRef(r), runRef(r));
      } else if (/^[0-9a-f]{16}$/.test(q)) {
        for (const r of scopedAll("resolve.spanById", org, project, q)) {
          push("span", str(r, "span_id"), runRef(r));
        }
      }
    }
    return out.slice(0, MAX_RESOLVE);
  }

  status(s: OrgScope, allowedProjects: readonly PrjId[]): StoreStatus {
    const org = orgOf(s);
    const st = this.#use();
    const projects = this.#projectsOf(st, org, allowedProjects);
    const nowMs = this.#options.nowMs();
    if (!nat(nowMs)) throw new DbError("db-io");
    const since = Math.max(0, nowMs - 86_400_000);
    const version = st.get("mig.schemaVersion");
    const rows = projects.map((project): ProjectStatus => {
      const r = st.get(
        "status.project",
        org,
        org,
        org,
        org,
        since,
        org,
        since,
        org,
        since,
        org,
        project,
      );
      if (r === undefined) throw new DbError("db-scope-violation");
      assertRowScope(r, { orgId: org, projectId: project });
      const contentPolicy = str(r, "content_policy");
      const rawRetention = str(r, "raw_retention");
      if (!oneOf(contentPolicy, CONTENT_POLICIES) || !oneOf(rawRetention, RAW_RETENTIONS))
        corrupt();
      return {
        projectId: project,
        slug: str(r, "slug"),
        agents: int(r, "agents"),
        runs: int(r, "runs"),
        lastIngestMs: nint(r, "last_ingest_ms"),
        batches24h: {
          accepted: int(r, "accepted"),
          partial: int(r, "partial"),
          rejected: int(r, "rejected"),
        },
        contentPolicy,
        rawRetention,
      };
    });
    return { schemaVersion: version === undefined ? 0 : int(version, "v"), projects: rows };
  }

  // ---- auth ------------------------------------------------------------------------------------
  putLoginCode(c: NewLoginCode): void {
    if (!isOrgId(c.orgId) || !isHex64(c.codeSha256) || !isSafeNextPath(c.nextPath)) bad();
    if (!nat(c.expiresAtMs)) bad();
    // A login code lives at most 60 s from now (G3 F10).
    if (c.expiresAtMs > this.#now() + MAX_LOGIN_CODE_MS) bad();
    this.#tx((st) => {
      st.run("login.insert", c.codeSha256, c.orgId, c.nextPath, c.expiresAtMs);
    });
  }

  consumeLoginCode(codeSha256: string, nowMs: number): LoginResult | null {
    if (!isHex64(codeSha256) || !nat(nowMs)) return null;
    // One UPDATE ... RETURNING: two concurrent consumers cannot both succeed.
    const row = this.#tx((st) => st.get("login.consume", nowMs, codeSha256, nowMs));
    if (row === undefined) return null;
    const orgId = str(row, "org_id");
    const nextPath = str(row, "next_path");
    if (!isOrgId(orgId) || !isSafeNextPath(nextPath)) return null;
    return { orgId, nextPath };
  }

  putSession(orgId: OrgId, s: NewSession): void {
    if (!isOrgId(orgId) || !isHex64(s.tokenSha256) || !text(s.principal, 128)) bad();
    if (!nat(s.createdMs)) bad();
    this.#tx((st) => {
      st.run("session.insert", s.tokenSha256, orgId, s.principal, s.createdMs, s.createdMs);
    });
  }

  findSession(tokenSha256: string, nowMs: number): Session | null {
    if (!isHex64(tokenSha256) || !nat(nowMs)) return null;
    const life = SESSION_LIFETIMES[this.#options.sessionMode];
    const row = this.#tx((st) =>
      st.get("session.touch", nowMs, tokenSha256, nowMs, life.idleMs, nowMs, life.absoluteMs),
    );
    if (row === undefined) return null;
    const orgId = str(row, "org_id");
    if (!isOrgId(orgId)) return corrupt();
    return {
      orgId,
      principal: str(row, "principal"),
      createdMs: int(row, "created_ms"),
      lastSeenMs: int(row, "last_seen_ms"),
    };
  }

  revokeSession(tokenSha256: string, atMs: number): void {
    if (!isHex64(tokenSha256) || !nat(atMs)) bad();
    this.#tx((st) => {
      st.run("session.revoke", atMs, tokenSha256);
    });
  }

  // ---- audit -----------------------------------------------------------------------------------
  appendAudit(orgId: OrgId, e: AuditEntryInput): void {
    if (!isOrgId(orgId) || !oneOf(e.action, AUDIT_ACTIONS) || !text(e.at, 40)) bad();
    if (
      !/^[a-z][a-z0-9._-]{0,31}$/.test(e.actorType) ||
      !/^[a-z][a-z0-9._-]{0,31}$/.test(e.targetType)
    ) {
      bad();
    }
    if (!text(e.actorId, 128) || !text(e.targetId, 128)) bad();
    if (!isObj(e.detail) || Object.keys(e.detail).length > 32) bad();
    for (const v of Object.values(e.detail)) {
      const okType =
        v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
      if (!okType || (typeof v === "string" && !text(v, 256, 0))) bad();
    }
    const detailJson = canonicalJson(e.detail);
    this.#tx((st) => {
      const last = st.get("audit.last", orgId);
      const seq = last === undefined ? 1 : int(last, "seq") + 1;
      const prevHash = last === undefined ? ZERO_HASH : str(last, "hash");
      const hash = auditHash(orgId, seq, e, detailJson, prevHash);
      st.run(
        "audit.insert",
        orgId,
        seq,
        e.at,
        e.actorType,
        e.actorId,
        e.action,
        e.targetType,
        e.targetId,
        detailJson,
        prevHash,
        hash,
      );
    });
  }

  verifyAudit(orgId: OrgId): AuditVerifyResult {
    if (!isOrgId(orgId)) bad();
    const st = this.#use();
    let expected = 1;
    let prev = ZERO_HASH;
    let after = 0;
    for (;;) {
      const page = st.all("audit.page", orgId, after, 500);
      if (page.length === 0) return { ok: true, entries: expected - 1 };
      for (const r of page) {
        const seq = nint(r, "seq");
        const fail = (reason: "gap" | "prev-hash" | "hash" | "invalid-row"): AuditVerifyResult => ({
          ok: false,
          entries: expected - 1,
          firstBadSeq: seq ?? expected,
          reason,
        });
        let entry: AuditEntryInput;
        let detailJson: string;
        let rowPrev: string;
        let rowHash: string;
        try {
          assertRowScope(r, { orgId });
          detailJson = str(r, "detail_json");
          rowPrev = str(r, "prev_hash");
          rowHash = str(r, "hash");
          entry = {
            at: str(r, "at"),
            actorType: str(r, "actor_type"),
            actorId: str(r, "actor_id"),
            action: str(r, "action") as AuditEntryInput["action"],
            targetType: str(r, "target_type"),
            targetId: str(r, "target_id"),
            detail: {},
          };
        } catch {
          return fail("invalid-row");
        }
        if (seq !== expected) return fail("gap");
        if (rowPrev !== prev) return fail("prev-hash");
        if (auditHash(orgId, seq, entry, detailJson, rowPrev) !== rowHash) return fail("hash");
        prev = rowHash;
        after = seq;
        expected++;
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stmts.clear();
    try {
      this.#opened.db.close();
    } catch (e) {
      throw toDbError(e);
    }
  }
}

/** `HMAC-SHA256(server_secrets.client_proof, lp("swain:v1:proof-key") || lp(keyId))` (ADR-0006 8). */
function proofKeyOf(clientProof: Uint8Array, keyId: string): Uint8Array {
  return hmacSha256(clientProof, concat(lp("swain:v1:proof-key"), lp(keyId)));
}

/** `HMAC-SHA256(server_secrets.client_proof, lp("swain:v1:owner-proof-key"))`. */
function ownerKeyOf(clientProof: Uint8Array): Uint8Array {
  return hmacSha256(clientProof, lp("swain:v1:owner-proof-key"));
}

/**
 * `sha256(lp("swain:v1:audit") || lp(prev_hash) || lp(canonicalJson(entry without hash)))`, chained
 * per org (ADR-0007 r2 section 8).
 */
function auditHash(
  orgId: OrgId,
  seq: number,
  e: AuditEntryInput,
  detailJson: string,
  prevHash: string,
): string {
  const entry = canonicalJson({
    org_id: orgId,
    seq,
    at: e.at,
    actor_type: e.actorType,
    actor_id: e.actorId,
    action: e.action,
    target_type: e.targetType,
    target_id: e.targetId,
    detail_json: detailJson,
    prev_hash: prevHash,
  });
  return sha256Hex(concat(lp("swain:v1:audit"), lp(prevHash), lp(entry)));
}
