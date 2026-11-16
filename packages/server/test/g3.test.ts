/**
 * N1.5 G3 follow-ups: one odd record must not poison its batch (F2, F10), the Swain key masker
 * (F3), `allowUnverifiedProtobuf` reachability (F6), runtime listener errors (F7), a key revoked
 * between authentication and write, a locked database, and the decoder `internal` 500 (F9).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { DbError, type SwainStore } from "@swain/db";
import { OtlpDecodeError } from "@swain/otlp";
import * as publicApi from "../src/index.js";
import { createSwainServerWithHooks } from "../src/server.js";
import { bearer, dbDump, fixture, http, L1_TABLES, postJson, rows, startEnv } from "./helpers.js";

const attr = (key: string, value: string): unknown => ({ key, value: { stringValue: value } });

function span(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: "5b8efff798038103d269b633813fc60c",
    spanId: id.toString(16).padStart(16, "0"),
    name: `span-${id}`,
    kind: 1,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000900000000",
    ...over,
  };
}

function group(resourceAttrs: unknown[], spans: unknown[]): unknown {
  return {
    resource: { attributes: resourceAttrs },
    scopeSpans: [{ scope: { name: "t" }, spans }],
  };
}

const doc = (...groups: unknown[]): string => JSON.stringify({ resourceSpans: groups });
const count = (env: Awaited<ReturnType<typeof startEnv>>, table: string): bigint =>
  rows(env.store, `SELECT COUNT(*) AS n FROM ${table}`)[0]?.["n"] as bigint;

// ---- F2 (a): the resource-ns identity never throws --------------------------------------------

test("F2a: a 256-byte namespace and a 256-byte name use the hash form and store; the rest of the batch is stored", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const long = group(
      [attr("service.namespace", "n".repeat(256)), attr("service.name", "m".repeat(256))],
      [span(1)],
    );
    const normal = group([attr("service.name", "svc")], [span(2)]);
    const r = await postJson(env.srv.port, "/v1/traces", env.key, doc(long, normal));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, "{}");
    assert.equal(count(env, "spans"), 2n);
    const agents = rows(env.store, "SELECT agent_key, key_basis, display_name FROM agents");
    const ns = agents.find((a) => a["key_basis"] === "resource-ns");
    assert.ok(ns !== undefined);
    assert.match(String(ns["agent_key"]), /^resource:h:[0-9a-f]{64}$/);
    assert.ok(Buffer.byteLength(String(ns["display_name"])) <= 256);
    assert.equal(env.srv.counters().internalErrors, 0);
  } finally {
    await env.done();
  }
});

// ---- F2 (b): a bare swn_ substring is not refused ---------------------------------------------

test("F2b: identity values that merely contain swn_ are accepted; the other records are stored", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const odd = group([attr("service.name", "my-swn_tool")], [span(1)]);
    const odd2 = group(
      [attr("service.name", "svc")],
      [span(2, { attributes: [attr("gen_ai.agent.name", "swn_helper")] })],
    );
    const normal = group([attr("service.name", "svc")], [span(3)]);
    const r = await postJson(env.srv.port, "/v1/traces", env.key, doc(odd, odd2, normal));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, "{}");
    assert.equal(count(env, "spans"), 3n);
    const names = rows(env.store, "SELECT display_name FROM agents").map((a) => a["display_name"]);
    assert.ok(names.includes("my-swn_tool"), names.join(","));
    assert.ok(names.includes("swn_helper"), names.join(","));
  } finally {
    await env.done();
  }
});

// ---- F3: the masker, end to end ---------------------------------------------------------------

test("F3: a Swain key in a short attribute is never stored in the clear", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const bare = `swn_0123456789abcdef_${"a".repeat(64)}`;
    const url = `Authorization=Bearer%20swn_fedcba9876543210_${"b".repeat(64)}`;
    const named = `swn_1111111111111111_${"c".repeat(64)}`;
    const r = await postJson(
      env.srv.port,
      "/v1/traces",
      env.key,
      doc(
        group(
          [attr("service.name", `agent-${named}`), attr("note", bare)],
          [
            span(1, {
              name: bare,
              attributes: [attr("short", bare), attr("hdr", url), attr("gen_ai.agent.name", named)],
            }),
          ],
        ),
      ),
    );
    assert.equal(r.status, 200, r.text);
    const dump = dbDump(env.store, L1_TABLES);
    for (const needle of [
      bare,
      named,
      "0123456789abcdef_a",
      "fedcba9876543210_b",
      "1111111111111111_c",
    ]) {
      assert.ok(!dump.includes(needle), `found ${needle.slice(0, 30)} in the database`);
    }
    assert.match(dump, /\[REDACTED\]/);
    // and a logs record
    const logs = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [attr("service.name", "svc")] },
          scopeLogs: [
            {
              scope: { name: "t" },
              logRecords: [
                {
                  timeUnixNano: "1700000000000000000",
                  severityNumber: 9,
                  body: { stringValue: bare },
                  attributes: [attr("hdr", url), attr("k", bare)],
                },
              ],
            },
          ],
        },
      ],
    });
    const lr = await postJson(env.srv.port, "/v1/logs", env.key, logs);
    assert.equal(lr.status, 200, lr.text);
    const dump2 = dbDump(env.store, L1_TABLES);
    assert.ok(!dump2.includes("0123456789abcdef_a"));
    assert.ok(!dump2.includes("fedcba9876543210_b"));
  } finally {
    await env.done();
  }
});

// ---- F2 (c) / F10: a store-level per-record rejection ----------------------------------------------
//
// Under the real content policy no span can reach the 4 MiB `attributesJson` limit (measured: the
// applier retains about 155 KB for 4,600 attributes of 1 KB and about 1.0 MB for ten of 100 KB, even
// with `maxInlineBytes` 1,000,000). The store still checks, and what the server does when it says
// "this record is refused" is tested here by making `precheckSpans` / `precheckLogs` refuse the
// first record; the store's own detection is tested in `packages/db/test/facts.test.ts`.

function refusingFirst(s: SwainStore): SwainStore {
  return new Proxy(s, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        const out = v.apply(t, args);
        if (k === "precheckSpans" || k === "precheckLogs") {
          return [{ index: 0, code: "constraint" }, ...(out as readonly unknown[])];
        }
        return out;
      };
    },
  });
}

test("F2c/F10: a record the store refuses is rejected alone, counted in partial_success and in the batch row", async () => {
  const env = await startEnv({ store: refusingFirst });
  try {
    const three = doc(group([], [span(1), span(2), span(3)]));
    const r = await postJson(env.srv.port, "/v1/traces", env.key, three);
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.equal(body.partialSuccess.rejectedSpans, "1", r.text);
    assert.equal(body.partialSuccess.errorMessage, "A record was refused by the store.");
    assert.equal(count(env, "spans"), 2n, "the other records are stored");
    const ids = rows(env.store, "SELECT span_id FROM spans ORDER BY span_id").map(
      (x) => x["span_id"],
    );
    assert.deepEqual(ids, ["0000000000000002", "0000000000000003"]);
    const b = rows(env.store, "SELECT status, accepted, rejected FROM ingest_batches")[0];
    assert.deepEqual([b?.["status"], b?.["accepted"], b?.["rejected"]], ["partial", 2n, 1n]);
    assert.equal(env.srv.counters().internalErrors, 0);
    // a resend of the same bytes replays the same partial result and stores nothing new
    const again = await postJson(env.srv.port, "/v1/traces", env.key, three);
    assert.equal(JSON.parse(again.text).partialSuccess.rejectedSpans, "1");
    assert.equal(count(env, "spans"), 2n);
    // logs: the same
    const logs = JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: [attr("service.name", "svc")] },
          scopeLogs: [
            {
              scope: { name: "t" },
              logRecords: [1, 2].map((n) => ({
                timeUnixNano: `${1700000000000000000n + BigInt(n)}`,
                severityNumber: 9,
                body: { stringValue: `m${n}` },
              })),
            },
          ],
        },
      ],
    });
    const lr = await postJson(env.srv.port, "/v1/logs", env.key, logs);
    assert.equal(lr.status, 200, lr.text);
    assert.equal(JSON.parse(lr.text).partialSuccess.rejectedLogRecords, "1");
    assert.equal(count(env, "log_records"), 1n);
  } finally {
    await env.done();
  }
});

// ---- F6: allowUnverifiedProtobuf is not reachable from configuration or environment -------------

test("F6: allowUnverifiedProtobuf is only an in-code option: no env, argv or config parsing reaches it", () => {
  const dir = new URL("../../src/", import.meta.url);
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(sources.length >= 8);
  for (const f of sources) {
    const text = readFileSync(new URL(f, dir), "utf8");
    // product code has no env, argv or file reads at all
    assert.doesNotMatch(text, /\bprocess\.(env|argv|stdin|stdout)\b/, `${f} reads process state`);
    assert.doesNotMatch(text, /node:fs|readFileSync|JSON\.parse\(.*env/, `${f} reads files or env`);
    if (f !== "server.ts") {
      const code = text
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      assert.doesNotMatch(code, /allowUnverifiedProtobuf/, `${f} uses the option`);
    }
  }
  // in server.ts the option is read from the options object only, as a strict boolean
  const server = readFileSync(new URL("server.ts", dir), "utf8");
  const uses = server.split("\n").filter((l) => l.includes("allowUnverifiedProtobuf"));
  assert.ok(uses.some((l) => l.includes("=== true")));
  // the test-only seams are not exported from the package
  assert.deepEqual(Object.keys(publicApi).includes("createSwainServerWithHooks"), false);
  assert.equal(typeof publicApi.createSwainServer, "function");
});

test("F6: only a literal boolean true enables protobuf (strings, numbers and objects do not)", async () => {
  for (const v of ["true", 1, {}, "yes"]) {
    const env = await startEnv({ allowUnverifiedProtobuf: v as never });
    try {
      const r = await http(env.srv.port, {
        path: "/v1/traces",
        headers: { "Content-Type": "application/x-protobuf", ...bearer(env.key) },
        body: new Uint8Array(0),
      });
      assert.equal(r.status, 415, JSON.stringify(v));
    } finally {
      await env.done();
    }
  }
});

// ---- F7: a runtime listener error is counted and does not stop the server ----------------------

test("F7: an error event on a listening server is counted and the server keeps serving", async () => {
  const env = await startEnv();
  await env.srv.close();
  let seen: readonly { emit(e: string, ...a: unknown[]): boolean }[] = [];
  const srv = await createSwainServerWithHooks(
    { store: env.store, nowMs: () => env.clock.now, port: 0 },
    { onServers: (l) => (seen = l) },
  );
  try {
    assert.ok(seen.length >= 1);
    for (const s of seen) s.emit("error", new Error("boom"));
    assert.equal(srv.counters().serverErrors, seen.length);
    const r = await http(srv.port, { method: "GET", path: "/healthz" });
    assert.equal(r.status, 200);
  } finally {
    await srv.close();
    env.store.close();
  }
});

// ---- F9: key revoked between auth and write, locked DB, decoder internal ------------------------

test("F9: a key revoked between authentication and the write is 401, not 500", async () => {
  let revoke: (() => void) | null = null;
  const env = await startEnv({
    store: (s) =>
      new Proxy(s, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (k === "precheckSpans" && revoke !== null) {
              const r = revoke;
              revoke = null;
              r();
            }
            return v.apply(t, args);
          };
        },
      }),
  });
  try {
    revoke = () => env.store.revokeKey(env.scope, env.key.keyId, env.clock.now);
    const r = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
    assert.equal(r.status, 401, r.text);
    assert.equal(r.headers["www-authenticate"], "Bearer");
    assert.equal(count(env, "spans"), 0n);
    assert.equal(env.srv.counters().internalErrors, 0);
  } finally {
    await env.done();
  }
});

test("F9: a locked database is 503 with Retry-After, and the next request works", async () => {
  let fail = true;
  const env = await startEnv({
    store: (s) =>
      new Proxy(s, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function") return v;
          return (...args: unknown[]) => {
            if (k === "ingestTraces" && fail) {
              fail = false;
              throw new DbError("db-locked");
            }
            return v.apply(t, args);
          };
        },
      }),
  });
  try {
    const r = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
    assert.equal(r.status, 503);
    assert.match(String(r.headers["retry-after"]), /^[1-9]/);
    assert.equal(count(env, "spans"), 0n);
    const ok = await postJson(env.srv.port, "/v1/traces", env.key, fixture("traces-genai.json"));
    assert.equal(ok.status, 200);
  } finally {
    await env.done();
  }
});

test("F9: a decoder `internal` error is a static 500, the counter rises, nothing is echoed or stored", async () => {
  const env = await startEnv();
  await env.srv.close();
  const MARK = "DECODER_INTERNAL_MARK";
  const srv = await createSwainServerWithHooks(
    { store: env.store, nowMs: () => env.clock.now, port: 0, host: "127.0.0.1" },
    {
      decode: () => {
        throw new OtlpDecodeError("internal");
      },
    },
  );
  try {
    const r = await postJson(srv.port, "/v1/traces", env.key, `{"resourceSpans":[],"x":"${MARK}"}`);
    assert.equal(r.status, 500);
    assert.deepEqual(JSON.parse(r.text), { code: 13, message: "Internal error." });
    assert.ok(!r.text.includes(MARK));
    assert.equal(srv.counters().decoderInternalErrors, 1);
    assert.equal(srv.counters().internalErrors, 0, "a decoder error is not a handler throw");
    assert.equal(count(env, "ingest_batches"), 0n);
    // a second request is served (nothing is stuck, no slot leaked)
    const again = await http(srv.port, { method: "GET", path: "/healthz" });
    assert.equal(again.status, 200);
  } finally {
    await srv.close();
    env.store.close();
  }
});
