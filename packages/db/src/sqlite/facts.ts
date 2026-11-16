/**
 * Derived facts the store does not take on trust (round 4, N1.5; SPEC-003 "Hard condition").
 *
 *  - `opClass` / `opJson` come from `@swain/model`'s `normalizeSpan` over the post-policy attributes
 *    of the `PolicyAppliedSpan`; the caller supplies neither. `opJson` has a closed key set and a
 *    16 KiB cap.
 *  - The agent is a stamped `AgentIdentity` (frozen, registered in `@swain/model`; a copy or a
 *    literal is refused). The store additionally recomputes it: a key with a pinned agent name must
 *    carry the `cred`/`cred-sub` identity derived from that name, an unpinned key must not; any
 *    other basis must equal `deriveAgentIdentity` over the record's own attributes. `agentKey` for
 *    the key-evidence bases has an exact format (no free text), and `displayName`, `agentKey`
 *    and `keyBasis` are taken from the identity, never from the caller.
 *  - The run is a stamped `RunRef`. The store recomputes it from the record: the trace run of the
 *    record's trace ID, or (logs without a trace) `logsRun` over the record's own `session.id`
 *    identity, so `sessionKey` and the run ID are read from the policy-applied record. Session runs
 *    are accepted only for a projected log (`projectedImportId` set), whose ADR-0002 session ID
 *    has the fixed `ses_` format.
 *  - `projectedImportId` must have the import ID format; a log is never accepted as a span.
 */
import { canonicalJson } from "@swain/core";
import {
  type AgentIdentity,
  containsSwainKey,
  deriveAgentIdentity,
  identityOfAttribute,
  isAgentIdentity,
  isRunRef,
  logsRun,
  normalizeSpan,
  type PolicyAppliedLog,
  type PolicyAppliedSpan,
  type RunRef,
  traceRun,
} from "@swain/model";
import { DbError } from "../errors.js";
import type { AgentUpsert, KeyRecord, OpClass, RunUpsert } from "../types.js";

export const OP_JSON_MAX_BYTES = 16 * 1024;
const IMPORT_ID = /^imp_[0-9a-f]{32}$/;

function bad(): never {
  throw new DbError("db-constraint");
}

const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

/** Refuses a log where a span is expected, and the reverse (by the fields only one kind has). */
export function requireSpanKind(v: PolicyAppliedSpan): void {
  if (typeof v !== "object" || v === null) bad();
  if (!has(v, "status") || !has(v, "events") || has(v, "severityNumber") || has(v, "body")) bad();
}
export function requireLogKind(v: PolicyAppliedLog): void {
  if (typeof v !== "object" || v === null) bad();
  if (!has(v, "severityNumber") || !has(v, "body") || has(v, "status") || has(v, "events")) bad();
}

export function deriveOp(span: PolicyAppliedSpan): { opClass: OpClass; opJson: string } {
  const n = normalizeSpan(span);
  const opJson = canonicalJson({
    operation: n.operation,
    subtype: n.subtype,
    detector: { basis: n.detector.basis, value: n.detector.value },
    provider: n.provider,
    requestModel: n.requestModel,
    responseModel: n.responseModel,
    usage: { ...n.usage },
    toolName: n.toolName,
    toolCallId: n.toolCallId,
    normBasis: n.normBasis.map((b) => ({ field: b.field, key: b.key })),
  });
  if (new TextEncoder().encode(opJson).length > OP_JSON_MAX_BYTES) bad();
  const opClass: OpClass = n.operation;
  return { opClass, opJson };
}

/** The agent row of a stamped identity: key, basis and display name all come from the model. */
export function agentUpsertOf(a: AgentIdentity): AgentUpsert {
  if (!isAgentIdentity(a)) bad();
  return {
    agentId: a.agentId as AgentUpsert["agentId"],
    agentKey: a.key,
    keyBasis: a.keyBasis,
    displayName: a.displayName,
  };
}

/** The run row of a stamped run; derivation is always `server` on the OTLP path. */
export function runUpsertOf(run: RunRef, primaryAgentId: string): RunUpsert {
  if (!isRunRef(run)) bad();
  return {
    runId: run.runId as RunUpsert["runId"],
    kind: run.kind,
    primaryAgentId: primaryAgentId as RunUpsert["primaryAgentId"],
    traceId: run.traceId,
    adrSessionId: run.adrSessionId,
    sessionKey: run.sessionKey,
    legacyImportId: run.legacyImportId,
    derivation: "server",
  };
}

/**
 * The agent must be the one the model derives from the key and the record. `projected` is true
 * only for a log consumed by an ADR-0002 projection, the only OTLP evidence for the adr0002 bases.
 */
export function checkAgentFacts(
  project: string,
  key: KeyRecord,
  agent: AgentIdentity,
  evidence: PolicyAppliedSpan | PolicyAppliedLog,
  projected: boolean,
): void {
  if (!isAgentIdentity(agent) || agent.projectId !== project) bad();
  if (containsSwainKey(agent.key) || containsSwainKey(agent.displayName)) bad();
  const b = agent.keyBasis;
  if (key.agentName !== null) {
    // Rule 1: a pinned key is authoritative; nothing else may name the agent.
    if (b !== "cred" && b !== "cred-sub") bad();
    const expected = deriveAgentIdentity(project, {
      pinnedAgentName: key.agentName,
      pinnedSubagentType: b === "cred-sub" ? (agent.components[1] ?? null) : null,
    });
    if (expected.agentId !== agent.agentId || expected.key !== agent.key) bad();
    return;
  }
  if (b === "cred" || b === "cred-sub") bad();
  if (b === "adr0002" || b === "adr0002-sub") {
    if (!projected) bad();
    return;
  }
  const own = deriveAgentIdentity(project, {
    attributes: evidence.attributes,
    resourceAttributes: evidence.resource.attributes,
  });
  if (own.agentId !== agent.agentId || own.keyBasis !== b || own.key !== agent.key) bad();
}

/** A span's run is the trace run of its trace ID. */
export function checkSpanRun(project: string, run: RunRef, span: PolicyAppliedSpan): void {
  if (!isRunRef(run) || run.projectId !== project || run.kind !== "trace") bad();
  if (run.runId !== traceRun(project, span.traceId).runId) bad();
}

/**
 * A log's run is recomputed from the record: the trace run when it carries a trace ID, else the
 * `logs` run over its own `session.id` identity (or the per-day run), else, for a projected log,
 * a session run with a fixed-format ADR-0002 session ID.
 */
export function checkLogRun(
  project: string,
  run: RunRef,
  agent: AgentIdentity,
  log: PolicyAppliedLog,
  projected: boolean,
): void {
  if (!isRunRef(run) || run.projectId !== project) bad();
  if (run.kind === "session") {
    if (!projected || run.adrSessionId === null) bad();
    return;
  }
  if (log.traceId !== null) {
    if (run.kind !== "trace" || run.runId !== traceRun(project, log.traceId).runId) bad();
    return;
  }
  if (run.kind !== "logs" || run.agentId !== agent.agentId) bad();
  const expected = logsRun(
    project,
    agent.agentId,
    identityOfAttribute(log.attributes, "session.id"),
    log.timeUnixNano,
  );
  if (expected.runId !== run.runId || expected.sessionKey !== run.sessionKey) bad();
}

export function checkProjectedImportId(id: string | null): void {
  if (id !== null && !IMPORT_ID.test(id)) bad();
}
