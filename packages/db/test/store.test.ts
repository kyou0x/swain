import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalJson, sha256Hex, validateEvents } from "@swain/core";
import {
  type AgtId,
  DbError,
  hashKeySecret,
  type KeyId,
  type OrgId,
  type PrjId,
  type RunId,
  SESSION_LIFETIMES,
  SqliteSwainStore,
} from "../src/index.js";
import { assertRowScope } from "../src/sqlite/store.js";
import {
  counterRandom,
  fixture,
  importPut,
  localTenant,
  NOW,
  NOW_ISO,
  openStore,
  shaOf,
  spanOf,
  TRACE,
  tempDir,
  uid,
} from "./helpers.js";
import { extraKey, logOf, rawDb, recorded } from "./helpers2.js";

const DAY = 86_400_000;
const FIXTURES = ["claude-code", "codex-cli", "gemini-cli", "opencode"] as const;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DbError, String(e));
    return e.code;
  }
  return "no-error";
}

/** Run `fn` with a fresh migrated store in a temp dir. */
function withStore(fn: (store: SqliteSwainStore, dir: string) => void): void {
  const t = tempDir();
  const store = openStore(t.dir);
  try {
    fn(store, t.dir);
  } finally {
    store.close();
    t.done();
  }
}

function scalar(store: SqliteSwainStore, sql: string, ...params: (string | number)[]): number {
  const raw = rawDb(store);
  try {
    const row = raw.prepare(sql).get(...params) as { n: number } | undefined;
    return row === undefined ? 0 : Number(row.n);
  } finally {
    raw.close();
  }
}

function exec(store: SqliteSwainStore, sql: string, ...params: (string | number)[]): void {
  const raw = rawDb(store);
  try {
    raw.prepare(sql).run(...params);
  } finally {
    raw.close();
  }
}

