import assert from "node:assert/strict";
import { test } from "node:test";
import type { InputKeyValue } from "../src/index.js";
import { applyContentPolicy, normalizeSpan, type PolicyKeyValue } from "../src/index.js";
import { d, kv, n, s, span, traces } from "./helpers.js";

/** Run attributes through the real policy, then normalize the stored span. */
function norm(attrs: InputKeyValue[], over: Parameters<typeof span>[0] = {}) {
  const out = applyContentPolicy(traces([span({ attributes: attrs, ...over })]), {
    contentPolicy: "hash-only",
    maxInlineBytes: 1024,
  });
  const sp = out.spans[0];
  assert.ok(sp);
  return normalizeSpan(sp);
}

test("classification by gen_ai.operation.name", () => {
  const table: [string, string, string | null][] = [
    ["chat", "llm", null],
    ["generate_content", "llm", null],
    ["text_completion", "llm", null],
    ["embeddings", "llm", "embeddings"],
    ["retrieval", "llm", "retrieval"],
    ["invoke_agent", "agent", null],
    ["create_agent", "agent", "create_agent"],
    ["execute_tool", "tool", null],
    ["invoke_workflow", "workflow", null],
    ["invoke_runner", "workflow", null],
    ["plan", "workflow", null],
  ];
  for (const [op, kind, sub] of table) {
    const r = norm([kv("gen_ai.operation.name", s(op))]);
    assert.equal(r.operation, kind, op);
    assert.equal(r.subtype, sub, op);
    assert.deepEqual(r.detector, { basis: "gen_ai.operation.name", value: op });
  }
});

test("classification by openinference.span.kind", () => {
  const table: [string, string, string | null][] = [
    ["LLM", "llm", null],
    ["AGENT", "agent", null],
    ["TOOL", "tool", null],
    ["CHAIN", "workflow", null],
    ["EMBEDDING", "llm", "embeddings"],
    ["RETRIEVER", "llm", "retrieval"],
  ];
  for (const [k, kind, sub] of table) {
    const r = norm([kv("openinference.span.kind", s(k))]);
    assert.equal(r.operation, kind, k);
    assert.equal(r.subtype, sub, k);
    assert.equal(r.detector.basis, "openinference.span.kind");
  }
});

test("gen_ai.operation.name wins over openinference.span.kind when both are present and recognised", () => {
  const r = norm([
    kv("openinference.span.kind", s("TOOL")),
    kv("gen_ai.operation.name", s("chat")),
  ]);
  assert.equal(r.operation, "llm");
  assert.equal(r.detector.basis, "gen_ai.operation.name");
  // An unrecognised gen_ai value falls through to OpenInference.
  const r2 = norm([
    kv("gen_ai.operation.name", s("mystery")),
    kv("openinference.span.kind", s("AGENT")),
  ]);
  assert.equal(r2.operation, "agent");
});

test("never classifies by span name or kind: a misleading name and kind give generic", () => {
  for (const name of [
    "chat gpt-4",
    "execute_tool",
    "invoke_agent",
    "LLM",
    "handoff to X",
    "claude_code.tool",
  ]) {
    for (const kind of [0, 1, 2, 3, 4, 5] as const) {
      const r = norm([kv("custom", s("x"))], { name, kind });
      assert.equal(r.operation, "generic", `${name}/${kind}`);
      assert.deepEqual(r.detector, { basis: "none", value: null });
    }
  }
  // The attribute wins whatever the name says.
  const r = norm([kv("gen_ai.operation.name", s("execute_tool"))], { name: "chat", kind: 3 });
  assert.equal(r.operation, "tool");
  // Values that are Object.prototype member names are not operations.
  assert.equal(norm([kv("gen_ai.operation.name", s("__proto__"))]).operation, "generic");
  assert.equal(norm([kv("gen_ai.operation.name", s("toString"))]).operation, "generic");
});

test("the normalizer takes attributes only: it cannot read name or kind", () => {
  // Compile-time: NormalizerInput has just `attributes`. Runtime: an object with only attributes works.
  const r = normalizeSpan({ attributes: [] as readonly PolicyKeyValue[] });
  assert.equal(r.operation, "generic");
});

test("a classified-by-nothing span is generic and keeps its attributes post-policy", () => {
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("custom.a", s("1")), kv("custom.b", n(2n))] })]),
    { contentPolicy: "hash-only", maxInlineBytes: 10 },
  );
  assert.equal(out.spans[0]?.attributes.length, 2);
  assert.equal(normalizeSpan(out.spans[0] ?? { attributes: [] }).operation, "generic");
});

test("handoff: execute_tool with gen_ai.transfer.* attributes", () => {
  const r = norm([
    kv("gen_ai.operation.name", s("execute_tool")),
    kv("gen_ai.transfer.target.name", s("planner")),
  ]);
  assert.equal(r.operation, "handoff");
  // OpenInference TOOL is only a tool (no handoff evidence in N1).
  assert.equal(norm([kv("openinference.span.kind", s("TOOL"))]).operation, "tool");
});

