/** Bind (ADR-0007 section 1, F7): literal loopback only, address asserted, both families by default. */
import assert from "node:assert/strict";
import { createServer as netServer } from "node:net";
import { test } from "node:test";
import { assertBoundAddress, createSwainServer, SwainServerError } from "../src/index.js";
import { http, startEnv } from "./helpers.js";

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof SwainServerError, String(e));
    return e.code;
  }
  return "no-error";
}

function listen(host: string, port: number): Promise<{ close(): Promise<void>; port: number }> {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once("error", reject);
    s.listen({ host, port }, () => {
      const a = s.address();
      assert.ok(a !== null && typeof a !== "string");
      resolve({
        port: a.port,
        close: () => new Promise<void>((r) => s.close(() => r())),
      });
    });
  });
}

const ipv6 = await listen("::1", 0).then(
  async (l) => {
    await l.close();
    return true;
  },
  () => false,
);

test("F7: only the literals 127.0.0.1 and ::1 are accepted, before any socket is opened", async () => {
  const env = await startEnv();
  try {
    for (const host of [
      "localhost",
      "0.0.0.0",
      "::",
      "::ffff:127.0.0.1",
      "127.0.0.2",
      "127.1",
      "[::1]",
      "LOCALHOST",
      "",
      " 127.0.0.1",
      "127.0.0.1 ",
      "::1%lo",
      "example.com",
    ]) {
      assert.equal(
        await codeOf(
          createSwainServer({
            store: env.store,
            nowMs: () => 0,
            port: 0,
            host: host as "127.0.0.1",
          }),
        ),
        "bind-not-loopback",
        JSON.stringify(host),
      );
    }
  } finally {
    await env.done();
  }
});

test("F7: with the host omitted the server binds 127.0.0.1 and ::1 on one port, and asserts the address", async () => {
  const env = await startEnv();
  try {
    assert.ok(env.srv.port > 0);
    assert.equal(env.srv.addresses[0], `127.0.0.1:${env.srv.port}`);
    if (ipv6) {
      assert.deepEqual(env.srv.addresses, [`127.0.0.1:${env.srv.port}`, `[::1]:${env.srv.port}`]);
      assert.deepEqual(env.srv.warnings, []);
      // both families answer
      const v4 = await http(env.srv.port, { method: "GET", path: "/healthz" }, "127.0.0.1");
      const v6 = await http(
        env.srv.port,
        { method: "GET", path: "/healthz", headers: { Host: `[::1]:${env.srv.port}` } },
        "::1",
      );
      assert.equal(v4.status, 200);
      assert.equal(v6.status, 200);
    } else {
      assert.deepEqual(env.srv.warnings, ["ipv6-unavailable"]);
    }
  } finally {
    await env.done();
  }
});

test("F7: a host of 127.0.0.1 binds one family; ::1 stays free for someone else", async () => {
  const env = await startEnv({ host: "127.0.0.1" });
  try {
    assert.deepEqual(env.srv.addresses, [`127.0.0.1:${env.srv.port}`]);
    if (ipv6) {
      const other = await listen("::1", env.srv.port);
      await other.close();
    }
  } finally {
    await env.done();
  }
});

test("F7: host ::1 binds only ::1", { skip: !ipv6 }, async () => {
  const env = await startEnv({ host: "::1" });
  try {
    assert.deepEqual(env.srv.addresses, [`[::1]:${env.srv.port}`]);
    const r = await http(
      env.srv.port,
      { method: "GET", path: "/healthz", headers: { Host: `[::1]:${env.srv.port}` } },
      "::1",
    );
    assert.equal(r.status, 200);
    await assert.rejects(http(env.srv.port, { method: "GET", path: "/healthz" }, "127.0.0.1"));
  } finally {
    await env.done();
  }
});

test("F7: EADDRINUSE on ::1 refuses the start and releases 127.0.0.1", {
  skip: !ipv6,
}, async () => {
  const env = await startEnv();
  try {
    const squatter = await listen("::1", 0);
    try {
      const err = await createSwainServer({
        store: env.store,
        nowMs: () => 0,
        port: squatter.port,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof SwainServerError);
      assert.equal(err.code, "port-held");
      assert.equal(err.family, "::1");
      // the v4 listener was released: the port is free on 127.0.0.1
      const v4 = await listen("127.0.0.1", squatter.port);
      await v4.close();
    } finally {
      await squatter.close();
    }
  } finally {
    await env.done();
  }
});

test("F7: EADDRINUSE on 127.0.0.1 refuses the start", async () => {
  const env = await startEnv();
  try {
    const squatter = await listen("127.0.0.1", 0);
    try {
      const err = await createSwainServer({
        store: env.store,
        nowMs: () => 0,
        port: squatter.port,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(err instanceof SwainServerError);
      assert.equal(err.code, "port-held");
      assert.equal(err.family, "127.0.0.1");
    } finally {
      await squatter.close();
    }
  } finally {
    await env.done();
  }
});

test("F7: assertBoundAddress refuses a pipe, a wrong address and a wrong port", () => {
  const ok = { address: "127.0.0.1", family: "IPv4", port: 4318 };
  assert.equal(assertBoundAddress(ok, "127.0.0.1", 4318), 4318);
  assert.equal(assertBoundAddress(ok, "127.0.0.1", 0), 4318);
  assert.equal(assertBoundAddress({ address: "::1", family: "IPv6", port: 9 }, "::1", 9), 9);
  const bad = (a: unknown, host: "127.0.0.1" | "::1", port: number): void =>
    assert.throws(
      () => assertBoundAddress(a as never, host, port),
      (e: unknown) => e instanceof SwainServerError && e.code === "bind-address-mismatch",
    );
  bad(null, "127.0.0.1", 0);
  bad("/tmp/pipe", "127.0.0.1", 0);
  bad({ address: "0.0.0.0", family: "IPv4", port: 4318 }, "127.0.0.1", 4318);
  bad({ address: "::", family: "IPv6", port: 4318 }, "::1", 4318);
  bad({ address: "::ffff:127.0.0.1", family: "IPv6", port: 4318 }, "127.0.0.1", 4318);
  bad(ok, "127.0.0.1", 4319);
  bad({ address: "127.0.0.1", family: "IPv4", port: 0 }, "127.0.0.1", 0);
  bad(ok, "::1", 4318);
});

test("options are validated: port range, clock, store, limits above their hard max", async () => {
  const env = await startEnv();
  try {
    const base = { store: env.store, nowMs: () => 0, port: 0 };
    for (const bad of [
      { ...base, port: -1 },
      { ...base, port: 65_536 },
      { ...base, port: 1.5 },
      { ...base, nowMs: undefined as never },
      { ...base, store: null as never },
      { ...base, limits: { maxBodyBytes: 65 * 1024 * 1024 } },
      { ...base, limits: { maxValues: 1_000_001 } },
      { ...base, limits: { decodeConcurrency: 0 } },
      { ...base, limits: { inFlight: 1.5 } },
    ]) {
      assert.equal(await codeOf(createSwainServer(bad)), "invalid-option");
    }
  } finally {
    await env.done();
  }
});