// ---- tenancy and policy -------------------------------------------------------------------------
test("tenancy: local bootstrap is idempotent; projects list; policy change is audited", () => {
  withStore((store) => {
    const a = store.ensureLocalTenancy(NOW_ISO);
    const b = store.ensureLocalTenancy(NOW_ISO);
    assert.deepEqual(a, b);
    assert.equal(a.project.contentPolicy, "hash-only");
    const second = store.createProject(
      { orgId: a.org.orgId },
      { workspaceId: a.workspace.workspaceId, slug: "two", name: "Two", createdAt: NOW_ISO },
    );
    assert.deepEqual(
      store.listProjects({ orgId: a.org.orgId }).projects.map((p) => p.slug),
      ["default", "two"],
    );
    const changed = store.setProjectPolicy(
      { orgId: a.org.orgId, projectId: second.projectId },
      { contentPolicy: "inline", maxInlineBytes: 1024 },
      { type: "owner", id: "local", at: NOW_ISO },
    );
    assert.equal(changed.contentPolicy, "inline");
    assert.equal(changed.maxInlineBytes, 1024);
    assert.equal(changed.rawRetention, "hash-only");
    assert.deepEqual(store.verifyAudit(a.org.orgId), { ok: true, entries: 1 });
    assert.equal(
      scalar(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.policy.change'"),
      1,
    );
    // invalid patches and foreign projects are refused and write nothing
    const scope = { orgId: a.org.orgId, projectId: second.projectId };
    const actor = { type: "owner", id: "local", at: NOW_ISO };
    assert.equal(
      code(() => store.setProjectPolicy(scope, { maxInlineBytes: -1 }, actor)),
      "db-constraint",
    );
    assert.equal(
      code(() =>
        store.setProjectPolicy({ ...scope, projectId: `prj_${"9".repeat(32)}` }, {}, actor),
      ),
      "db-scope-violation",
    );
    assert.equal(store.verifyAudit(a.org.orgId).ok, true);
  });
});

test("scopes are validated at the boundary: a missing projectId is refused", () => {
  withStore((store) => {
    const t = localTenant(store);
    const bare = { orgId: t.orgId } as unknown as { orgId: OrgId; projectId: PrjId };
    assert.equal(
      code(() => store.fleet(bare, { sort: "recent", limit: 10, offset: 0 })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.runs(bare, { limit: 10, offset: 0 })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.listKeys(bare)),
      "db-constraint",
    );
  });
});

// ---- keys ---------------------------------------------------------------------------------------
test("keys: only the hash is stored (DB and WAL bytes hold no secret); proof key is exact", () => {
  withStore((store) => {
    const a = store.ensureLocalTenancy(NOW_ISO);
    const scope = { orgId: a.org.orgId, projectId: a.project.projectId };
    const made = store.createKey(scope, {
      label: "ci",
      scopes: ["ingest:otlp", "ingest:replace"],
      createdBy: "owner",
      createdAt: NOW_ISO,
    });
    assert.match(made.secret, /^swn_[0-9a-f]{16}_[0-9a-f]{64}$/);
    assert.match(made.serverProofKey, /^[0-9a-f]{64}$/);
    assert.equal(made.key.keyId, `key_${made.secret.slice(4, 20)}`);
    const found = store.findKey(made.key.keyId);
    assert.equal(found?.secretSha256, hashKeySecret(made.secret));
    assert.equal(found?.projectId, scope.projectId);
    assert.deepEqual(
      Object.keys(store.listKeys(scope).keys[0] ?? {}).includes("secretSha256"),
      false,
    );
    const secretPart = made.secret.slice(21);
    for (const file of [store.path, `${store.path}-wal`]) {
      let bytes: Buffer | null = null;
      try {
        bytes = readFileSync(file);
      } catch {
        // no WAL file is fine
      }
      if (bytes !== null) {
        assert.equal(bytes.includes(Buffer.from(secretPart)), false, `${file} holds the secret`);
        assert.equal(bytes.includes(Buffer.from(made.secret)), false);
      }
    }
    // proof key = HMAC(client_proof, lp("swain:v1:proof-key") || lp(keyId)), computed independently
    const lp = (s: string): Buffer =>
      Buffer.concat([Buffer.from(`${Buffer.byteLength(s)}:`), Buffer.from(s)]);
    const raw = rawDb(store);
    const row = raw
      .prepare("SELECT value FROM server_secrets WHERE name = 'client_proof'")
      .get() as {
      value: Uint8Array;
    };
    raw.close();
    assert.equal(row.value.length, 32);
    const proofKey = createHmac("sha256", row.value)
      .update(Buffer.concat([lp("swain:v1:proof-key"), lp(made.key.keyId)]))
      .digest();
    assert.equal(made.serverProofKey, proofKey.toString("hex"));
    const challenge = "ab".repeat(32);
    const instance = "cd".repeat(16);
    const expected = createHmac("sha256", proofKey)
      .update(
        Buffer.concat([
          lp("swain:v1:server-proof"),
          lp("http://127.0.0.1:4318"),
          lp(instance),
          lp(challenge),
        ]),
      )
      .digest("hex");
    assert.equal(
      store.serverProof(made.key.keyId, "http://127.0.0.1:4318", instance, challenge),
      expected,
    );
    // the origin is covered by the proof
    assert.notEqual(
      store.serverProof(made.key.keyId, "http://[::1]:4318", instance, challenge),
      expected,
    );
    // a second key shares the secret but gets its own proof key
    const second = store.createKey(scope, {
      label: "x",
      scopes: ["ingest:otlp"],
      createdBy: "o",
      createdAt: NOW_ISO,
    });
    assert.notEqual(second.serverProofKey, made.serverProofKey);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM server_secrets"), 1);
    // unknown, malformed and revoked keys: no proof
    assert.equal(store.serverProof(`key_${"0".repeat(16)}`, "http://x", instance, challenge), null);
    assert.equal(store.serverProof("nope", "http://x", instance, challenge), null);
    assert.equal(store.serverProof(made.key.keyId, "http://x", "short", challenge), null);
    assert.equal(store.revokeKey(scope, made.key.keyId, NOW), true);
    assert.equal(store.revokeKey(scope, made.key.keyId, NOW), false);
    assert.equal(store.serverProof(made.key.keyId, "http://x", instance, challenge), null);
    assert.equal(store.findKey(made.key.keyId)?.revokedAtMs, NOW);
  });
});

test("keys: unknown scopes, duplicates and empty scope lists are refused", () => {
  withStore((store) => {
    const t = localTenant(store);
    const mk = (scopes: string[]): string =>
      code(() =>
        store.createKey(t.scope, {
          label: "k",
          scopes: scopes as never,
          createdBy: "o",
          createdAt: NOW_ISO,
        }),
      );
    assert.equal(mk([]), "db-constraint");
    assert.equal(mk(["admin"]), "db-constraint");
    assert.equal(mk(["ingest:otlp", "ingest:otlp"]), "db-constraint");
    assert.equal(mk(["ingest:otlp", "ingest:replace", "read:status"]), "no-error");
  });
});

test("a key of another project cannot be used for ingest (db-scope-violation)", () => {
  withStore((store) => {
    const t = localTenant(store);
    const other = store.createProject(
      { orgId: t.orgId },
      {
        workspaceId: store.ensureLocalTenancy(NOW_ISO).workspace.workspaceId,
        slug: "other",
        name: "o",
        createdAt: NOW_ISO,
      },
    );
    const foreignKey = store.createKey(
      { orgId: t.orgId, projectId: other.projectId },
      { label: "f", scopes: ["ingest:otlp"], createdBy: "o", createdAt: NOW_ISO },
    ).key.keyId;
    assert.equal(
      code(() => store.recordBatch(t.scope, foreignKey, { ...batch("b1") })),
      "db-scope-violation",
    );
    assert.equal(
      code(() => store.putOtelTraces(t.scope, foreignKey, "b1", [])),
      "db-scope-violation",
    );
  });
});

function batch(id: string, over: Record<string, unknown> = {}) {
  return {
    batchId: id,
    signal: "traces" as const,
    encoding: "json" as const,
    contentEncoding: "identity" as const,
    bodySha256: shaOf(`body:${id}`),
    bodyBytes: 10,
    decodedSha256: shaOf(`dec:${id}`),
    decodedBytes: 10,
    receivedMs: NOW,
    status: "accepted" as const,
    accepted: 1,
    rejected: 0,
    resultJson: "{}",
    ...over,
  };
}

// ---- batches and idempotency --------------------------------------------------------------------
test("batches: ON CONFLICT dedups per (key, signal, decoded sha); another key gets its own batch", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const first = store.recordBatch(t.scope, t.keyId, batch("b1"));
    assert.equal(first.outcome, "created");
    const again = store.recordBatch(
      t.scope,
      t.keyId,
      batch("b2", { decodedSha256: shaOf("dec:b1") }),
    );
    assert.equal(again.outcome, "duplicate");
    assert.equal(again.outcome === "duplicate" && again.batch.batchId, "b1");
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM ingest_batches"), 1);
    // the same decoded body from another credential is a new batch (F6)
    const other = store.recordBatch(t.scope, k2, batch("b3", { decodedSha256: shaOf("dec:b1") }));
    assert.equal(other.outcome, "created");
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM ingest_batches"), 2);
    // another signal with the same hash is a different batch too
    assert.equal(
      store.recordBatch(
        t.scope,
        t.keyId,
        batch("b4", { signal: "logs", decodedSha256: shaOf("dec:b1") }),
      ).outcome,
      "created",
    );
    assert.equal(
      code(() => store.recordBatch(t.scope, t.keyId, batch("b5", { signal: "nope" }))),
      "db-constraint",
    );
    assert.equal(
      code(() => store.recordBatch(t.scope, t.keyId, batch("b5", { resultJson: "[]" }))),
      "db-constraint",
    );
  });
});

