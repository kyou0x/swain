/**
 * Hostile ordering (ADR-0006 section 5a, F1): the steps run in order and a failed step ends the
 * request, so an unauthenticated sender can never make the server read, buffer or decompress a body.
 */
import assert from "node:assert/strict";
import { connect } from "node:net";
import { test } from "node:test";
import { bearer, type Credential, http, postJson, raw, startEnv, statusOf } from "./helpers.js";

const MIB = 1024 * 1024;

const head = (port: number, lines: readonly string[]): string =>
  `${lines.join("\r\n")}\r\nHost: 127.0.0.1:${port}\r\n\r\n`;

test("S19: an unauthenticated 64 MiB gzip body gets 401 and its body is never read", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    const headers = [
      "POST /v1/traces HTTP/1.1",
      "Content-Type: application/json",
      "Content-Encoding: gzip",
      `Content-Length: ${64 * MIB}`,
    ];
    // announce 64 MiB and send the first 32 KiB; the server must answer without waiting for more
    const r = await raw(port, [head(port, headers), new Uint8Array(32 * 1024).fill(0x1f)]);
    assert.equal(statusOf(r), 401);
    assert.match(r.text, /WWW-Authenticate: Bearer/i);
    assert.match(r.text, /Connection: close/i);
    assert.equal(env.srv.counters().bodyBytesRead, 0);
    const ev = env.logs.at(-1);
    assert.equal(ev?.status, 401);
    assert.equal(ev?.bodyBytes, 0);
    assert.equal(ev?.code, "unauthenticated");
    assert.equal(ev?.keyId, null);
  } finally {
    await env.done();
  }
});

test("F1: a sender that keeps streaming an 8 MiB body is cut off after headers + 64 KiB", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    const header = head(port, [
      "POST /v1/logs HTTP/1.1",
      "Content-Type: application/json",
      `Content-Length: ${8 * MIB}`,
    ]);
    const sock = connect({ host: "127.0.0.1", port });
    let reply = "";
    sock.on("data", (d: Buffer) => {
      reply += d.toString("latin1");
    });
    sock.on("error", () => undefined);
    const closed = new Promise<void>((r) => sock.on("close", () => r()));
    sock.write(header);
    // keep writing 64 KiB chunks until the server hangs up (at most the full 8 MiB)
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        if (sock.destroyed || sent >= 8 * MIB) {
          resolve();
          return;
        }
        sent += chunk.length;
        sock.write(chunk, () => setImmediate(pump));
      };
      pump();
    });
    sock.destroy();
    await closed;
    // the server hangs up with unread input, so the 401 may be lost to a reset; it is never a 2xx
    assert.match(reply, /^(HTTP\/1\.1 401.*)?$/s);
    assert.equal(env.srv.counters().bodyBytesRead, 0);
    const ev = env.logs.at(-1);
    assert.ok(ev !== undefined);
    assert.ok(
      ev.connBytesRead <= header.length + 64 * 1024,
      `server consumed ${ev.connBytesRead} bytes, limit ${header.length + 64 * 1024}`,
    );
  } finally {
    await env.done();
  }
});

test("F1: a body is never acknowledged to an unauthenticated Expect: 100-continue; an authenticated one is", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    const ok = [
      "POST /v1/traces HTTP/1.1",
      "Content-Type: application/json",
      "Expect: 100-continue",
      "Content-Length: 2",
    ];
    const unauth = await raw(port, [head(port, ok)]);
    assert.equal(statusOf(unauth), 401);
    assert.doesNotMatch(unauth.text, /100 Continue/);
    const authed = await raw(
      port,
      [head(port, [...ok, `Authorization: Bearer ${env.key.secret}`])],
      500,
    );
    assert.match(authed.text, /^HTTP\/1\.1 100 Continue/);
  } finally {
    await env.done();
  }
});

test("step order: Host (421) beats route (404), cookie (400), type (415) and auth (401)", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    const r = await http(port, {
      path: "/nope",
      headers: { Host: "evil.example", Cookie: "a=b", "Content-Type": "text/plain" },
    });
    assert.equal(r.status, 421);
    const r2 = await http(port, {
      path: "/v1/traces",
      headers: { Host: "evil.example", Cookie: "a=b", "Content-Type": "text/plain" },
    });
    assert.equal(r2.status, 421);
  } finally {
    await env.done();
  }
});

test("step order: route (404/405) beats cookie, type and auth", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    const cookie = { Cookie: "s=1", "Content-Type": "text/plain" };
    assert.equal((await http(port, { path: "/v1/nope", headers: cookie })).status, 404);
    assert.equal(
      (await http(port, { method: "GET", path: "/v1/traces", headers: cookie })).status,
      405,
    );
    assert.equal(
      (await http(port, { method: "PUT", path: "/v1/logs", headers: cookie })).status,
      405,
    );
    const post = await http(port, { path: "/healthz", headers: cookie });
    assert.equal(post.status, 405);
    assert.equal(post.headers["allow"], "GET");
    // /v1/metrics is a loud 404 for any method, before everything else
    for (const method of ["POST", "GET", "PUT", "DELETE"]) {
      const m = await http(port, { method, path: "/v1/metrics", headers: cookie });
      assert.equal(m.status, 404, method);
    }
    // exact paths only
    for (const path of [
      "/v1/traces/",
      "/V1/traces",
      "/v1//traces",
      "/v1/traces%2f",
      "//v1/traces",
      "/v1/trace",
    ]) {
      assert.equal((await http(port, { path })).status, 404, path);
    }
  } finally {
    await env.done();
  }
});

