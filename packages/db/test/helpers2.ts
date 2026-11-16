import { DatabaseSync } from "node:sqlite";
import {
  applyContentPolicy,
  type ContentPolicyInput,
  type InputLogRecord,
  type PolicyInputLogs,
} from "@swain/model";
import type { BatchInput, KeyId, LogPut, SqliteSwainStore } from "../src/index.js";
import {
  agentFor,
  batchOf,
  NOW,
  NOW_ISO,
  POLICY,
  runFor,
  SHA_B,
  SHA_C,
  type Tenant,
  TRACE,
} from "./helpers.js";

/** A second key in the same project (the credential of another agent or integration). */
export function extraKey(store: SqliteSwainStore, t: Tenant, label = "k2"): KeyId {
  return store.createKey(t.scope, {
    label,
    agentName: "planner",
    scopes: ["ingest:otlp", "ingest:native", "ingest:replace"],
    createdBy: "test",
    createdAt: NOW_ISO,
  }).key.keyId;
}

/** Record a batch for `keyId` and return its ID (the batch must exist before its records). */
export function recorded(
  store: SqliteSwainStore,
  t: Tenant,
  keyId: KeyId,
  id: string,
  over: Partial<BatchInput> = {},
): string {
  const out = store.recordBatch(t.scope, keyId, batchOf(t, id, over));
  if (out.outcome === "idempotency-conflict") throw new Error("unexpected idempotency conflict");
  return out.batch.batchId;
}

export interface LogOver {
  readonly occurrence?: number;
  readonly recordSha256?: string;
  readonly timeNs?: bigint;
  readonly body?: string;
  readonly traceId?: string | null;
  readonly policy?: ContentPolicyInput;
  readonly resourceSha256?: string;
  readonly scopeSha256?: string;
  readonly attrs?: Readonly<Record<string, string>>;
}

/** A decoded log record run through the real `applyContentPolicy`, plus the derived run and agent. */
export function logOf(t: Tenant, over: LogOver = {}): LogPut {
  const agent = agentFor(t.projectId, "planner");
  const record: InputLogRecord = {
    timeUnixNano: over.timeNs ?? 1_700_000_000_000_000_001n,
    observedTimeUnixNano: 0n,
    severityNumber: 9,
    severityText: "INFO",
    body: { kind: "string", value: over.body ?? "hello" },
    attributes: Object.entries(over.attrs ?? {}).map(([key, value]) => ({
      key,
      value: { kind: "string" as const, value },
    })),
    droppedAttributesCount: 0,
    flags: 0,
    traceId: over.traceId === undefined ? TRACE : over.traceId,
    spanId: null,
    eventName: "",
    path: "/resourceLogs/0/scopeLogs/0/logRecords/0",
    recordSha256: over.recordSha256 ?? "c".repeat(64),
  };
  const batch: PolicyInputLogs = {
    signal: "logs",
    resourceLogs: [
      {
        path: "/resourceLogs/0",
        resource: {
          attributes: [{ key: "service.name", value: { kind: "string", value: "svc" } }],
          droppedAttributesCount: 0,
        },
        resourceSha256: over.resourceSha256 ?? SHA_B,
        schemaUrl: "",
        scopeLogs: [
          {
            path: "/resourceLogs/0/scopeLogs/0",
            scope: { name: "s", version: "", attributes: [], droppedAttributesCount: 0 },
            scopeSha256: over.scopeSha256 ?? SHA_C,
            schemaUrl: "",
            logRecords: [record],
          },
        ],
      },
    ],
    rejected: [],
    warnings: [],
  };
  const log = applyContentPolicy(batch, over.policy ?? POLICY).logs[0];
  if (log === undefined) throw new Error("applier dropped the log");
  return {
    log,
    received: { resourceSchemaUrl: "", scopeSchemaUrl: "" },
    occurrence: over.occurrence ?? 0,
    run: runFor(t.projectId, TRACE, agent),
    agent,
    projectedImportId: null,
    receivedMs: NOW,
  };
}

/** A second connection for tampering with stored rows, as someone who can edit the file could. */
export function rawDb(store: SqliteSwainStore): DatabaseSync {
  const raw = new DatabaseSync(store.path);
  raw.exec("PRAGMA busy_timeout=5000");
  return raw;
}