test("idempotency: replay returns the stored batch; another body conflicts; keys are per credential; 24 h window", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const idem = { route: "/api/v1/ingest/events", key: "abc-1" };
    const created = store.recordBatch(t.scope, t.keyId, batch("i1", { idempotency: idem }));
    assert.equal(created.outcome, "created");
    // replay with the same body: no new row, stored batch returned
    const replay = store.recordBatch(
      t.scope,
      t.keyId,
      batch("i2", {
        idempotency: idem,
        bodySha256: shaOf("body:i1"),
        decodedSha256: "9".repeat(64),
      }),
    );
    assert.equal(replay.outcome, "duplicate");
    assert.equal(replay.outcome === "duplicate" && replay.batch.batchId, "i1");
    // same key, another body: conflict, nothing written
    const conflict = store.recordBatch(
      t.scope,
      t.keyId,
      batch("i3", { idempotency: idem, bodySha256: "8".repeat(64), decodedSha256: "8".repeat(64) }),
    );
    assert.equal(conflict.outcome, "idempotency-conflict");
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM ingest_batches"), 1);
    // another credential may reuse the same Idempotency-Key value
    assert.equal(
      store.recordBatch(
        t.scope,
        k2,
        batch("i4", {
          idempotency: idem,
          bodySha256: "7".repeat(64),
          decodedSha256: "7".repeat(64),
        }),
      ).outcome,
      "created",
    );
    // after 24 h the entry no longer matches (evidence is not deleted; it just stops applying)
    const late = store.recordBatch(
      t.scope,
      t.keyId,
      batch("i5", {
        idempotency: idem,
        receivedMs: NOW + DAY + 1,
        bodySha256: "6".repeat(64),
        decodedSha256: "6".repeat(64),
      }),
    );
    assert.equal(late.outcome, "created");
    // G3 F8: the old row stays (append-only) and a new window row is appended, so the key protects again
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM idempotency_keys"), 3);
    const again = store.recordBatch(
      t.scope,
      t.keyId,
      batch("i5b", {
        idempotency: idem,
        receivedMs: NOW + DAY + 2,
        bodySha256: "6".repeat(64),
        decodedSha256: "5".repeat(64),
      }),
    );
    assert.equal(again.outcome === "duplicate" && again.batch.batchId, "i5");
    assert.equal(
      store.recordBatch(
        t.scope,
        t.keyId,
        batch("i5c", {
          idempotency: idem,
          receivedMs: NOW + DAY + 3,
          bodySha256: "4".repeat(64),
          decodedSha256: "4".repeat(64),
        }),
      ).outcome,
      "idempotency-conflict",
    );
    // route is part of the key
    assert.equal(
      store.recordBatch(
        t.scope,
        t.keyId,
        batch("i6", {
          idempotency: { route: "/other", key: "abc-1" },
          bodySha256: "5".repeat(64),
          decodedSha256: "5".repeat(64),
        }),
      ).outcome,
      "created",
    );
  });
});

// ---- spans --------------------------------------------------------------------------------------
test("spans: ON CONFLICT dedup; same key, other key and conflicting sightings are rows with a relation", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const k3 = extraKey(store, t, "k3");
    const b1 = recorded(store, t, t.keyId, "s1");
    const b2 = recorded(store, t, k2, "s2");
    const b3 = recorded(store, t, k3, "s3");
    const sp = spanOf(t);
    assert.deepEqual(store.putOtelTraces(t.scope, t.keyId, b1, [sp]), {
      inserted: 1,
      seenAgain: 0,
      identicalOtherKey: 0,
      conflicts: 0,
      rejected: 0,
      rejections: [],
    });
    // same key sends it again: a re-sighting row; and again: still one row (PK dedup)
    assert.equal(
      store.putOtelTraces(t.scope, t.keyId, recorded(store, t, t.keyId, "s1b"), [sp]).seenAgain,
      1,
    );
    assert.equal(
      store.putOtelTraces(t.scope, t.keyId, recorded(store, t, t.keyId, "s1c"), [sp]).seenAgain,
      0,
    );
    // another key sends the identical record
    const other = store.putOtelTraces(t.scope, k2, b2, [sp]);
    assert.equal(other.identicalOtherKey, 1);
    assert.equal(other.inserted, 0);
    // a third key sends a different record under the same IDs
    const diff = spanOf(t, { recordSha256: "d".repeat(64), name: "other" });
    assert.equal(store.putOtelTraces(t.scope, k3, b3, [diff]).conflicts, 1);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM spans"), 1);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM span_conflicts"), 3);
    const run = spanOf(t).run.runId;
    const data = store.runSpans(t.scope, run, 100);
    assert.equal(data.spans.length, 1);
    const stored = data.spans[0];
    assert.equal(stored?.keyId, t.keyId);
    assert.equal(
      stored?.canonical,
      false,
      "a conflicting record from another key makes the span non-canonical",
    );
    assert.deepEqual(data.conflicts.map((c) => [c.relation, c.keyId, c.canonicalKeyId]).sort(), [
      ["conflicting", k3, t.keyId],
      ["identical-other-key", k2, t.keyId],
      ["identical-same-key", t.keyId, t.keyId],
    ]);
    assert.deepEqual(store.run(t.scope, run)?.run.counts["conflicts"], 1);
    assert.deepEqual(store.run(t.scope, run)?.run.credentials, [{ keyId: t.keyId, records: 1 }]);
  });
});

test("spans: a conflicting record from the same key does not make the span non-canonical", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b1 = recorded(store, t, t.keyId, "c1");
    const b2 = recorded(store, t, t.keyId, "c2");
    store.putOtelTraces(t.scope, t.keyId, b1, [spanOf(t)]);
    const out = store.putOtelTraces(t.scope, t.keyId, b2, [
      spanOf(t, { recordSha256: "e".repeat(64) }),
    ]);
    assert.equal(out.conflicts, 1);
    const data = store.runSpans(t.scope, spanOf(t).run.runId, 10);
    assert.equal(data.spans[0]?.canonical, true);
  });
});

