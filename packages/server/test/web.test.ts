/**
 * N1.6: server-rendered pages and local login (ADR-0007, ADR-0008) over real loopback HTTP.
 * Hostile cases: code replay, GET-only code use, cross-origin and cross-site POST, `next=`, XSS in
 * span names and attributes, expired and revoked sessions.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { hashSessionToken, issueLoginCode } from "../src/websession.js";
import { type Env, fixture, http, NOW0, postJson, type Reply, startEnv } from "./helpers.js";

const HOUR = 3_600_000;

function origin(env: Env): string {
  return `http://127.0.0.1:${env.srv.port}`;
}

function form(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

function cookieOf(r: Reply): string | null {
  const sc = r.headers["set-cookie"];
  const line = Array.isArray(sc) ? sc[0] : sc;
  const m = /^swain_session=([A-Za-z0-9_-]+);/.exec(line ?? "");
  return m?.[1] ?? null;
}

function code(env: Env, nextPath = "/"): string {
  return issueLoginCode(env.store, { orgId: env.orgId, nextPath, nowMs: env.clock.now });
}

async function login(env: Env, nextPath = "/"): Promise<string> {
  const c = code(env, nextPath);
  const f = form({ code: c });
  const r = await http(env.srv.port, {
    path: "/login",
    headers: { ...f.headers, Origin: origin(env) },
    body: f.body,
  });
  assert.equal(r.status, 303, r.text);
  const tok = cookieOf(r);
  assert.ok(tok !== null);
  return tok;
}

const get = (env: Env, path: string, tok: string | null): Promise<Reply> =>
  http(env.srv.port, {
    method: "GET",
    path,
    headers: tok === null ? {} : { Cookie: `swain_session=${tok}` },
  });

function csrfOf(html: string): string {
  const m = /name="csrf" value="([0-9a-f]{64})"/.exec(html);
  assert.ok(m?.[1] !== undefined, "page has a logout form with a csrf field");
  return m[1];
}

async function ingest(env: Env): Promise<void> {
  const r = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
  assert.equal(r.status, 200, r.text);
}

const TAGS = new Set([
  "html",
  "head",
  "meta",
  "title",
  "style",
  "body",
  "header",
  "div",
  "span",
  "a",
  "p",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "code",
  "dl",
  "dt",
  "dd",
  "details",
  "summary",
  "form",
  "button",
  "input",
  "label",
  "pre",
  "strong",
  "em",
  "br",
  "section",
  "fieldset",
  "legend",
]);
const ATTRS = new Set([
  "class",
  "id",
  "href",
  "lang",
  "charset",
  "name",
  "content",
  "http-equiv",
  "colspan",
  "type",
  "value",
  "method",
  "action",
  "title",
  "data-outcome",
  "data-provider",
  "for",
  "open",
  "rel",
  "checked",
]);

/** Structural check on the response bytes: only allowed tags and attributes, no script or handler. */
function violations(html: string): string[] {
  const bad: string[] = [];
  const text = html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  for (const m of text.matchAll(/<([^>]*)>/g)) {
    const inner = m[1] ?? "";
    const name = /^\/?([a-zA-Z0-9!]+)/.exec(inner)?.[1]?.toLowerCase() ?? "";
    if (name === "!doctype") continue;
    if (!TAGS.has(name)) bad.push(`tag ${inner.slice(0, 40)}`);
    for (const a of inner.replace(/="[^"]*"/g, "=").matchAll(/\s([a-zA-Z-]+)=?/g)) {
      const an = a[1] ?? "";
      if (!ATTRS.has(an)) bad.push(`attr ${an}`);
    }
  }
  if (/[<]/.test(text.replace(/<[^>]*>/g, ""))) bad.push("raw < in text");
  return bad;
}

