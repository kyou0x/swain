/**
 * Run and session IDs and kinds (ADR-0005 sections 2 and 4). Pure.
 *
 * Run ID components (after the domain string, via `deriveSwainId("run", ...)`):
 * - `trace`   `["trace", projectId, traceIdHex]`
 * - `session` `["session", projectId, sessionId]`
 * - `import`  `["import", projectId, importId]`
 * - `logs`    `["logs", projectId, agentId, sessionValue]`; without a session value the run is one
 *   rolling run per agent per UTC day, `["logs", projectId, agentId, "ungrouped", "YYYY-MM-DD"]`
 *   (five components, so it cannot equal a four-component session form).
 */
import { AtmError } from "@swain/core";
import { type IdentityValue, requireIdentity } from "./identity.js";
import { deriveSwainId } from "./ids.js";
import { deepFreeze } from "./policy/types.js";

export type RunKind = "trace" | "session" | "import" | "logs";
export type SessionKeyBasis = "session.id" | "gen_ai.conversation.id" | "adr0002.sessionId";

const PROJECT_ID = /^prj_[0-9a-f]{32}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const AGENT_ID = /^agt_[0-9a-f]{32}$/;
/** Fixed formats of the facts a run carries into storage (SPEC-003 hard condition 3). */
export const ADR_SESSION_ID = /^ses_[0-9a-f]{32}$/;
export const IMPORT_ID = /^imp_[0-9a-f]{32}$/;
export const SESSION_KEY = /^sess_[0-9a-f]{32}$/;

function bad(): never {
  throw new AtmError("invalid-id-component");
}

function projectOf(p: string): string {
  return typeof p === "string" && PROJECT_ID.test(p) ? p : bad();
}

/**
 * A run as the store needs it, stamped by the functions below (frozen, registered): the run ID,
 * kind and every grouping fact come from one place, in a fixed format, never from caller text.
 * `adrSessionId` is `ses_<32 hex>`, `legacyImportId` `imp_<32 hex>`, `sessionKey` `sess_<32 hex>`
 * (derived from the identity value, so a raw session value never leaves this module), `agentId` is
 * set for `logs` runs only.
 */
export interface RunRef {
  readonly kind: RunKind;
  readonly runId: `run_${string}`;
  readonly projectId: string;
  readonly traceId: string | null;
  readonly adrSessionId: string | null;
  readonly sessionKey: string | null;
  readonly legacyImportId: string | null;
  readonly agentId: string | null;
  /** Set for the rolling per-day `logs` run: the UI labels it "ungrouped logs". */
  readonly ungroupedLogsDay?: string;
}

/** What `deriveSwainId("run", ...)` was given, kept privately so the ID can be recomputed. */
const RUNS = new WeakMap<object, readonly string[]>();

function makeRun(components: readonly string[], f: Omit<RunRef, "runId">): RunRef {
  const run: RunRef = deepFreeze({
    ...f,
    runId: deriveSwainId("run", components) as `run_${string}`,
  });
  RUNS.set(run, Object.freeze([...components]));
  return run;
}

/**
 * True only for a run these functions produced whose ID still equals the derivation from its own
 * components and whose facts have their fixed formats. `@swain/db` calls this on every run it stores.
 */
export function isRunRef(v: unknown): v is RunRef {
  if (typeof v !== "object" || v === null) return false;
  const components = RUNS.get(v);
  if (components === undefined) return false;
  const r = v as RunRef;
  try {
    if (r.runId !== deriveSwainId("run", components)) return false;
  } catch {
    return false;
  }
  return (
    PROJECT_ID.test(r.projectId) &&
    (r.traceId === null || TRACE_ID.test(r.traceId)) &&
    (r.adrSessionId === null || ADR_SESSION_ID.test(r.adrSessionId)) &&
    (r.legacyImportId === null || IMPORT_ID.test(r.legacyImportId)) &&
    (r.sessionKey === null || SESSION_KEY.test(r.sessionKey)) &&
    (r.agentId === null || AGENT_ID.test(r.agentId))
  );
}