test("S19: a Cookie on an ingest route is 400 before content type and auth", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    for (const path of ["/v1/traces", "/v1/logs"]) {
      // no auth at all, and a bad content type: the cookie is what is reported
      const r = await http(port, {
        path,
        headers: { Cookie: "swain_session=abc", "Content-Type": "text/plain" },
      });
      assert.equal(r.status, 400, path);
      assert.equal(JSON.parse(r.text).message, ERR("cookie-on-ingest"));
      // with a valid key it is still rejected
      const r2 = await http(port, {
        path,
        headers: { Cookie: "a=b", "Content-Type": "application/json", ...bearer(env.key) },
        body: "{}",
      });
      assert.equal(r2.status, 400);
      // an empty Cookie header counts too
      const r3 = await raw(port, [
        head(port, [
          `POST ${path} HTTP/1.1`,
          "Cookie:",
          "Content-Type: application/json",
          "Content-Length: 0",
          "Connection: close",
        ]),
      ]);
      assert.equal(statusOf(r3), 400);
    }
    assert.equal(env.srv.counters().bodyBytesRead, 0);
  } finally {
    await env.done();
  }
});

const ERR = (code: string): string => {
  const m: Record<string, string> = {
    "cookie-on-ingest": "Ingest requests must not carry cookies.",
  };
  return m[code] ?? "";
};

test("step 4: a bad content type is 415 before auth, and so is a bad Content-Encoding", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    for (const ct of [
      "text/plain",
      "application/jsonx",
      "application/json, application/json",
      "application/json; charset=latin1",
      "",
    ]) {
      const r = await http(port, {
        path: "/v1/traces",
        headers: ct === "" ? {} : { "Content-Type": ct },
        body: "{}",
      });
      assert.equal(r.status, 415, JSON.stringify(ct));
    }
    // a duplicated Content-Type is refused (Node would silently keep the first)
    const dup = await raw(port, [
      head(port, [
        "POST /v1/traces HTTP/1.1",
        "Content-Type: application/json",
        "Content-Type: application/json",
        "Content-Length: 0",
        "Connection: close",
      ]),
    ]);
    assert.equal(statusOf(dup), 415);
    for (const ce of [
      "GZIP",
      "gzip, identity",
      "gzip, gzip",
      "br",
      "deflate",
      "identity, gzip",
      "gzip;q=1",
      "",
    ]) {
      const r = await http(port, {
        path: "/v1/traces",
        headers: { "Content-Type": "application/json", "Content-Encoding": ce },
        body: "{}",
      });
      assert.equal(r.status, 415, JSON.stringify(ce));
      assert.equal(JSON.parse(r.text).code, 3);
      // and with a valid key too
      const r2 = await http(port, {
        path: "/v1/traces",
        headers: { "Content-Type": "application/json", "Content-Encoding": ce, ...bearer(env.key) },
        body: "{}",
      });
      assert.equal(r2.status, 415, JSON.stringify(ce));
    }
    // two Content-Encoding fields are joined by Node as "gzip, gzip": refused
    const twice = await raw(port, [
      head(port, [
        "POST /v1/traces HTTP/1.1",
        "Content-Type: application/json",
        "Content-Encoding: gzip",
        "Content-Encoding: gzip",
        "Content-Length: 0",
        "Connection: close",
      ]),
    ]);
    assert.equal(statusOf(twice), 415);
    assert.equal(env.srv.counters().bodyBytesRead, 0);
    assert.equal(env.srv.counters().unauthenticated, 0, "415 is not an authentication failure");
  } finally {
    await env.done();
  }
});

test("protobuf is disabled by default: 415 with a static body that names http/json", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    for (const headers of [
      { "Content-Type": "application/x-protobuf" },
      { "Content-Type": "application/x-protobuf", ...bearer(env.key) },
    ]) {
      const r = await http(port, { path: "/v1/traces", headers, body: new Uint8Array(0) });
      assert.equal(r.status, 415);
      assert.match(r.text, /http\/json/);
      assert.match(r.text, /OTEL_EXPORTER_OTLP_PROTOCOL/);
      assert.equal(r.headers["content-type"], "application/json");
      assert.equal(JSON.parse(r.text).code, 3);
    }
    assert.equal(env.srv.counters().bodyBytesRead, 0);
  } finally {
    await env.done();
  }
});

