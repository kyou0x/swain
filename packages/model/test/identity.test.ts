import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AGENT_KEY_BASES,
  applyContentPolicy,
  containsSwainKey,
  deriveAgentIdentity,
  deriveSessionId,
  deriveSwainId,
  type InputKeyValue,
  importRun,
  isAgentIdentity,
  isAgentKeyFormat,
  isPolicyApplied,
  isRunRef,
  logsRun,
  runForLogRecord,
  sessionRun,
  traceRun,
  utcDay,
} from "../src/index.js";
import { id, kv, PRJ, PRJ2, s, span, TRACE, traces } from "./helpers.js";

const SES = `ses_${"1".repeat(32)}`;
const IMP = `imp_${"2".repeat(32)}`;

/** Independent recomputation (no shared code with the implementation). */
function recompute(type: string, components: readonly string[]): string {
  let buf = Buffer.from(`swain:v1:${type}\n`, "utf8");
  for (const c of components) {
    const body = Buffer.from(c, "utf8");
    buf = Buffer.concat([buf, Buffer.from(`${body.length}:`, "ascii"), body]);
  }
  return `${type}_${createHash("sha256").update(buf).digest("hex").slice(0, 32)}`;
}

/** Post-policy attributes through the real applier. */
function attrs(list: InputKeyValue[]) {
  const out = applyContentPolicy(traces([span({ attributes: list })]), {
    contentPolicy: "hash-only",
    maxInlineBytes: 10,
  });
  const sp = out.spans[0];
  assert.ok(sp);
  return sp.attributes;
}

test("agent keys: each rule yields its documented components (independent recomputation)", () => {
  const cases: [string, ReturnType<typeof deriveAgentIdentity>, string[]][] = [
    ["rule 1", deriveAgentIdentity(PRJ, { pinnedAgentName: "billing" }), ["cred", "billing"]],
    [
      "rule 1 sub",
      deriveAgentIdentity(PRJ, { pinnedAgentName: "billing", pinnedSubagentType: "reviewer" }),
      ["cred-sub", "billing", "reviewer"],
    ],
    [
      "rule 2",
      deriveAgentIdentity(PRJ, { attributes: attrs([kv("gen_ai.agent.id", s("a-1"))]) }),
      ["attr:gen_ai.agent.id", "a-1"],
    ],
    [
      "rule 3 gen_ai.agent.name",
      deriveAgentIdentity(PRJ, { attributes: attrs([kv("gen_ai.agent.name", s("planner"))]) }),
      ["attr:name", "planner"],
    ],
    [
      "rule 3 agent.name",
      deriveAgentIdentity(PRJ, { attributes: attrs([kv("agent.name", s("planner"))]) }),
      ["attr:name", "planner"],
    ],
    [
      "rule 4 no namespace",
      deriveAgentIdentity(PRJ, { resourceAttributes: attrs([kv("service.name", s("svc"))]) }),
      ["resource", "svc"],
    ],
    [
      "rule 4 namespace",
      deriveAgentIdentity(PRJ, {
        resourceAttributes: attrs([kv("service.namespace", s("ns")), kv("service.name", s("svc"))]),
      }),
      ["resource-ns", "ns", "svc"],
    ],
    [
      "rule 5",
      deriveAgentIdentity(PRJ, { adr0002: { provider: "claude-code" } }),
      ["adr0002", "claude-code"],
    ],
    [
      "rule 5 sub",
      deriveAgentIdentity(PRJ, { adr0002: { provider: "claude-code", agentType: "Explore" } }),
      ["adr0002-sub", "claude-code", "Explore"],
    ],
    ["rule 6", deriveAgentIdentity(PRJ, {}), ["none", "none"]],
  ];
  for (const [name, got, comps] of cases) {
    assert.equal(got.agentId, recompute("agt", [PRJ, ...comps]), name);
    assert.equal(got.agentId, deriveSwainId("agt", [PRJ, ...comps]), name);
    assert.match(got.agentId, /^agt_[0-9a-f]{32}$/);
  }
  assert.deepEqual(
    cases.map((c) => c[1].key),
    [
      "cred:billing",
      "cred:billing/sub:reviewer",
      "attr:gen_ai.agent.id:a-1",
      "attr:name:planner",
      "attr:name:planner",
      "resource:/svc",
      "resource:ns/svc",
      "adr0002:claude-code",
      "adr0002:claude-code/Explore",
      "none",
    ],
  );
  assert.ok(AGENT_KEY_BASES.length >= 6);
});

