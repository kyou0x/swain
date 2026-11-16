/**
 * Tenant isolation through every store method (ADR-0007 r2 section 3, N1.1 integration test).
 *
 * Three tenants share colliding identifiers on purpose:
 *  - A: the local org, project PA
 *  - A2: a second project in the same org
 *  - B: a second org whose project has the SAME project ID as PA (the PK is (org_id, project_id)),
 *    so run, agent, span, log, batch and import IDs all collide between A and B.
 * Each tenant carries a unique marker and a distinct number of records, so a leaked row shows up as
 * a wrong count or a foreign marker.
 *
 * The test enumerates `SqliteSwainStore.prototype`: a public method that is not classified below
 * fails the test, so a new method cannot ship without an isolation probe or a written exemption.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSwainId } from "@swain/model";
import {
  type AgtId,
  DbError,
  type OrgId,
  type PrjId,
  type RunId,
  SqliteSwainStore,
} from "../src/index.js";
import {
  fixture,
  importPut,
  localTenant,
  NOW,
  NOW_ISO,
  openStore,
  spanOf,
  type Tenant,
  TRACE,
  tempDir,
} from "./helpers.js";
import { logOf, rawDb, recorded } from "./helpers2.js";

interface Who {
  readonly name: "A" | "A2" | "B";
  readonly t: Tenant;
  readonly marker: string;
  readonly extraSpans: number;
  readonly versions: number;
  readonly extraBatches: number;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DbError, String(e));
    return e.code;
  }
  return "no-error";
}

function dump(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
}

const ORG_B = `org_${"b".repeat(32)}` as OrgId;

interface World {
  readonly store: SqliteSwainStore;
  readonly a: Who;
  readonly a2: Who;
  readonly b: Who;
  readonly all: readonly Who[];
  readonly done: () => void;
}

function spanIdOf(i: number): string {
  return String(i + 1).padStart(16, "a");
}

function build(): World {
  const dir = tempDir();
  const store = openStore(dir.dir);
  const ta = localTenant(store);
  const { workspace } = store.ensureLocalTenancy(NOW_ISO);
  const p2 = store.createProject(
    { orgId: ta.orgId },
    { workspaceId: workspace.workspaceId, slug: "two", name: "A2", createdAt: NOW_ISO },
  );
  const scope2 = { orgId: ta.orgId, projectId: p2.projectId };
  const key2 = store.createKey(scope2, {
    label: "k",
    agentName: "planner",
    scopes: ["ingest:otlp", "ingest:native", "ingest:replace"],
    createdBy: "test",
    createdAt: NOW_ISO,
  }).key.keyId;
  // org B: its project carries the same project ID as A's
  const raw = rawDb(store);
  raw
    .prepare("INSERT INTO orgs (org_id, slug, name, created_at) VALUES (?, 'b', 'b', ?)")
    .run(ORG_B, NOW_ISO);
  raw
    .prepare(
      "INSERT INTO workspaces (org_id, workspace_id, slug, name, created_at) VALUES (?, ?, 'default', 'default', ?)",
    )
    .run(ORG_B, workspace.workspaceId, NOW_ISO);
  raw
    .prepare(
      "INSERT INTO projects (org_id, workspace_id, project_id, slug, name, created_at) VALUES (?, ?, ?, 'default', 'B', ?)",
    )
    .run(ORG_B, workspace.workspaceId, ta.projectId, NOW_ISO);
  raw.close();
  const scopeB = { orgId: ORG_B, projectId: ta.projectId };
  const keyB = store.createKey(scopeB, {
    label: "k",
    agentName: "planner",
    scopes: ["ingest:otlp", "ingest:native", "ingest:replace"],
    createdBy: "test",
    createdAt: NOW_ISO,
  }).key.keyId;

  const a: Who = {
    name: "A",
    t: ta,
    marker: "MARK-A-1111",
    extraSpans: 0,
    versions: 1,
    extraBatches: 0,
  };
  const a2: Who = {
    name: "A2",
    t: { orgId: ta.orgId, projectId: p2.projectId, keyId: key2, scope: scope2 },
    marker: "MARK-A2-2222",
    extraSpans: 1,
    versions: 2,
    extraBatches: 1,
  };
  const b: Who = {
    name: "B",
    t: { orgId: ORG_B, projectId: ta.projectId, keyId: keyB, scope: scopeB },
    marker: "MARK-B-3333",
    extraSpans: 2,
    versions: 3,
    extraBatches: 2,
  };
  for (const w of [a, a2, b]) seed(store, w);
  return {
    store,
    a,
    a2,
    b,
    all: [a, a2, b],
    done: () => {
      store.close();
      dir.done();
    },
  };
}

function seed(store: SqliteSwainStore, w: Who): void {
  const { t } = w;
  // identical batch IDs, hashes and idempotency keys in every tenant
  const out = store.recordBatch(t.scope, t.keyId, {
    batchId: "shared",
    signal: "traces",
    encoding: "json",
    contentEncoding: "identity",
    bodySha256: "1".repeat(64),
    bodyBytes: 1,
    decodedSha256: "2".repeat(64),
    decodedBytes: 1,
    receivedMs: NOW,
    status: "accepted",
    accepted: 1,
    rejected: 0,
    resultJson: `{"marker":"${w.marker}"}`,
    idempotency: { route: "/r", key: "same" },
  });
  assert.equal(out.outcome, "created", w.name);
  recorded(store, t, t.keyId, "shared-logs", {
    signal: "logs",
    decodedSha256: "3".repeat(64),
    bodySha256: "4".repeat(64),
  });
  for (let i = 0; i < w.extraBatches; i++) {
    recorded(store, t, t.keyId, `extra-${i}`, {
      decodedSha256: String(i + 5).repeat(64),
      bodySha256: String(i + 5).repeat(64),
    });
  }
  const spans = [
    spanOf(t, { name: w.marker, attrs: { m: w.marker } }),
    ...Array.from({ length: w.extraSpans }, (_, i) =>
      spanOf(t, {
        spanId: spanIdOf(i),
        recordSha256: String(i + 6).repeat(64),
        name: w.marker,
      }),
    ),
  ];
  store.putOtelTraces(t.scope, t.keyId, "shared", spans);
  store.putOtelLogs(t.scope, t.keyId, "shared-logs", [logOf(t, { body: w.marker })]);
  const first = store.putImport(t.scope, t.keyId, importPut("claude-code"), "add");
  assert.equal(first.status, "added");
  for (let v = 1; v < w.versions; v++) {
    store.putImport(
      t.scope,
      t.keyId,
      importPut("claude-code", { receivedMs: NOW + v }),
      "supersede",
    );
  }
  store.appendAudit(t.orgId, {
    at: NOW_ISO,
    actorType: "owner",
    actorId: "local",
    action: "key.create",
    targetType: "key",
    targetId: t.keyId,
    detail: { marker: w.marker },
  });
}

/** The import's run ID is derived from the session ID and the project ID. */
const importRunOf = (w: Who): RunId =>
  deriveSwainId("run", [
    "session",
    w.t.projectId,
    fixture("claude-code").record.sessionId,
  ]) as RunId;