test("provider and model aliases, current names first", () => {
  assert.equal(norm([kv("gen_ai.provider.name", s("anthropic"))]).provider, "anthropic");
  assert.equal(norm([kv("gen_ai.system", s("openai"))]).provider, "openai");
  assert.equal(norm([kv("llm.provider", s("p3"))]).provider, "p3");
  assert.equal(norm([kv("llm.system", s("p4"))]).provider, "p4");
  const both = norm([kv("gen_ai.system", s("old")), kv("gen_ai.provider.name", s("new"))]);
  assert.equal(both.provider, "new");
  assert.deepEqual(both.normBasis, [{ field: "provider", key: "gen_ai.provider.name" }]);
  assert.equal(
    norm([kv("gen_ai.request.model", s("a")), kv("llm.model_name", s("b"))]).requestModel,
    "a",
  );
  assert.equal(norm([kv("llm.model_name", s("b"))]).requestModel, "b");
  assert.equal(norm([kv("gen_ai.response.model", s("r"))]).responseModel, "r");
});

test("token aliases and precedence: GenAI current, v1.36, OpenInference; both cache-write names", () => {
  const cases: [string, string, keyof ReturnType<typeof norm>["usage"]][] = [
    ["gen_ai.usage.input_tokens", "x", "inputTokens"],
    ["gen_ai.usage.prompt_tokens", "x", "inputTokens"],
    ["llm.token_count.prompt", "x", "inputTokens"],
    ["gen_ai.usage.output_tokens", "x", "outputTokens"],
    ["gen_ai.usage.completion_tokens", "x", "outputTokens"],
    ["llm.token_count.completion", "x", "outputTokens"],
    ["gen_ai.usage.cache_read.input_tokens", "x", "cacheReadTokens"],
    ["llm.token_count.prompt_details.cache_read", "x", "cacheReadTokens"],
    ["gen_ai.usage.cache_write.input_tokens", "x", "cacheWriteTokens"],
    ["gen_ai.usage.cache_creation.input_tokens", "x", "cacheWriteTokens"],
    ["llm.token_count.prompt_details.cache_write", "x", "cacheWriteTokens"],
    ["gen_ai.usage.reasoning.output_tokens", "x", "reasoningTokens"],
    ["llm.token_count.completion_details.reasoning", "x", "reasoningTokens"],
  ];
  for (const [key, , field] of cases) {
    const r = norm([kv(key, n(42n))]);
    assert.equal(r.usage[field], 42, key);
    assert.deepEqual(r.normBasis, [{ field, key }], key);
  }
  // Precedence: current name beats the alias, in either attribute order.
  const r = norm([
    kv("llm.token_count.prompt", n(1n)),
    kv("gen_ai.usage.prompt_tokens", n(2n)),
    kv("gen_ai.usage.input_tokens", n(3n)),
  ]);
  assert.equal(r.usage.inputTokens, 3);
  const w = norm([
    kv("gen_ai.usage.cache_creation.input_tokens", n(5n)),
    kv("gen_ai.usage.cache_write.input_tokens", n(6n)),
  ]);
  assert.equal(w.usage.cacheWriteTokens, 6);
  // An unusable current value falls through to the alias.
  const f = norm([
    kv("gen_ai.usage.input_tokens", s("not a number")),
    kv("llm.token_count.prompt", n(9n)),
  ]);
  assert.equal(f.usage.inputTokens, 9);
});

test("token values: doubles that are whole numbers and digit strings are accepted; negatives and fractions are not", () => {
  assert.equal(norm([kv("gen_ai.usage.input_tokens", d(7))]).usage.inputTokens, 7);
  assert.equal(norm([kv("gen_ai.usage.input_tokens", s("12"))]).usage.inputTokens, 12);
  assert.equal(norm([kv("gen_ai.usage.input_tokens", d(1.5))]).usage.inputTokens, null);
  assert.equal(norm([kv("gen_ai.usage.input_tokens", n(-1n))]).usage.inputTokens, null);
  assert.equal(norm([kv("gen_ai.usage.input_tokens", n(2n ** 60n))]).usage.inputTokens, null);
});

test("totals are computed from input + output only when both are present", () => {
  assert.equal(
    norm([kv("gen_ai.usage.input_tokens", n(3n)), kv("gen_ai.usage.output_tokens", n(4n))]).usage
      .totalTokensComputed,
    7,
  );
  assert.equal(norm([kv("gen_ai.usage.input_tokens", n(3n))]).usage.totalTokensComputed, null);
});

test("tool name and call id", () => {
  const r = norm([
    kv("tool.name", s("alias")),
    kv("gen_ai.tool.name", s("search")),
    kv("gen_ai.tool.call.id", s("call_1")),
  ]);
  assert.equal(r.toolName, "search");
  assert.equal(r.toolCallId, "call_1");
  assert.equal(norm([kv("tool.name", s("alias"))]).toolName, "alias");
  assert.equal(norm([]).toolName, null);
});

test("normalizer keys survive the allowlist and masking unchanged", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("gen_ai.operation.name", s("chat")),
          kv("gen_ai.request.model", s("m")),
          kv("gen_ai.usage.input_tokens", n(5n)),
        ],
      }),
    ]),
    { contentPolicy: "hash-only", maxInlineBytes: 10, metadataPolicy: "allowlist" },
  );
  const r = normalizeSpan(out.spans[0] ?? { attributes: [] });
  assert.equal(r.operation, "llm");
  assert.equal(r.requestModel, "m");
  assert.equal(r.usage.inputTokens, 5);
});