test("rules apply in order: first with evidence wins", () => {
  const all = {
    pinnedAgentName: "pin",
    attributes: attrs([kv("gen_ai.agent.id", s("id")), kv("gen_ai.agent.name", s("nm"))]),
    resourceAttributes: attrs([kv("service.name", s("svc"))]),
    adr0002: { provider: "p" },
  };
  assert.equal(deriveAgentIdentity(PRJ, all).keyBasis, "cred");
  const { pinnedAgentName: _p, ...noPin } = all;
  assert.equal(deriveAgentIdentity(PRJ, noPin).keyBasis, "attr:gen_ai.agent.id");
  const noId = { ...noPin, attributes: attrs([kv("gen_ai.agent.name", s("nm"))]) };
  assert.equal(deriveAgentIdentity(PRJ, noId).keyBasis, "attr:name");
  const noAttr = { ...noId, attributes: [] };
  assert.equal(deriveAgentIdentity(PRJ, noAttr).keyBasis, "resource");
  const { resourceAttributes: _r, ...noRes } = noAttr;
  assert.equal(deriveAgentIdentity(PRJ, noRes).keyBasis, "adr0002");
  assert.equal(deriveAgentIdentity(PRJ, {}).keyBasis, "none");
  // gen_ai.agent.name beats agent.name inside rule 3.
  const both = attrs([kv("agent.name", s("oi")), kv("gen_ai.agent.name", s("genai"))]);
  assert.equal(deriveAgentIdentity(PRJ, { attributes: both }).key, "attr:name:genai");
});

test("rule 4 ignores unknown_service*, empty values, and content-ref (oversize) values", () => {
  const unknown = attrs([kv("service.name", s("unknown_service:node"))]);
  assert.equal(deriveAgentIdentity(PRJ, { resourceAttributes: unknown }).keyBasis, "none");
  assert.equal(
    deriveAgentIdentity(PRJ, { attributes: attrs([kv("gen_ai.agent.id", s(""))]) }).keyBasis,
    "none",
  );
  const huge = attrs([kv("gen_ai.agent.id", s("x".repeat(400)))]);
  assert.equal(deriveAgentIdentity(PRJ, { attributes: huge }).keyBasis, "none");
  // A pinned name that is present but empty is a configuration error, not "no evidence" (F8).
  assert.throws(
    () => deriveAgentIdentity(PRJ, { pinnedAgentName: "" }),
    (e: unknown) => e instanceof Error && e.message === "invalid-id-component",
  );
  assert.throws(() =>
    deriveAgentIdentity(PRJ, {
      pinnedAgentName: "",
      attributes: attrs([kv("gen_ai.agent.id", s("claimed"))]),
    }),
  );
});

test("collision suite: one value under every basis gives distinct IDs", () => {
  const v = "A";
  const ids = [
    deriveAgentIdentity(PRJ, { pinnedAgentName: v }),
    deriveAgentIdentity(PRJ, { attributes: attrs([kv("gen_ai.agent.id", s(v))]) }),
    deriveAgentIdentity(PRJ, { attributes: attrs([kv("gen_ai.agent.name", s(v))]) }),
    deriveAgentIdentity(PRJ, { resourceAttributes: attrs([kv("service.name", s(v))]) }),
    deriveAgentIdentity(PRJ, { adr0002: { provider: v } }),
    deriveAgentIdentity(PRJ, {}),
  ];
  assert.equal(new Set(ids.map((i) => i.agentId)).size, 6);
  assert.deepEqual(
    ids.map((i) => i.keyBasis),
    ["cred", "attr:gen_ai.agent.id", "attr:name", "resource", "adr0002", "none"],
  );
});