const traceRunOf = (w: Who): RunId => spanOf(w.t).run.runId;

function others(w: Who, all: readonly Who[]): string[] {
  return all.filter((x) => x.marker !== w.marker).map((x) => x.marker);
}

function assertClean(label: string, value: unknown, w: Who, all: readonly Who[]): void {
  const text = dump(value);
  for (const m of others(w, all))
    assert.equal(text.includes(m), false, `${label}: ${w.name} saw ${m}`);
}

// ---- the probes --------------------------------------------------------------------------------
type Probe = (world: World) => void;

const READ_PROBES: Record<string, Probe> = {
  fleet: (world) => {
    for (const w of world.all) {
      const page = world.store.fleet(w.t.scope, { sort: "recent", limit: 50, offset: 0 });
      assert.equal(page.total, 2, w.name);
      assert.equal(page.rows.length, 2, w.name);
      for (const r of page.rows) assert.equal(r.projectId, w.t.projectId);
      assertClean("fleet", page, w, world.all);
    }
  },
  agent: (world) => {
    const agentId = world.store.fleet(world.a.t.scope, { sort: "name", limit: 10, offset: 0 })
      .rows[0]?.agentId as AgtId;
    for (const w of [world.a, world.b]) {
      // colliding agent ID: each org sees only its own run counts
      const d = world.store.agent(w.t.scope, agentId);
      assert.ok(d !== null, w.name);
      assert.equal(d.runCount, 1, w.name);
      assertClean("agent", d, w, world.all);
    }
    // A2's agents do not exist in A
    const a2Agent = world.store.fleet(world.a2.t.scope, { sort: "name", limit: 10, offset: 0 })
      .rows[0]?.agentId as AgtId;
    assert.equal(world.store.agent(world.a.t.scope, a2Agent), null);
  },
  runs: (world) => {
    for (const w of world.all) {
      const page = world.store.runs(w.t.scope, { limit: 50, offset: 0 });
      assert.equal(page.total, 2, w.name);
      assert.deepEqual(
        page.rows.map((r) => r.projectId),
        [w.t.projectId, w.t.projectId],
        w.name,
      );
      assertClean("runs", page, w, world.all);
    }
  },
  run: (world) => {
    for (const w of world.all) {
      const d = world.store.run(w.t.scope, importRunOf(w));
      assert.ok(d !== null, w.name);
      assert.deepEqual(
        d.imports.map((i) => i.version),
        [w.versions],
        `${w.name}: current version only`,
      );
      assert.deepEqual(d.run.credentials, [{ keyId: w.t.keyId, records: 1 }], w.name);
      assertClean("run", d, w, world.all);
      const t = world.store.run(w.t.scope, traceRunOf(w));
      assert.equal(t?.run.counts["spans"], 1 + w.extraSpans, w.name);
      assert.equal(t?.run.counts["logs"], 1, w.name);
      assert.deepEqual(
        t?.run.credentials,
        [{ keyId: w.t.keyId, records: 2 + w.extraSpans }],
        w.name,
      );
    }
    // another project's run is not visible, and a colliding ID gives each org its own run
    assert.equal(world.store.run(world.a.t.scope, importRunOf(world.a2)), null);
    assert.equal(world.store.run(world.a2.t.scope, importRunOf(world.a)), null);
    assert.equal(world.store.run(world.b.t.scope, importRunOf(world.a))?.imports[0]?.version, 3);
    assert.equal(world.store.run(world.a.t.scope, importRunOf(world.a))?.imports[0]?.version, 1);
  },
  runEvents: (world) => {
    for (const w of world.all) {
      const views = world.store.runEvents(w.t.scope, importRunOf(w)).sessions;
      assert.equal(views.length, 1, w.name);
      assertClean("runEvents", views, w, world.all);
    }
    assert.deepEqual(world.store.runEvents(world.a.t.scope, importRunOf(world.a2)).sessions, []);
  },
  runSpans: (world) => {
    for (const w of world.all) {
      const data = world.store.runSpans(w.t.scope, traceRunOf(w), 100);
      assert.equal(data.spans.length, 1 + w.extraSpans, w.name);
      for (const s of data.spans) {
        assert.equal(s.keyId, w.t.keyId, w.name);
        assert.ok(dump(s).includes(w.marker), w.name);
      }
      assertClean("runSpans", data, w, world.all);
    }
    // A2's trace run ID differs from A's (the project is in the ID): A2's run is empty for A
    assert.notEqual(traceRunOf(world.a2), traceRunOf(world.a));
    assert.equal(world.store.runSpans(world.a.t.scope, traceRunOf(world.a2), 10).spans.length, 0);
  },
  resolveId: (world) => {
    const orgA = { orgId: world.a.t.orgId };
    const orgB = { orgId: world.b.t.orgId };
    const both = world.store.resolveId(
      orgA,
      [world.a.t.projectId, world.a2.t.projectId],
      "b7ad6b7169203331",
    );
    assert.deepEqual(
      both.map((r) => r.projectId).sort(),
      [world.a.t.projectId, world.a2.t.projectId].sort(),
    );
    assert.deepEqual(
      world.store
        .resolveId(orgA, [world.a2.t.projectId], "b7ad6b7169203331")
        .map((r) => r.projectId),
      [world.a2.t.projectId],
    );
    const forB = world.store.resolveId(
      orgB,
      [world.b.t.projectId],
      traceRunOf(world.b).slice(0, 14),
    );
    assert.deepEqual(
      forB.map((r) => [r.projectId, r.id]),
      [[world.b.t.projectId, traceRunOf(world.b)]],
    );
    assert.equal(dump(forB).includes("MARK"), false);
    // the project list is the caller's allow-list: a project of another org is an error, not a miss
    assert.equal(
      code(() => world.store.resolveId(orgB, [world.a2.t.projectId], TRACE)),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.resolveId(orgA, [`prj_${"5".repeat(32)}` as PrjId], TRACE)),
      "db-scope-violation",
    );
    // a project not in the allow-list is never searched
    assert.deepEqual(
      world.store.resolveId(orgA, [world.a.t.projectId], TRACE).map((r) => r.projectId),
      [world.a.t.projectId],
    );
  },
  status: (world) => {
    for (const w of world.all) {
      const s = world.store.status({ orgId: w.t.orgId }, [w.t.projectId]);
      assert.equal(s.projects.length, 1, w.name);
      assert.equal(s.projects[0]?.projectId, w.t.projectId);
      assert.equal(s.projects[0]?.batches24h.accepted, 2 + w.extraBatches, w.name);
      assert.equal(s.projects[0]?.runs, 2, w.name);
    }
    const both = world.store.status({ orgId: world.a.t.orgId }, [
      world.a.t.projectId,
      world.a2.t.projectId,
    ]);
    assert.equal(both.projects.length, 2);
    assert.equal(
      code(() => world.store.status({ orgId: world.b.t.orgId }, [world.a2.t.projectId])),
      "db-scope-violation",
    );
  },
  listProjects: (world) => {
    assert.deepEqual(
      world.store
        .listProjects({ orgId: world.a.t.orgId })
        .projects.map((p) => p.name)
        .sort(),
      ["A2", "default"],
    );
    const b = world.store.listProjects({ orgId: world.b.t.orgId });
    assert.deepEqual(
      b.projects.map((p) => [p.orgId, p.projectId, p.name]),
      [[ORG_B, world.b.t.projectId, "B"]],
    );
  },
  listKeys: (world) => {
    for (const w of world.all) {
      const keys = world.store.listKeys(w.t.scope).keys;
      assert.deepEqual(
        keys.map((k) => k.keyId),
        [w.t.keyId],
        w.name,
      );
      assert.equal(keys[0]?.orgId, w.t.orgId);
    }
  },
  getProject: (world) => {
    for (const w of world.all) {
      const p = world.store.getProject(w.t.scope);
      assert.equal(p?.projectId, w.t.projectId, w.name);
      assert.equal(p?.orgId, w.t.orgId, w.name);
      assertClean("getProject", p, w, world.all);
    }
    // the same project ID in another org is another project; an unknown ID is null
    assert.equal(world.store.getProject(world.b.t.scope)?.name, "B");
    assert.equal(world.store.getProject(world.a.t.scope)?.name, "default");
    assert.equal(
      world.store.getProject({ orgId: world.a.t.orgId, projectId: `prj_${"9".repeat(32)}` }),
      null,
    );
  },
  findBatch: (world) => {
    // every tenant has its own "shared" batch with the same decoded hash (seed())
    for (const w of world.all) {
      const hit = world.store.findBatch(w.t.scope, w.t.keyId, "traces", "2".repeat(64));
      assert.equal(hit?.batchId, "shared", w.name);
      assert.ok((hit?.resultJson ?? "").includes(w.marker), w.name);
      assertClean("findBatch", hit, w, world.all);
      // another key of the same project does not see it (dedup is per key)
      assert.equal(world.store.findBatch(w.t.scope, w.t.keyId, "logs", "2".repeat(64)), null);
    }
    assert.equal(
      world.store.findBatch(world.a.t.scope, world.a2.t.keyId, "traces", "2".repeat(64)),
      null,
    );
    assert.equal(
      world.store.findBatch(world.a.t.scope, world.b.t.keyId, "traces", "2".repeat(64)),
      null,
    );
  },
  verifyAudit: (world) => {
    assert.deepEqual(
      world.store.verifyAudit(world.a.t.orgId),
      { ok: true, entries: 2 },
      "A and A2 share the org log",
    );
    assert.deepEqual(world.store.verifyAudit(world.b.t.orgId), { ok: true, entries: 1 });
  },
};