test("spans: int64 nanoseconds round trip as BigInt (2^53+1 and the int64 maximum); unset is null", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "n1");
    const big = (1n << 53n) + 1n;
    const max = 9_223_372_036_854_775_807n;
    store.putOtelTraces(t.scope, t.keyId, b, [
      spanOf(t, { startNs: big, endNs: max }),
      // OTLP zero means unset: stored as NULL
      spanOf(t, {
        spanId: "1111111111111111",
        startNs: 0n,
        endNs: 0n,
        recordSha256: "f".repeat(64),
      }),
    ]);
    const spans = store.runSpans(t.scope, spanOf(t).run.runId, 10).spans;
    const bySpan = new Map(spans.map((s) => [s.spanId, s]));
    assert.equal(bySpan.get("b7ad6b7169203331")?.startNs, big);
    assert.equal(bySpan.get("b7ad6b7169203331")?.endNs, max);
    assert.equal(bySpan.get("1111111111111111")?.startNs, null);
    assert.equal(bySpan.get("1111111111111111")?.endNs, null);
    const run = store.run(t.scope, spanOf(t).run.runId)?.run;
    assert.equal(run?.firstTimeNs, big);
    assert.equal(run?.lastTimeNs, max);
    assert.equal(typeof run?.lastTimeNs, "bigint");
  });
});

test("spans: a value outside int64 rejects that record only (F13); the batch goes on", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "r1");
    const out = store.putOtelTraces(t.scope, t.keyId, b, [
      spanOf(t, { spanId: "2222222222222222", recordSha256: "1".repeat(64) }),
      spanOf(t, {
        spanId: "3333333333333333",
        startNs: 9_223_372_036_854_775_808n,
        recordSha256: "2".repeat(64),
      }),
      spanOf(t, {
        spanId: "4444444444444444",
        endNs: 18_446_744_073_709_551_615n,
        recordSha256: "3".repeat(64),
      }),
      spanOf(t, { spanId: "5555555555555555", recordSha256: "4".repeat(64) }),
    ]);
    assert.equal(out.inserted, 2);
    assert.equal(out.rejected, 2);
    assert.deepEqual(out.rejections, [
      { index: 1, code: "ns-out-of-range" },
      { index: 2, code: "ns-out-of-range" },
    ]);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM spans"), 2);
  });
});

test("spans: a batch recorded by another key, or missing, refuses the write", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b = recorded(store, t, t.keyId, "x1");
    assert.equal(
      code(() => store.putOtelTraces(t.scope, k2, b, [spanOf(t)])),
      "db-scope-violation",
    );
    assert.equal(
      code(() => store.putOtelTraces(t.scope, t.keyId, "missing", [spanOf(t)])),
      "db-constraint",
    );
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM spans"), 0);
  });
});

test("spans: invalid input is refused whole and writes nothing (one transaction)", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "v1");
    const badSpan = spanOf(t, { spanId: "not-a-span-id" });
    assert.equal(
      code(() => store.putOtelTraces(t.scope, t.keyId, b, [spanOf(t), badSpan])),
      "db-constraint",
    );
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM spans"), 0);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM resources"), 0);
  });
});

// ---- logs ---------------------------------------------------------------------------------------
test("logs: dedup per record; another key's identical record gets its own row pointing at the first", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b1 = recorded(store, t, t.keyId, "l1", { signal: "logs" });
    const b2 = recorded(store, t, t.keyId, "l2", { signal: "logs" });
    const b3 = recorded(store, t, k2, "l3", { signal: "logs" });
    const l = logOf(t);
    const first = store.putOtelLogs(t.scope, t.keyId, b1, [l, logOf(t, { occurrence: 1 })]);
    assert.equal(first.inserted, 2);
    const again = store.putOtelLogs(t.scope, t.keyId, b2, [l]);
    assert.deepEqual([again.inserted, again.duplicates, again.identicalOtherKey], [0, 1, 0]);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM log_records"), 2);
    const other = store.putOtelLogs(t.scope, k2, b3, [l]);
    assert.deepEqual([other.inserted, other.duplicates, other.identicalOtherKey], [0, 1, 1]);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM log_records"), 3);
    assert.equal(
      scalar(
        store,
        "SELECT COUNT(*) AS n FROM log_records WHERE dup_of IS NOT NULL AND key_id = ?",
        k2,
      ),
      1,
    );
    // and again from the second key: no new row
    assert.equal(
      store.putOtelLogs(t.scope, k2, recorded(store, t, k2, "l4", { signal: "logs" }), [l])
        .identicalOtherKey,
      0,
    );
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM log_records"), 3);
    // F13 applies to logs too
    const rej = store.putOtelLogs(t.scope, t.keyId, b1, [
      logOf(t, { recordSha256: "9".repeat(64), timeNs: 1n << 63n }),
    ]);
    assert.equal(rej.rejected, 1);
    assert.equal(rej.inserted, 0);
  });
});

// ---- imports ------------------------------------------------------------------------------------
for (const name of FIXTURES) {
  test(`putImport (${name}): the round trip equals validateEvents output; supersede keeps v1 byte for byte`, () => {
    withStore((store) => {
      const t = localTenant(store);
      const f = fixture(name);
      const expected = validateEvents(JSON.parse(JSON.stringify(f.result.events)));
      assert.equal(expected.ok, true);
      const added = store.putImport(t.scope, t.keyId, importPut(name), "add");
      assert.equal(added.status, "added");
      assert.equal(added.version, 1);
      const views = store.runEvents(t.scope, added.runId).sessions;
      assert.equal(views.length, 1);
      assert.deepEqual(views[0]?.result.events, expected.ok ? expected.events : null);
      assert.deepEqual(views[0]?.record, f.record);
      assert.deepEqual(views[0]?.result.source, f.result.source);
      // reads are re-validated and re-derivable: run summary counters match the record
      const run = store.run(t.scope, added.runId);
      assert.equal(run?.run.counts["events"], f.record.counts.events);
      assert.equal(run?.imports[0]?.keyId, t.keyId);
      assert.deepEqual(run?.run.credentials, [{ keyId: t.keyId, records: 1 }]);
      const v1 = rowsOf(
        store,
        "SELECT ord, event_id, kind, event_json, key_id FROM events WHERE version = 1 ORDER BY ord",
      );
      assert.equal(v1.length, f.record.counts.events);
      // add again: unchanged, nothing written
      const same = store.putImport(t.scope, t.keyId, importPut(name), "add");
      assert.deepEqual([same.status, same.version], ["unchanged", 1]);
      assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM imports"), 1);
      // a client-derived upload over an existing ID is `exists`, in both modes
      assert.equal(
        store.putImport(t.scope, t.keyId, importPut(name, { derivation: "client" }), "add").status,
        "exists",
      );
      assert.equal(
        store.putImport(t.scope, t.keyId, importPut(name, { derivation: "client" }), "supersede")
          .status,
        "exists",
      );
      // supersede appends v2 and v1 is untouched
      const key2 = extraKey(store, t);
      const sup = store.putImport(
        t.scope,
        key2,
        importPut(name, { receivedMs: NOW + 1000 }),
        "supersede",
      );
      assert.deepEqual([sup.status, sup.version, sup.runId], ["superseded", 2, added.runId]);
      assert.deepEqual(
        rowsOf(
          store,
          "SELECT ord, event_id, kind, event_json, key_id FROM events WHERE version = 1 ORDER BY ord",
        ),
        v1,
      );
      assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM imports"), 2);
      assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM events"), 2 * f.record.counts.events);
      // the current version is v2: one view, credited to the second key
      assert.equal(store.runEvents(t.scope, added.runId).sessions.length, 1);
      assert.deepEqual(
        store.run(t.scope, added.runId)?.imports.map((i) => [i.version, i.keyId]),
        [[2, key2]],
      );
      assert.equal(store.run(t.scope, added.runId)?.run.counts["imports"], 1);
    });
  });
}