test("an unpinned gen_ai.agent.name=A must not merge into the agent pinned to credential A", () => {
  const pinned = deriveAgentIdentity(PRJ, { pinnedAgentName: "A" });
  const claimed = deriveAgentIdentity(PRJ, {
    attributes: attrs([kv("gen_ai.agent.name", s("A"))]),
  });
  assert.notEqual(pinned.agentId, claimed.agentId);
  // Under the same pinned key, the attribute does not change the agent; the claim is surfaced.
  const withClaim = deriveAgentIdentity(PRJ, {
    pinnedAgentName: "A",
    attributes: attrs([kv("gen_ai.agent.name", s("B"))]),
  });
  assert.equal(withClaim.agentId, pinned.agentId);
  assert.deepEqual(withClaim.senderClaim, { keyBasis: "attr:name", key: "attr:name:B" });
  assert.equal(pinned.senderClaim, null);
});

test("pinned key wins over attributes, resource and ADR-0002 evidence", () => {
  const a = deriveAgentIdentity(PRJ, {
    pinnedAgentName: "billing",
    attributes: attrs([kv("gen_ai.agent.id", s("other"))]),
    resourceAttributes: attrs([kv("service.name", s("svc"))]),
    adr0002: { provider: "claude-code" },
  });
  assert.equal(a.agentId, deriveAgentIdentity(PRJ, { pinnedAgentName: "billing" }).agentId);
});

test('"unattributed", "adr0002:claude-code", ":" and "/" values cannot forge another basis', () => {
  const none = deriveAgentIdentity(PRJ, {});
  const unattributed = deriveAgentIdentity(PRJ, { pinnedAgentName: "unattributed" });
  const noneNamed = deriveAgentIdentity(PRJ, { pinnedAgentName: "none" });
  assert.notEqual(none.agentId, unattributed.agentId);
  assert.notEqual(none.agentId, noneNamed.agentId);
  assert.notEqual(
    none.agentId,
    deriveAgentIdentity(PRJ, { attributes: attrs([kv("gen_ai.agent.name", s("unattributed"))]) })
      .agentId,
  );

  const real = deriveAgentIdentity(PRJ, { adr0002: { provider: "claude-code" } });
  const forgeCred = deriveAgentIdentity(PRJ, { pinnedAgentName: "adr0002:claude-code" });
  const forgeAttr = deriveAgentIdentity(PRJ, {
    attributes: attrs([kv("gen_ai.agent.id", s("adr0002:claude-code"))]),
  });
  const forgeName = deriveAgentIdentity(PRJ, {
    attributes: attrs([kv("gen_ai.agent.name", s("adr0002:claude-code"))]),
  });
  const forgeRes = deriveAgentIdentity(PRJ, {
    resourceAttributes: attrs([kv("service.name", s("adr0002:claude-code"))]),
  });
  const ids = new Set([real, forgeCred, forgeAttr, forgeName, forgeRes].map((x) => x.agentId));
  assert.equal(ids.size, 5);

  // `:` and `/` inside a value never reach another basis or another component split.
  const pins = ["cred:x", "attr:name:x", "x/sub:y", "a/b", "a", "b", "resource:/x"];
  const seen = new Set<string>();
  for (const p of pins) seen.add(deriveAgentIdentity(PRJ, { pinnedAgentName: p }).agentId);
  assert.equal(seen.size, pins.length);
  // A pinned agent named "A/sub:B" is not the subagent B of agent A, nor the other way round.
  assert.notEqual(
    deriveAgentIdentity(PRJ, { pinnedAgentName: "A/sub:B" }).agentId,
    deriveAgentIdentity(PRJ, { pinnedAgentName: "A", pinnedSubagentType: "B" }).agentId,
  );
  assert.notEqual(
    deriveAgentIdentity(PRJ, { adr0002: { provider: "p/q" } }).agentId,
    deriveAgentIdentity(PRJ, { adr0002: { provider: "p", agentType: "q" } }).agentId,
  );
  assert.notEqual(
    deriveAgentIdentity(PRJ, {
      resourceAttributes: attrs([kv("service.name", s("ns/svc"))]),
    }).agentId,
    deriveAgentIdentity(PRJ, {
      resourceAttributes: attrs([kv("service.namespace", s("ns")), kv("service.name", s("svc"))]),
    }).agentId,
  );
});

