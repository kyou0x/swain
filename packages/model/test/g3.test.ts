/** G3 review conditions B1, B2, B3, F1, F2, F4, F7, F8 and the db brand reconciliation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContentRef, sha256Hex } from "@swain/core";
import {
  applyContentPolicy,
  type ContentPolicyInput,
  deriveAgentIdentity,
  deriveParentOfEdges,
  deriveSameSessionEdges,
  deriveSessionId,
  identityOfAttribute,
  isPolicyApplied,
  logsRun,
  METADATA_CAP_BYTES,
  type PolicyAppliedSpan,
  type PolicyKeyValue,
  policyAppliedLogJson,
  policyAppliedSpanJson,
} from "../src/index.js";
import { arr, dump, id, kv, kvs, log, logs, n, PRJ, s, span, traces } from "./helpers.js";

const HASH_ONLY: ContentPolicyInput = { contentPolicy: "hash-only", maxInlineBytes: 1024 };
const INLINE: ContentPolicyInput = { contentPolicy: "inline", maxInlineBytes: 1024 };
const ALLOW: ContentPolicyInput = { ...HASH_ONLY, metadataPolicy: "allowlist" };
const bytesOf = (x: string): number => new TextEncoder().encode(x).length;
const PH = /^\[key:[0-9a-f]{16}\]$/;

function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o["key"] === "string" && "keyAltered" in o) out.push(o["key"]);
    for (const x of Object.values(o)) allKeys(x, out);
  }
  return out;
}

// ---- B1 -------------------------------------------------------------------------------------

test("B1: 10,000 256-byte keys keep at most 16 KiB of key bytes; the rest are placeholders", () => {
  const prefix = "SWAIN-CANARY-key-";
  const attributes = Array.from({ length: 10_000 }, (_, i) =>
    kv(`${prefix}${i.toString().padStart(5, "0")}${"k".repeat(256)}`.slice(0, 256), {
      kind: "bool",
      value: true,
    }),
  );
  const out = applyContentPolicy(traces([span({ attributes })]), HASH_ONLY);
  const sp = out.spans[0];
  assert.ok(sp);
  const kept = sp.attributes.filter((a) => !PH.test(a.key));
  const keptBytes = kept.reduce((t, a) => t + bytesOf(a.key), 0);
  assert.ok(keptBytes <= METADATA_CAP_BYTES, `${keptBytes}`);
  assert.equal(kept.length, 63); // 63 * 256 = 16128; the span name takes 1 byte
  const placeholders = sp.attributes.filter((a) => PH.test(a.key));
  assert.equal(placeholders.length, 10_000 - 63);
  assert.ok(placeholders.every((a) => a.keyAltered));
  assert.ok(sp.metadataBytes <= METADATA_CAP_BYTES);
  assert.deepEqual(
    sp.warnings.map((w) => w.code),
    ["over-bounds"],
  );
  // The placeholder is the first 16 hex of sha256 of the original key, deterministic.
  const orig = attributes[9_999]?.key ?? "";
  assert.equal(
    sp.attributes[9_999]?.key,
    `[key:${sha256Hex(new TextEncoder().encode(orig)).slice(0, 16)}]`,
  );
});

test("B1: a key over 256 bytes is replaced, never kept as a 256-byte prefix", () => {
  const long = `SWAIN-CANARY-longkey-${"k".repeat(300)}`;
  const out = applyContentPolicy(
    traces([span({ attributes: [kv(long, n(1n)), kv("ok", n(2n))] })]),
    HASH_ONLY,
  );
  assert.ok(!dump(out).includes("SWAIN-CANARY"));
  const a = out.spans[0]?.attributes ?? [];
  assert.match(a[0]?.key ?? "", PH);
  assert.equal(a[0]?.keyAltered, true);
  assert.equal(a[1]?.key, "ok");
  assert.deepEqual(
    out.spans[0]?.warnings.map((w) => w.code),
    ["over-bounds"],
  );
});

test("B1: under allowlist every non-allowlisted key, nested ones included, is a placeholder", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("SWAIN-CANARY-top", s("v")),
          kv("gen_ai.request.model", s("m")),
          kv("outer", kvs(kv("SWAIN-CANARY-nested", s("v")), kv("service.name", s("x")))),
          kv("arr", arr(kvs(kv("SWAIN-CANARY-deep", n(1n))))),
        ],
      }),
    ]),
    ALLOW,
  );
  assert.ok(!dump(out).includes("SWAIN-CANARY"));
  const keys = allKeys(out.spans[0]);
  assert.ok(keys.includes("gen_ai.request.model"));
  assert.ok(keys.includes("service.name"));
  assert.equal(keys.filter((k) => PH.test(k)).length, 5); // top, outer, nested, arr, deep
  // Allowlist replacement is not a bound: no over-bounds warning for it.
  assert.equal(out.spans[0]?.warnings.length, 0);
});

test("B1: resource + scope + record share ONE cap per emitted record", () => {
  const big = (p: string, count: number) =>
    Array.from({ length: count }, (_, i) => kv(`${p}${i}`, s("v".repeat(200))));
  const out = applyContentPolicy(
    traces(
      [
        span({ attributes: big("r", 30) }),
        span({ spanId: "00f067aa0ba902b8", attributes: [kv("a", s("1"))] }),
      ],
      { resource: big("res", 40), scope: { attributes: big("sc", 40) } },
    ),
    HASH_ONLY,
  );
  for (const sp of out.spans) {
    assert.ok(sp.metadataBytes <= METADATA_CAP_BYTES, `${sp.metadataBytes}`);
    // Resource + scope already hold ~16.3 KiB, so nearly all of the cap is gone for every record.
    assert.ok(sp.metadataBytes > 16_000);
  }
  assert.equal(out.spans[0]?.resource.attributes.length, 40);
  // The first record's 30 large values cannot fit in what is left: its own over-bounds warning.
  assert.ok(out.spans[0]?.warnings.some((w) => w.code === "over-bounds"));
  assert.ok(out.spans[0]?.attributes.every((a) => a.value.kind === "content"));
  // The second record's tiny attribute still fits.
  assert.equal(out.spans[1]?.attributes[0]?.value.kind, "text");
  assert.equal(out.spans[1]?.warnings.length, 0);
});

// ---- B2 -------------------------------------------------------------------------------------

const ASST_A = "asst_aB3dE5gH7jK9mN1pQ3sT5vW7";
const ASST_B = "asst_zY9xW8vU7tS6rQ5pO4nM3lK2";

function agentOf(value: string) {
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("gen_ai.agent.id", s(value))] })]),
    HASH_ONLY,
  );
  const sp = out.spans[0] as PolicyAppliedSpan;
  const attr = sp.attributes[0];
  assert.equal(attr?.value.kind === "text" && attr.value.redactionCount > 0, true, "masked");
  return { out, id: deriveAgentIdentity(PRJ, { attributes: sp.attributes }) };
}

test("B2: two distinct masked agent IDs give two agents; the same one twice gives the same agent", () => {
  const a = agentOf(ASST_A);
  const b = agentOf(ASST_B);
  const a2 = agentOf(ASST_A);
  assert.notEqual(a.id.agentId, b.id.agentId);
  assert.equal(a.id.agentId, a2.id.agentId);
  assert.equal(a.id.keyBasis, "attr:gen_ai.agent.id");
  // Display uses the masked form only; the originals appear nowhere.
  assert.equal(a.id.key, "attr:gen_ai.agent.id:[REDACTED]");
  for (const x of [a, b]) {
    const text = dump(x);
    assert.ok(!text.includes(ASST_A) && !text.includes(ASST_B));
  }
  // The component is the hash of the original.
  const part = `h:${sha256Hex(new TextEncoder().encode(ASST_A))}`;
  const expected = deriveAgentIdentity(PRJ, {
    attributes: [
      {
        key: "gen_ai.agent.id",
        keyAltered: false,
        value: {
          kind: "text",
          value: "x",
          bestEffortMasked: true,
          redactionCount: 1,
          identity: part,
        },
      },
    ],
  });
  assert.equal(expected.agentId, a.id.agentId);
});

test("B2: an unmasked value is used directly; a value without an applier identity is no evidence", () => {
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("gen_ai.agent.name", s("planner"))] })]),
    HASH_ONLY,
  );
  const attrs = out.spans[0]?.attributes ?? [];
  assert.equal(attrs[0]?.value.kind === "text" && attrs[0].value.identity, "planner");
  const forged: PolicyKeyValue[] = [
    {
      key: "gen_ai.agent.name",
      keyAltered: false,
      value: { kind: "text", value: "planner", bestEffortMasked: true, redactionCount: 0 },
    },
  ];
  assert.equal(deriveAgentIdentity(PRJ, { attributes: forged }).keyBasis, "none");
  // Non-identity keys never carry an identity part.
  const other = applyContentPolicy(
    traces([span({ attributes: [kv("custom", s("planner"))] })]),
    HASH_ONLY,
  );
  const v = other.spans[0]?.attributes[0]?.value;
  assert.equal(v?.kind === "text" && v.identity, undefined);
});

test("B2: service.name and namespace use unmasked identity too", () => {
  const mk = (name: string) => {
    const o = applyContentPolicy(
      traces([span()], { resource: [kv("service.name", s(name))] }),
      HASH_ONLY,
    );
    return deriveAgentIdentity(PRJ, { resourceAttributes: o.spans[0]?.resource.attributes ?? [] });
  };
  assert.notEqual(mk(ASST_A).agentId, mk(ASST_B).agentId);
  assert.equal(mk(ASST_A).agentId, mk(ASST_A).agentId);
});

function conv(value: string) {
  const o = applyContentPolicy(
    traces([span({ attributes: [kv("gen_ai.conversation.id", s(value))] })]),
    HASH_ONLY,
  );
  const idv = identityOfAttribute(o.spans[0]?.attributes, "gen_ai.conversation.id");
  assert.ok(idv);
  return idv;
}

test("B2: distinct masked conversation IDs give no same-session edge; the same one does", () => {
  const a = conv(ASST_A);
  const b = conv(ASST_B);
  const fact = (runId: string, session: typeof a) => ({
    runId,
    sessionBasis: "gen_ai.conversation.id" as const,
    session,
    keyId: "k",
    ref: runId,
  });
  assert.equal(deriveSameSessionEdges(PRJ, [fact("run_1", a), fact("run_2", b)]).length, 0);
  assert.equal(
    deriveSameSessionEdges(PRJ, [fact("run_1", a), fact("run_2", conv(ASST_A))]).length,
    1,
  );
  assert.notEqual(
    deriveSessionId(PRJ, "gen_ai.conversation.id", a),
    deriveSessionId(PRJ, "gen_ai.conversation.id", b),
  );
  const agent = deriveAgentIdentity(PRJ, {}).agentId;
  assert.notEqual(logsRun(PRJ, agent, a, 1n).runId, logsRun(PRJ, agent, b, 1n).runId);
  assert.equal(logsRun(PRJ, agent, a, 1n).runId, logsRun(PRJ, agent, conv(ASST_A), 1n).runId);
  // No unmasked original anywhere in the derived output.
  const text = dump([
    deriveSameSessionEdges(PRJ, [fact("run_1", a), fact("run_2", conv(ASST_A))]),
    a,
    logsRun(PRJ, agent, a, 1n),
  ]);
  assert.ok(!text.includes(ASST_A));
});

test("B2: identity functions refuse values that did not come from the applier", () => {
  const agent = deriveAgentIdentity(PRJ, {}).agentId;
  assert.throws(() => logsRun(PRJ, agent, "S" as never, 1n));
  assert.throws(() => deriveSessionId(PRJ, "session.id", { part: "x", display: "x" } as never));
  assert.throws(() =>
    deriveSameSessionEdges(PRJ, [
      { runId: "r", sessionBasis: "session.id", session: "x" as never, keyId: "k", ref: "r" },
    ]),
  );
  assert.ok(id("ok"));
});

// ---- B3 -------------------------------------------------------------------------------------

test("B3: outputs are deep-frozen; a forged span fails isPolicyApplied", () => {
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("input.value", s("x")), kv("a", s("b"))] })], {
      resource: [kv("r", s("v"))],
      scope: { name: "sc" },
    }),
    HASH_ONLY,
  );
  const sp = out.spans[0] as PolicyAppliedSpan;
  assert.ok(Object.isFrozen(out) && Object.isFrozen(out.spans) && Object.isFrozen(sp));
  const mutations: (() => void)[] = [
    () => (sp.attributes as PolicyKeyValue[]).push(sp.attributes[0] as PolicyKeyValue),
    () => {
      (sp as unknown as { name: unknown }).name = "x";
    },
    () => {
      (sp.attributes[0] as unknown as { key: string }).key = "x";
    },
    () => {
      const v = sp.attributes[0]?.value as unknown as { ref: { sha256: string } };
      v.ref.sha256 = "0";
    },
    () => {
      (sp.resource.attributes as PolicyKeyValue[]).length = 0;
    },
    () => {
      (sp.scope as unknown as { name: unknown }).name = "x";
    },
    () => (out.spans as PolicyAppliedSpan[]).push({ ...sp } as PolicyAppliedSpan),
    () => {
      (sp.policy as unknown as { contentPolicy: string }).contentPolicy = "inline";
    },
  ];
  for (const m of mutations) assert.throws(m, TypeError);
  const forged = { ...sp } as PolicyAppliedSpan;
  assert.equal(isPolicyApplied(forged), false);
  assert.equal(isPolicyApplied([forged]), false);
  assert.equal(isPolicyApplied(sp), true);
  assert.equal(isPolicyApplied(out), true);
  assert.throws(() => policyAppliedSpanJson(forged));
});

// ---- F1, F2, F4, F7 ------------------------------------------------------------------------

test("F1: inline kvlist content: nested secret-name and content keys are replaced before inlining", () => {
  const value = kvs(
    kv("password", s("hunter2")),
    kv("msg", s("hi")),
    kv("nested", arr(kvs(kv("api_key", s("sk-123")), kv("input.value", s("deep secret"))))),
  );
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("gen_ai.input.messages", value)] })]),
    INLINE,
  );
  const v = out.spans[0]?.attributes[0]?.value;
  assert.equal(v?.kind, "content");
  const ref = v?.kind === "content" ? v.ref : undefined;
  assert.ok(ref?.inline);
  for (const bad of ["hunter2", "sk-123", "deep secret"]) assert.ok(!ref.inline.includes(bad), bad);
  assert.ok(ref.inline.includes("[REDACTED]") && ref.inline.includes("hi"));
  assert.ok((ref.redactionCount ?? 0) >= 3);
  // The hash and byteLength stay over the ORIGINAL projection.
  const original = makeContentRef({
    kv: [
      ["password", "hunter2"],
      ["msg", "hi"],
      [
        "nested",
        [
          {
            kv: [
              ["api_key", "sk-123"],
              ["input.value", "deep secret"],
            ],
          },
        ],
      ],
    ],
  });
  assert.equal(ref.sha256, original.sha256);
  assert.equal(ref.byteLength, original.byteLength);
});

test("F2: an oversize URL under inline gets the URL rule before inlining", () => {
  const url = `https://user:pw@h.example/p?a=${"x".repeat(300)}&sig=TOPSECRETVALUE`;
  const out = applyContentPolicy(traces([span({ attributes: [kv("url.full", s(url))] })]), INLINE);
  const v = out.spans[0]?.attributes[0]?.value;
  const ref = v?.kind === "content" ? v.ref : undefined;
  assert.ok(ref?.inline);
  assert.ok(!ref.inline.includes("user:pw"));
  assert.ok(!ref.inline.includes("xxxx"));
  assert.ok(!ref.inline.includes("TOPSECRETVALUE"));
  assert.ok(ref.inline.includes("a=[REDACTED]"));
  assert.equal(ref.sha256, makeContentRef(url).sha256);
});

test("F4: every claude_code.* record: strings, arrays and maps are content except the allowlist", () => {
  const attributes = [
    kv("event.name", s("claude_code.tool_result")),
    kv("session.id", s("sess-1")),
    kv("tool_name", s("Bash")),
    kv("tool_use_id", s("toolu_1")),
    kv("model", s("m")),
    kv("success", { kind: "bool", value: true }),
    kv("duration_ms", n(5n)),
    kv("unknown_text", s("SWAIN-CANARY-cc")),
    kv("unknown_list", arr(s("SWAIN-CANARY-cc2"))),
    kv("unknown_map", kvs(kv("x", s("SWAIN-CANARY-cc3")))),
    kv("tool_input", s("SWAIN-CANARY-cc4")),
    kv("count", n(3n)),
  ];
  for (const rec of [
    log({ eventName: "claude_code.tool_result", attributes }),
    log({ attributes }),
    log({ eventName: "claude_code.future_event", attributes: attributes.slice(1) }),
  ]) {
    const out = applyContentPolicy(logs([rec]), HASH_ONLY);
    assert.ok(!dump(out).includes("SWAIN-CANARY"));
    const m = new Map((out.logs[0]?.attributes ?? []).map((a) => [a.key, a.value.kind]));
    assert.equal(m.get("session.id"), "text");
    assert.equal(m.get("tool_name"), "text");
    assert.equal(m.get("tool_use_id"), "text");
    assert.equal(m.get("model"), "text");
    assert.equal(m.get("success"), "bool");
    assert.equal(m.get("duration_ms"), "int");
    assert.equal(m.get("count"), "int");
    for (const k of ["unknown_text", "unknown_list", "unknown_map", "tool_input"]) {
      assert.equal(m.get(k), "content", k);
    }
  }
  // A non-Claude record is unaffected.
  const plain = applyContentPolicy(
    logs([log({ eventName: "other", attributes: [kv("custom", s("plain"))] })]),
    HASH_ONLY,
  );
  assert.equal(plain.logs[0]?.attributes[0]?.value.kind, "text");
});

test("F7: over-depth values are a distinct marker kind with no hash", () => {
  let v = s("SWAIN-CANARY-deep");
  for (let i = 0; i < 40; i++) v = arr(v);
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("custom", v), kv("input.value", v)] })]),
    HASH_ONLY,
  );
  assert.deepEqual(
    out.spans[0]?.attributes.map((a) => a.value),
    [{ kind: "over-depth" }, { kind: "over-depth" }],
  );
  const lo = applyContentPolicy(logs([log({ body: v })]), HASH_ONLY);
  assert.deepEqual(lo.logs[0]?.body, { kind: "over-depth" });
  assert.ok(!dump([out, lo]).includes("sha256"));
});

// ---- brand reconciliation ------------------------------------------------------------------

test("records carry traceState, severityText, eventName and the applied policy", () => {
  const out = applyContentPolicy(traces([span({ traceState: "a=b" })]), {
    contentPolicy: "inline",
    maxInlineBytes: 77,
    metadataPolicy: "allowlist",
  });
  const sp = out.spans[0];
  assert.deepEqual(sp?.policy, {
    contentPolicy: "inline",
    maxInlineBytes: 77,
    metadataPolicy: "allowlist",
    contentKeysVersion: "swain.content-keys/1",
  });
  assert.equal(sp?.traceState.kind, "text");
  const lo = applyContentPolicy(logs([log({ severityText: "INFO", eventName: "e" })]), HASH_ONLY);
  assert.equal(lo.logs[0]?.severityText.kind === "text" && lo.logs[0].severityText.value, "INFO");
  assert.equal(lo.logs[0]?.eventName.kind === "text" && lo.logs[0].eventName.value, "e");
  assert.equal(lo.logs[0]?.policy.contentPolicy, "hash-only");
});

test("policyAppliedSpanJson / policyAppliedLogJson: stable, sorted, bigint as strings, forgery refused", () => {
  const input = traces([
    span({ attributes: [kv("b", s("1")), kv("a", n(5n))], startTimeUnixNano: 2n ** 62n }),
  ]);
  const t1 = policyAppliedSpanJson(
    applyContentPolicy(input, HASH_ONLY).spans[0] as PolicyAppliedSpan,
  );
  const t2 = policyAppliedSpanJson(
    applyContentPolicy(input, HASH_ONLY).spans[0] as PolicyAppliedSpan,
  );
  assert.equal(t1, t2);
  const parsed = JSON.parse(t1) as Record<string, unknown>;
  assert.equal(parsed["format"], "swain.policy-applied/1");
  assert.equal(parsed["type"], "span");
  assert.equal(parsed["startTimeUnixNano"], (2n ** 62n).toString());
  assert.ok(Object.keys(parsed).join() === [...Object.keys(parsed)].sort().join());
  assert.ok("traceState" in parsed && "policy" in parsed && "resource" in parsed);
  const lj = JSON.parse(
    policyAppliedLogJson(
      applyContentPolicy(logs([log({ body: s("x") })]), HASH_ONLY).logs[0] as never,
    ),
  ) as Record<string, unknown>;
  assert.equal(lj["type"], "log");
  assert.ok("severityText" in lj && "eventName" in lj && "policy" in lj);
  assert.throws(() =>
    policyAppliedLogJson({
      ...(applyContentPolicy(logs([log()]), HASH_ONLY).logs[0] as object),
    } as never),
  );
  assert.ok(deriveParentOfEdges);
});