test("GET /login shows a form and does not consume the code; POST consumes it once", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const c = code(env, "/runs");
    const page = await get(env, `/login?code=${c}`, null);
    assert.equal(page.status, 200);
    assert.match(page.text, /<form method="post" action="\/login">/);
    assert.equal(page.headers["set-cookie"], undefined, "a GET never sets a cookie");
    assert.match(String(page.headers["cache-control"]), /no-store/);
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.match(String(page.headers["content-security-policy"]), /form-action 'self'/);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    // fetching the page twice (a link preview, a prefetch) still leaves the code usable
    await get(env, `/login?code=${c}`, null);
    const f = form({ code: c });
    const post = await http(env.srv.port, {
      path: "/login",
      headers: { ...f.headers, Origin: origin(env) },
      body: f.body,
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers["location"], "/runs", "next_path is the server-side one");
    const line = String(post.headers["set-cookie"]);
    assert.match(
      line,
      /^swain_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=/,
    );
    assert.doesNotMatch(line, /Domain=/i);
    // replay
    const again = await http(env.srv.port, {
      path: "/login",
      headers: { ...f.headers, Origin: origin(env) },
      body: f.body,
    });
    assert.notEqual(again.status, 303);
    assert.equal(again.headers["set-cookie"], undefined);
  } finally {
    await env.done();
  }
});

test("a login code that reached the server only by GET never becomes a session", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const c = code(env);
    const r = await get(env, `/login?code=${c}`, null);
    assert.equal(r.headers["set-cookie"], undefined);
    const home = await get(env, "/", null);
    assert.notEqual(home.status, 200);
  } finally {
    await env.done();
  }
});

test("a query next= is ignored: the stored next_path wins", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const c = code(env, "/runs");
    const f = form({ code: c, next: "//evil.example/" });
    const r = await http(env.srv.port, {
      path: "/login?next=//evil.example/",
      headers: { ...f.headers, Origin: origin(env) },
      body: f.body,
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers["location"], "/runs");
  } finally {
    await env.done();
  }
});

test("cross-origin and cross-site login POSTs are refused and leave the code usable", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const c = code(env);
    const f = form({ code: c });
    for (const h of [
      { Origin: "http://evil.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site", Origin: origin(env) },
      {},
    ]) {
      const r = await http(env.srv.port, {
        path: "/login",
        headers: { ...f.headers, ...h },
        body: f.body,
      });
      assert.ok(r.status === 403, `${JSON.stringify(h)} -> ${r.status}`);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    const ok = await http(env.srv.port, {
      path: "/login",
      headers: { ...f.headers, Origin: origin(env), "Sec-Fetch-Site": "same-origin" },
      body: f.body,
    });
    assert.equal(ok.status, 303);
  } finally {
    await env.done();
  }
});

test("an unknown, malformed or expired code gives no session", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    for (const c of ["x", "A".repeat(43), "../../etc/passwd"]) {
      const f = form({ code: c });
      const r = await http(env.srv.port, {
        path: "/login",
        headers: { ...f.headers, Origin: origin(env) },
        body: f.body,
      });
      assert.notEqual(r.status, 303);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    const c = code(env);
    env.clock.now += 61_000;
    const f = form({ code: c });
    const r = await http(env.srv.port, {
      path: "/login",
      headers: { ...f.headers, Origin: origin(env) },
      body: f.body,
    });
    assert.notEqual(r.status, 303, "a code older than 60 s is dead");
  } finally {
    await env.done();
  }
});

test("every page needs a session: no cookie shows the sign-in hint and no data", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
    assert.ok(run !== undefined);
    for (const p of ["/", "/runs", `/r/${run.runId}`, `/a/${run.primaryAgentId}`]) {
      const r = await get(env, p, null);
      assert.notEqual(r.status, 200, p);
      assert.match(r.text, /swain open/, p);
      assert.doesNotMatch(r.text, /planner|run_[0-9a-f]{32}|agt_[0-9a-f]{32}/, p);
      assert.equal(r.headers["set-cookie"], undefined);
    }
    const bogus = await get(env, "/", "A".repeat(43));
    assert.notEqual(bogus.status, 200);
  } finally {
    await env.done();
  }
});