/** Writes: the scope and the key must agree, and a write never reaches another tenant's rows. */
const WRITE_PROBES: Record<string, Probe> = {
  recordBatch: (world) => {
    // a key of org B (same project ID as A) cannot write into A's scope, and vice versa
    const b = world.b.t;
    const a = world.a.t;
    assert.equal(
      code(() => world.store.recordBatch(a.scope, b.keyId, batchFor("x1"))),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.recordBatch(b.scope, a.keyId, batchFor("x2"))),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.recordBatch(a.scope, world.a2.t.keyId, batchFor("x3"))),
      "db-scope-violation",
    );
  },
  putOtelTraces: (world) => {
    assert.equal(
      code(() => world.store.putOtelTraces(world.a.t.scope, world.b.t.keyId, "shared", [])),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.putOtelTraces(world.a.t.scope, world.a2.t.keyId, "shared", [])),
      "db-scope-violation",
    );
  },
  putOtelLogs: (world) => {
    assert.equal(
      code(() => world.store.putOtelLogs(world.b.t.scope, world.a.t.keyId, "shared-logs", [])),
      "db-scope-violation",
    );
  },
  precheckSpans: (world) => {
    const a = world.a.t;
    const b = world.b.t;
    assert.equal(
      code(() => world.store.precheckSpans(a.scope, b.keyId, [])),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.precheckSpans(b.scope, a.keyId, [])),
      "db-scope-violation",
    );
  },
  precheckLogs: (world) => {
    const a = world.a.t;
    const b = world.b.t;
    assert.equal(
      code(() => world.store.precheckLogs(a.scope, b.keyId, [])),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.precheckLogs(b.scope, a.keyId, [])),
      "db-scope-violation",
    );
  },
  ingestTraces: (world) => {
    const a = world.a.t;
    const b = world.b.t;
    const batch = batchFor("ing-1");
    assert.equal(
      code(() => world.store.ingestTraces(a.scope, b.keyId, batch, [])),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.ingestTraces(b.scope, a.keyId, batch, [])),
      "db-scope-violation",
    );
    assert.equal(world.store.findBatch(a.scope, a.keyId, "traces", "f".repeat(64)), null);
    assert.equal(world.store.findBatch(b.scope, b.keyId, "traces", "f".repeat(64)), null);
  },
  ingestLogs: (world) => {
    const a = world.a.t;
    const b = world.b.t;
    const batch = { ...batchFor("ing-2"), signal: "logs" as const };
    assert.equal(
      code(() => world.store.ingestLogs(a.scope, world.a2.t.keyId, batch, [])),
      "db-scope-violation",
    );
    assert.equal(
      code(() => world.store.ingestLogs(b.scope, a.keyId, batch, [])),
      "db-scope-violation",
    );
    assert.equal(world.store.findBatch(a.scope, a.keyId, "logs", "f".repeat(64)), null);
  },
  putImport: (world) => {
    // G3 C4: a cited batch must exist in this project and belong to the citing key
    const batchId = "shared-logs"; // recorded by every tenant's own key in seed()
    assert.equal(
      code(() =>
        world.store.putImport(
          world.a.t.scope,
          world.a2.t.keyId,
          importPut("codex-cli", { batchId }),
          "add",
        ),
      ),
      "db-scope-violation",
      "another key's batch",
    );
    assert.equal(
      code(() =>
        world.store.putImport(
          world.a.t.scope,
          world.a.t.keyId,
          importPut("codex-cli", { batchId: "extra-1" }), // exists only in org B
          "add",
        ),
      ),
      "db-constraint",
      "a batch of another org does not exist here",
    );
    assert.equal(
      code(() =>
        world.store.putImport(
          world.a.t.scope,
          world.a.t.keyId,
          importPut("codex-cli", { batchId: "no-such-batch" }),
          "add",
        ),
      ),
      "db-constraint",
    );
    assert.equal(
      code(() =>
        world.store.putImport(world.a.t.scope, world.b.t.keyId, importPut("codex-cli"), "add"),
      ),
      "db-scope-violation",
    );
    assert.equal(
      code(() =>
        world.store.putImport(world.a.t.scope, world.a2.t.keyId, importPut("codex-cli"), "add"),
      ),
      "db-scope-violation",
    );
  },
  putMigratedImport: (world) => {
    // local-cli never cites a batch, and a migrated import lands only in the scope it is given
    assert.equal(
      code(() =>
        world.store.putMigratedImport(
          world.a.t.scope,
          importPut("codex-cli", { derivation: "migrated", batchId: "some-batch" }),
          "add",
        ),
      ),
      "db-constraint",
    );
  },
  createKey: (world) => {
    // a key is created in exactly the scope it is asked for
    const k = world.store.createKey(world.a2.t.scope, {
      label: "n",
      scopes: ["ingest:otlp"],
      createdBy: "t",
      createdAt: NOW_ISO,
    });
    assert.equal(k.key.projectId, world.a2.t.projectId);
    assert.equal(k.key.orgId, world.a2.t.orgId);
    assert.equal(world.store.listKeys(world.a.t.scope).keys.length, 1);
    assert.equal(world.store.listKeys(world.b.t.scope).keys.length, 1);
    assert.equal(
      code(() =>
        world.store.createKey(
          { orgId: ORG_B, projectId: world.a2.t.projectId },
          { label: "n", scopes: ["ingest:otlp"], createdBy: "t", createdAt: NOW_ISO },
        ),
      ),
      "db-scope-violation",
    );
  },
  revokeKey: (world) => {
    // same project ID, other org: no effect
    assert.equal(world.store.revokeKey(world.a.t.scope, world.b.t.keyId, NOW), false);
    assert.equal(world.store.revokeKey(world.b.t.scope, world.a.t.keyId, NOW), false);
    assert.equal(world.store.revokeKey(world.a.t.scope, world.a2.t.keyId, NOW), false);
    for (const w of world.all)
      assert.equal(world.store.findKey(w.t.keyId)?.revokedAtMs, null, w.name);
  },
  setProjectPolicy: (world) => {
    const actor = { type: "owner", id: "t", at: NOW_ISO };
    world.store.setProjectPolicy(world.a.t.scope, { contentPolicy: "inline" }, actor);
    const raw = rawDb(world.store);
    const rows = raw
      .prepare("SELECT org_id, content_policy FROM projects WHERE project_id = ? ORDER BY org_id")
      .all(world.a.t.projectId) as { org_id: string; content_policy: string }[];
    raw.close();
    assert.deepEqual(
      rows.map((r) => [r.org_id === ORG_B, r.content_policy]),
      [
        [false, "inline"],
        [true, "hash-only"],
      ],
    );
    // A's audit log grew, B's did not
    assert.deepEqual(world.store.verifyAudit(world.a.t.orgId), { ok: true, entries: 3 });
    assert.deepEqual(world.store.verifyAudit(world.b.t.orgId), { ok: true, entries: 1 });
    assert.equal(
      code(() =>
        world.store.setProjectPolicy({ orgId: ORG_B, projectId: world.a2.t.projectId }, {}, actor),
      ),
      "db-scope-violation",
    );
  },
  createProject: (world) => {
    const p = world.store.createProject(
      { orgId: ORG_B },
      {
        workspaceId: world.store.listProjects({ orgId: ORG_B }).projects[0]?.workspaceId as never,
        slug: "three",
        name: "B3",
        createdAt: NOW_ISO,
      },
    );
    assert.equal(p.orgId, ORG_B);
    assert.equal(world.store.listProjects({ orgId: world.a.t.orgId }).projects.length, 2);
  },
  appendAudit: (world) => {
    world.store.appendAudit(world.b.t.orgId, {
      at: NOW_ISO,
      actorType: "owner",
      actorId: "t",
      action: "key.revoke",
      targetType: "key",
      targetId: "k",
      detail: {},
    });
    assert.equal(world.store.verifyAudit(world.b.t.orgId).ok, true);
  },
};