test("S19: unauthenticated floods hit the one global bucket and never take a slot or a body", async () => {
  const env = await startEnv({ limits: { inFlight: 1 } });
  try {
    const port = env.srv.port;
    const auth = (): Credential => env.key;
    // hold the only in-flight slot: authenticated, body announced but not sent
    const holder = connect({ host: "127.0.0.1", port });
    holder.on("error", () => undefined);
    holder.write(
      head(port, [
        "POST /v1/traces HTTP/1.1",
        "Content-Type: application/json",
        `Authorization: Bearer ${auth().secret}`,
        "Content-Length: 1000",
      ]),
    );
    await new Promise((r) => setTimeout(r, 100));
    // 50 concurrent unauthenticated requests with huge announced bodies
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        raw(
          port,
          [
            head(port, [
              "POST /v1/logs HTTP/1.1",
              "Content-Type: application/json",
              "Authorization: Bearer swn_0000000000000000_" + "0".repeat(64),
              `Content-Length: ${8 * MIB}`,
            ]),
          ],
          800,
        ),
      ),
    );
    const codes = results.map(statusOf);
    assert.equal(codes.filter((c) => c === 401).length, 20, "burst of 20");
    assert.equal(codes.filter((c) => c === 429).length, 30);
    assert.equal(
      codes.filter((c) => c === 503).length,
      0,
      "an unauthenticated request never needs a slot",
    );
    for (const r of results.filter((x) => statusOf(x) === 429))
      assert.match(r.text, /Retry-After: [1-9]/i);
    const c = env.srv.counters();
    assert.equal(c.unauthenticated, 20);
    assert.equal(c.rateLimitedGlobal, 30);
    assert.equal(c.busy, 0);
    assert.equal(c.bodyBytesRead, 0);
    holder.destroy();
    // the bucket refills with the injected clock: 5 per second
    env.clock.now += 1000;
    const again = await http(port, {
      path: "/v1/traces",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(again.status, 401);
  } finally {
    await env.done();
  }
});

test("N1.5 G3 F1: a flood of failed authentications never locks out a valid key", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    // another client (a browser page, say) hammers /v1 and /api/v1/status without a key
    for (let i = 0; i < 60; i++) {
      await http(port, { method: "GET", path: "/api/v1/status" });
      await http(port, {
        path: "/v1/traces",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    }
    const c = env.srv.counters();
    assert.equal(c.unauthenticated, 20, "the failure bucket (burst 20) is spent");
    assert.ok(c.rateLimitedGlobal >= 1, "and later failures are answered 429");
    // yet the valid key keeps getting through, on ingest and on status
    for (const path of ["/v1/traces", "/v1/logs"]) {
      const ok = await http(port, {
        path,
        headers: { "Content-Type": "application/json", ...bearer(env.key) },
        body: "{}",
      });
      assert.equal(ok.status, 200, path);
    }
    const st = await http(port, {
      method: "GET",
      path: "/api/v1/status",
      headers: bearer(env.key),
    });
    assert.equal(st.status, 200);
    // a failure while the bucket is empty is 429 with Retry-After, and a valid key still passes
    const flood = await http(port, {
      path: "/v1/traces",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(flood.status, 429);
    assert.match(String(flood.headers["retry-after"]), /^[1-9][0-9]*$/);
    assert.equal((await postJson(port, "/v1/traces", env.key, "{}")).status, 200);
    // the bucket refills with the injected clock (5 per second): failures are 401 again
    env.clock.now += 2000;
    const again = await http(port, {
      path: "/v1/traces",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(again.status, 401);
  } finally {
    await env.done();
  }
});

test("N1.5 G3 F8: the per-key bucket is taken before the scope check, so a forbidden key is also limited", async () => {
  const env = await startEnv();
  try {
    const k = env.newKey({ scopes: ["read:status"] });
    const codes: number[] = [];
    for (let i = 0; i < 102; i++)
      codes.push((await postJson(env.srv.port, "/v1/traces", k, "{}")).status);
    assert.equal(codes.filter((c) => c === 403).length, 100);
    assert.equal(codes.filter((c) => c === 429).length, 2);
  } finally {
    await env.done();
  }
});

test("step 5: ?key= is 400 before authentication, even with a valid header, and counts as an unauthenticated failure", async () => {
  const env = await startEnv();
  try {
    const port = env.srv.port;
    for (const q of ["?key=abc", "?a=1&key=swn_x", "?%6bey=1", "?key"]) {
      const r = await http(port, {
        path: `/v1/traces${q}`,
        headers: { "Content-Type": "application/json", ...bearer(env.key) },
        body: "{}",
      });
      assert.equal(r.status, 400, q);
      assert.match(r.text, /Authorization header/);
    }
    assert.equal(env.srv.counters().unauthenticated, 4);
    // other query parameters are harmless
    const ok = await http(port, {
      path: "/v1/traces?x=1",
      headers: { "Content-Type": "application/json", ...bearer(env.key) },
      body: "{}",
    });
    assert.equal(ok.status, 200);
  } finally {
    await env.done();
  }
});