function rowsOf(store: SqliteSwainStore, sql: string): string[] {
  const raw = rawDb(store);
  try {
    return raw
      .prepare(sql)
      .all()
      .map((r) => canonicalJson(JSON.parse(JSON.stringify(r))));
  } finally {
    raw.close();
  }
}

test("putImport: a server-derived version over a client-derived one appends and wins", () => {
  withStore((store) => {
    const t = localTenant(store);
    const c = store.putImport(
      t.scope,
      t.keyId,
      importPut("claude-code", { derivation: "client" }),
      "add",
    );
    assert.deepEqual([c.status, c.version], ["added", 1]);
    const s = store.putImport(
      t.scope,
      t.keyId,
      importPut("claude-code", { derivation: "server", receivedMs: NOW + 5 }),
      "add",
    );
    assert.deepEqual([s.status, s.version], ["superseded", 2]);
    // current = the server-derived version; asking again is `unchanged` at v2
    const again = store.putImport(
      t.scope,
      t.keyId,
      importPut("claude-code", { derivation: "server" }),
      "add",
    );
    assert.deepEqual([again.status, again.version], ["unchanged", 2]);
    assert.equal(store.run(t.scope, c.runId)?.imports[0]?.derivation, "server");
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM imports"), 2);
  });
});

test("putImport: a different adapter version is skipped-version, never an overwrite", () => {
  withStore((store) => {
    const t = localTenant(store);
    store.putImport(t.scope, t.keyId, importPut("codex-cli"), "add");
    const f = fixture("codex-cli");
    const newer = importPut("codex-cli", {
      record: { ...f.record, adapter: { ...f.record.adapter, version: "9.9.9" } },
    });
    const out = store.putImport(t.scope, t.keyId, newer, "add");
    assert.deepEqual([out.status, out.version], ["skipped-version", 1]);
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM imports"), 1);
  });
});

test("putImport: local-cli is the credential of migrated imports and only of those", () => {
  withStore((store) => {
    const t = localTenant(store);
    const m = store.putMigratedImport(
      t.scope,
      importPut("gemini-cli", { derivation: "migrated" }),
      "add",
    );
    assert.equal(m.status, "added");
    const run = store.run(t.scope, m.runId);
    assert.equal(run?.run.kind, "import");
    assert.deepEqual(run?.run.credentials, [{ keyId: "local-cli", records: 1 }]);
    assert.equal(
      code(() => store.putMigratedImport(t.scope, importPut("gemini-cli"), "add")),
      "db-constraint",
    );
    assert.equal(
      code(() =>
        store.putImport(
          t.scope,
          t.keyId,
          importPut("gemini-cli", { derivation: "migrated" }),
          "add",
        ),
      ),
      "db-constraint",
    );
  });
});

test("putImport: records that fail the strict validators are refused", () => {
  withStore((store) => {
    const t = localTenant(store);
    const f = fixture("opencode");
    const wrongCount = importPut("opencode", {
      record: { ...f.record, counts: { ...f.record.counts, events: 1 } },
    });
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, wrongCount, "add")),
      "db-constraint",
    );
    const wrongSession = importPut("opencode", {
      record: { ...f.record, sessionId: `ses_${"0".repeat(32)}` },
    });
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, wrongSession, "add")),
      "db-constraint",
    );
    const extra = importPut("opencode", { record: { ...f.record, extra: 1 } as never });
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, extra, "add")),
      "db-constraint",
    );
    const events = importPut("opencode", {
      result: { ...f.result, events: [{ nope: true }] as never },
    });
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, events, "add")),
      "db-constraint",
    );
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, importPut("opencode"), "replace" as never)),
      "db-constraint",
    );
    assert.equal(scalar(store, "SELECT COUNT(*) AS n FROM imports"), 0);
  });
});