function batchFor(id: string) {
  return {
    batchId: id,
    signal: "traces" as const,
    encoding: "json" as const,
    contentEncoding: "identity" as const,
    bodySha256: "e".repeat(64),
    bodyBytes: 1,
    decodedSha256: "f".repeat(64),
    decodedBytes: 1,
    receivedMs: NOW,
    status: "accepted" as const,
    accepted: 0,
    rejected: 0,
    resultJson: "{}",
  };
}

/** Credential lookups are unscoped by design (pinned in the registry): they return only the owner. */
const CREDENTIAL_PROBES: Record<string, Probe> = {
  findKey: (world) => {
    for (const w of world.all) {
      const k = world.store.findKey(w.t.keyId);
      assert.equal(k?.orgId, w.t.orgId, w.name);
      assert.equal(k?.projectId, w.t.projectId, w.name);
    }
  },
  serverProof: (world) => {
    const args = ["http://127.0.0.1:1", "ab".repeat(16), "cd".repeat(32)] as const;
    const proofs = world.all.map((w) => world.store.serverProof(w.t.keyId, ...args));
    assert.equal(new Set(proofs).size, 3, "each key has its own proof key");
    assert.equal(
      proofs.every((p) => p !== null),
      true,
    );
  },
  putLoginCode: (world) => {
    world.store.putLoginCode({
      codeSha256: "a1".repeat(32),
      orgId: world.a.t.orgId,
      nextPath: "/",
      expiresAtMs: NOW + 10,
    });
    world.store.putLoginCode({
      codeSha256: "b1".repeat(32),
      orgId: world.b.t.orgId,
      nextPath: "/runs",
      expiresAtMs: NOW + 10,
    });
  },
  consumeLoginCode: (world) => {
    assert.deepEqual(world.store.consumeLoginCode("b1".repeat(32), NOW), {
      orgId: world.b.t.orgId,
      nextPath: "/runs",
    });
    assert.deepEqual(world.store.consumeLoginCode("a1".repeat(32), NOW), {
      orgId: world.a.t.orgId,
      nextPath: "/",
    });
  },
  putSession: (world) => {
    world.store.putSession(world.a.t.orgId, {
      tokenSha256: "a2".repeat(32),
      principal: "pa",
      createdMs: NOW,
    });
    world.store.putSession(world.b.t.orgId, {
      tokenSha256: "b2".repeat(32),
      principal: "pb",
      createdMs: NOW,
    });
  },
  findSession: (world) => {
    assert.equal(world.store.findSession("a2".repeat(32), NOW + 1)?.orgId, world.a.t.orgId);
    assert.equal(world.store.findSession("b2".repeat(32), NOW + 1)?.orgId, world.b.t.orgId);
  },
  revokeSession: (world) => {
    world.store.revokeSession("a2".repeat(32), NOW + 2);
    assert.equal(world.store.findSession("a2".repeat(32), NOW + 3), null);
    assert.equal(
      world.store.findSession("b2".repeat(32), NOW + 3)?.orgId,
      world.b.t.orgId,
      "another org's session is untouched",
    );
  },
};