test("pages with a session: fleet, agent, runs list and run page show the data", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const tok = await login(env);
    const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
    assert.ok(run !== undefined);
    const fleet = await get(env, "/", tok);
    assert.equal(fleet.status, 200);
    assert.match(fleet.text, /planner/);
    assert.match(fleet.text, /active/);
    assert.match(fleet.text, new RegExp(env.key.keyId));
    assert.match(fleet.text, /class="wm">Swain</);
    assert.deepEqual(violations(fleet.text), []);
    const agent = await get(env, `/a/${run.primaryAgentId}`, tok);
    assert.equal(agent.status, 200);
    assert.match(agent.text, /planner/);
    assert.deepEqual(violations(agent.text), []);
    const runs = await get(env, "/runs", tok);
    assert.equal(runs.status, 200);
    assert.match(runs.text, new RegExp(run.runId));
    const page = await get(env, `/r/${run.runId}`, tok);
    assert.equal(page.status, 200);
    assert.match(page.text, /invoke_agent planner/);
    assert.match(page.text, /execute_tool search/);
    assert.match(page.text, new RegExp(env.key.keyId));
    assert.match(page.text, /best-effort masked/);
    assert.deepEqual(violations(page.text), []);
    // hash-only: the prompt body is not on the page, only its hash
    assert.match(page.text, /content not stored \(hash-only\)/);
    for (const r of [fleet, agent, runs, page]) {
      assert.match(String(r.headers["cache-control"]), /no-store/);
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.match(String(r.headers["content-security-policy"]), /default-src 'none'/);
      assert.doesNotMatch(String(r.headers["content-security-policy"]), /script-src|unsafe/);
      assert.doesNotMatch(
        r.text.replace(/<style>[\s\S]*?<\/style>/, ""),
        /<script|<img|<iframe|<[^>]*\son[a-z]+=/i,
      );
    }
  } finally {
    await env.done();
  }
});

test("IDs are validated: malformed and unknown IDs are 404 without echo", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const tok = await login(env);
    for (const p of [
      "/r/run_zz",
      "/r/<script>",
      "/a/agt_" + "0".repeat(32),
      "/r/run_" + "0".repeat(32),
      "/r/run_" + "0".repeat(32) + "?part=9",
      "/nope",
    ]) {
      const r = await get(env, p, tok);
      assert.equal(r.status, 404, p);
      assert.doesNotMatch(r.text, /<script/);
    }
  } finally {
    await env.done();
  }
});

test("XSS: hostile span names and attributes are escaped and the page stays CSP-clean", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const evil = "<script>alert(1)</script><img src=x onerror=alert(2)>\"'&";
    const body = fixture("traces-genai.json")
      .replace("invoke_agent planner", JSON.stringify(evil).slice(1, -1))
      .replace("synthetic tool failure", JSON.stringify('"><svg onload=alert(3)>').slice(1, -1));
    const r = await postJson(env.srv.port, "/v1/traces", env.key, body);
    assert.equal(r.status, 200, r.text);
    const tok = await login(env);
    const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
    assert.ok(run !== undefined);
    for (const p of ["/", `/a/${run.primaryAgentId}`, "/runs", `/r/${run.runId}`]) {
      const page = await get(env, p, tok);
      assert.equal(page.status, 200, p);
      assert.doesNotMatch(page.text, /<script|<img|<svg/i, p);
      assert.doesNotMatch(page.text, /<[^>]*\s(onerror|onload)=/i, p);
      assert.deepEqual(violations(page.text), [], p);
    }
    const run1 = await get(env, `/r/${run.runId}`, tok);
    assert.match(run1.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  } finally {
    await env.done();
  }
});

test("logout needs a session, a CSRF token and a same-origin request", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const tok = await login(env);
    const csrf = csrfOf((await get(env, "/", tok)).text);
    const post = (fields: Record<string, string>, h: Record<string, string>) => {
      const f = form(fields);
      return http(env.srv.port, {
        path: "/logout",
        headers: { ...f.headers, ...h },
        body: f.body,
      });
    };
    const ck = { Cookie: `swain_session=${tok}` };
    for (const [fields, h] of [
      [{}, { ...ck, Origin: origin(env) }],
      [{ csrf: "0".repeat(64) }, { ...ck, Origin: origin(env) }],
      [{ csrf }, { ...ck, Origin: "http://evil.example" }],
      [{ csrf }, { ...ck, "Sec-Fetch-Site": "cross-site" }],
      [{ csrf }, { ...ck }],
      [{ csrf }, { Origin: origin(env) }],
    ] as const) {
      const r = await post(fields, h);
      assert.ok(r.status === 403 || r.status === 401, `${JSON.stringify(h)} -> ${r.status}`);
    }
    assert.equal((await get(env, "/", tok)).status, 200, "still signed in after refused logouts");
    const ok = await post({ csrf }, { ...ck, Origin: origin(env) });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers["location"], "/");
    assert.match(String(ok.headers["set-cookie"]), /^swain_session=; .*Max-Age=0/);
    assert.notEqual((await get(env, "/", tok)).status, 200, "the old token is dead");
    // GET /logout is not a thing
    assert.notEqual((await get(env, "/logout", tok)).status, 200);
  } finally {
    await env.done();
  }
});