// ---- boundary re-validation of stored rows ------------------------------------------------------
test("tampered rows are refused on read, never returned (db-corrupt)", () => {
  withStore((store) => {
    const t = localTenant(store);
    const put = store.putImport(t.scope, t.keyId, importPut("claude-code"), "add");
    const b = recorded(store, t, t.keyId, "t1");
    store.putOtelTraces(t.scope, t.keyId, b, [spanOf(t)]);
    const spanRun = spanOf(t).run.runId;
    assert.doesNotThrow(() => store.runEvents(t.scope, put.runId));
    // 1. an event row that is no longer a valid event
    exec(store, 'UPDATE events SET event_json = \'{"kind":"nope"}\' WHERE ord = 0');
    assert.equal(
      code(() => store.runEvents(t.scope, put.runId)),
      "db-corrupt",
    );
    exec(store, "UPDATE events SET event_json = 'not json' WHERE ord = 0");
    assert.equal(
      code(() => store.runEvents(t.scope, put.runId)),
      "db-corrupt",
    );
    // 2. an import record that no longer parses
    exec(store, "UPDATE imports SET record_json = '{}'");
    assert.equal(
      code(() => store.run(t.scope, put.runId)),
      "db-corrupt",
    );
    // 3. a span with a malformed JSON column or a bad span id
    exec(store, "UPDATE spans SET attributes_json = '{}'");
    assert.equal(
      code(() => store.runSpans(t.scope, spanRun, 10)),
      "db-corrupt",
    );
    exec(store, "UPDATE spans SET attributes_json = '[]', span_id = 'zz'");
    assert.equal(
      code(() => store.runSpans(t.scope, spanRun, 10)),
      "db-corrupt",
    );
    // 4. run cache columns
    exec(store, "UPDATE runs SET counts_json = '{\"spans\":-1}' WHERE run_id = ?", spanRun);
    assert.equal(
      code(() => store.run(t.scope, spanRun)),
      "db-corrupt",
    );
    exec(
      store,
      'UPDATE runs SET counts_json = \'{}\', credentials_json = \'[{"keyId":"x","records":1}]\' WHERE run_id = ?',
      spanRun,
    );
    assert.equal(
      code(() => store.run(t.scope, spanRun)),
      "db-corrupt",
    );
    // 5. a key row with a scope outside the closed set
    exec(store, "UPDATE ingest_keys SET scopes = '[\"root\"]'");
    assert.equal(
      code(() => store.listKeys(t.scope)),
      "db-corrupt",
    );
    assert.equal(
      code(() => store.findKey(t.keyId)),
      "db-corrupt",
    );
  });
});

test("assertRowScope: a row outside the scope throws db-scope-violation", () => {
  const org = `org_${"1".repeat(32)}` as OrgId;
  const prj = `prj_${"2".repeat(32)}` as PrjId;
  assert.doesNotThrow(() =>
    assertRowScope({ org_id: org, project_id: prj }, { orgId: org, projectId: prj }),
  );
  assert.doesNotThrow(() => assertRowScope({ org_id: org }, { orgId: org }));
  const throwsScope = (fn: () => void): void => {
    assert.throws(fn, (e: unknown) => e instanceof DbError && e.code === "db-scope-violation");
  };
  throwsScope(() =>
    assertRowScope(
      { org_id: `org_${"3".repeat(32)}`, project_id: prj },
      { orgId: org, projectId: prj },
    ),
  );
  throwsScope(() =>
    assertRowScope(
      { org_id: org, project_id: `prj_${"3".repeat(32)}` },
      { orgId: org, projectId: prj },
    ),
  );
  assert.throws(() => assertRowScope({ org_id: org }, { orgId: org, projectId: prj }), DbError);
});

// ---- login codes and sessions -------------------------------------------------------------------
test("login codes: single use, expiry, and atomic across two connections", () => {
  const t = tempDir();
  const a = openStore(t.dir);
  const b = SqliteSwainStore.open(a.path, {
    randomBytes: counterRandom(),
    sessionMode: "team",
    uid,
    nowMs: () => NOW,
  });
  b.migrate({ nowIso: () => NOW_ISO });
  try {
    const tenant = localTenant(a);
    const sha = sha256Hex(new TextEncoder().encode("code-1"));
    a.putLoginCode({
      codeSha256: sha,
      orgId: tenant.orgId,
      nextPath: "/runs",
      expiresAtMs: NOW + 60_000,
    });
    const results = [a.consumeLoginCode(sha, NOW), b.consumeLoginCode(sha, NOW)];
    assert.equal(results.filter((r) => r !== null).length, 1, "exactly one consumer wins");
    assert.deepEqual(
      results.find((r) => r !== null),
      { orgId: tenant.orgId, nextPath: "/runs" },
    );
    assert.equal(a.consumeLoginCode(sha, NOW), null);
    // expired and unknown look the same as used
    const sha2 = sha256Hex(new TextEncoder().encode("code-2"));
    a.putLoginCode({
      codeSha256: sha2,
      orgId: tenant.orgId,
      nextPath: "/",
      expiresAtMs: NOW + 1000,
    });
    assert.equal(a.consumeLoginCode(sha2, NOW + 1000), null);
    assert.equal(a.consumeLoginCode(sha2, NOW + 5000), null);
    assert.equal(a.consumeLoginCode("f".repeat(64), NOW), null);
    assert.equal(a.consumeLoginCode("not-a-hash", NOW), null);
    // an expired code is not consumed by the failed attempt, but stays unusable
    const sha3 = sha256Hex(new TextEncoder().encode("code-3"));
    a.putLoginCode({
      codeSha256: sha3,
      orgId: tenant.orgId,
      nextPath: "/",
      expiresAtMs: NOW + 1000,
    });
    assert.deepEqual(a.consumeLoginCode(sha3, NOW + 999), { orgId: tenant.orgId, nextPath: "/" });
    // unsafe next paths are refused when stored
    for (const next of [
      "//evil.example",
      "http://evil.example",
      "/a\nb",
      "x",
      `/${"a".repeat(600)}`,
    ]) {
      assert.equal(
        code(() =>
          a.putLoginCode({
            codeSha256: sha3.replace(/^./, "0"),
            orgId: tenant.orgId,
            nextPath: next,
            expiresAtMs: NOW + 1,
          }),
        ),
        "db-constraint",
        next,
      );
    }
  } finally {
    a.close();
    b.close();
    t.done();
  }
});