// ownerProofKey/ownerProof read and create only the server-wide `client_proof` secret (no tenant
// row); they are covered by owner-proof.test.ts.
const LIFECYCLE = [
  "migrate",
  "close",
  "ensureLocalTenancy",
  "findLocalOrg",
  "ownerProofKey",
  "ownerProof",
] as const;

function publicMethods(): string[] {
  const proto = SqliteSwainStore.prototype as object;
  return Object.getOwnPropertyNames(proto)
    .filter((n) => n !== "constructor")
    .filter((n) => typeof Object.getOwnPropertyDescriptor(proto, n)?.value === "function")
    .sort();
}

test("every public store method has an isolation probe or a written exemption", () => {
  const classified = [
    ...Object.keys(READ_PROBES),
    ...Object.keys(WRITE_PROBES),
    ...Object.keys(CREDENTIAL_PROBES),
    ...LIFECYCLE,
  ].sort();
  assert.equal(new Set(classified).size, classified.length, "a method is classified twice");
  assert.deepEqual(publicMethods(), classified, "an unclassified or stale store method");
});

test("isolation: reads see only their own tenant, through every read method", () => {
  const world = build();
  try {
    for (const [name, probe] of Object.entries(READ_PROBES)) {
      try {
        probe(world);
      } catch (e) {
        throw new Error(
          `read probe ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    }
  } finally {
    world.done();
  }
});

test("isolation: writes, keys and credential lookups never cross tenants", () => {
  const world = build();
  try {
    const rowsBefore = counts(world.store);
    for (const probes of [WRITE_PROBES, CREDENTIAL_PROBES]) {
      for (const [name, probe] of Object.entries(probes)) {
        try {
          probe(world);
        } catch (e) {
          throw new Error(`probe ${name} failed: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          });
        }
      }
    }
    // the refused writes left no rows behind: evidence counts per (org, project) are unchanged
    const after = counts(world.store);
    assert.deepEqual(after, rowsBefore);
    // and the seeded totals are exactly what each tenant wrote (A and B collide on every ID)
    assert.deepEqual(after["spans"], { A: 1, A2: 2, B: 3 });
    assert.deepEqual(after["imports"], { A: 1, A2: 2, B: 3 });
    assert.deepEqual(after["log_records"], { A: 1, A2: 1, B: 1 });
  } finally {
    world.done();
  }
});

