/**
 * Per-agent error attribution on the fleet page is sender-controlled input, so it is bounded:
 * same-credential walks only, canonical spans with unique IDs only, the agent's own error never
 * cleared, a run-wide fallback for truncated runs and a per-render span budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorAgents } from "../src/webdata.js";
import { type Credential, type Env, http, postJson, type Reply, startEnv } from "./helpers.js";

const get = (env: Env, path: string): Promise<Reply> =>
  http(env.srv.port, { method: "GET", path, headers: {} });

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const hex = (n: number): string => n.toString(16).padStart(16, "0");

interface S {
  id: number;
  parent: number | null;
  agent: string | null;
  code: number;
  trace?: string;
}

function body(service: string, spans: readonly S[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [
          {
            scope: { name: "t" },
            spans: spans.map((s) => ({
              traceId: s.trace ?? TRACE,
              spanId: hex(s.id),
              ...(s.parent === null ? {} : { parentSpanId: hex(s.parent) }),
              name: s.agent === null ? "execute_tool x" : `invoke_agent ${s.agent}`,
              kind: 1,
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000001000000000",
              attributes: [
                {
                  key: "gen_ai.operation.name",
                  value: { stringValue: s.agent === null ? "execute_tool" : "invoke_agent" },
                },
                ...(s.agent === null
                  ? []
                  : [{ key: "gen_ai.agent.name", value: { stringValue: s.agent } }]),
              ],
              status: { code: s.code },
            })),
          },
        ],
      },
    ],
  });
}

async function send(env: Env, key: Credential, service: string, spans: readonly S[]) {
  const r = await postJson(env.srv.port, "/v1/traces", key, body(service, spans));
  assert.equal(r.status, 200, r.text);
}

/** agent name -> has the error badge, from the fleet table rows. */
function badges(html: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const row of html.split("<tr>").slice(2)) {
    const name = /<\/a> ([^<]+)<\/td>/.exec(row)?.[1];
    if (name !== undefined) out.set(name, row.includes("b-bad"));
  }
  return out;
}

test("cross-key parenting: key A cannot move its error onto key B's agent or clear its own", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const keyB = env.newKey({ agentName: null });
    await send(env, keyB, "svc-b", [{ id: 1, parent: null, agent: "victim", code: 1 }]);
    // key A: an OK agent span, and an ERROR tool span parented under B's agent span, plus an
    // ERROR agent span of its own parented under B as well
    await send(env, env.key, "svc-a", [
      { id: 10, parent: 1, agent: null, code: 2 },
      { id: 11, parent: 1, agent: "attacker", code: 2 },
    ]);
    const b = badges((await get(env, "/")).text);
    assert.equal(b.get("victim"), false, "B's agent is not marked by A's error");
    assert.equal(b.get("svc-a"), true, "A's tool error stays on A's own resource agent");
    assert.equal(b.get("attacker"), true, "an agent's own error is never cleared by a parent");
  } finally {
    await env.done();
  }
});

test("a duplicated spanId from another key cannot override the tree", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const keyB = env.newKey({ agentName: null });
    await send(env, env.key, "svc-a", [
      { id: 1, parent: null, agent: "victim", code: 1 },
      { id: 2, parent: 1, agent: null, code: 2 },
    ]);
    const before = badges((await get(env, "/")).text);
    assert.equal(before.get("victim"), true, "baseline: same-key enclosing agent is marked");
    // key B re-uses span ID 1 for a decoy agent span
    await send(env, keyB, "svc-b", [{ id: 1, parent: null, agent: "decoy", code: 1 }]);
    const after = badges((await get(env, "/")).text);
    assert.equal(after.get("decoy"), false, "the decoy never receives A's error");
    assert.equal(after.get("svc-a"), true, "A's own agent keeps its error");
  } finally {
    await env.done();
  }
});

