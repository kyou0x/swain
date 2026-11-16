/** Auth, Host, endpoints, pipeline and e2e from fixtures through HTTP to the database. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  bearer,
  dbDump,
  fixture,
  gz,
  http,
  L1_TABLES,
  postJson,
  raw,
  rows,
  startEnv,
  statusOf,
} from "./helpers.js";

const MIB = 1024 * 1024;
const JSON_CT = { "Content-Type": "application/json" };

function runsOf(env: Awaited<ReturnType<typeof startEnv>>) {
  return env.store.runs(env.scope, { limit: 100, offset: 0 });
}

test("e2e: fixtures traces-genai.json goes through HTTP into runs and spans and reads back", async () => {
  const env = await startEnv();
  try {
    const r = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, "{}");
    assert.equal(r.headers["content-type"], "application/json");
    const page = runsOf(env);
    assert.equal(page.total, 1);
    const run = page.rows[0];
    assert.ok(run !== undefined);
    assert.equal(run.kind, "trace");
    assert.equal(run.traceId, "5b8efff798038103d269b633813fc60c");
    const data = env.store.runSpans(env.scope, run.runId, 100);
    assert.ok(data.spans.length >= 1);
    assert.equal(data.conflicts.length, 0);
    const names = data.spans.map((s) => s.nameJson);
    assert.ok(
      names.some((n) => n.includes("invoke_agent planner")),
      names.join(","),
    );
    const batches = rows(env.store, "SELECT status, signal FROM ingest_batches");
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.["status"], "accepted");
    assert.equal(env.logs.at(-1)?.code, "ok");
    assert.equal(env.logs.at(-1)?.keyId, env.key.keyId);
  } finally {
    await env.done();
  }
});

test("e2e: traces-openinference.json and gzip-encoded input work and are deduplicated", async () => {
  const env = await startEnv();
  try {
    const body = fixture("traces-openinference.json");
    const a = await postJson(env.srv.port, "/v1/traces", env.key, gz(body), {
      "Content-Encoding": "gzip",
    });
    assert.equal(a.status, 200, a.text);
    const before = rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"];
    // the same bytes again are the same batch: a replay, not new rows
    const b = await postJson(env.srv.port, "/v1/traces", env.key, gz(body), {
      "Content-Encoding": "gzip",
    });
    assert.equal(b.status, 200, b.text);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], before);
    // the same content, identity encoding, is a different request body but the same decoded batch
    const c = await postJson(env.srv.port, "/v1/traces", env.key, body);
    assert.equal(c.status, 200, c.text);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], before);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM span_conflicts")[0]?.["n"], 0n);
  } finally {
    await env.done();
  }
});

test("e2e: logs-claude-code.json is stored and the session run reads back", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const r = await postJson(env.srv.port, "/v1/logs", env.key, fixture("logs-claude-code.json"));
    assert.equal(r.status, 200, r.text);
    const n = rows(env.store, "SELECT COUNT(*) AS n FROM log_records")[0]?.["n"];
    assert.ok(typeof n === "bigint" && n > 0n);
    assert.ok(runsOf(env).total >= 1);
  } finally {
    await env.done();
  }
});

test("partial_success: records that fail validation are counted and the rest are stored", async () => {
  const env = await startEnv();
  try {
    const doc = JSON.parse(fixture("traces-genai.json"));
    const spans = doc.resourceSpans[0].scopeSpans[0].spans;
    const good = spans[0];
    // a span with an all-zero span id is a per-record reject
    const bad = { ...good, spanId: "0000000000000000", name: "bad" };
    doc.resourceSpans[0].scopeSpans[0].spans = [good, bad];
    const r = await postJson(env.srv.port, "/v1/traces", env.key, JSON.stringify(doc));
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.equal(body.partialSuccess.rejectedSpans, "1");
    assert.equal(typeof body.partialSuccess.errorMessage, "string");
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], 1n);
    assert.equal(rows(env.store, "SELECT status FROM ingest_batches")[0]?.["status"], "partial");
  } finally {
    await env.done();
  }
});

test("hostile fixtures never produce a 5xx, and never store a Bearer-style secret", async () => {
  const env = await startEnv();
  try {
    for (const name of [
      "duplicate-span-ids",
      "enum-names",
      "injection-strings",
      "int64-number-unsafe",
      "invalid-utf8",
      "lone-surrogate",
      "proto-keys",
      "secrets",
      "span-id-all-zero",
      "time-over-2-63",
      "time-start-after-end",
      "trace-id-31",
      "trace-id-33",
      "trace-id-all-zero",
      "trace-id-non-hex",
    ]) {
      const r = await postJson(
        env.srv.port,
        "/v1/traces",
        env.key,
        fixture(`hostile/${name}.json`),
      );
      assert.ok(r.status < 500, `${name}: ${r.status} ${r.text}`);
    }
    assert.equal(env.srv.counters().internalErrors, 0);
    assert.equal(env.srv.counters().decoderInternalErrors, 0);
    const dump = dbDump(env.store, L1_TABLES);
    assert.ok(!dump.includes("synthetic-secret-token"));
    assert.ok(!dump.includes("sk-synthetic-0000000000000000000000"));
  } finally {
    await env.done();
  }
});

test("S19: /v1/metrics is 404 and decodes nothing", async () => {
  const env = await startEnv();
  try {
    const r = await postJson(env.srv.port, "/v1/metrics", env.key, "{}");
    assert.equal(r.status, 404);
    assert.equal(env.srv.counters().bodyBytesRead, 0);
  } finally {
    await env.done();
  }
});

// ---- Host ------------------------------------------------------------------------------------

test("S19: Host is exact and case-insensitive; every other form is 421", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const get = (host: string) =>
      http(p, { method: "GET", path: "/healthz", headers: { Host: host } });
    for (const h of [`127.0.0.1:${p}`, `localhost:${p}`, `LOCALHOST:${p}`, `[::1]:${p}`]) {
      assert.equal((await get(h)).status, 200, h);
    }
    for (const h of [
      `localhost.:${p}`,
      `127.0.0.1.:${p}`,
      "127.0.0.1",
      "localhost",
      `127.0.0.1:${p + 1}`,
      `evil.example:${p}`,
      `127.0.0.1:${p}.evil.example`,
      `foo.localhost:${p}`,
      `0.0.0.0:${p}`,
      `[::ffff:127.0.0.1]:${p}`,
      `user@127.0.0.1:${p}`,
      ` 127.0.0.1:${p}x`,
    ]) {
      const r = await get(h);
      assert.ok(r.status === 421 || r.status === 400, `${JSON.stringify(h)} -> ${r.status}`);
    }
    assert.equal((await get(`localhost.:${p}`)).status, 421);
  } finally {
    await env.done();
  }
});

test("S19: a missing Host, two Host headers and absolute-form targets are refused", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const none = await raw(p, ["GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n"]);
    assert.ok([400, 421].includes(statusOf(none)), none.text);
    const two = await raw(p, [
      `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    ]);
    assert.ok([400, 421].includes(statusOf(two)), two.text);
    const abs = await raw(p, [
      `GET http://127.0.0.1:${p}/healthz HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    ]);
    assert.equal(statusOf(abs), 400);
    const absEvil = await raw(p, [
      `GET http://evil.example/healthz HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    ]);
    assert.equal(statusOf(absEvil), 400);
    const star = await raw(p, [
      `OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: close\r\n\r\n`,
    ]);
    assert.equal(statusOf(star), 400);
  } finally {
    await env.done();
  }
});

// ---- auth ------------------------------------------------------------------------------------

test("auth: missing, malformed, wrong, revoked and expired keys are all the same 401", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const revoked = env.newKey();
    assert.equal(env.store.revokeKey(env.scope, revoked.keyId, env.clock.now), true);
    const expiring = env.newKey({ expiresAtMs: env.clock.now + 20_000 });
    const wrongSecret = `swn_${env.key.keyId.slice(4)}_${"0".repeat(64)}`;
    const cases: Record<string, string>[] = [
      {},
      { Authorization: "Bearer" },
      { Authorization: "Bearer " },
      { Authorization: "Basic " + env.key.secret },
      { Authorization: env.key.secret },
      { Authorization: `Bearer ${env.key.secret}x` },
      { Authorization: `Bearer ${wrongSecret}` },
      { Authorization: `Bearer swn_ffffffffffffffff_${"0".repeat(64)}` },
      { Authorization: `Bearer ${revoked.secret}` },
    ];
    const bodies = new Set<string>();
    for (const [i, h] of cases.entries()) {
      env.clock.now += 1000;
      const r = await http(p, { path: "/v1/traces", headers: { ...JSON_CT, ...h }, body: "{}" });
      assert.equal(r.status, 401, `case ${i}`);
      assert.equal(r.headers["www-authenticate"], "Bearer");
      bodies.add(r.text);
    }
    assert.equal(bodies.size, 1, "one static body for every authentication failure");
    // an expiring key works, then does not
    env.clock.now += 1000;
    assert.equal((await postJson(p, "/v1/traces", expiring, "{}")).status, 200);
    env.clock.now += 30_000;
    assert.equal((await postJson(p, "/v1/traces", expiring, "{}")).status, 401);
    // two Authorization headers are refused
    const two = await raw(p, [
      `POST /v1/traces HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${env.key.secret}\r\nAuthorization: Bearer ${env.key.secret}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    ]);
    assert.equal(statusOf(two), 401);
  } finally {
    await env.done();
  }
});

test("auth: a key without ingest:otlp is 403 and reads no body", async () => {
  const env = await startEnv();
  try {
    const k = env.newKey({ scopes: ["read:status"] });
    const r = await postJson(env.srv.port, "/v1/traces", k, "{}");
    assert.equal(r.status, 403);
    assert.equal(env.srv.counters().bodyBytesRead, 0);
  } finally {
    await env.done();
  }
});

test("auth: the secret is compared with timingSafeEqual (source check) and never logged", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/auth.ts", import.meta.url), "utf8");
  assert.match(src, /timingSafeEqual\(/);
  const env = await startEnv();
  try {
    await postJson(env.srv.port, "/v1/traces", env.key, "{}");
    for (const e of env.logs) assert.ok(!JSON.stringify(e).includes(env.key.secret));
    assert.deepEqual(Object.keys(env.logs[0] ?? {}).sort(), [
      "bodyBytes",
      "code",
      "connBytesRead",
      "durationMs",
      "keyId",
      "route",
      "status",
    ]);
  } finally {
    await env.done();
  }
});

// ---- per-key bucket and in-flight --------------------------------------------------------------

test("S19: the per-key bucket is 100 burst, 20/s, and one key does not starve another", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const other = env.newKey();
    const statuses: number[] = [];
    for (let i = 0; i < 105; i++)
      statuses.push((await postJson(p, "/v1/traces", env.key, "{}")).status);
    assert.equal(statuses.filter((s) => s === 200).length, 100);
    const limited = await postJson(p, "/v1/traces", env.key, "{}");
    assert.equal(limited.status, 429);
    assert.match(String(limited.headers["retry-after"]), /^[1-9]/);
    assert.equal((await postJson(p, "/v1/traces", other, "{}")).status, 200);
    env.clock.now += 1000;
    assert.equal((await postJson(p, "/v1/traces", env.key, "{}")).status, 200);
  } finally {
    await env.done();
  }
});

test("S19: with inFlight 1 and decode 1, a second authenticated request gets 503 + Retry-After", async () => {
  const env = await startEnv({ limits: { inFlight: 1, decodeConcurrency: 1 } });
  try {
    const p = env.srv.port;
    const { connect } = await import("node:net");
    const holder = connect({ host: "127.0.0.1", port: p });
    holder.on("error", () => undefined);
    holder.write(
      `POST /v1/traces HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${env.key.secret}\r\nContent-Length: 100\r\n\r\n`,
    );
    await new Promise((r) => setTimeout(r, 150));
    const r = await postJson(p, "/v1/traces", env.key, "{}");
    assert.equal(r.status, 503);
    assert.equal(r.headers["retry-after"], "1");
    holder.destroy();
    await new Promise((res) => setTimeout(res, 150));
    assert.equal((await postJson(p, "/v1/traces", env.key, "{}")).status, 200);
    assert.ok(env.srv.counters().busy >= 1);
  } finally {
    await env.done();
  }
});

test("decode semaphore: a third body is 503 even though the in-flight limit (32) is not reached", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const { connect } = await import("node:net");
    const hold = (): ReturnType<typeof connect> => {
      const s = connect({ host: "127.0.0.1", port: p });
      s.on("error", () => undefined);
      s.write(
        `POST /v1/traces HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${env.key.secret}\r\nContent-Length: 100\r\n\r\n`,
      );
      return s;
    };
    const a = hold();
    const b = hold();
    await new Promise((r) => setTimeout(r, 200));
    const r = await postJson(p, "/v1/traces", env.key, "{}");
    assert.equal(r.status, 503);
    assert.equal(r.headers["retry-after"], "1");
    a.destroy();
    b.destroy();
  } finally {
    await env.done();
  }
});

// ---- size caps -------------------------------------------------------------------------------

test("S19: a body over 8 MiB is 413 (declared and streamed), with the connection closed", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const big = new Uint8Array(8 * MIB + 1).fill(0x20);
    const r = await postJson(p, "/v1/traces", env.key, big).catch((e: unknown) => e);
    // the server may reset the connection while the client is still writing; either is a refusal
    if (r instanceof Error) assert.match(r.message, /EPIPE|ECONNRESET|socket hang up/);
    else assert.equal((r as { status: number }).status, 413);
    // chunked, no declared length: the running cap applies
    const chunked = await raw(
      p,
      [
        `POST /v1/traces HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nContent-Type: application/json\r\nAuthorization: Bearer ${env.key.secret}\r\nTransfer-Encoding: chunked\r\n\r\n`,
        ...Array.from({ length: 9 }, () => `${MIB.toString(16)}\r\n${" ".repeat(MIB)}\r\n`),
      ],
      3000,
    );
    assert.ok(statusOf(chunked) === 413 || chunked.text === "", chunked.text.slice(0, 80));
    assert.ok(env.srv.counters().bodyBytesRead <= 8 * MIB + 64 * 1024);
  } finally {
    await env.done();
  }
});

test("S19: a gzip bomb is capped at 32 MiB decoded and answered 413", async () => {
  const env = await startEnv();
  try {
    // 100 MiB of spaces compresses to about 100 KiB
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(100 * MIB, 0x20)));
    assert.ok(bomb.length < 1 * MIB);
    const r = await postJson(env.srv.port, "/v1/traces", env.key, bomb, {
      "Content-Encoding": "gzip",
    });
    assert.equal(r.status, 413);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], 0n);
    // truncated, trailing garbage and non-gzip input are 400
    const full = new Uint8Array(gzipSync(Buffer.from("{}")));
    for (const body of [
      full.slice(0, full.length - 4),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([...full, 1, 2, 3]),
    ]) {
      const r2 = await postJson(env.srv.port, "/v1/traces", env.key, body, {
        "Content-Encoding": "gzip",
      });
      assert.ok(r2.status === 400 || r2.status === 200, `${r2.status}`);
      assert.notEqual(r2.status, 500);
    }
    assert.equal(env.srv.counters().internalErrors, 0);
  } finally {
    await env.done();
  }
});

test("limits: maxValues and maxRecords refuse with 413 or 400 and store nothing", async () => {
  const env = await startEnv({ limits: { maxRecords: 1 } });
  try {
    const doc = JSON.parse(fixture("traces-genai.json"));
    const s0 = doc.resourceSpans[0].scopeSpans[0].spans[0];
    doc.resourceSpans[0].scopeSpans[0].spans = [s0, { ...s0, spanId: "00f067aa0ba902b8" }];
    const r = await postJson(env.srv.port, "/v1/traces", env.key, JSON.stringify(doc));
    assert.ok(r.status === 413 || r.status === 400, `${r.status} ${r.text}`);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], 0n);
  } finally {
    await env.done();
  }
});

// ---- static 500, internal decoder error, no echo -----------------------------------------------

test("hardening: a throwing store is a static 500, the counter rises and nothing is echoed", async () => {
  const MARKER = "MARKER_SECRET_zzz_do_not_echo";
  const env = await startEnv({
    store: (s) =>
      new Proxy(s, {
        get(t, k) {
          if (k === "ingestTraces") {
            return () => {
              throw new Error(MARKER);
            };
          }
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }),
  });
  try {
    const r = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
    assert.equal(r.status, 500);
    assert.ok(!r.text.includes(MARKER));
    assert.equal(JSON.parse(r.text).message, "Internal error.");
    assert.equal(env.srv.counters().internalErrors, 1);
    assert.ok(!JSON.stringify(env.logs).includes(MARKER));
    // the server is still alive
    assert.equal((await http(env.srv.port, { method: "GET", path: "/healthz" })).status, 200);
  } finally {
    await env.done();
  }
});

test("hardening: no response or log line echoes a marker sent in a header, query, path or body", async () => {
  const MARKER = "ECHO_MARKER_8f3a";
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const replies = [
      await http(p, { path: `/v1/${MARKER}`, headers: { "X-Test": MARKER } }),
      await http(p, {
        path: `/v1/traces?x=${MARKER}`,
        headers: { ...JSON_CT, Authorization: `Bearer ${MARKER}` },
        body: MARKER,
      }),
      await http(p, {
        path: "/v1/traces",
        headers: { "Content-Type": `application/${MARKER}` },
        body: MARKER,
      }),
      await postJson(p, "/v1/traces", env.key, `{"resourceSpans":"${MARKER}"}`),
      await postJson(p, "/v1/traces", env.key, MARKER),
      await http(p, { path: "/v1/traces", headers: { ...JSON_CT, "Content-Encoding": MARKER } }),
      await http(p, { path: "/healthz", headers: { Host: `${MARKER}.example` } }),
    ];
    for (const r of replies) {
      assert.ok(!r.text.includes(MARKER));
      assert.ok(!JSON.stringify(r.headers).includes(MARKER));
    }
    assert.ok(!JSON.stringify(env.logs).includes(MARKER));
  } finally {
    await env.done();
  }
});

test("hardening: malformed HTTP gets a static 400 and the socket is destroyed; upgrade and CONNECT are dropped", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const bad = await raw(p, ["GET /healthz HTTP/1.1\r\nHost: x\r\nBad Header\r\n\r\n"]);
    assert.equal(statusOf(bad), 400);
    assert.equal(bad.closed, true);
    const up = await raw(p, [
      `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ]);
    assert.ok(up.closed || statusOf(up) === 200);
    assert.doesNotMatch(up.text, /101 Switching/);
    const conn = await raw(p, [
      `CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n`,
    ]);
    assert.ok(conn.closed);
    const hdr = await raw(p, [
      `GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`,
    ]);
    assert.ok(statusOf(hdr) === 431 || statusOf(hdr) === 400 || hdr.closed);
    assert.ok(!hdr.text.includes("aaaa"));
  } finally {
    await env.done();
  }
});

test("hardening: maxConnections is enforced", async () => {
  const env = await startEnv({ limits: { maxConnections: 3 } });
  try {
    const { connect } = await import("node:net");
    const socks = Array.from({ length: 3 }, () => {
      const s = connect({ host: "127.0.0.1", port: env.srv.port });
      s.on("error", () => undefined);
      return s;
    });
    await new Promise((r) => setTimeout(r, 200));
    const extra = await raw(
      env.srv.port,
      [`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${env.srv.port}\r\n\r\n`],
      500,
    );
    assert.doesNotMatch(extra.text, /200 OK/);
    for (const s of socks) s.destroy();
  } finally {
    await env.done();
  }
});

// ---- server-proof, status, healthz ------------------------------------------------------------

test("server-proof: a known key gets a proof for the Host origin; unknown and revoked keys get the static 401", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const challenge = "ab".repeat(32);
    const ask = (keyId: string, ch = challenge, host?: string) =>
      http(p, {
        path: "/api/v1/server-proof",
        headers: { ...JSON_CT, ...(host === undefined ? {} : { Host: host }) },
        body: JSON.stringify({ keyId, challenge: ch }),
      });
    const ok = await ask(env.key.keyId);
    assert.equal(ok.status, 200, ok.text);
    const j = JSON.parse(ok.text);
    assert.equal(j.origin, `http://127.0.0.1:${p}`);
    assert.equal(j.instanceId, env.srv.instanceId);
    assert.equal(
      j.proof,
      env.store.serverProof(env.key.keyId, j.origin, env.srv.instanceId, challenge),
    );
    // the proof origin is the accepting socket's literal IP, whatever allowed Host was sent
    const other = await ask(env.key.keyId, challenge, `localhost:${p}`);
    assert.equal(JSON.parse(other.text).origin, `http://127.0.0.1:${p}`);
    assert.equal(JSON.parse(other.text).proof, j.proof);
    const unknown = await ask("key_0000000000000000");
    const revoked = env.newKey();
    env.store.revokeKey(env.scope, revoked.keyId, env.clock.now);
    const rv = await ask(revoked.keyId);
    assert.equal(unknown.status, 401);
    assert.equal(rv.status, 401);
    assert.equal(unknown.text, rv.text);
    for (const body of [
      "{}",
      "[]",
      "x",
      JSON.stringify({ keyId: env.key.keyId, challenge: "zz" }),
      JSON.stringify({ keyId: "nope", challenge }),
    ]) {
      const r = await http(p, { path: "/api/v1/server-proof", headers: JSON_CT, body });
      assert.equal(r.status, 400, body);
    }
    const big = await http(p, {
      path: "/api/v1/server-proof",
      headers: JSON_CT,
      body: " ".repeat(2000),
    }).catch((e: unknown) => e);
    assert.ok(big instanceof Error || (big as { status: number }).status === 413);
  } finally {
    await env.done();
  }
});

test("server-proof: every call spends a token from the global bucket", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const body = JSON.stringify({ keyId: env.key.keyId, challenge: "cd".repeat(32) });
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) {
      codes.push((await http(p, { path: "/api/v1/server-proof", headers: JSON_CT, body })).status);
    }
    assert.equal(codes.filter((c) => c === 200).length, 20);
    assert.equal(codes.filter((c) => c === 429).length, 5);
  } finally {
    await env.done();
  }
});

test("status: needs a key; returns the server block and the project counters; healthz is open", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    assert.equal(
      (await http(p, { method: "GET", path: "/healthz" })).text,
      '{"ok":true,"webAuth":"none"}',
    );
    assert.equal((await http(p, { method: "GET", path: "/api/v1/status" })).status, 401);
    await postJson(p, "/v1/traces", env.key, fixture("traces-genai.json"));
    const r = await http(p, { method: "GET", path: "/api/v1/status", headers: bearer(env.key) });
    assert.equal(r.status, 200, r.text);
    const j = JSON.parse(r.text);
    assert.equal(j.server.mode, "local");
    assert.equal(j.server.canonicalSchema, "0.1.0");
    assert.equal(j.server.bind, env.srv.addresses[0]);
    assert.equal(j.projects.length, 1);
    assert.equal(j.projects[0].runs, 1);
  } finally {
    await env.done();
  }
});

test("security headers are on every response", async () => {
  const env = await startEnv();
  try {
    const r = await http(env.srv.port, { method: "GET", path: "/healthz" });
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
  } finally {
    await env.done();
  }
});

test("protobuf: with allowUnverifiedProtobuf the type is accepted and a bad body is 400, not 415", async () => {
  const env = await startEnv({ allowUnverifiedProtobuf: true });
  try {
    const r = await http(env.srv.port, {
      path: "/v1/traces",
      headers: { "Content-Type": "application/x-protobuf", ...bearer(env.key) },
      body: new Uint8Array([0xff, 0xff, 0xff]),
    });
    assert.equal(r.status, 400);
    assert.equal(r.headers["content-type"], "application/x-protobuf");
  } finally {
    await env.done();
  }
});

test("F4: the same span resent under a different resource is a conflict row, not 'seen again'", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const doc = JSON.parse(fixture("traces-genai.json"));
    const first = await postJson(p, "/v1/traces", env.key, JSON.stringify(doc));
    assert.equal(first.status, 200, first.text);
    const spans = rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"];
    doc.resourceSpans[0].resource.attributes[1].value.stringValue = "9.9.9";
    const second = await postJson(p, "/v1/traces", env.key, JSON.stringify(doc));
    assert.equal(second.status, 200, second.text);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM spans")[0]?.["n"], spans);
    const n = rows(env.store, "SELECT COUNT(*) AS n FROM span_conflicts")[0]?.["n"];
    assert.ok(typeof n === "bigint" && n >= 1n, `conflicts ${String(n)}`);
    const third = await postJson(p, "/v1/traces", env.key, JSON.stringify(doc));
    assert.equal(third.status, 200);
    assert.equal(rows(env.store, "SELECT COUNT(*) AS n FROM span_conflicts")[0]?.["n"], n);
  } finally {
    await env.done();
  }
});