test("the same key in two projects gives distinct IDs; deterministic", () => {
  const a = deriveAgentIdentity(PRJ, { pinnedAgentName: "x" });
  const b = deriveAgentIdentity(PRJ2, { pinnedAgentName: "x" });
  assert.notEqual(a.agentId, b.agentId);
  assert.equal(a.agentId, deriveAgentIdentity(PRJ, { pinnedAgentName: "x" }).agentId);
  for (const bad of ["", "prj_xyz", `prj_${"G".repeat(32)}`]) {
    assert.throws(
      () => deriveAgentIdentity(bad, {}),
      (e: unknown) => e instanceof Error && e.message === "invalid-id-component",
    );
  }
});

test("key values are never trimmed or case-folded, control characters are neutralized, bounded to 256 bytes", () => {
  const sp = deriveAgentIdentity(PRJ, { pinnedAgentName: " A " });
  assert.notEqual(sp.agentId, deriveAgentIdentity(PRJ, { pinnedAgentName: "A" }).agentId);
  assert.notEqual(
    deriveAgentIdentity(PRJ, { pinnedAgentName: "a" }).agentId,
    deriveAgentIdentity(PRJ, { pinnedAgentName: "A" }).agentId,
  );
  const ctl = deriveAgentIdentity(PRJ, { pinnedAgentName: "a‮b\nc" });
  // Free text never enters a key: a non-token value is keyed by its hash and shown neutralized.
  assert.match(ctl.key, /^cred:h:[0-9a-f]{64}$/);
  assert.equal(ctl.displayName, "a\\u202Eb\\u000Ac");
  const long = deriveAgentIdentity(PRJ, { pinnedAgentName: "é".repeat(300) });
  assert.match(long.key, /^cred:h:[0-9a-f]{64}$/);
  assert.ok(new TextEncoder().encode(long.displayName).length <= 256);
});

test("run IDs: components and vectors from ADR-0005 section 4", () => {
  assert.equal(traceRun(PRJ, TRACE).runId, recompute("run", ["trace", PRJ, TRACE]));
  assert.equal(traceRun(PRJ, TRACE).kind, "trace");
  assert.equal(sessionRun(PRJ, SES).runId, recompute("run", ["session", PRJ, SES]));
  assert.equal(sessionRun(PRJ, SES).kind, "session");
  assert.equal(importRun(PRJ, IMP).runId, recompute("run", ["import", PRJ, IMP]));
  assert.equal(importRun(PRJ, IMP).kind, "import");
  // The committed N0 vector.
  assert.equal(
    traceRun(PRJ, "0af7651916cd43dd8448eb211c80319c").runId,
    "run_7b1ff1b975cbf85d88a2b2a739d81243",
  );
  assert.notEqual(traceRun(PRJ, TRACE).runId, traceRun(PRJ2, TRACE).runId);
  assert.notEqual(sessionRun(PRJ, `ses_${TRACE}`).runId, traceRun(PRJ, TRACE).runId);
  for (const bad of ["", "ABC", TRACE.toUpperCase(), TRACE.slice(1), `${TRACE}0`]) {
    assert.throws(() => traceRun(PRJ, bad));
  }
  assert.throws(() => sessionRun(PRJ, ""));
  assert.throws(() => traceRun("nope", TRACE));
});

test("logs runs: grouped by session.id, else one rolling run per agent per UTC day", () => {
  const agent = deriveAgentIdentity(PRJ, { pinnedAgentName: "x" }).agentId;
  const other = deriveAgentIdentity(PRJ, { pinnedAgentName: "y" }).agentId;
  const withSession = logsRun(PRJ, agent, id("S1"), 1n);
  assert.equal(withSession.runId, recompute("run", ["logs", PRJ, agent, "S1"]));
  assert.equal(withSession.ungroupedLogsDay, undefined);
  assert.equal(logsRun(PRJ, agent, id("S1"), 99_999_999_999_999n).runId, withSession.runId);
  assert.notEqual(logsRun(PRJ, other, id("S1"), 1n).runId, withSession.runId);

  const t1 = 1_763_251_200_000_000_000n; // 2025-11-16T00:00:00Z
  const day = logsRun(PRJ, agent, null, t1);
  assert.equal(day.ungroupedLogsDay, "2025-11-16");
  assert.equal(day.runId, recompute("run", ["logs", PRJ, agent, "ungrouped", "2025-11-16"]));
  assert.equal(logsRun(PRJ, agent, null, t1 + 86_399_999_999_999n).runId, day.runId);
  assert.notEqual(logsRun(PRJ, agent, null, t1 + 86_400_000_000_000n).runId, day.runId);
  // A session literally named "ungrouped" is a different run than an ungrouped day.
  assert.notEqual(logsRun(PRJ, agent, id("ungrouped"), t1).runId, day.runId);
  assert.equal(utcDay(0n), "undated");
  assert.equal(utcDay(t1), "2025-11-16");
});