test("errorAgents: boundaries, duplicates, non-canonical spans, cycles and the own-agent rule", () => {
  const mk = (
    spanId: string,
    parentSpanId: string | null,
    agentId: string,
    opClass: string,
    statusCode: number,
    keyId = "k1",
    canonical = true,
  ) => ({ spanId, parentSpanId, agentId, opClass, statusCode, keyId, canonical });
  // same key chain: error tool -> agent
  assert.deepEqual(
    [...errorAgents([mk("a", null, "A", "agent", 1), mk("t", "a", "R", "tool", 2)])].sort(),
    ["A", "R"],
  );
  // key boundary
  assert.deepEqual(
    [...errorAgents([mk("a", null, "A", "agent", 1, "k2"), mk("t", "a", "R", "tool", 2)])],
    ["R"],
  );
  // duplicated span ID is a boundary
  assert.deepEqual(
    [
      ...errorAgents([
        mk("a", null, "A", "agent", 1),
        mk("a", null, "D", "agent", 1, "k2"),
        mk("t", "a", "R", "tool", 2),
      ]),
    ],
    ["R"],
  );
  // non-canonical ancestor is a boundary; a non-canonical error span still charges its own agent
  assert.deepEqual(
    [
      ...errorAgents([
        mk("a", null, "A", "agent", 1, "k1", false),
        mk("t", "a", "R", "tool", 2),
        mk("u", null, "N", "tool", 2, "k1", false),
      ]),
    ].sort(),
    ["N", "R"],
  );
  // an untrusted (non-canonical) error span does not reach its parent agent either
  assert.deepEqual(
    [...errorAgents([mk("a", null, "A", "agent", 1), mk("t", "a", "R", "tool", 2, "k1", false)])],
    ["R"],
  );
  // a sub-agent's error does not mark the parent agent; siblings stay clean
  assert.deepEqual(
    [
      ...errorAgents([
        mk("p", null, "P", "agent", 1),
        mk("s", "p", "S", "agent", 1),
        mk("e", "s", "R", "tool", 2),
        mk("q", "p", "Q", "agent", 1),
      ]),
    ].sort(),
    ["R", "S"],
  );
  // a parent cycle terminates
  assert.deepEqual(
    [...errorAgents([mk("x", "y", "X", "tool", 2), mk("y", "x", "Y", "tool", 1)])],
    ["X"],
  );
  // a long chain is linear: memoization keeps this fast
  const chain = [mk("n0", null, "A", "agent", 1)];
  for (let i = 1; i < 5000; i++) chain.push(mk(`n${i}`, `n${i - 1}`, "R", "tool", 2));
  assert.deepEqual([...errorAgents(chain)].sort(), ["A", "R"]);
});

test("truncated runs fall back to the run-wide flag", async () => {
  const env = await startEnv({ agentName: null });
  try {
    const spans: S[] = [
      { id: 1, parent: null, agent: "alpha", code: 1 },
      { id: 2, parent: null, agent: "beta", code: 1 },
      { id: 3, parent: 2, agent: null, code: 2 },
    ];
    for (let i = 0; i < 1100; i++) spans.push({ id: 100 + i, parent: 1, agent: null, code: 1 });
    await send(env, env.key, "svc", spans);
    const b = badges((await get(env, "/")).text);
    // more than 1000 spans: the per-agent view is not trusted, so the run flag shows on all
    assert.equal(b.get("alpha"), true);
    assert.equal(b.get("beta"), true);
  } finally {
    await env.done();
  }
});

test("a per-render span budget bounds the fleet page: over budget uses the run-wide flag", async () => {
  const env = await startEnv({ agentName: null, fleetSpanBudget: 4 });
  try {
    // trace 1: 3 spans, within the budget of 4, so per-agent
    await send(env, env.key, "svc", [
      { id: 1, parent: null, agent: "one-a", code: 1 },
      { id: 2, parent: null, agent: "one-b", code: 1 },
      { id: 3, parent: 2, agent: null, code: 2 },
    ]);
    const first = badges((await get(env, "/")).text);
    assert.equal(first.get("one-a"), false, "within budget: per agent");
    assert.equal(first.get("one-b"), true);
    // trace 2: 3 more spans; together over the budget of 4, so one trace falls back
    await send(env, env.key, "svc", [
      { id: 21, parent: null, agent: "two-a", code: 1, trace: "5bf92f3577b34da6a3ce929d0e0e4737" },
      { id: 22, parent: null, agent: "two-b", code: 1, trace: "5bf92f3577b34da6a3ce929d0e0e4737" },
      { id: 23, parent: 22, agent: null, code: 2, trace: "5bf92f3577b34da6a3ce929d0e0e4737" },
    ]);
    const second = badges((await get(env, "/")).text);
    const fellBack = [second.get("one-a"), second.get("two-a")].filter((v) => v === true);
    assert.equal(fellBack.length, 1, "exactly the trace past the budget shows the run-wide flag");
  } finally {
    await env.done();
  }
});