test("sessions: idle and absolute expiry, revocation, and last-seen refresh", () => {
  withStore((store) => {
    const t = localTenant(store);
    const token = sha256Hex(new TextEncoder().encode("tok-1"));
    store.putSession(t.orgId, { tokenSha256: token, principal: "owner", createdMs: NOW });
    const s1 = store.findSession(token, NOW + 1000);
    assert.deepEqual(s1, {
      orgId: t.orgId,
      principal: "owner",
      createdMs: NOW,
      lastSeenMs: NOW + 1000,
    });
    // idle: 12 h without use ends the session (the refusal does not extend it)
    assert.equal(store.findSession(token, NOW + 1000 + SESSION_LIFETIMES.team.idleMs + 1), null);
  });
  withStore((store) => {
    const t = localTenant(store);
    const token = sha256Hex(new TextEncoder().encode("tok-2"));
    store.putSession(t.orgId, { tokenSha256: token, principal: "owner", createdMs: NOW });
    // keep it alive every 11 h: still valid just before 7 days, dead after
    let now = NOW;
    while (now + 11 * 3_600_000 < NOW + SESSION_LIFETIMES.team.absoluteMs) {
      now += 11 * 3_600_000;
      assert.notEqual(store.findSession(token, now), null);
    }
    assert.equal(store.findSession(token, NOW + SESSION_LIFETIMES.team.absoluteMs + 1), null);
  });
  withStore((store) => {
    const t = localTenant(store);
    const token = sha256Hex(new TextEncoder().encode("tok-3"));
    store.putSession(t.orgId, { tokenSha256: token, principal: "owner", createdMs: NOW });
    assert.notEqual(store.findSession(token, NOW + 1), null);
    store.revokeSession(token, NOW + 2);
    assert.equal(store.findSession(token, NOW + 3), null);
    store.revokeSession(token, NOW + 4); // revoking twice is harmless
    store.revokeSession("f".repeat(64), NOW); // and so is an unknown token
    assert.equal(store.findSession("garbage", NOW), null);
  });
});

// ---- audit chain --------------------------------------------------------------------------------
test("audit: the hash chain verifies, and any edit, deletion or reorder is detected", () => {
  withStore((store) => {
    const t = localTenant(store);
    for (let i = 0; i < 4; i++) {
      store.appendAudit(t.orgId, {
        at: NOW_ISO,
        actorType: "owner",
        actorId: "local",
        action: "key.create",
        targetType: "key",
        targetId: `key_${i}`,
        detail: { n: i, ok: true, note: null },
      });
    }
    assert.deepEqual(store.verifyAudit(t.orgId), { ok: true, entries: 4 });
    const first = rowsOf(store, "SELECT prev_hash FROM audit_log WHERE seq = 1");
    assert.ok(first[0]?.includes("0".repeat(64)), "genesis links to the zero hash");

    exec(store, "UPDATE audit_log SET target_id = 'forged' WHERE seq = 2");
    assert.deepEqual(store.verifyAudit(t.orgId), {
      ok: false,
      entries: 1,
      firstBadSeq: 2,
      reason: "hash",
    });
    exec(store, "UPDATE audit_log SET target_id = 'key_1' WHERE seq = 2");
    assert.equal(store.verifyAudit(t.orgId).ok, true);

    exec(store, "UPDATE audit_log SET detail_json = '{}' WHERE seq = 4");
    const bad4 = store.verifyAudit(t.orgId);
    assert.equal(!bad4.ok && bad4.firstBadSeq, 4);
    exec(
      store,
      'UPDATE audit_log SET detail_json = \'{"n":3,"note":null,"ok":true}\' WHERE seq = 4',
    );
    assert.equal(store.verifyAudit(t.orgId).ok, true);

    exec(store, "DELETE FROM audit_log WHERE seq = 3");
    const gap = store.verifyAudit(t.orgId);
    assert.deepEqual(gap.ok, false);
    assert.equal(!gap.ok && gap.reason, "gap");
    assert.equal(!gap.ok && gap.firstBadSeq, 4);
  });
});

test("audit: entries are validated (closed action list, flat static detail)", () => {
  withStore((store) => {
    const t = localTenant(store);
    const base = {
      at: NOW_ISO,
      actorType: "owner",
      actorId: "x",
      action: "key.create" as const,
      targetType: "key",
      targetId: "k",
      detail: {},
    };
    assert.equal(
      code(() => store.appendAudit(t.orgId, { ...base, action: "rm.rf" as never })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.appendAudit(t.orgId, { ...base, detail: { a: { b: 1 } } as never })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.appendAudit(t.orgId, { ...base, actorType: "Bad Type" })),
      "db-constraint",
    );
    assert.deepEqual(store.verifyAudit(t.orgId), { ok: true, entries: 0 });
  });
});

// ---- ID resolution and status -------------------------------------------------------------------
test("resolveId: prefixes, session, trace and span IDs; a foreign project is a scope error; no wildcards", () => {
  withStore((store) => {
    const t = localTenant(store);
    const put = store.putImport(t.scope, t.keyId, importPut("claude-code"), "add");
    const f = fixture("claude-code");
    const b = recorded(store, t, t.keyId, "q1");
    store.putOtelTraces(t.scope, t.keyId, b, [spanOf(t)]);
    const org = { orgId: t.orgId };
    const allowed = [t.projectId];
    const run = store.resolveId(org, allowed, put.runId.slice(0, 12));
    assert.deepEqual(
      run.map((r) => [r.type, r.id, r.projectId]),
      [["run", put.runId, t.projectId]],
    );
    assert.deepEqual(
      store.resolveId(org, allowed, f.record.sessionId).map((r) => r.runId),
      [put.runId],
    );
    assert.deepEqual(
      store.resolveId(org, allowed, f.record.importId.slice(0, 12)).map((r) => [r.type, r.runId]),
      [["import", put.runId]],
    );
    const evt = f.result.events[0];
    assert.ok(evt !== undefined);
    assert.equal(store.resolveId(org, allowed, evt.eventId.slice(0, 12))[0]?.type, "event");
    assert.deepEqual(
      store.resolveId(org, allowed, TRACE).map((r) => r.type),
      ["run"],
    );
    assert.deepEqual(
      store.resolveId(org, allowed, "b7ad6b7169203331").map((r) => r.type),
      ["span"],
    );
    const agent = store.agent(
      t.scope,
      store.fleet(t.scope, { sort: "name", limit: 10, offset: 0 }).rows[0]?.agentId ??
        ("agt_x" as AgtId),
    );
    assert.ok(agent !== null);
    assert.equal(store.resolveId(org, allowed, agent.agent.agentId.slice(0, 10)).length, 1);
    // wildcards and junk never match anything
    for (const q of ["run_%", "run_______", "%", "run_aa%", "", "x".repeat(100), "run_ZZZZZZ"]) {
      assert.deepEqual(store.resolveId(org, allowed, q), [], q);
    }
    // a project that is not in this org
    assert.equal(
      code(() => store.resolveId(org, [`prj_${"7".repeat(32)}`], "run_000000")),
      "db-scope-violation",
    );
    // no allowed projects: nothing
    assert.deepEqual(store.resolveId(org, [], put.runId), []);
  });
});