test("run kind for a log record: projected session, then trace, then logs", () => {
  const agent = deriveAgentIdentity(PRJ, {}).agentId;
  const base = { projectId: PRJ, agentId: agent, session: id("S"), timeUnixNano: 1n };
  assert.equal(
    runForLogRecord({ ...base, traceId: null, projectedSessionId: SES }).kind,
    "session",
  );
  assert.equal(runForLogRecord({ ...base, traceId: TRACE }).kind, "trace");
  assert.equal(runForLogRecord({ ...base, traceId: null }).kind, "logs");
});

test("session IDs by basis", () => {
  const ids = (["session.id", "gen_ai.conversation.id", "adr0002.sessionId"] as const).map((b) =>
    deriveSessionId(PRJ, b, id("v")),
  );
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], recompute("sess", [PRJ, "session.id", "v"]));
  assert.throws(() => deriveSessionId(PRJ, "x" as never, id("v")));
  assert.throws(() => deriveSessionId(PRJ, "session.id", "v" as never));
});

test("agent identities and runs are stamped, frozen and checked; copies are not accepted", () => {
  const a = deriveAgentIdentity(PRJ, { pinnedAgentName: "billing" });
  assert.ok(isAgentIdentity(a));
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.components));
  assert.equal(a.displayName, "billing");
  assert.equal(a.projectId, PRJ);
  assert.equal(isAgentIdentity({ ...a }), false, "a copy is not stamped");
  assert.equal(isAgentIdentity(JSON.parse(JSON.stringify(a))), false);
  assert.equal(isAgentIdentity(null), false);
  assert.equal(isPolicyApplied(a), false, "an identity is not a policy-applied record");
  const sub = deriveAgentIdentity(PRJ, { pinnedAgentName: "billing", pinnedSubagentType: "rev" });
  assert.equal(sub.key, "cred:billing/sub:rev");
  assert.equal(sub.displayName, "billing/rev");
  assert.equal(deriveAgentIdentity(PRJ, {}).displayName, "unattributed");

  const run = traceRun(PRJ, TRACE);
  assert.ok(isRunRef(run) && Object.isFrozen(run));
  assert.equal(run.traceId, TRACE);
  assert.equal(isRunRef({ ...run }), false);
  assert.equal(isRunRef(a), false);
  for (const r of [
    sessionRun(PRJ, SES),
    importRun(PRJ, IMP),
    logsRun(PRJ, a.agentId, id("S1"), 1n),
  ]) {
    assert.ok(isRunRef(r));
  }
  assert.equal(sessionRun(PRJ, SES).adrSessionId, SES);
  assert.equal(importRun(PRJ, IMP).legacyImportId, IMP);
  const lr = logsRun(PRJ, a.agentId, id("S1"), 1n);
  assert.equal(lr.sessionKey, deriveSessionId(PRJ, "session.id", id("S1")));
  assert.match(lr.sessionKey ?? "", /^sess_[0-9a-f]{32}$/);
  assert.equal(lr.agentId, a.agentId);
  assert.equal(logsRun(PRJ, a.agentId, null, 1n).sessionKey, null);
  // ADR-0002 and import IDs have fixed formats: free text is refused.
  for (const bad of ["ses_abc", "x", `ses_${"G".repeat(32)}`, `${SES}0`]) {
    assert.throws(() => sessionRun(PRJ, bad));
  }
  assert.throws(() => importRun(PRJ, "imp_x"));
});