function counts(store: SqliteSwainStore): Record<string, Record<string, number>> {
  const raw = rawDb(store);
  const out: Record<string, Record<string, number>> = {};
  try {
    const a2 = (
      raw.prepare("SELECT project_id FROM projects WHERE name = 'A2'").get() as {
        project_id: string;
      }
    ).project_id;
    for (const table of [
      "spans",
      "log_records",
      "imports",
      "ingest_batches",
      "span_conflicts",
      "events",
    ]) {
      const rows = raw
        .prepare(
          `SELECT org_id, project_id, COUNT(*) AS n FROM ${table} GROUP BY org_id, project_id`,
        )
        .all() as { org_id: string; project_id: string; n: number }[];
      const m: Record<string, number> = {};
      for (const r of rows) {
        const who = r.org_id === ORG_B ? "B" : r.project_id === a2 ? "A2" : "A";
        m[who] = (m[who] ?? 0) + Number(r.n);
      }
      out[table] = m;
    }
  } finally {
    raw.close();
  }
  return out;
}

test("isolation: colliding IDs across orgs keep distinct rows (counts per org by raw SQL)", () => {
  const world = build();
  try {
    const raw = rawDb(world.store);
    const rows = raw
      .prepare(
        "SELECT org_id, COUNT(*) AS n FROM spans WHERE trace_id = ? AND span_id = ? GROUP BY org_id ORDER BY org_id",
      )
      .all(TRACE, "b7ad6b7169203331") as { org_id: string; n: number }[];
    raw.close();
    // A and A2 share the org; B is the other
    assert.deepEqual(
      rows.map((r) => [r.org_id === ORG_B, Number(r.n)]),
      [
        [false, 2],
        [true, 1],
      ],
    );
  } finally {
    world.done();
  }
});
