/**
 * N1.5 Step A and B (SPEC-003 "Hard condition" 1 to 5, otlp README F4): the store recomputes agent
 * and run facts, takes display name and session facts from stamped model output, and decides
 * "identical" on the whole evidence tuple.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentIdentity,
  deriveAgentIdentity,
  identityOfAttribute,
  importRun,
  logsRun,
  type RunRef,
  sessionRun,
  traceRun,
} from "@swain/model";
import { DbError, type SqliteSwainStore } from "../src/index.js";
import {
  batchOf,
  importPut,
  localTenant,
  NOW_ISO,
  openStore,
  runFor,
  SHA_A,
  SHA_B,
  seedTenant,
  spanOf,
  tempDir,
} from "./helpers.js";
import { extraKey, logOf, rawDb, recorded } from "./helpers2.js";

const SECRET = `swn_${"a".repeat(16)}_${"b".repeat(64)}`;
const PII = "alice.smith@example.com";
const OTHER_TRACE = "11111111111111111111111111111111";

function withStore(fn: (store: SqliteSwainStore) => void): void {
  const t = tempDir();
  const store = openStore(t.dir);
  try {
    fn(store);
  } finally {
    store.close();
    t.done();
  }
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

function all(store: SqliteSwainStore, sql: string): Record<string, unknown>[] {
  const raw = rawDb(store);
  try {
    const st = raw.prepare(sql);
    st.setReadBigInts(true);
    return st.all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

const dump = (store: SqliteSwainStore): string =>
  JSON.stringify(
    ["agents", "runs", "spans", "log_records", "span_conflicts", "run_agents"].map((t) =>
      all(store, `SELECT * FROM ${t}`),
    ),
    (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
  );

// ---- Step A, item 5: planted values in each field ---------------------------------------------
test("A5: a swn_ secret or a PII sentinel in agentKey, agentId, displayName, sessionKey, adrSessionId or a logs runId is db-constraint", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "plant-t");
    const lb = recorded(store, t, t.keyId, "plant-l", { signal: "logs" });
    const span = spanOf(t);
    const log = logOf(t);
    const sessionLog = logOf(t, { traceId: null, attrs: { "session.id": "sess-1" } });
    assert.ok(span.agent && sessionLog.run);
    for (const planted of [SECRET, PII]) {
      const agentFields: readonly (keyof AgentIdentity)[] = ["key", "agentId", "displayName"];
      for (const f of agentFields) {
        const forged = { ...span.agent, [f]: planted };
        assert.equal(
          code(() => store.putOtelTraces(t.scope, t.keyId, b, [{ ...span, agent: forged }])),
          "db-constraint",
          `span agent.${f}`,
        );
        assert.equal(
          code(() =>
            store.putOtelLogs(t.scope, t.keyId, lb, [{ ...log, agent: forged as AgentIdentity }]),
          ),
          "db-constraint",
          `log agent.${f}`,
        );
      }
      const run: RunRef = sessionLog.run as RunRef;
      for (const f of ["sessionKey", "adrSessionId", "runId", "legacyImportId"] as const) {
        const forged: RunRef = { ...run, [f]: planted };
        assert.equal(
          code(() => store.putOtelLogs(t.scope, t.keyId, lb, [{ ...sessionLog, run: forged }])),
          "db-constraint",
          `logs run.${f}`,
        );
        assert.equal(
          code(() => store.putOtelTraces(t.scope, t.keyId, b, [{ ...span, run: forged }])),
          "db-constraint",
          `span run.${f}`,
        );
      }
    }
    assert.equal(dump(store).includes(SECRET), false);
    assert.equal(dump(store).includes(PII), false);
    assert.equal(all(store, "SELECT 1 FROM spans").length, 0);
    assert.equal(all(store, "SELECT 1 FROM log_records").length, 0);
  });
});

test("A5: frozen stamped outputs cannot be edited, and a literal or a prototype-derived copy is refused", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "stamp-t");
    const real = spanOf(t);
    assert.throws(() => {
      (real.agent as { key: string }).key = SECRET;
    }, TypeError);
    assert.throws(() => {
      (real.run as { runId: string }).runId = "run_x";
    }, TypeError);
    const literal = {
      agentId: real.agent.agentId,
      projectId: real.agent.projectId,
      keyBasis: real.agent.keyBasis,
      components: [...real.agent.components],
      displayName: real.agent.displayName,
      key: real.agent.key,
      senderClaim: null,
    };
    const viaProto = Object.create(real.agent) as AgentIdentity;
    for (const agent of [
      literal as AgentIdentity,
      viaProto,
      JSON.parse(JSON.stringify(real.agent)),
    ]) {
      assert.equal(
        code(() => store.putOtelTraces(t.scope, t.keyId, b, [{ ...real, agent }])),
        "db-constraint",
      );
    }
    const runLiteral = { ...real.run };
    assert.equal(
      code(() => store.putOtelTraces(t.scope, t.keyId, b, [{ ...real, run: runLiteral }])),
      "db-constraint",
    );
    assert.equal(store.putOtelTraces(t.scope, t.keyId, b, [real]).inserted, 1);
  });
});

// ---- Step A, items 1 to 4: recomputation from the key and the record ---------------------------
test("A1/A2: agent facts come from the stamped identity; a pinned key must carry its own cred identity", () => {
  withStore((store) => {
    const t = localTenant(store); // key pinned to "planner"
    const b = recorded(store, t, t.keyId, "agent-1");
    const real = spanOf(t);
    const row = (): Record<string, unknown> => all(store, "SELECT * FROM agents")[0] ?? {};
    assert.equal(store.putOtelTraces(t.scope, t.keyId, b, [real]).inserted, 1);
    assert.equal(row()["agent_key"], "cred:planner");
    assert.equal(row()["key_basis"], "cred");
    assert.equal(row()["display_name"], "planner");
    assert.equal(row()["agent_id"], real.agent.agentId);

    const b2 = recorded(store, t, t.keyId, "agent-2");
    const refused = (o: Parameters<typeof spanOf>[1]): string =>
      code(() => store.putOtelTraces(t.scope, t.keyId, b2, [spanOf(t, o)]));
    // another cred name, the attribute basis, the resource basis and "none" under a pinned key
    assert.equal(
      refused({ agent: deriveAgentIdentity(t.projectId, { pinnedAgentName: "other" }) }),
      "db-constraint",
    );
    assert.equal(
      refused({
        spanId: "2222222222222222",
        agent: deriveAgentIdentity(t.projectId, {}),
      }),
      "db-constraint",
    );
    assert.equal(
      refused({
        spanId: "3333333333333333",
        agent: deriveAgentIdentity(t.projectId, { adr0002: { provider: "claude-code" } }),
      }),
      "db-constraint",
    );
    // an identity of another project
    const prj2 = seedTenant(store, "other-org");
    assert.equal(
      refused({
        spanId: "4444444444444444",
        agent: deriveAgentIdentity(prj2.projectId, { pinnedAgentName: "planner" }),
      }),
      "db-constraint",
    );
    assert.equal(all(store, "SELECT 1 FROM agents").length, 1);
  });
});

test("A1: an unpinned key cannot carry a cred identity; attribute identities are recomputed from the record", () => {
  withStore((store) => {
    const t = localTenant(store);
    const { key } = store.createKey(t.scope, {
      label: "free",
      scopes: ["ingest:otlp"],
      createdBy: "test",
      createdAt: NOW_ISO,
    });
    const kid = key.keyId;
    const b = recorded(store, t, kid, "free-1");
    const cred = deriveAgentIdentity(t.projectId, { pinnedAgentName: "planner" });
    assert.equal(
      code(() => store.putOtelTraces(t.scope, kid, b, [spanOf(t, { agent: cred })])),
      "db-constraint",
    );
    // the identity the span itself evidences is accepted
    const own = spanOf(t, { resourceAttrs: { "service.name": "svc" } });
    const ident = deriveAgentIdentity(t.projectId, {
      resourceAttributes: own.span.resource.attributes,
    });
    assert.equal(ident.keyBasis, "resource");
    assert.equal(store.putOtelTraces(t.scope, kid, b, [{ ...own, agent: ident }]).inserted, 1);
    const a = all(store, "SELECT * FROM agents")[0] ?? {};
    assert.equal(a["agent_key"], "resource:/svc");
    assert.equal(a["display_name"], "svc");
    // an identity evidenced by another span is not this span's
    const other = deriveAgentIdentity(t.projectId, {
      resourceAttributes: spanOf(t, { resourceAttrs: { "service.name": "different" } }).span
        .resource.attributes,
    });
    assert.equal(
      code(() =>
        store.putOtelTraces(t.scope, kid, b, [
          {
            ...spanOf(t, { spanId: "5555555555555555", resourceAttrs: { "service.name": "svc" } }),
            agent: other,
          },
        ]),
      ),
      "db-constraint",
    );
    // adr0002 identities are only for projected logs
    const adr = deriveAgentIdentity(t.projectId, { adr0002: { provider: "claude-code" } });
    assert.equal(
      code(() =>
        store.putOtelTraces(t.scope, kid, b, [
          { ...spanOf(t, { spanId: "6666666666666666" }), agent: adr },
        ]),
      ),
      "db-constraint",
    );
  });
});

test("A2: a secret-shaped or PII pinned name reaches the database only as a hash key and a redacted display name", () => {
  withStore((store) => {
    const t = localTenant(store);
    for (const [i, name] of [SECRET, PII].entries()) {
      const { key } = store.createKey(t.scope, {
        label: `pin-${i}`,
        agentName: name,
        scopes: ["ingest:otlp"],
        createdBy: "test",
        createdAt: NOW_ISO,
      });
      const b = recorded(store, t, key.keyId, `pin-${i}`);
      const agent = deriveAgentIdentity(t.projectId, { pinnedAgentName: name });
      assert.match(agent.key, /^cred:h:[0-9a-f]{64}$/);
      const put = spanOf(t, { agent, spanId: `${i + 1}`.repeat(16) });
      assert.equal(store.putOtelTraces(t.scope, key.keyId, b, [put]).inserted, 1);
    }
    const rows = all(store, "SELECT agent_key, display_name FROM agents ORDER BY agent_key");
    const text = JSON.stringify(rows);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes("swn_"), false);
    assert.ok(rows.every((r) => /^cred:(planner|h:[0-9a-f]{64})$/.test(String(r["agent_key"]))));
  });
});

test("A3/A4: a logs run is recomputed from the record; sessionKey and adrSessionId have fixed derived formats", () => {
  withStore((store) => {
    const t = localTenant(store);
    const lb = recorded(store, t, t.keyId, "logs-1", { signal: "logs" });
    const good = logOf(t, { traceId: null, attrs: { "session.id": "sess-1" } });
    const agent = good.agent;
    assert.ok(agent && good.run);
    assert.equal(good.run.kind, "trace", "logOf default derives a trace run; build the logs run");
    const sessionId = identityOfAttribute(good.log.attributes, "session.id");
    assert.ok(sessionId);
    const logsRef = logsRun(t.projectId, agent.agentId, sessionId, good.log.timeUnixNano);
    const refused = (o: Partial<typeof good>): string =>
      code(() => store.putOtelLogs(t.scope, t.keyId, lb, [{ ...good, ...o }]));
    // the trace run for a log without a trace ID
    assert.equal(refused({ run: traceRun(t.projectId, OTHER_TRACE) }), "db-constraint");
    // a logs run grouped by a session value the record does not carry
    const wrongSession = logOf(t, { traceId: null, attrs: { "session.id": "sess-2" } });
    const wrongId = identityOfAttribute(wrongSession.log.attributes, "session.id");
    assert.ok(wrongId);
    assert.equal(
      refused({ run: logsRun(t.projectId, agent.agentId, wrongId, good.log.timeUnixNano) }),
      "db-constraint",
    );
    // the ungrouped run for a log that has a session value
    assert.equal(
      refused({ run: logsRun(t.projectId, agent.agentId, null, good.log.timeUnixNano) }),
      "db-constraint",
    );
    // a logs run of another agent
    const other = deriveAgentIdentity(t.projectId, {
      pinnedAgentName: "planner",
      pinnedSubagentType: "x",
    });
    assert.equal(
      refused({ run: logsRun(t.projectId, other.agentId, sessionId, good.log.timeUnixNano) }),
      "db-constraint",
    );
    // a session run is for projected logs only
    assert.equal(
      refused({ run: sessionRun(t.projectId, `ses_${"1".repeat(32)}`) }),
      "db-constraint",
    );
    // run without agent, agent without run
    assert.equal(refused({ agent: null }), "db-constraint");
    assert.equal(refused({ run: null }), "db-constraint");
    assert.equal(all(store, "SELECT 1 FROM log_records").length, 0);
    // the genuine run goes through; its facts are the model's
    assert.equal(store.putOtelLogs(t.scope, t.keyId, lb, [{ ...good, run: logsRef }]).inserted, 1);
    const run = all(store, "SELECT * FROM runs")[0] ?? {};
    assert.equal(run["kind"], "logs");
    assert.equal(run["run_id"], logsRef.runId);
    assert.equal(run["session_key"], logsRef.sessionKey);
    assert.match(String(run["session_key"]), /^sess_[0-9a-f]{32}$/);
    assert.equal(run["adr_session_id"], null);
    // the ungrouped (per-day) run
    const plain = logOf(t, { traceId: null, body: "no session", recordSha256: "9".repeat(64) });
    const day = logsRun(t.projectId, agent.agentId, null, plain.log.timeUnixNano);
    assert.equal(store.putOtelLogs(t.scope, t.keyId, lb, [{ ...plain, run: day }]).inserted, 1);
    assert.equal(all(store, "SELECT * FROM runs WHERE kind = 'logs'").length, 2);
  });
});

test("A3: a projected log may use a session run with a fixed-format ADR-0002 session ID", () => {
  withStore((store) => {
    const t = localTenant(store);
    const lb = recorded(store, t, t.keyId, "proj-1", { signal: "logs" });
    const base = logOf(t, { traceId: null });
    const ses = `ses_${"3".repeat(32)}`;
    const put = {
      ...base,
      run: sessionRun(t.projectId, ses),
      projectedImportId: `imp_${"4".repeat(32)}`,
    };
    assert.equal(store.putOtelLogs(t.scope, t.keyId, lb, [put]).inserted, 1);
    const run = all(store, "SELECT * FROM runs")[0] ?? {};
    assert.equal(run["adr_session_id"], ses);
    assert.equal(run["kind"], "session");
    assert.equal(
      code(() => store.putOtelLogs(t.scope, t.keyId, lb, [{ ...put, projectedImportId: null }])),
      "db-constraint",
    );
  });
});

// ---- Step B: dedup keyed on the whole evidence tuple ------------------------------------------
test("B: a same-record resend under another resource, scope or schema URL is a conflict row, not 'seen again'", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b1 = recorded(store, t, t.keyId, "dd-1");
    const b2 = recorded(store, t, t.keyId, "dd-2");
    const b3 = recorded(store, t, k2, "dd-3");
    const first = store.putOtelTraces(t.scope, t.keyId, b1, [spanOf(t)]);
    assert.equal(first.inserted, 1);
    // identical tuple, same key
    const again = store.putOtelTraces(t.scope, t.keyId, b2, [spanOf(t)]);
    assert.deepEqual(
      [again.seenAgain, again.conflicts, again.identicalOtherKey, again.inserted],
      [1, 0, 0, 0],
    );
    // same record hash, three different groups: three separate pieces of evidence, none dropped
    const variants = [
      { resourceSha256: "d".repeat(64) },
      { scopeSha256: "e".repeat(64) },
      { resourceSchemaUrl: "https://example.test/schema/1" },
      { scopeSchemaUrl: "https://example.test/schema/2" },
    ] as const;
    for (const v of variants) {
      const r = store.putOtelTraces(t.scope, t.keyId, b2, [spanOf(t, v)]);
      assert.deepEqual(
        [r.seenAgain, r.conflicts, r.inserted],
        [0, 1, 0],
        `variant ${JSON.stringify(v)}`,
      );
    }
    // another key, identical tuple: identical-other-key; another key, other resource: conflicting
    const o1 = store.putOtelTraces(t.scope, k2, b3, [spanOf(t)]);
    assert.deepEqual([o1.identicalOtherKey, o1.conflicts], [1, 0]);
    const o2 = store.putOtelTraces(t.scope, k2, b3, [
      spanOf(t, { resourceSha256: "f".repeat(64) }),
    ]);
    assert.deepEqual([o2.identicalOtherKey, o2.conflicts], [0, 1]);
    const rows = all(
      store,
      "SELECT relation, key_id, record_sha256 FROM span_conflicts ORDER BY relation, key_id, record_sha256",
    );
    const rel = (r: string): number => rows.filter((x) => x["relation"] === r).length;
    assert.equal(rel("identical-same-key"), 1);
    assert.equal(rel("identical-other-key"), 1);
    assert.equal(rel("conflicting"), 5);
    // record_sha256 is the bare record hash; evidence_sha256 is the digest and is never the bare hash
    const ev = all(store, "SELECT record_sha256, evidence_sha256, key_id FROM span_conflicts");
    assert.ok(ev.every((r) => r["record_sha256"] === SHA_A));
    assert.ok(ev.every((r) => r["evidence_sha256"] !== SHA_A));
    const own = ev.filter((x) => x["key_id"] === t.keyId).map((x) => x["evidence_sha256"]);
    assert.equal(new Set(own).size, own.length);
    const sp = all(store, "SELECT record_sha256, evidence_sha256 FROM spans");
    assert.equal(sp[0]?.["record_sha256"], SHA_A);
    assert.notEqual(sp[0]?.["evidence_sha256"], SHA_A);
    // the evidence index exists
    const idx = all(
      store,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%evidence%'",
    );
    assert.equal(idx.length, 3);
    // a conflicting record from a different key makes the span non-canonical (read side)
    const data = store.runSpans(t.scope, spanOf(t).run.runId, 10);
    assert.equal(data.spans[0]?.canonical, false);
  });
});

test("F2/F10: precheckSpans and precheckLogs report each refused record by index and write nothing", () => {
  withStore((store) => {
    const t = localTenant(store);
    const good = spanOf(t);
    const forged = { ...spanOf(t, { resourceSha256: "d".repeat(64) }), agent: { ...good.agent } };
    const unrelated = { ...spanOf(t), run: runFor(t.projectId, "a".repeat(32), good.agent) };
    const r = store.precheckSpans(t.scope, t.keyId, [good, forged, unrelated]);
    assert.deepEqual(
      r.map((x) => [x.index, x.code]),
      [
        [1, "constraint"],
        [2, "constraint"],
      ],
    );
    assert.deepEqual(store.precheckSpans(t.scope, t.keyId, [good]), []);
    assert.equal(all(store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], 0n);
    const lg = logOf(t);
    const bad = { ...logOf(t), agent: { ...(lg.agent as object) } as never };
    assert.deepEqual(
      store.precheckLogs(t.scope, t.keyId, [lg, bad]).map((x) => [x.index, x.code]),
      [[1, "constraint"]],
    );
    // a revoked key is a whole-call refusal, not a per-record one
    store.revokeKey(t.scope, t.keyId, 1);
    assert.equal(
      code(() => store.precheckSpans(t.scope, t.keyId, [good])),
      "db-constraint",
    );
  });
});

test("F5: the evidence digest covers the RECEIVED schema URLs, not the masked ones", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b1 = recorded(store, t, t.keyId, "rc-1");
    const b2 = recorded(store, t, t.keyId, "rc-2");
    // both URLs mask to the same post-policy text (userinfo is redacted), but they differ as received
    const one = spanOf(t, { resourceSchemaUrl: "https://alice:pw1@schemas.example/v1" });
    const two = spanOf(t, { resourceSchemaUrl: "https://bob:pw2@schemas.example/v1" });
    assert.equal(
      JSON.stringify(one.span.resourceSchemaUrl),
      JSON.stringify(two.span.resourceSchemaUrl),
      "the post-policy forms are equal",
    );
    assert.equal(store.putOtelTraces(t.scope, t.keyId, b1, [one]).inserted, 1);
    const r = store.putOtelTraces(t.scope, t.keyId, b2, [two]);
    assert.deepEqual([r.seenAgain, r.conflicts, r.inserted], [0, 1, 0]);
  });
});

test("B: the digests are domain-separated: span, log, and sighting digests never coincide", async () => {
  const { spanEvidenceSha256, logEvidenceSha256, logSightingSha256 } = await import(
    "../src/sqlite/evidence.js"
  );
  const parts = {
    recordSha256: SHA_A,
    resourceSha256: SHA_B,
    scopeSha256: "c".repeat(64),
    resourceSchemaUrl: "{}",
    scopeSchemaUrl: "{}",
  };
  const s = spanEvidenceSha256(parts);
  const l = logEvidenceSha256(parts, 0);
  const d = logSightingSha256(parts, 0, "key_0000000000000000");
  assert.equal(new Set([s, l, d, SHA_A, SHA_B]).size, 5);
  // field boundaries are length-prefixed: moving a character between fields changes the digest
  assert.notEqual(
    spanEvidenceSha256({ ...parts, resourceSchemaUrl: "ab", scopeSchemaUrl: "c" }),
    spanEvidenceSha256({ ...parts, resourceSchemaUrl: "a", scopeSchemaUrl: "bc" }),
  );
  assert.notEqual(logEvidenceSha256(parts, 1), logEvidenceSha256(parts, 11));
});

test("B: logs: the same record under another resource or scope is its own row; an identical resend is a duplicate", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b1 = recorded(store, t, t.keyId, "lg-1", { signal: "logs" });
    const b2 = recorded(store, t, t.keyId, "lg-2", { signal: "logs" });
    const b3 = recorded(store, t, k2, "lg-3", { signal: "logs" });
    assert.equal(store.putOtelLogs(t.scope, t.keyId, b1, [logOf(t)]).inserted, 1);
    const dup = store.putOtelLogs(t.scope, t.keyId, b2, [logOf(t)]);
    assert.deepEqual([dup.inserted, dup.duplicates], [0, 1]);
    const r = store.putOtelLogs(t.scope, t.keyId, b2, [
      logOf(t, { resourceSha256: "d".repeat(64) }),
    ]);
    assert.deepEqual([r.inserted, r.duplicates], [1, 0]);
    const s = store.putOtelLogs(t.scope, t.keyId, b2, [logOf(t, { scopeSha256: "e".repeat(64) })]);
    assert.deepEqual([s.inserted, s.duplicates], [1, 0]);
    const o = store.putOtelLogs(t.scope, k2, b3, [logOf(t)]);
    assert.deepEqual([o.inserted, o.identicalOtherKey], [0, 1]);
    assert.equal(all(store, "SELECT 1 FROM log_records").length, 4);
  });
});

test("A1/A2: an import's agent and run come from the model: adr0002 basis, exact key, derived display name", () => {
  withStore((store) => {
    const t = localTenant(store);
    const put = importPut("claude-code", { derivation: "migrated" });
    const res = store.putMigratedImport(t.scope, put, "add");
    assert.equal(res.status, "added");
    const a = all(store, "SELECT * FROM agents")[0] ?? {};
    const id = deriveAgentIdentity(t.projectId, { adr0002: { provider: put.record.provider } });
    assert.equal(a["agent_id"], id.agentId);
    assert.equal(a["key_basis"], "adr0002");
    assert.equal(a["agent_key"], id.key);
    assert.match(String(a["agent_key"]), /^adr0002:[A-Za-z0-9._-]+$/);
    assert.equal(a["display_name"], put.record.provider);
    const run = all(store, "SELECT * FROM runs")[0] ?? {};
    assert.equal(run["run_id"], importRun(t.projectId, put.record.importId).runId);
    assert.equal(run["primary_agent_id"], id.agentId);
  });
});

test("N1.5: ingestTraces/ingestLogs commit the batch row and its records together; findBatch dedups before decoding", () => {
  withStore((store) => {
    const t = localTenant(store);
    const sha = "7".repeat(64);
    const input = (id: string, signal: "traces" | "logs" = "traces") => ({
      ...batchOf(t, id, { signal, decodedSha256: sha }),
    });
    assert.equal(store.findBatch(t.scope, t.keyId, "traces", sha), null);
    // a forged span rolls the whole thing back: no batch row is left to turn a retry into a no-op
    const real = spanOf(t);
    const forged = { ...real, agent: { ...real.agent } };
    assert.equal(
      code(() => store.ingestTraces(t.scope, t.keyId, input("atom-1"), [forged])),
      "db-constraint",
    );
    assert.equal(store.findBatch(t.scope, t.keyId, "traces", sha), null);
    assert.equal(all(store, "SELECT 1 FROM ingest_batches").length, 0);
    // the genuine batch commits both
    const ok = store.ingestTraces(t.scope, t.keyId, input("atom-2"), [real]);
    assert.equal(ok.batch.outcome, "created");
    assert.equal(ok.stats?.inserted, 1);
    assert.equal(store.findBatch(t.scope, t.keyId, "traces", sha)?.batchId, "atom-2");
    // a resend of the same decoded bytes is a duplicate and writes nothing
    const again = store.ingestTraces(t.scope, t.keyId, input("atom-3"), [real]);
    assert.equal(again.batch.outcome, "duplicate");
    assert.equal(again.stats, null);
    assert.equal(all(store, "SELECT 1 FROM span_conflicts").length, 0);
    // another key does not see the first key's batch (dedup is per key)
    const k2 = extraKey(store, t);
    assert.equal(store.findBatch(t.scope, k2, "traces", sha), null);
    // logs
    const lg = logOf(t);
    const bad = { ...lg, agent: { ...(lg.agent as object) } } as typeof lg;
    assert.equal(
      code(() => store.ingestLogs(t.scope, t.keyId, input("atom-4", "logs"), [bad])),
      "db-constraint",
    );
    assert.equal(store.findBatch(t.scope, t.keyId, "logs", sha), null);
    const l = store.ingestLogs(t.scope, t.keyId, input("atom-5", "logs"), [lg]);
    assert.equal(l.stats?.inserted, 1);
    assert.equal(store.getProject(t.scope)?.projectId, t.projectId);
  });
});