test("N1.5 G3 F2: a bare swn_ substring is not refused; only a full key shape is hashed or masked", () => {
  for (const v of ["swn_x", "SWN_x", "my-swn_tool"]) {
    const c = deriveAgentIdentity(PRJ, { pinnedAgentName: v });
    assert.equal(c.key, `cred:${v}`);
    assert.ok(isAgentKeyFormat("cred", c.key));
    assert.ok(isAgentIdentity(c));
    assert.equal(c.displayName, v);
  }
  const key = `swn_${"a".repeat(16)}_${"b".repeat(64)}`;
  assert.equal(containsSwainKey(key), true);
  assert.equal(containsSwainKey("swn_x"), false);
  const masked = deriveAgentIdentity(PRJ, { pinnedAgentName: `n-${key}` });
  assert.match(masked.key, /^cred:h:[0-9a-f]{64}$/);
  assert.equal(masked.displayName.includes("swn_"), false);
});

test("N1.5 G3 F2: a 256-byte namespace and name get a hash-form key and a display of at most 256 bytes", () => {
  const a = deriveAgentIdentity(PRJ, {
    resourceAttributes: attrs([
      kv("service.namespace", s("n".repeat(256))),
      kv("service.name", s("m".repeat(256))),
    ]),
  });
  assert.equal(a.keyBasis, "resource-ns");
  assert.match(a.key, /^resource:h:[0-9a-f]{64}$/);
  assert.ok(new TextEncoder().encode(a.displayName).length <= 256);
  assert.ok(new TextEncoder().encode(a.key).length <= 512);
  assert.ok(isAgentIdentity(a));
  // a short pair keeps the readable key
  const b = deriveAgentIdentity(PRJ, {
    resourceAttributes: attrs([kv("service.namespace", s("team")), kv("service.name", s("svc"))]),
  });
  assert.equal(b.key, "resource:team/svc");
});

test("hard condition 1: cred and adr0002 keys have exact formats and never carry free text", () => {
  const SECRET = `swn_${"a".repeat(16)}_${"b".repeat(64)}`;
  const PII = "alice.smith@example.com";
  for (const v of [SECRET, PII, "has space", "a/b", "é", "-lead"]) {
    const c = deriveAgentIdentity(PRJ, { pinnedAgentName: v });
    assert.match(c.key, /^cred:h:[0-9a-f]{64}$/, v);
    assert.ok(isAgentKeyFormat("cred", c.key));
    assert.equal(c.key.includes("swn_"), false);
    assert.equal(c.displayName.includes(SECRET), false);
    const sub = deriveAgentIdentity(PRJ, { pinnedAgentName: "ok", pinnedSubagentType: v });
    assert.match(sub.key, /^cred:ok\/sub:h:[0-9a-f]{64}$/);
    const p = deriveAgentIdentity(PRJ, { adr0002: { provider: v } });
    assert.match(p.key, /^adr0002:h:[0-9a-f]{64}$/);
    const ps = deriveAgentIdentity(PRJ, { adr0002: { provider: "claude-code", agentType: v } });
    assert.match(ps.key, /^adr0002:claude-code\/h:[0-9a-f]{64}$/);
  }
  assert.equal(deriveAgentIdentity(PRJ, { pinnedAgentName: SECRET }).displayName, "[REDACTED]");
  // the format check refuses planted values and other bases' shapes
  for (const [basis, key] of [
    ["cred", `cred:${SECRET}`],
    ["cred", `cred:${PII}`],
    ["cred", "cred:a b"],
    ["cred", "cred:"],
    ["cred", "adr0002:x"],
    ["cred", "cred:a/sub:b"],
    ["cred-sub", "cred:a"],
    ["cred-sub", `cred:a/sub:${SECRET}`],
    ["adr0002", `adr0002:${SECRET}`],
    ["adr0002-sub", "adr0002:a"],
    ["adr0002-sub", `adr0002:a/${PII}`],
    ["none", "none"],
    ["attr:name", "attr:name:x"],
    ["toString", "x"],
  ] as const) {
    assert.equal(isAgentKeyFormat(basis, key), false, `${basis} ${key}`);
  }
  assert.ok(isAgentKeyFormat("cred", "cred:billing"));
  assert.ok(isAgentKeyFormat("cred-sub", "cred:billing/sub:rev"));
  assert.ok(isAgentKeyFormat("adr0002", "adr0002:claude-code"));
  assert.ok(isAgentKeyFormat("adr0002-sub", "adr0002:claude-code/Explore"));
});
