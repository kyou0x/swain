/**
 * Security review conditions on the no-login pages: per-agent error display, the page-render
 * bucket and runtime validation of `webAuth`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSwainServer, SwainServerError } from "../src/index.js";
import { type Env, http, postJson, type Reply, startEnv } from "./helpers.js";

const get = (env: Env, path: string, headers: Record<string, string> = {}): Promise<Reply> =>
  http(env.srv.port, { method: "GET", path, headers });

function span(
  spanId: string,
  parent: string | null,
  name: string,
  agent: string | null,
  code: number,
): Record<string, unknown> {
  const op = agent === null ? "execute_tool" : "invoke_agent";
  return {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId,
    ...(parent === null ? {} : { parentSpanId: parent }),
    name,
    kind: 1,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: op } },
      ...(agent === null ? [] : [{ key: "gen_ai.agent.name", value: { stringValue: agent } }]),
    ],
    status: { code },
  };
}

test("fleet: an agent shows error only for its own spans, not for siblings in the same trace", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const spans = [
      span("0000000000000001", null, "invoke_agent root", "root-agent", 1),
      span("0000000000000002", "0000000000000001", "invoke_agent osint", "osint", 1),
      span("0000000000000003", "0000000000000002", "execute_tool fail", null, 2),
      span("0000000000000004", "0000000000000001", "invoke_agent recon", "recon", 1),
      span("0000000000000005", "0000000000000004", "execute_tool ok", null, 1),
    ];
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeSpans: [{ scope: { name: "t" }, spans }],
        },
      ],
    });
    const r = await postJson(env.srv.port, "/v1/traces", env.key, body);
    assert.equal(r.status, 200, r.text);
    const fleet = await get(env, "/");
    assert.equal(fleet.status, 200);
    const rowOf = (name: string): string => {
      const rows = fleet.text.split("<tr>").filter((x) => x.includes(` ${name}</td>`));
      assert.equal(rows.length, 1, `row for ${name}: ${fleet.text}`);
      return rows[0] ?? "";
    };
    assert.match(rowOf("osint"), /error/);
    assert.doesNotMatch(rowOf("recon"), /error/, "a sibling's error is not recon's");
    assert.doesNotMatch(
      rowOf("root-agent"),
      /error/,
      "no propagation from a sub-agent to its parent",
    );
  } finally {
    await env.done();
  }
});

test("default mode: page renders are rate limited per server (burst 60) and recover with time", async () => {
  const env = await startEnv();
  try {
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await get(env, "/runs");
      if (r.status === 429) {
        limited++;
        assert.ok(Number(r.headers["retry-after"]) >= 1);
      } else assert.equal(r.status, 200);
    }
    assert.equal(limited, 10, "exactly the requests past the burst of 60");
    env.clock.now += 2000;
    assert.equal((await get(env, "/runs")).status, 200);
    // refused requests (403) never spend a token
    env.clock.now += 5000;
    for (let i = 0; i < 100; i++) {
      assert.equal((await get(env, "/runs", { "Sec-Fetch-Site": "cross-site" })).status, 403);
    }
    assert.equal((await get(env, "/runs")).status, 200);
  } finally {
    await env.done();
  }
});

test("webAuth is validated at runtime: only undefined, none or login; null never means open", async () => {
  const env = await startEnv();
  try {
    for (const bad of [null, "", "None", "off", false, 0, {}]) {
      let started: { close(): Promise<void> } | null = null;
      await assert
        .rejects(
          createSwainServer({
            store: env.store,
            nowMs: () => env.clock.now,
            port: 0,
            webAuth: bad as never,
          }).then((s) => {
            started = s;
            return s;
          }),
          (e: unknown) => e instanceof SwainServerError && e.code === "invalid-option",
          String(bad),
        )
        .finally(async () => {
          await (started as { close(): Promise<void> } | null)?.close();
        });
    }
    for (const ok of [undefined, "none", "login"] as const) {
      const s = await createSwainServer({
        store: env.store,
        nowMs: () => env.clock.now,
        port: 0,
        ...(ok === undefined ? {} : { webAuth: ok }),
      });
      await s.close();
    }
  } finally {
    await env.done();
  }
});