export function traceRun(projectId: string, traceIdHex: string): RunRef {
  if (typeof traceIdHex !== "string" || !TRACE_ID.test(traceIdHex)) return bad();
  const prj = projectOf(projectId);
  return makeRun(["trace", prj, traceIdHex], {
    kind: "trace",
    projectId: prj,
    traceId: traceIdHex,
    adrSessionId: null,
    sessionKey: null,
    legacyImportId: null,
    agentId: null,
  });
}

export function sessionRun(projectId: string, adr0002SessionId: string): RunRef {
  if (typeof adr0002SessionId !== "string" || !ADR_SESSION_ID.test(adr0002SessionId)) return bad();
  const prj = projectOf(projectId);
  return makeRun(["session", prj, adr0002SessionId], {
    kind: "session",
    projectId: prj,
    traceId: null,
    adrSessionId: adr0002SessionId,
    sessionKey: null,
    legacyImportId: null,
    agentId: null,
  });
}

export function importRun(projectId: string, importId: string): RunRef {
  if (typeof importId !== "string" || !IMPORT_ID.test(importId)) return bad();
  const prj = projectOf(projectId);
  return makeRun(["import", prj, importId], {
    kind: "import",
    projectId: prj,
    traceId: null,
    adrSessionId: null,
    sessionKey: null,
    legacyImportId: importId,
    agentId: null,
  });
}

/** UTC calendar day of a Unix-nanosecond time, or `"undated"` for an unset (zero) time. */
export function utcDay(timeUnixNano: bigint): string {
  if (typeof timeUnixNano !== "bigint" || timeUnixNano <= 0n) return "undated";
  const ms = Number(timeUnixNano / 1_000_000n);
  if (!Number.isSafeInteger(ms) || ms > 8_640_000_000_000_000) return "undated";
  return new Date(ms).toISOString().slice(0, 10);
}

export function logsRun(
  projectId: string,
  agentId: string,
  session: IdentityValue | null,
  timeUnixNano: bigint,
): RunRef {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return bad();
  const prj = projectOf(projectId);
  const base = {
    kind: "logs" as const,
    projectId: prj,
    traceId: null,
    adrSessionId: null,
    legacyImportId: null,
    agentId,
  };
  if (session !== null) {
    const sv = requireIdentity(session).part;
    return makeRun(["logs", prj, agentId, sv], {
      ...base,
      sessionKey: deriveSessionId(prj, "session.id", session),
    });
  }
  const day = utcDay(timeUnixNano);
  return makeRun(["logs", prj, agentId, "ungrouped", day], {
    ...base,
    sessionKey: null,
    ungroupedLogsDay: day,
  });
}

export interface LogRunInput {
  readonly projectId: string;
  readonly agentId: string;
  readonly traceId: string | null;
  /** `session.id` identity from `identityOfAttribute`, when present (never post-mask text). */
  readonly session: IdentityValue | null;
  /** True when a projection (the Claude Code logs adapter) consumes this record into a session run. */
  readonly projectedSessionId?: string | null;
  readonly timeUnixNano: bigint;
}

/**
 * Which run owns an OTLP log record: a projected ADR-0002 session first, else the trace run when
 * the record carries a trace ID, else a `logs` run grouped by `session.id` (ADR-0005 section 4).
 */
export function runForLogRecord(i: LogRunInput): RunRef {
  if (i.projectedSessionId !== undefined && i.projectedSessionId !== null) {
    return sessionRun(i.projectId, i.projectedSessionId);
  }
  if (i.traceId !== null) return traceRun(i.projectId, i.traceId);
  return logsRun(i.projectId, i.agentId, i.session, i.timeUnixNano);
}

/** `sess_` + derived from `(projectId, sessionKeyBasis, value)` (ADR-0005 section 2). */
export function deriveSessionId(
  projectId: string,
  basis: SessionKeyBasis,
  value: IdentityValue,
): string {
  if (
    basis !== "session.id" &&
    basis !== "gen_ai.conversation.id" &&
    basis !== "adr0002.sessionId"
  ) {
    return bad();
  }
  const v = requireIdentity(value).part;
  return deriveSwainId("sess", [projectOf(projectId), basis, v]);
}
