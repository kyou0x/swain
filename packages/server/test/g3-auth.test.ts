/**
 * G3-auth fixes: B1 (proof origin from the accepting socket, Host restricted to bound families),
 * B2 (owner proof), R1/F4 (aggregated login-failure audit; no pre-consume throttle) and F13
 * (redirect headers).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteSwainStore } from "@swain/db";
import { createSwainServer } from "../src/index.js";
import { issueLoginCode } from "../src/websession.js";
import { type Env, http, NOW_ISO, NOW0, rows, startEnv } from "./helpers.js";

const JSON_CT = { "Content-Type": "application/json" };
const CHALLENGE = "ab".repeat(32);

function proofReq(env: Env, body: unknown, host?: string, via = "127.0.0.1") {
  return http(
    env.srv.port,
    {
      path: "/api/v1/server-proof",
      headers: { ...JSON_CT, ...(host === undefined ? {} : { Host: host }) },
      body: JSON.stringify(body),
    },
    via,
  );
}

test("B1: bound to 127.0.0.1 only, a [::1] Host (or any other) gets no proof", async () => {
  const env = await startEnv({ host: "127.0.0.1" });
  try {
    const p = env.srv.port;
    // a squatter on [::1]:P relaying the challenge with the Host it saw
    for (const host of [`[::1]:${p}`, `[::1]:${p + 1}`, `127.0.0.1:${p + 1}`, "evil.example"]) {
      const r = await proofReq(env, { keyId: env.key.keyId, challenge: CHALLENGE }, host);
      assert.equal(r.status, 421, host);
      assert.doesNotMatch(r.text, /proof/, host);
    }
    // and the owner proof is refused the same way
    const o = await proofReq(env, { purpose: "owner", challenge: CHALLENGE }, `[::1]:${p}`);
    assert.equal(o.status, 421);
    // pages and every other route are refused for the unbound family too
    for (const path of ["/healthz", "/", "/login", "/api/v1/status"]) {
      const r = await http(p, { method: "GET", path, headers: { Host: `[::1]:${p}` } });
      assert.equal(r.status, 421, path);
    }
    // the honest request still works and names the socket's origin
    const ok = await proofReq(env, { keyId: env.key.keyId, challenge: CHALLENGE });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.text).origin, `http://127.0.0.1:${p}`);
  } finally {
    await env.done();
  }
});

test("B1: bound to ::1 only, a 127.0.0.1 Host is refused", async (t) => {
  let env: Env;
  try {
    env = await startEnv({ host: "::1" });
  } catch {
    t.skip("IPv6 loopback unavailable");
    return;
  }
  try {
    const p = env.srv.port;
    const r = await http(
      p,
      { method: "GET", path: "/healthz", headers: { Host: `127.0.0.1:${p}` } },
      "::1",
    );
    assert.equal(r.status, 421);
    const ok = await http(
      p,
      { method: "GET", path: "/healthz", headers: { Host: `[::1]:${p}` } },
      "::1",
    );
    assert.equal(ok.status, 200);
  } finally {
    await env.done();
  }
});

test("B1: the proof origin is the accepting socket's, whatever allowed Host is sent", async (t) => {
  const env = await startEnv();
  try {
    if (env.srv.warnings.includes("ipv6-unavailable")) {
      t.skip("IPv6 loopback unavailable");
      return;
    }
    const p = env.srv.port;
    // arrives on the ::1 socket with a 127.0.0.1 Host: the origin is still [::1]'s
    const v6 = await proofReq(
      env,
      { keyId: env.key.keyId, challenge: CHALLENGE },
      `127.0.0.1:${p}`,
      "::1",
    );
    assert.equal(v6.status, 200, v6.text);
    assert.equal(JSON.parse(v6.text).origin, `http://[::1]:${p}`);
    const v4 = await proofReq(
      env,
      { keyId: env.key.keyId, challenge: CHALLENGE },
      `[::1]:${p}`,
      "127.0.0.1",
    );
    assert.equal(JSON.parse(v4.text).origin, `http://127.0.0.1:${p}`);
    assert.notEqual(JSON.parse(v4.text).proof, JSON.parse(v6.text).proof);
  } finally {
    await env.done();
  }
});

test("B2: the owner proof answers only a valid owner challenge, under its own label", async () => {
  const env = await startEnv();
  try {
    const p = env.srv.port;
    const origin = `http://127.0.0.1:${p}`;
    // no server secret yet is impossible here (a key exists), so the answer is a proof
    const ok = await proofReq(env, { purpose: "owner", challenge: CHALLENGE });
    assert.equal(ok.status, 200, ok.text);
    const j = JSON.parse(ok.text);
    assert.equal(j.origin, origin);
    assert.equal(j.proof, env.store.ownerProof(origin, env.srv.instanceId, CHALLENGE));
    // distinct from the key-bound proof
    const k = await proofReq(env, { keyId: env.key.keyId, challenge: CHALLENGE });
    assert.notEqual(JSON.parse(k.text).proof, j.proof);
    for (const body of [
      { purpose: "owner", keyId: env.key.keyId, challenge: CHALLENGE },
      { purpose: "admin", challenge: CHALLENGE },
      { purpose: "owner", challenge: "zz" },
      { purpose: "owner" },
      { challenge: CHALLENGE },
    ]) {
      const r = await proofReq(env, body);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
  } finally {
    await env.done();
  }
});

async function badLogin(env: Env, code: string): Promise<number> {
  const r = await http(env.srv.port, {
    path: "/login",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: `http://127.0.0.1:${env.srv.port}`,
    },
    body: new URLSearchParams({ code }).toString(),
  });
  return r.status;
}

test("R1: draining the global failure bucket cannot lock out a valid login; real failures are audited per minute", async () => {
  const env = await startEnv({ webAuth: "login", limits: { unauthBurst: 2, unauthPerSec: 1 } });
  try {
    const good = issueLoginCode(env.store, {
      orgId: env.orgId,
      nextPath: "/",
      nowMs: env.clock.now,
    });
    // bad Bearer floods and session-less page GETs both spend the shared bucket
    for (let i = 0; i < 5; i++) {
      await http(env.srv.port, {
        path: "/v1/traces",
        headers: { ...JSON_CT, Authorization: `Bearer swn_${"0".repeat(16)}_${"0".repeat(64)}` },
        body: "{}",
      });
      await http(env.srv.port, { method: "GET", path: "/" });
    }
    const drained = await http(env.srv.port, { method: "GET", path: "/" });
    assert.equal(drained.status, 429, "the bucket is empty");
    // a valid code is consumed first and still logs in; the bucket is charged only by failures
    assert.equal(await badLogin(env, good), 303);
    // a real failure now gets 429 (bucket empty) and is counted
    assert.equal(await badLogin(env, "A".repeat(43)), 429);
    env.clock.now += 120_000;
    assert.equal(await badLogin(env, "B".repeat(43)), 401, "refilled after two minutes");
    await env.srv.close();
    const failures = rows(
      env.store,
      "SELECT action, detail_json FROM audit_log ORDER BY seq",
    ).filter((r) => r["action"] === "login.failure");
    assert.equal(failures.length, 2, "one aggregate per minute, for real failures only");
    const counts = failures.map(
      (r) => (JSON.parse(String(r["detail_json"])) as { count: number }).count,
    );
    assert.deepEqual(counts, [1, 1]);
  } finally {
    await env.done();
  }
});

test("R1: the login-failure audit never creates tenancy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "swain-notenancy-"));
  const store = SqliteSwainStore.open(join(dir, "swain.sqlite"), {
    sessionMode: "local",
    uid: (process.getuid as () => number)(),
    nowMs: () => NOW0,
  });
  store.migrate({ nowIso: () => NOW_ISO });
  const srv = await createSwainServer({
    store,
    nowMs: () => NOW0,
    port: 0,
    host: "127.0.0.1",
    webAuth: "login",
  });
  try {
    const r = await http(srv.port, {
      path: "/login",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: `http://127.0.0.1:${srv.port}`,
      },
      body: new URLSearchParams({ code: "A".repeat(43) }).toString(),
    });
    assert.equal(r.status, 401);
    await srv.close();
    assert.equal(store.findLocalOrg(), null, "no org was created");
    assert.deepEqual(rows(store, "SELECT org_id FROM orgs"), []);
    assert.deepEqual(rows(store, "SELECT seq FROM audit_log"), []);
  } finally {
    await srv.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F13: a login redirect carries the same isolation headers as a page", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const c = issueLoginCode(env.store, {
      orgId: env.orgId,
      nextPath: "/runs",
      nowMs: env.clock.now,
    });
    const r = await http(env.srv.port, {
      path: "/login",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: `http://127.0.0.1:${env.srv.port}`,
      },
      body: new URLSearchParams({ code: c }).toString(),
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(r.headers["cache-control"], "no-store");
  } finally {
    await env.done();
  }
});