test("status: per-project counts over a 24 h window from the injected clock; foreign project refused", () => {
  const t = tempDir();
  let now = NOW;
  const store = SqliteSwainStore.open(`${t.dir}/n.sqlite`, {
    randomBytes: counterRandom(),
    sessionMode: "team",
    uid,
    nowMs: () => now,
  });
  store.migrate({ nowIso: () => NOW_ISO });
  try {
    const tenant = localTenant(store);
    recorded(store, tenant, tenant.keyId, "st1", { receivedMs: NOW });
    recorded(store, tenant, tenant.keyId, "st2", { receivedMs: NOW + 1000, status: "partial" });
    recorded(store, tenant, tenant.keyId, "st3", { receivedMs: NOW - 2 * DAY, status: "rejected" });
    store.putOtelTraces(tenant.scope, tenant.keyId, "st1", [spanOf(tenant)]);
    now = NOW + 2000;
    const s = store.status({ orgId: tenant.orgId }, [tenant.projectId]);
    assert.equal(s.schemaVersion, 1);
    assert.equal(s.projects.length, 1);
    const p = s.projects[0];
    assert.deepEqual(p?.batches24h, { accepted: 1, partial: 1, rejected: 0 });
    assert.equal(p?.agents, 1);
    assert.equal(p?.runs, 1);
    assert.equal(p?.lastIngestMs, NOW + 1000);
    now = NOW + 3 * DAY;
    assert.deepEqual(
      store.status({ orgId: tenant.orgId }, [tenant.projectId]).projects[0]?.batches24h,
      { accepted: 0, partial: 0, rejected: 0 },
    );
    assert.equal(
      code(() => store.status({ orgId: tenant.orgId }, [`prj_${"7".repeat(32)}`])),
      "db-scope-violation",
    );
    assert.deepEqual(store.status({ orgId: tenant.orgId }, []).projects, []);
  } finally {
    store.close();
    t.done();
  }
});

test("reads: fleet, agent, runs and run detail", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "f1");
    store.putOtelTraces(t.scope, t.keyId, b, [spanOf(t)]);
    store.putImport(t.scope, t.keyId, importPut("claude-code"), "add");
    const fleet = store.fleet(t.scope, { sort: "recent", limit: 10, offset: 0 });
    assert.equal(fleet.total, 2);
    assert.equal(fleet.rows.length, 2);
    assert.equal(store.fleet(t.scope, { sort: "name", limit: 1, offset: 1 }).rows.length, 1);
    assert.equal(store.runs(t.scope, { limit: 10, offset: 0 }).total, 2);
    assert.equal(store.runs(t.scope, { kind: "trace", limit: 10, offset: 0 }).total, 1);
    const agentId = store.runs(t.scope, { kind: "trace", limit: 10, offset: 0 }).rows[0]
      ?.primaryAgentId as AgtId;
    assert.equal(store.runs(t.scope, { agentId, limit: 10, offset: 0 }).total, 1);
    assert.equal(store.agent(t.scope, agentId)?.runCount, 1);
    assert.equal(store.agent(t.scope, `agt_${"0".repeat(32)}`), null);
    assert.equal(store.run(t.scope, `run_${"0".repeat(32)}` as RunId), null);
    assert.equal(store.run(t.scope, "garbage" as RunId), null);
    assert.equal(
      code(() => store.fleet(t.scope, { sort: "recent", limit: 0, offset: 0 })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.fleet(t.scope, { sort: "recent", limit: 201, offset: 0 })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.runs(t.scope, { kind: "nope" as never, limit: 1, offset: 0 })),
      "db-constraint",
    );
    assert.equal(
      code(() => store.runSpans(t.scope, spanOf(t).run.runId, 0)),
      "db-constraint",
    );
    assert.deepEqual(store.runSpans(t.scope, spanOf(t).run.runId, 1).truncated, false);
  });
});

test("every L1 insert records the credential: key_id is the caller's key on every evidence row", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b = recorded(store, t, k2, "k1");
    store.putOtelTraces(t.scope, k2, b, [spanOf(t)]);
    store.putOtelLogs(t.scope, k2, recorded(store, t, k2, "k2", { signal: "logs" }), [logOf(t)]);
    store.putImport(t.scope, k2, importPut("opencode"), "add");
    for (const table of ["ingest_batches", "spans", "log_records", "imports", "events"]) {
      assert.ok(scalar(store, `SELECT COUNT(*) AS n FROM ${table}`) > 0, table);
      assert.equal(
        scalar(store, `SELECT COUNT(*) AS n FROM ${table} WHERE key_id <> ?`, k2),
        0,
        table,
      );
    }
    const idem = store.recordBatch(
      t.scope,
      k2 as KeyId,
      batch("k3", { idempotency: { route: "/r", key: "1" } }),
    );
    assert.equal(idem.outcome, "created");
    assert.equal(
      scalar(store, "SELECT COUNT(*) AS n FROM idempotency_keys WHERE key_id = ?", k2),
      1,
    );
  });
});

test("the store refuses calls after close and before migrate", () => {
  const t = tempDir();
  try {
    const raw = SqliteSwainStore.open(`${t.dir}/z.sqlite`, {
      randomBytes: counterRandom(),
      sessionMode: "team",
      uid,
      nowMs: () => NOW,
    });
    assert.equal(
      code(() => raw.ensureLocalTenancy(NOW_ISO)),
      "db-io",
    );
    raw.migrate({ nowIso: () => NOW_ISO });
    raw.close();
    raw.close();
    assert.equal(
      code(() => raw.listProjects({ orgId: `org_${"1".repeat(32)}` })),
      "db-io",
    );
  } finally {
    t.done();
  }
});