test("a session expires after 2 h idle and after 24 h absolute", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const idle = await login(env);
    env.clock.now += 2 * HOUR + 1000;
    assert.notEqual((await get(env, "/", idle)).status, 200, "idle");
    const busy = await login(env);
    for (let i = 0; i < 13; i++) {
      env.clock.now += HOUR + HOUR / 2;
      const r = await get(env, "/", busy);
      if (env.clock.now - NOW0 < 24 * HOUR) assert.equal(r.status, 200, `hour ${i}`);
    }
    env.clock.now = NOW0 + 100 * HOUR;
    assert.notEqual((await get(env, "/", busy)).status, 200, "absolute");
  } finally {
    await env.done();
  }
});

test("a revoked session no longer reads anything", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const tok = await login(env);
    assert.equal((await get(env, "/", tok)).status, 200);
    env.store.revokeSession(hashSessionToken(tok), env.clock.now);
    const r = await get(env, "/", tok);
    assert.notEqual(r.status, 200);
    assert.doesNotMatch(r.text, /planner/);
  } finally {
    await env.done();
  }
});

test("cookie-authenticated /api/v1/status needs Sec-Fetch-Site: same-origin", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const tok = await login(env);
    const ck = { Cookie: `swain_session=${tok}` };
    const no = await http(env.srv.port, { method: "GET", path: "/api/v1/status", headers: ck });
    assert.equal(no.status, 403);
    const cross = await http(env.srv.port, {
      method: "GET",
      path: "/api/v1/status",
      headers: { ...ck, "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(cross.status, 403);
    const ok = await http(env.srv.port, {
      method: "GET",
      path: "/api/v1/status",
      headers: { ...ck, "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(ok.status, 200, ok.text);
  } finally {
    await env.done();
  }
});

test("a run fed by two credentials says so in the header", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    await ingest(env);
    const second = env.newKey({ agentName: "planner" });
    const other = fixture("traces-genai.json")
      .replaceAll("00f067aa0ba902b7", "11f067aa0ba902b7")
      .replaceAll("53995c3f42cd8ad8", "13995c3f42cd8ad8")
      .replaceAll("b7ad6b7169203331", "17ad6b7169203331");
    const r = await postJson(env.srv.port, "/v1/traces", second, other);
    assert.equal(r.status, 200, r.text);
    const tok = await login(env);
    const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
    assert.ok(run !== undefined);
    const page = await get(env, `/r/${run.runId}`, tok);
    assert.equal(page.status, 200);
    assert.match(page.text, /multiple credentials contributed/);
    assert.match(page.text, new RegExp(env.key.keyId));
    assert.match(page.text, new RegExp(second.keyId));
  } finally {
    await env.done();
  }
});

test("wrong methods and a body on a GET page are refused", async () => {
  const env = await startEnv({ webAuth: "login" });
  try {
    const tok = await login(env);
    const put = await http(env.srv.port, {
      method: "PUT",
      path: "/",
      headers: { Cookie: `swain_session=${tok}` },
      body: "x",
    });
    assert.ok(put.status === 405 || put.status === 404, String(put.status));
    const post = await http(env.srv.port, {
      path: "/runs",
      headers: { Cookie: `swain_session=${tok}`, Origin: origin(env) },
      body: "x",
    });
    assert.notEqual(post.status, 200);
  } finally {
    await env.done();
  }
});
