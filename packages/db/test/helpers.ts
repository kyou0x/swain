import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ImportResult, sha256Hex } from "@swain/core";
import {
  type AgentIdentity,
  applyContentPolicy,
  type ContentPolicyInput,
  deriveAgentIdentity,
  type InputKeyValue,
  type InputSpan,
  type PolicyInputTraces,
  type RunRef,
  traceRun,
} from "@swain/model";
import type { ImportRecord } from "@swain/report";
import {
  type BatchInput,
  type ImportPut,
  type KeyId,
  type OrgId,
  type PolicyAppliedImport,
  type PrjId,
  type SpanPut,
  SqliteSwainStore,
} from "../src/index.js";

export const NOW = 1_700_000_000_000;
export const NOW_ISO = "2026-01-01T00:00:00.000Z";
export const uid: number = (process.getuid as () => number)();

/**
 * Imports only: `@swain/model` does not produce `PolicyAppliedImport` yet (ADR-0005 6.5), so tests
 * stand in for that one producer. Spans and logs go through the real `applyContentPolicy`.
 */
export function pa(x: ImportPut): PolicyAppliedImport {
  return x as PolicyAppliedImport;
}

/** Deterministic entropy: a counter run through the byte positions. */
export function counterRandom(): (n: number) => Uint8Array {
  let c = 0;
  return (n) => {
    c++;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (c * 31 + i * 17 + 7) & 0xff;
    out[0] = c & 0xff;
    out[1] = (c >> 8) & 0xff;
    return out;
  };
}

export function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atm-db-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export function openStore(dir: string, name = "swain.sqlite"): SqliteSwainStore {
  const s = SqliteSwainStore.open(join(dir, name), {
    randomBytes: counterRandom(),
    sessionMode: "team",
    uid,
    nowMs: () => NOW,
  });
  s.migrate({ nowIso: () => NOW_ISO });
  return s;
}

const FIXTURES = new URL("../../../../fixtures/report/", import.meta.url);
export function fixture(name: string): { record: ImportRecord; result: ImportResult } {
  const f = JSON.parse(readFileSync(new URL(`${name}/session.json`, FIXTURES), "utf8")) as {
    record: ImportRecord;
    result: ImportResult;
  };
  // The report fixtures label the container "plain"; stored records use the store's "none".
  return {
    record: { ...f.record, source: { ...f.record.source, container: "none" } },
    result: f.result,
  };
}

export function importPut(name: string, over: Partial<ImportPut> = {}): PolicyAppliedImport {
  const f = fixture(name);
  return pa({
    record: f.record,
    result: f.result,
    derivation: "server",
    batchId: null,
    receivedMs: NOW,
    ...over,
  });
}

export interface Tenant {
  readonly orgId: OrgId;
  readonly projectId: PrjId;
  readonly keyId: KeyId;
  readonly scope: { orgId: OrgId; projectId: PrjId };
}

let seeded = 0;
/**
 * A second (or third) org with its own workspace, project and key, inserted directly: org creation
 * is not part of the N1 store interface (team mode, N4). Workspace and project slugs collide with
 * the local tenant's on purpose; `orgs.slug` is globally unique, so that one differs.
 */
