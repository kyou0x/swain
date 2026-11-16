/** G3 hardening: pinned hash vectors, session lifetimes, key states, row-scope coverage, F-items. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { policyAppliedSpanJson } from "@swain/model";
import { hmacSha256, lp, toHex } from "../src/hmac.js";
import { DbError, hashKeySecret, SESSION_LIFETIMES, SqliteSwainStore } from "../src/index.js";
import { createExclusive, removeFile } from "../src/sqlite/open.js";
import { AGGREGATE_STATEMENTS, STATEMENTS } from "../src/sqlite/statements.js";
import { openWithStatementOverrides } from "../src/sqlite/testing.js";
import {
  batchOf,
  counterRandom,
  importPut,
  localTenant,
  NOW,
  NOW_ISO,
  openStore,
  seedTenant,
  shaOf,
  spanOf,
  tempDir,
  uid,
} from "./helpers.js";
import { extraKey, logOf, rawDb, recorded } from "./helpers2.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DbError, String(e));
    return e.code;
  }
  return "no-error";
}

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

function exec(store: SqliteSwainStore, sql: string, ...p: (string | number)[]): void {
  const raw = rawDb(store);
  try {
    raw.prepare(sql).run(...p);
  } finally {
    raw.close();
  }
}

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

test("C1: the ingest-key hash is sha256 of the domain prefix and the secret (pinned vector)", () => {
  const secret = `swn_0123456789abcdef_${"ab".repeat(32)}`;
  assert.equal(hashKeySecret(secret), sha(`swain:v1:ingest-key\n${secret}`));
  assert.notEqual(hashKeySecret(secret), sha(secret));
  assert.equal(
    hashKeySecret(secret),
    "d0e3312ef9cb3be95ec63a4cf1bda09326a6b7abd0d3f3d57b06fa27625e9f6d",
  );
});

test("C2: the audit hash is sha256(lp(domain) || lp(prev) || lp(canonical entry))", () => {
  withStore((store) => {
    const t = localTenant(store);
    store.appendAudit(t.orgId, {
      at: NOW_ISO,
      actorType: "owner",
      actorId: "local",
      action: "key.create",
      targetType: "key",
      targetId: "key_1",
      detail: { n: 1 },
    });
    const raw = rawDb(store);
    let row: Record<string, unknown>;
    try {
      row = raw.prepare("SELECT * FROM audit_log WHERE seq = 1").get() as Record<string, unknown>;
    } finally {
      raw.close();
    }
    const entry =
      `{"action":"key.create","actor_id":"local","actor_type":"owner","at":"${NOW_ISO}",` +
      `"detail_json":"{\\"n\\":1}","org_id":"${t.orgId}","prev_hash":"${"0".repeat(64)}",` +
      `"seq":1,"target_id":"key_1","target_type":"key"}`;
    const l = (s: string): string => `${Buffer.byteLength(s)}:${s}`;
    const want = sha(`${l("swain:v1:audit")}${l("0".repeat(64))}${l(entry)}`);
    assert.equal(row["hash"], want);
    assert.notEqual(row["hash"], sha(`${"0".repeat(64)}${entry}`), "not the old unprefixed form");
    assert.deepEqual(store.verifyAudit(t.orgId), { ok: true, entries: 1 });
  });
});

test("RFC 4231 HMAC-SHA-256 vectors (cases 1, 2 and 6, a key longer than the block)", () => {
  const enc = new TextEncoder();
  assert.equal(
    toHex(hmacSha256(new Uint8Array(20).fill(0x0b), enc.encode("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  assert.equal(
    toHex(hmacSha256(enc.encode("Jefe"), enc.encode("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  assert.equal(
    toHex(
      hmacSha256(
        new Uint8Array(131).fill(0xaa),
        enc.encode("Test Using Larger Than Block-Size Key - Hash Key First"),
      ),
    ),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  );
  assert.equal(toHex(lp("ab")), toHex(enc.encode("2:ab")));
});

test("C3: session lifetimes follow the mode (local 2 h / 24 h, team 12 h / 7 d)", () => {
  assert.deepEqual(SESSION_LIFETIMES.local, { idleMs: 7_200_000, absoluteMs: 86_400_000 });
  assert.deepEqual(SESSION_LIFETIMES.team, { idleMs: 43_200_000, absoluteMs: 604_800_000 });
  for (const mode of ["local", "team"] as const) {
    const t = tempDir();
    const s = SqliteSwainStore.open(join(t.dir, "n.sqlite"), {
      randomBytes: counterRandom(),
      sessionMode: mode,
      uid,
      nowMs: () => NOW,
    });
    try {
      s.migrate({ nowIso: () => NOW_ISO });
      const org = localTenant(s).orgId;
      const life = SESSION_LIFETIMES[mode];
      const put = (c: string): string => {
        const h = c.repeat(64);
        s.putSession(org, { tokenSha256: h, principal: "p", createdMs: NOW });
        return h;
      };
      const idle = put("a");
      assert.ok(s.findSession(idle, NOW + life.idleMs), `${mode} alive at the idle limit`);
      assert.equal(s.findSession(idle, NOW + 2 * life.idleMs + 1), null, `${mode} idle expiry`);
      const abs = put("b");
      let now = NOW;
      while (now + life.idleMs - 1 < NOW + life.absoluteMs) {
        now += life.idleMs - 1;
        assert.ok(s.findSession(abs, now), `${mode} kept alive by use`);
      }
      assert.equal(s.findSession(abs, NOW + life.absoluteMs + 1), null, `${mode} absolute expiry`);
    } finally {
      s.close();
      t.done();
    }
  }
  const t = tempDir();
  try {
    assert.equal(
      code(() =>
        SqliteSwainStore.open(join(t.dir, "x.sqlite"), {
          sessionMode: "bogus" as never,
          uid,
          nowMs: () => NOW,
        }),
      ),
      "db-io",
    );
  } finally {
    t.done();
  }
});

test("C4: an import citing a batch needs that key's batch; local-cli cites none", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b = recorded(store, t, t.keyId, "prov-1");
    assert.equal(
      code(() => store.putImport(t.scope, k2, importPut("codex-cli", { batchId: b }), "add")),
      "db-scope-violation",
    );
    assert.equal(
      code(() =>
        store.putImport(t.scope, t.keyId, importPut("codex-cli", { batchId: "nope" }), "add"),
      ),
      "db-constraint",
    );
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, importPut("codex-cli", { batchId: b }), "add")),
      "no-error",
    );
    assert.equal(
      code(() =>
        store.putMigratedImport(
          t.scope,
          importPut("gemini-cli", { derivation: "migrated", batchId: b }),
          "add",
        ),
      ),
      "db-constraint",
    );
  });
});

test("F7: revoked and expired keys write nothing and prove nothing; supersede needs ingest:replace", () => {
  withStore((store) => {
    const t = localTenant(store);
    const inst = "1".repeat(32);
    const chal = "2".repeat(64);
    const k = store.createKey(t.scope, {
      label: "r",
      scopes: ["ingest:otlp", "ingest:native"],
      createdBy: "o",
      createdAt: NOW_ISO,
    });
    assert.notEqual(store.serverProof(k.key.keyId, "http://x", inst, chal), null);
    assert.equal(
      code(() => store.putImport(t.scope, k.key.keyId, importPut("codex-cli"), "add")),
      "no-error",
    );
    assert.equal(
      code(() => store.putImport(t.scope, k.key.keyId, importPut("codex-cli"), "supersede")),
      "db-scope-violation",
    );
    assert.equal(
      code(() => store.putImport(t.scope, t.keyId, importPut("codex-cli"), "supersede")),
      "no-error",
    );
    assert.equal(store.revokeKey(t.scope, k.key.keyId, NOW), true);
    assert.equal(store.serverProof(k.key.keyId, "http://x", inst, chal), null);
    assert.equal(
      code(() => store.putImport(t.scope, k.key.keyId, importPut("gemini-cli"), "add")),
      "db-constraint",
    );
    assert.equal(
      code(() => recorded(store, t, k.key.keyId, "rev-1")),
      "db-constraint",
    );
    const e = store.createKey(t.scope, {
      label: "e",
      scopes: ["ingest:otlp"],
      createdBy: "o",
      createdAt: NOW_ISO,
      expiresAtMs: NOW + 5,
    });
    assert.notEqual(store.serverProof(e.key.keyId, "http://x", inst, chal), null);
    exec(store, "UPDATE ingest_keys SET expires_at_ms = ? WHERE key_id = ?", NOW - 1, e.key.keyId);
    assert.equal(store.serverProof(e.key.keyId, "http://x", inst, chal), null);
    assert.equal(
      code(() => recorded(store, t, e.key.keyId, "exp-1")),
      "db-constraint",
    );
  });
});

test("F5: raw bytes are refused unless the project keeps raw_retention = full", () => {
  withStore((store) => {
    const t = localTenant(store);
    const raw = new Uint8Array([1, 2, 3]);
    assert.equal(
      code(() => recorded(store, t, t.keyId, "raw-1", { raw })),
      "db-constraint",
    );
    store.setProjectPolicy(
      t.scope,
      { rawRetention: "full" },
      { type: "owner", id: "o", at: NOW_ISO },
    );
    assert.equal(
      code(() => recorded(store, t, t.keyId, "raw-2", { raw })),
      "no-error",
    );
  });
});

test("F6: list reads are bounded and say so", () => {
  withStore((store) => {
    const t = localTenant(store);
    assert.equal(store.listKeys(t.scope).truncated, false);
    for (let i = 0; i < 1000; i++) extraKey(store, t, `k${i}`);
    const l = store.listKeys(t.scope);
    assert.equal(l.keys.length, 1000);
    assert.equal(l.truncated, true);
    assert.equal(store.listProjects({ orgId: t.orgId }).truncated, false);
    assert.equal(store.runSpans(t.scope, spanOf(t).run.runId, 10).conflictsTruncated, false);
  });
});

test("F10: login codes live at most 60 s", () => {
  withStore((store) => {
    const t = localTenant(store);
    const put = (ms: number, c: string): string =>
      code(() =>
        store.putLoginCode({
          codeSha256: c.repeat(64),
          orgId: t.orgId,
          nextPath: "/",
          expiresAtMs: ms,
        }),
      );
    assert.equal(put(NOW + 60_000, "a"), "no-error");
    assert.equal(put(NOW + 60_001, "b"), "db-constraint");
    assert.equal(put(NOW + 86_400_000, "c"), "db-constraint");
  });
});

test("F10: removeFile only removes our own scratch names inside the directory", () => {
  const t = tempDir();
  const other = tempDir();
  try {
    const ok = join(t.dir, ".0123456789abcdef.tmp");
    const part = join(t.dir, ".fedcba9876543210.partial");
    writeFileSync(ok, "x");
    writeFileSync(part, "x");
    for (const bad of ["victim.sqlite", ".abc.tmp", `.${"g".repeat(16)}.tmp`, "x.partial"]) {
      writeFileSync(join(t.dir, bad), "x");
      assert.equal(
        code(() => removeFile(join(t.dir, bad), t.dir)),
        "db-io",
        bad,
      );
      assert.ok(existsSync(join(t.dir, bad)), bad);
    }
    const foreign = join(other.dir, ".0123456789abcdef.tmp");
    writeFileSync(foreign, "x");
    assert.equal(
      code(() => removeFile(foreign, t.dir)),
      "db-io",
    );
    assert.ok(existsSync(foreign));
    removeFile(ok, t.dir);
    removeFile(part, t.dir);
    assert.equal(existsSync(ok) || existsSync(part), false);
  } finally {
    other.done();
    t.done();
  }
});

test("F1: createExclusive makes a 0600 file by descriptor and never touches an existing one", () => {
  const t = tempDir();
  try {
    const p = join(t.dir, "a.sqlite");
    assert.equal(createExclusive(p), true);
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(createExclusive(p), false);
  } finally {
    t.done();
  }
});

test("F2: no scratch file survives a migration (backup naming is covered in migrations.test.ts)", () => {
  const t = tempDir();
  try {
    const s = openStore(t.dir);
    s.close();
    const names = readdirSync(t.dir);
    assert.equal(
      names.some((n) => n.endsWith(".tmp") || n.endsWith(".partial")),
      false,
    );
  } finally {
    t.done();
  }
});

test("C7: every tenant read selects org_id, except the pinned aggregate list", () => {
  for (const [name, def] of Object.entries(STATEMENTS)) {
    const d = def as { tenant: boolean; sql: string };
    if (!d.tenant || !/^\s*SELECT\b/i.test(d.sql)) continue;
    const list = d.sql.slice(0, d.sql.search(/\bFROM\b/i));
    const has = /\borg_id\b/.test(list);
    const pinned = (AGGREGATE_STATEMENTS as readonly string[]).includes(name);
    assert.equal(has, !pinned, `${name}`);
  }
  for (const n of AGGREGATE_STATEMENTS) assert.ok(n in STATEMENTS, `stale aggregate ${n}`);
});

test("C7: tampered free text, batch ids and oversized or mistyped JSON are refused on read", () => {
  withStore((store) => {
    const t = localTenant(store);
    recorded(store, t, t.keyId, "c7-b");
    exec(store, "UPDATE ingest_keys SET label = 'bad' || char(7) || 'x'");
    assert.equal(
      code(() => store.listKeys(t.scope)),
      "db-corrupt",
    );
    exec(store, "UPDATE ingest_keys SET label = 'ok'");
    assert.equal(
      code(() => store.listKeys(t.scope)),
      "no-error",
    );
    exec(store, "UPDATE ingest_batches SET result_json = '[1]'");
    assert.equal(
      code(() => recorded(store, t, t.keyId, "c7-b")),
      "db-corrupt",
    );
  });
});

test("sessionMode is checked with Object.hasOwn: inherited property names are refused", () => {
  const t = tempDir();
  try {
    for (const bad of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.equal(
        code(() =>
          SqliteSwainStore.open(join(t.dir, `${bad}.sqlite`), {
            sessionMode: bad as never,
            uid,
            nowMs: () => NOW,
          }),
        ),
        "db-io",
        bad,
      );
    }
  } finally {
    t.done();
  }
});

test("F8: after 64 used idempotency windows the key fails closed with db-idempotency-exhausted", () => {
  withStore((store) => {
    const t = localTenant(store);
    const idem = { route: "/api/v1/ingest/events", key: "full" };
    const DAY = 86_400_000;
    // each use after an expiry appends the next window row
    for (let i = 0; i < 64; i++) {
      const out = store.recordBatch(
        t.scope,
        t.keyId,
        batchOf(t, `w${i}`, {
          idempotency: idem,
          receivedMs: NOW + i * (DAY + 1),
          bodySha256: shaOf(`b${i}`),
          decodedSha256: shaOf(`d${i}`),
        }),
      );
      assert.equal(out.outcome, "created", `window ${i}`);
    }
    assert.equal(
      code(() =>
        store.recordBatch(
          t.scope,
          t.keyId,
          batchOf(t, "w64", {
            idempotency: idem,
            receivedMs: NOW + 64 * (DAY + 1),
            bodySha256: shaOf("b64"),
            decodedSha256: shaOf("d64"),
          }),
        ),
      ),
      "db-idempotency-exhausted",
    );
    // nothing was written by the refused call
    const raw = rawDb(store);
    try {
      const n = raw.prepare("SELECT COUNT(*) AS n FROM ingest_batches").get() as { n: number };
      assert.equal(Number(n.n), 64);
    } finally {
      raw.close();
    }
  });
});

test("runEvents reports the imports-truncated flag", () => {
  withStore((store) => {
    const t = localTenant(store);
    const put = store.putImport(t.scope, t.keyId, importPut("claude-code"), "add");
    const r = store.runEvents(t.scope, put.runId);
    assert.equal(r.truncated, false);
    assert.equal(r.sessions.length, 1);
  });
});

test("assertRowScope is observable: a run.agents statement that lost its scope is refused", () => {
  const dir = tempDir();
  const options = {
    randomBytes: counterRandom(),
    sessionMode: "team",
    uid,
    nowMs: () => NOW,
  } as const;
  const unscoped =
    "SELECT org_id, project_id, agent_id FROM run_agents WHERE ? IS NOT NULL AND ? IS NOT NULL AND run_id IS NOT NULL AND ? IS NOT NULL ORDER BY agent_id LIMIT ?";
  const store = openWithStatementOverrides(join(dir.dir, "o.sqlite"), options, {
    "run.agents": unscoped,
  });
  try {
    store.migrate({ nowIso: () => NOW_ISO });
    const a = localTenant(store);
    const b = seedTenant(store, "other");
    const ra = store.putImport(a.scope, a.keyId, importPut("claude-code"), "add");
    store.putImport(b.scope, b.keyId, importPut("claude-code"), "add");
    assert.equal(
      code(() => store.run(a.scope, ra.runId)),
      "db-scope-violation",
    );
  } finally {
    store.close();
    dir.done();
  }
  // the control: the real statement on the same data does not throw
  const ok = openStore(tempDir().dir);
  try {
    const a = localTenant(ok);
    const b = seedTenant(ok, "other");
    const ra = ok.putImport(a.scope, a.keyId, importPut("claude-code"), "add");
    ok.putImport(b.scope, b.keyId, importPut("claude-code"), "add");
    assert.ok(ok.run(a.scope, ra.runId) !== null);
  } finally {
    ok.close();
  }
});

test("brand switch: a forged span or log (never produced by applyContentPolicy) is refused", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "forge-1");
    const lb = recorded(store, t, t.keyId, "forge-2", { signal: "logs" });
    const real = spanOf(t);
    // a structural copy has the same fields but is not a stamped object
    const forged = { ...real, span: { ...real.span } } as typeof real;
    assert.equal(
      code(() => store.putOtelTraces(t.scope, t.keyId, b, [forged])),
      "db-constraint",
    );
    const realLog = logOf(t);
    const forgedLog = { ...realLog, log: { ...realLog.log } } as typeof realLog;
    assert.equal(
      code(() => store.putOtelLogs(t.scope, t.keyId, lb, [forgedLog])),
      "db-constraint",
    );
    // a real log is not a span, and a primitive is not a record
    assert.equal(
      code(() =>
        store.putOtelTraces(t.scope, t.keyId, b, [{ ...real, span: realLog.log } as never]),
      ),
      "db-constraint",
    );
    assert.equal(
      code(() => store.putOtelTraces(t.scope, t.keyId, b, [null as never])),
      "db-constraint",
    );
    // nothing was written, and the genuine records go through
    assert.equal(rowCount(store, "spans") + rowCount(store, "log_records"), 0);
    assert.equal(store.putOtelTraces(t.scope, t.keyId, b, [real]).inserted, 1);
    assert.equal(store.putOtelLogs(t.scope, t.keyId, lb, [realLog]).inserted, 1);
  });
});

function rowCount(store: SqliteSwainStore, table: string): number {
  const raw = rawDb(store);
  try {
    return Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    raw.close();
  }
}

test("brand switch: the record's policy must equal the project's stored policy", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "pol-1");
    const lb = recorded(store, t, t.keyId, "pol-2", { signal: "logs" });
    const mismatches = [
      { contentPolicy: "inline", maxInlineBytes: 65536 },
      { contentPolicy: "hash-only", maxInlineBytes: 1024 },
      { contentPolicy: "hash-only", maxInlineBytes: 65536, metadataPolicy: "allowlist" },
    ] as const;
    for (const policy of mismatches) {
      assert.equal(
        code(() => store.putOtelTraces(t.scope, t.keyId, b, [spanOf(t, { policy })])),
        "db-constraint",
        JSON.stringify(policy),
      );
      assert.equal(
        code(() => store.putOtelLogs(t.scope, t.keyId, lb, [logOf(t, { policy })])),
        "db-constraint",
        JSON.stringify(policy),
      );
    }
    assert.equal(rowCount(store, "spans") + rowCount(store, "log_records"), 0);
    // after the project policy changes to match, the same records are accepted
    store.setProjectPolicy(
      t.scope,
      { contentPolicy: "inline", maxInlineBytes: 1024 },
      { type: "owner", id: "o", at: NOW_ISO },
    );
    assert.equal(
      store.putOtelTraces(t.scope, t.keyId, b, [
        spanOf(t, { policy: { contentPolicy: "inline", maxInlineBytes: 1024 } }),
      ]).inserted,
      1,
    );
    // and the default-policy record is now the mismatch
    assert.equal(
      code(() => store.putOtelTraces(t.scope, t.keyId, b, [spanOf(t, { spanId: "1".repeat(16) })])),
      "db-constraint",
    );
  });
});

test("brand switch: columns come from the post-policy fields; the conflict record is the model JSON", () => {
  withStore((store) => {
    const t = localTenant(store);
    const k2 = extraKey(store, t);
    const b1 = recorded(store, t, t.keyId, "col-1");
    const b2 = recorded(store, t, k2, "col-2");
    const first = spanOf(t, {
      traceState: "a=b",
      attrs: { "gen_ai.operation.name": "invoke_agent" },
    });
    store.putOtelTraces(t.scope, t.keyId, b1, [first]);
    const other = spanOf(t, { name: "other", recordSha256: "d".repeat(64) });
    assert.equal(store.putOtelTraces(t.scope, k2, b2, [other]).conflicts, 1);
    const raw = rawDb(store);
    try {
      const row = raw
        .prepare("SELECT trace_state_json, name_json, attributes_json FROM spans")
        .get() as Record<string, string>;
      assert.equal(JSON.parse(row["trace_state_json"] ?? "").kind, "text");
      assert.equal(JSON.parse(row["trace_state_json"] ?? "").value, "a=b");
      assert.ok(Array.isArray(JSON.parse(row["attributes_json"] ?? "")));
      const c = raw
        .prepare("SELECT record_json FROM span_conflicts WHERE relation = 'conflicting'")
        .get() as { record_json: string };
      assert.equal(c.record_json, policyAppliedSpanJson(other.span));
    } finally {
      raw.close();
    }
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("B3: the statement-override test hook is not reachable from the package", () => {
  const src = new URL("../../src/", import.meta.url).pathname;
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    exports: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(pkg.exports), ["."], "package exports only the entry");
  // the exported class has no such static
  assert.deepEqual(
    Object.getOwnPropertyNames(SqliteSwainStore)
      .filter((n) => !["length", "name", "prototype"].includes(n))
      .sort(),
    ["open"],
  );
  const hook =
    /openWithStatementOverrides|internalOpenWithOverrides|sqlite\/testing|\.\/testing\.js/;
  const allowed = new Set(["sqlite/store.ts", "sqlite/testing.ts"]);
  for (const f of sourceFiles(src)) {
    const rel = f.slice(src.length);
    if (readFileSync(f, "utf8").match(hook) !== null) {
      assert.ok(allowed.has(rel), `${rel} references the test-only override path`);
    }
  }
  // the package entry does not even mention it, and nothing but the two modules above imports it
  assert.ok(!hook.test(readFileSync(join(src, "index.ts"), "utf8")));
});

test("N1.5: run, agent and import facts are checked against @swain/model; kinds are not interchangeable", () => {
  withStore((store) => {
    const t = localTenant(store);
    const b = recorded(store, t, t.keyId, "facts-1");
    const lb = recorded(store, t, t.keyId, "facts-2", { signal: "logs" });
    const real = spanOf(t);
    const refused = (put: unknown): string | undefined =>
      code(() => store.putOtelTraces(t.scope, t.keyId, b, [put as typeof real]));
    // a run ID that is not the one the model derives from the facts
    assert.equal(
      refused({ ...real, run: { ...real.run, adrSessionId: "x", kind: "session" } }),
      "db-constraint",
    );
    assert.equal(
      refused({ ...real, run: { ...real.run, traceId: "f".repeat(32) } }),
      "db-constraint",
    );
    assert.equal(
      refused({ ...real, run: { ...real.run, kind: "import", legacyImportId: "imp_x" } }),
      "db-constraint",
    );
    // an agent basis outside the model's set, a pinned key of the wrong form, a mismatched id
    assert.equal(
      refused({ ...real, agent: { ...real.agent, keyBasis: "attr:gen_ai.agent.name" } }),
      "db-constraint",
    );
    assert.equal(
      refused({ ...real, agent: { ...real.agent, agentKey: "free-text" } }),
      "db-constraint",
    );
    assert.equal(
      refused({ ...real, agent: { ...real.agent, keyBasis: "none", agentKey: "none" } }),
      "db-constraint",
    );
    // a span passed as a log and a log passed as a span
    const realLog = logOf(t);
    assert.equal(
      code(() =>
        store.putOtelLogs(t.scope, t.keyId, lb, [{ ...realLog, log: real.span } as never]),
      ),
      "db-constraint",
    );
    assert.equal(refused({ ...real, span: realLog.log }), "db-constraint");
    // a projected import ID must be an import ID
    assert.equal(
      code(() =>
        store.putOtelLogs(t.scope, t.keyId, lb, [{ ...realLog, projectedImportId: "free text" }]),
      ),
      "db-constraint",
    );
    assert.equal(rowCount(store, "spans") + rowCount(store, "log_records"), 0);
    // the genuine ones go through, and opClass/opJson are derived (the caller has no such fields)
    assert.equal(store.putOtelTraces(t.scope, t.keyId, b, [real]).inserted, 1);
    assert.ok(!("opClass" in real) && !("opJson" in real));
  });
});
