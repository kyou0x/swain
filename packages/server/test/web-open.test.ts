/**
 * Owner decision 2026-11-16: the pages need no login (`webAuth: "none"`, the default). What still
 * protects them is tested here over real loopback HTTP: the Host allowlist (DNS rebinding), the
 * Sec-Fetch rule, no CORS, the isolation headers, ID validation and escaping. `/login` and
 * `/logout` do not exist in this mode. The `--require-login` behaviour stays in `web.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bearer,
  type Env,
  fixture,
  http,
  postJson,
  type Reply,
  raw,
  startEnv,
  statusOf,
} from "./helpers.js";

async function seeded(): Promise<{ env: Env; paths: string[] }> {
  const env = await startEnv();
  const r = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
  assert.equal(r.status, 200, r.text);
  const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
  assert.ok(run !== undefined);
  return { env, paths: ["/", "/runs", `/r/${run.runId}`, `/a/${run.primaryAgentId}`] };
}

const get = (env: Env, path: string, headers: Record<string, string> = {}): Promise<Reply> =>
  http(env.srv.port, { method: "GET", path, headers });

test("default mode: every page is 200 without a cookie, with no sign-in or sign-out chrome", async () => {
  const { env, paths } = await seeded();
  try {
    for (const p of paths) {
      const r = await get(env, p);
      assert.equal(r.status, 200, p);
      assert.match(r.text, /planner|run_[0-9a-f]{32}/, p);
      assert.doesNotMatch(r.text, /Sign out|Sign in|name="csrf"|action="\/logout"|<form/i, p);
      assert.equal(r.headers["set-cookie"], undefined, p);
      // a stray cookie changes nothing
      assert.equal((await get(env, p, { Cookie: `swain_session=${"A".repeat(43)}` })).status, 200);
    }
  } finally {
    await env.done();
  }
});

test("default mode: /login and /logout are 404 for every method and set no cookie", async () => {
  const env = await startEnv();
  try {
    for (const p of ["/login", `/login?code=${"A".repeat(43)}`, "/logout"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const r = await http(env.srv.port, {
          method,
          path: p,
          headers: { Origin: `http://127.0.0.1:${env.srv.port}`, "Content-Length": "0" },
        });
        assert.equal(r.status, 404, `${method} ${p}`);
        assert.equal(r.headers["set-cookie"], undefined);
      }
    }
  } finally {
    await env.done();
  }
});

test("default mode: a wrong Host (evil, rebinding, trailing dot, duplicate, missing) is 421", async () => {
  const { env, paths } = await seeded();
  const p = env.srv.port;
  try {
    const hosts = [
      "evil.example",
      `evil.example:${p}`,
      `127.0.0.1.evil.example:${p}`,
      `localhost.evil.example:${p}`,
      `localhost.:${p}`,
      `127.0.0.1:${p + 1}`,
      "127.0.0.1",
      `0.0.0.0:${p}`,
    ];
    for (const path of paths) {
      for (const h of hosts) {
        const r = await get(env, path, { Host: h });
        assert.equal(r.status, 421, `${h} ${path}`);
        assert.doesNotMatch(r.text, /planner/);
      }
    }
    const dup = await raw(p, [
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${p}\r\nHost: evil.example\r\nConnection: close\r\n\r\n`,
    ]);
    assert.equal(statusOf(dup), 421);
    const none = await raw(p, ["GET / HTTP/1.1\r\nConnection: close\r\n\r\n"]);
    assert.equal(statusOf(none), 421);
  } finally {
    await env.done();
  }
});

test("default mode: bound to 127.0.0.1 only, a [::1] Host gets 421 on the pages", async () => {
  const env = await startEnv({ host: "127.0.0.1" });
  try {
    const r = await get(env, "/", { Host: `[::1]:${env.srv.port}` });
    assert.equal(r.status, 421);
    assert.equal((await get(env, "/")).status, 200);
  } finally {
    await env.done();
  }
});

test("default mode: Sec-Fetch rule on pages (cross-site and same-site only as top-level navigation)", async () => {
  const { env, paths } = await seeded();
  try {
    for (const path of paths) {
      for (const site of ["cross-site", "same-site"]) {
        for (const h of [
          { "Sec-Fetch-Mode": "no-cors" },
          { "Sec-Fetch-Mode": "cors" },
          { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" },
          { "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "image" },
          { "Sec-Fetch-Mode": "navigate" },
          { "Sec-Fetch-Dest": "document" },
          {},
        ]) {
          const r = await get(env, path, { "Sec-Fetch-Site": site, ...h });
          assert.equal(r.status, 403, `${site} ${JSON.stringify(h)} ${path}`);
          assert.doesNotMatch(r.text, /planner/);
        }
        const nav = await get(env, path, {
          "Sec-Fetch-Site": site,
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        });
        assert.equal(nav.status, 200, `top-level navigation ${site} ${path}`);
      }
      for (const site of ["same-origin", "none"]) {
        assert.equal((await get(env, path, { "Sec-Fetch-Site": site })).status, 200, site);
      }
      assert.equal((await get(env, path, { "Sec-Fetch-Site": "bogus" })).status, 403);
    }
    const dup = await raw(env.srv.port, [
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${env.srv.port}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Site: cross-site\r\nConnection: close\r\n\r\n`,
    ]);
    assert.equal(statusOf(dup), 403);
  } finally {
    await env.done();
  }
});

test("default mode: /api/v1/status keeps its key; a cross-site fetch is 403 even as a navigation", async () => {
  const { env } = await seeded();
  try {
    const st = (h: Record<string, string>): Promise<Reply> =>
      get(env, "/api/v1/status", { ...bearer(env.key), ...h });
    assert.equal((await get(env, "/api/v1/status")).status, 401, "no key, no status");
    // not a browser (what swain status sends): no Sec-Fetch headers at all
    assert.equal((await st({})).status, 200);
    assert.equal((await st({ "Sec-Fetch-Site": "same-origin" })).status, 200);
    assert.equal((await st({ "Sec-Fetch-Site": "none" })).status, 200);
    for (const site of ["cross-site", "same-site", "bogus"]) {
      assert.equal((await st({ "Sec-Fetch-Site": site })).status, 403, site);
    }
    const nav = await st({
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
    });
    assert.equal(nav.status, 403, "no navigation exception for JSON");
    // a cookie is not a credential in this mode
    const ck = await get(env, "/api/v1/status", {
      Cookie: `swain_session=${"A".repeat(43)}`,
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(ck.status, 401);
    const evil = await get(env, "/api/v1/status", { Host: "evil.example", ...bearer(env.key) });
    assert.equal(evil.status, 421);
  } finally {
    await env.done();
  }
});

test("default mode: no CORS headers, isolation headers on every page, preflight gets nothing", async () => {
  const { env, paths } = await seeded();
  try {
    for (const p of paths) {
      const r = await get(env, p, { Origin: "http://evil.example" });
      assert.equal(r.status, 200);
      for (const h of Object.keys(r.headers)) assert.doesNotMatch(h, /^access-control-/i);
      assert.match(String(r.headers["content-security-policy"]), /frame-ancestors 'none'/);
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
      assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.match(String(r.headers["cache-control"]), /no-store/);
    }
    const pre = await http(env.srv.port, {
      method: "OPTIONS",
      path: "/",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "GET" },
    });
    assert.notEqual(pre.status, 200);
    for (const h of Object.keys(pre.headers)) assert.doesNotMatch(h, /^access-control-/i);
  } finally {
    await env.done();
  }
});

test("default mode: IDs are validated and hostile span content is escaped", async () => {
  const env = await startEnv();
  try {
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>\"'&";
    const body = fixture("traces-genai.json").replace(
      "invoke_agent planner",
      JSON.stringify(evil).slice(1, -1),
    );
    assert.equal((await postJson(env.srv.port, "/v1/traces", env.key, body)).status, 200);
    const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
    assert.ok(run !== undefined);
    for (const p of ["/", `/a/${run.primaryAgentId}`, "/runs", `/r/${run.runId}`]) {
      const page = await get(env, p);
      assert.equal(page.status, 200, p);
      assert.doesNotMatch(page.text, /<script|<img|<[^>]*\s(onerror|onload)=/i, p);
    }
    assert.match(
      (await get(env, `/r/${run.runId}`)).text,
      /&lt;script&gt;alert\(1\)&lt;\/script&gt;/,
    );
    for (const p of ["/r/run_zz", "/r/<script>", `/a/agt_${"0".repeat(32)}`, "/nope"]) {
      const r = await get(env, p);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /<script/);
    }
  } finally {
    await env.done();
  }
});

test("healthz advertises the web mode; wrong methods on pages are refused", async () => {
  const none = await startEnv();
  const login = await startEnv({ webAuth: "login" });
  try {
    assert.equal((await get(none, "/healthz")).text, '{"ok":true,"webAuth":"none"}');
    assert.equal((await get(login, "/healthz")).text, '{"ok":true,"webAuth":"login"}');
    const post = await http(none.srv.port, { path: "/runs", body: "x" });
    assert.equal(post.status, 405);
  } finally {
    await none.done();
    await login.done();
  }
});