export function seedTenant(
  store: SqliteSwainStore,
  orgSlug: string,
  projectSlug = "default",
): Tenant {
  seeded++;
  const n = String(seeded).padStart(2, "0");
  const orgId = `org_${n}${"0".repeat(30)}` as OrgId;
  const wspId = `wsp_${n}${"0".repeat(30)}`;
  const projectId = `prj_${n}${"0".repeat(30)}` as PrjId;
  const raw = new DatabaseSync(store.path);
  raw.exec("PRAGMA busy_timeout=5000");
  raw
    .prepare("INSERT INTO orgs (org_id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(orgId, orgSlug, orgSlug, NOW_ISO);
  raw
    .prepare(
      "INSERT INTO workspaces (org_id, workspace_id, slug, name, created_at) VALUES (?, ?, 'default', 'default', ?)",
    )
    .run(orgId, wspId, NOW_ISO);
  raw
    .prepare(
      "INSERT INTO projects (org_id, workspace_id, project_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(orgId, wspId, projectId, projectSlug, projectSlug, NOW_ISO);
  raw.close();
  const scope = { orgId, projectId };
  const { key } = store.createKey(scope, {
    label: "k",
    agentName: "planner",
    scopes: ["ingest:otlp", "ingest:native", "ingest:replace"],
    createdBy: "test",
    createdAt: NOW_ISO,
  });
  return { orgId, projectId, keyId: key.keyId, scope };
}

/** The local tenant created by `ensureLocalTenancy`, with a key. */
export function localTenant(store: SqliteSwainStore): Tenant {
  const { org, project } = store.ensureLocalTenancy(NOW_ISO);
  const scope = { orgId: org.orgId, projectId: project.projectId };
  const { key } = store.createKey(scope, {
    label: "k",
    agentName: "planner",
    scopes: ["ingest:otlp", "ingest:native", "ingest:replace"],
    createdBy: "test",
    createdAt: NOW_ISO,
  });
  return { orgId: org.orgId, projectId: project.projectId, keyId: key.keyId, scope };
}

export function agentFor(projectId: PrjId, key: string): AgentIdentity {
  // A pinned-key agent (rule 1): what `deriveAgentIdentity` makes of an ingest key's agent name.
  return deriveAgentIdentity(projectId, { pinnedAgentName: key });
}

export function runFor(projectId: PrjId, traceId: string, _agent?: AgentIdentity): RunRef {
  return traceRun(projectId, traceId);
}

/** A deterministic 64-hex digest for test inputs. */
export function shaOf(s: string): string {
  return sha256Hex(new TextEncoder().encode(s));
}

export const TRACE = "0af7651916cd43dd8448eb211c80319c";
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_C = "c".repeat(64);

/** The project policy the test stores use by default (the DDL defaults). */
export const POLICY = { contentPolicy: "hash-only", maxInlineBytes: 65536 } as const;

export interface SpanOver {
  readonly traceId?: string;
  readonly spanId?: string;
  readonly name?: string;
  readonly startNs?: bigint;
  readonly endNs?: bigint;
  readonly recordSha256?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly traceState?: string;
  readonly policy?: ContentPolicyInput;
  readonly resourceSha256?: string;
  readonly scopeSha256?: string;
  readonly resourceSchemaUrl?: string;
  readonly scopeSchemaUrl?: string;
  /** Extra resource attributes (the agent identity of an unpinned key comes from `service.name`). */
  readonly resourceAttrs?: Readonly<Record<string, string>>;
  /** The agent of the put; defaults to the pinned `planner`. */
  readonly agent?: AgentIdentity;
}

const kvs = (o: Readonly<Record<string, string>>): InputKeyValue[] =>
  Object.entries(o).map(([key, value]) => ({ key, value: { kind: "string", value } }));

const RESOURCE_ATTRS = [{ key: "service.name", value: { kind: "string", value: "svc" } }] as const;

/** A decoded span run through the real `applyContentPolicy`, plus the derived run and agent. */
export function spanOf(t: Tenant, over: SpanOver = {}): SpanPut {
  const agent = over.agent ?? agentFor(t.projectId, "planner");
  const traceId = over.traceId ?? TRACE;
  const input: InputSpan = {
    traceId,
    spanId: over.spanId ?? "b7ad6b7169203331",
    parentSpanId: null,
    traceState: over.traceState ?? "",
    flags: 0,
    name: over.name ?? "invoke_agent",
    kind: 1,
    startTimeUnixNano: over.startNs ?? 1_700_000_000_000_000_001n,
    endTimeUnixNano: over.endNs ?? 1_700_000_000_500_000_003n,
    attributes: kvs(over.attrs ?? {}),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    status: { code: 0, message: "" },
    path: "/resourceSpans/0/scopeSpans/0/spans/0",
    recordSha256: over.recordSha256 ?? SHA_A,
  };
  const batch: PolicyInputTraces = {
    signal: "traces",
    resourceSpans: [
      {
        path: "/resourceSpans/0",
        resource: {
          attributes: over.resourceAttrs === undefined ? RESOURCE_ATTRS : kvs(over.resourceAttrs),
          droppedAttributesCount: 0,
        },
        resourceSha256: over.resourceSha256 ?? SHA_B,
        schemaUrl: over.resourceSchemaUrl ?? "",
        scopeSpans: [
          {
            path: "/resourceSpans/0/scopeSpans/0",
            scope: { name: "s", version: "", attributes: [], droppedAttributesCount: 0 },
            scopeSha256: over.scopeSha256 ?? SHA_C,
            schemaUrl: over.scopeSchemaUrl ?? "",
            spans: [input],
          },
        ],
      },
    ],
    rejected: [],
    warnings: [],
  };
  const span = applyContentPolicy(batch, over.policy ?? POLICY).spans[0];
  if (span === undefined) throw new Error("applier dropped the span");
  return {
    span,
    received: {
      resourceSchemaUrl: over.resourceSchemaUrl ?? "",
      scopeSchemaUrl: over.scopeSchemaUrl ?? "",
    },
    run: runFor(t.projectId, traceId, agent),
    agent,
    receivedMs: NOW,
    late: false,
  };
}

export function batchOf(_t: Tenant, id: string, over: Partial<BatchInput> = {}): BatchInput {
  return {
    batchId: id,
    signal: "traces",
    encoding: "json",
    contentEncoding: "identity",
    bodySha256: shaOf(`body:${id}`),
    bodyBytes: 10,
    decodedSha256: shaOf(`dec:${id}`),
    decodedBytes: 10,
    receivedMs: NOW,
    status: "accepted",
    accepted: 1,
    rejected: 0,
    resultJson: "{}",
    ...over,
  };
}
