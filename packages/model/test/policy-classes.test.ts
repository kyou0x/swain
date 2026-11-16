import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContentRef, sha256Hex } from "@swain/core";
import {
  applyContentPolicy,
  type ContentPolicyInput,
  type PolicyAppliedTraces,
  type PolicyKeyValue,
  type PolicyValue,
} from "../src/index.js";
import { arr, bytes, d, dump, kv, kvs, log, logs, n, s, span, traces } from "./helpers.js";

const HASH_ONLY: ContentPolicyInput = { contentPolicy: "hash-only", maxInlineBytes: 1024 };
const INLINE: ContentPolicyInput = { contentPolicy: "inline", maxInlineBytes: 1024 };
const ALLOW: ContentPolicyInput = { ...HASH_ONLY, metadataPolicy: "allowlist" };

/** Every content key of ADR-0005 section 6.3 plus the SPEC-003 section 6.1 fixture keys, by family. */
const CONTENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  genai: [
    "gen_ai.input.messages",
    "gen_ai.output.messages",
    "gen_ai.system_instructions",
    "gen_ai.tool.call.arguments",
    "gen_ai.tool.call.result",
    "gen_ai.tool.definitions",
    "gen_ai.tool.description",
    "gen_ai.prompt.0.content",
    "gen_ai.prompt",
    "gen_ai.completion.0.content",
  ],
  openinference: [
    "input.value",
    "output.value",
    "llm.input_messages.0.message.content",
    "llm.output_messages.0.message.content",
    "llm.prompts",
    "llm.prompts.0.prompt.text",
    "llm.prompt_template.template",
    "llm.tools.0.tool.json_schema",
    "tool.parameters",
    "retrieval.documents.0.document.content",
    "reranker.input_documents.0",
    "embedding.embeddings.0.embedding.text",
    "metadata",
  ],
  "vercel-ai": [
    "ai.prompt",
    "ai.prompt.messages",
    "ai.response.text",
    "ai.toolCall.args",
    "ai.toolCall.result",
  ],
  traceloop: ["traceloop.entity.input", "traceloop.entity.output"],
  general: [
    "exception.message",
    "exception.stacktrace",
    "db.statement",
    "db.query.text",
    "process.command_line",
    "process.command_args",
  ],
  "claude-code": ["prompt", "tool_input", "tool_parameters"],
  "adk-legacy": [
    "gcp.vertex.agent.llm_request",
    "gcp.vertex.agent.tool_call_args",
    "gcp.vertex.agent.invocation_id",
  ],
  "secret-name": [
    "http.request.header.authorization",
    "http.response.header.set-cookie",
    "rpc.grpc.metadata.x-api-key",
    "my.custom.password",
    "db.connection_token",
    "x.client_secret",
    "private-key",
    "aws.credential",
    "payload.signature",
  ],
};

function canary(cls: string, pad = 0): string {
  return `SWAIN-CANARY-${cls}${"x".repeat(pad)}`;
}

function onlySpanAttr(out: PolicyAppliedTraces): PolicyKeyValue {
  const a = out.spans[0]?.attributes[0];
  if (a === undefined) throw new Error("no attribute");
  return a;
}

function contentRefOf(v: PolicyValue) {
  assert.equal(v.kind, "content");
  return v.kind === "content" ? v.ref : assert.fail("not content");
}

test("every content family and key: canary absent, ContentRef equals makeContentRef (hash-only)", () => {
  for (const [family, keys] of Object.entries(CONTENT_KEYS)) {
    for (const key of keys) {
      for (const text of [canary(family), canary(family, 400), `{${canary(family)}}`]) {
        const out = applyContentPolicy(
          traces([span({ attributes: [kv(key, s(text))] })]),
          HASH_ONLY,
        );
        assert.ok(!dump(out).includes("SWAIN-CANARY"), `${family}:${key}`);
        const a = onlySpanAttr(out);
        assert.equal(a.key, key);
        const ref = contentRefOf(a.value);
        assert.deepEqual(ref, makeContentRef(text), `${family}:${key}`);
        assert.equal(ref.retention, "hash-only");
        assert.equal(ref.inline, undefined);
      }
    }
  }
});

test("content keys match case-insensitively and cannot be dodged with format characters", () => {
  for (const key of ["GEN_AI.INPUT.MESSAGES", "gen_ai.input.messages​", " input.value", "Prompt"]) {
    const out = applyContentPolicy(
      traces([span({ attributes: [kv(key, s(canary("k")))] })]),
      HASH_ONLY,
    );
    assert.ok(!dump(out).includes("SWAIN-CANARY"), key);
  }
});

test("content at any value type: numbers, booleans, arrays and kvlists under a content key", () => {
  const values = [
    n(5n),
    d(1.5),
    arr(s(canary("a")), s("b")),
    kvs(kv("role", s("user")), kv("content", s(canary("m")))),
    arr(kvs(kv("content", s(canary("deep"))))),
  ];
  for (const v of values) {
    const out = applyContentPolicy(
      traces([span({ attributes: [kv("gen_ai.input.messages", v)] })]),
      HASH_ONLY,
    );
    assert.ok(!dump(out).includes("SWAIN-CANARY"));
    const ref = contentRefOf(onlySpanAttr(out).value);
    assert.equal(ref.retention, "hash-only");
    assert.equal(ref.encoding, v.kind === "string" ? "utf8" : "jcs-json");
  }
});

test("inline policy: content inline, masked, truncated; hash still equals makeContentRef of the original", () => {
  const text = `${canary("i")} token=hunter2 ${"y".repeat(2000)}`;
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("input.value", s(text))] })]),
    INLINE,
  );
  const ref = contentRefOf(onlySpanAttr(out).value);
  const plain = makeContentRef(text);
  assert.equal(ref.sha256, plain.sha256);
  assert.equal(ref.byteLength, plain.byteLength);
  assert.equal(ref.retention, "inline-truncated");
  assert.ok(ref.inline?.includes("SWAIN-CANARY-i"));
  assert.ok(!ref.inline?.includes("hunter2"));
  assert.equal(ref.redactionCount, 1);
  assert.ok(new TextEncoder().encode(ref.inline ?? "").length <= 1024);
  // Short, unmasked inline equals makeContentRef exactly.
  const short = applyContentPolicy(
    traces([span({ attributes: [kv("input.value", s("hello"))] })]),
    INLINE,
  );
  assert.deepEqual(
    contentRefOf(onlySpanAttr(short).value),
    makeContentRef("hello", { retention: "inline", maxInlineBytes: 1024 }),
  );
});

test("inline policy: a secret split by truncation is not left half-visible", () => {
  const secret = `sk-${"a".repeat(40)}`;
  const text = `${"z".repeat(1019)} ${secret}`;
  const out = applyContentPolicy(
    traces([span({ attributes: [kv("input.value", s(text))] })]),
    INLINE,
  );
  const ref = contentRefOf(onlySpanAttr(out).value);
  assert.ok(!(ref.inline ?? "").includes("sk-"));
});

test("bytesValue is always hash-only, even under inline, at any key, also nested in content", () => {
  for (const policy of [HASH_ONLY, INLINE]) {
    const out = applyContentPolicy(
      traces([
        span({
          attributes: [
            kv("blob", bytes(1, 2, 3)),
            kv("input.value", arr(s("text"), bytes(9, 9))),
            kv("nested", kvs(kv("raw", bytes(4, 5, 6)))),
          ],
        }),
      ]),
      policy,
    );
    const [a, b, c] = out.signal === "traces" ? (out.spans[0]?.attributes ?? []) : [];
    assert.ok(a && b && c);
    assert.deepEqual(contentRefOf(a.value), makeContentRef({ bytes: "AQID" }));
    assert.equal(contentRefOf(b.value).retention, "hash-only");
    assert.equal(b.value.kind, "content");
    const inner = c.value.kind === "kvlist" ? c.value.values[0]?.value : undefined;
    assert.equal(inner?.kind, "content");
    assert.equal(contentRefOf(inner as PolicyValue).retention, "hash-only");
  }
});

test("secret-name rule, usage-key exemption: numeric usage keys stay numbers", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("gen_ai.usage.input_tokens", n(12n)),
          kv("gen_ai.usage.output_tokens", d(7)),
          kv("gen_ai.usage.cache_read.input_tokens", n(1n)),
          kv("gen_ai.request.max_tokens", n(4096n)),
          kv("llm.token_count.prompt", n(3n)),
          kv("llm.token_count.prompt_details.cache_write", n(2n)),
          kv("gen_ai.usage.digits_tokens", s("123")),
          kv("gen_ai.usage.attack_tokens", s("sk-notanumber")),
          kv("auth_token", n(5n)),
        ],
      }),
    ]),
    HASH_ONLY,
  );
  const a = out.signal === "traces" ? (out.spans[0]?.attributes ?? []) : [];
  const byKey = new Map(a.map((x) => [x.key, x.value]));
  assert.deepEqual(byKey.get("gen_ai.usage.input_tokens"), { kind: "int", value: 12n });
  assert.deepEqual(byKey.get("gen_ai.usage.output_tokens"), { kind: "double", value: 7 });
  assert.equal(byKey.get("gen_ai.usage.cache_read.input_tokens")?.kind, "int");
  assert.equal(byKey.get("gen_ai.request.max_tokens")?.kind, "int");
  assert.equal(byKey.get("llm.token_count.prompt")?.kind, "int");
  assert.equal(byKey.get("llm.token_count.prompt_details.cache_write")?.kind, "int");
  assert.equal(byKey.get("gen_ai.usage.digits_tokens")?.kind, "text");
  // A usage-shaped key carrying a non-number string follows the secret-name rule.
  assert.equal(byKey.get("gen_ai.usage.attack_tokens")?.kind, "content");
  // `token` elsewhere is a secret name at any value type.
  assert.equal(byKey.get("auth_token")?.kind, "content");
});

test("nested arrays and maps: nearest key classifies each leaf", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv(
            "config",
            kvs(
              kv("region", s("eu-west-1")),
              kv("password", s(canary("pw"))),
              kv("list", arr(s("a"), s("b"), arr(s("c")))),
              kv("inner", kvs(kv("api_key", arr(s(canary("k")))))),
              kv("count", n(3n)),
              kv("flag", { kind: "bool", value: true }),
            ),
          ),
        ],
      }),
    ]),
    HASH_ONLY,
  );
  assert.ok(!dump(out).includes("SWAIN-CANARY"));
  const top = onlySpanAttr(out).value;
  assert.equal(top.kind, "kvlist");
  const m = new Map((top.kind === "kvlist" ? top.values : []).map((x) => [x.key, x.value]));
  const region = m.get("region");
  assert.equal(region?.kind, "text");
  assert.equal(region?.kind === "text" && region.bestEffortMasked, true);
  assert.equal(m.get("password")?.kind, "content");
  assert.equal(m.get("list")?.kind, "array");
  assert.equal(m.get("inner")?.kind, "kvlist");
  assert.deepEqual(m.get("count"), { kind: "int", value: 3n });
});

test("per-record metadata cap: 16 KiB of kept strings, then hash-only ContentRefs and over-bounds", () => {
  const attributes = Array.from({ length: 200 }, (_, i) =>
    kv(`k${i}`, s(`${i.toString().padStart(3, "0")}${"v".repeat(197)}`)),
  );
  const out = applyContentPolicy(traces([span({ attributes })]), HASH_ONLY);
  const sp = out.signal === "traces" ? out.spans[0] : undefined;
  assert.ok(sp);
  const kept = sp.attributes.filter((a) => a.value.kind === "text").length;
  const hashed = sp.attributes.filter((a) => a.value.kind === "content").length;
  assert.equal(kept + hashed, 200);
  assert.ok(kept >= 70 && kept < 81, `kept ${kept}`); // keys are charged as well as values
  // metadataBytes = span name + every kept key (not placeholders) + every kept value.
  const keyBytes = sp.attributes
    .filter((a) => !a.key.startsWith("[key:"))
    .reduce((n, a) => n + new TextEncoder().encode(a.key).length, 0);
  assert.equal(sp.metadataBytes, 1 + keyBytes + kept * 200);
  assert.ok(sp.metadataBytes <= 16 * 1024);
  assert.deepEqual(
    sp.warnings.map((w) => w.code),
    ["over-bounds"],
  );
  const last = sp.attributes[199];
  assert.equal(last?.value.kind, "content");
  assert.match(last?.key ?? "", /^\[key:[0-9a-f]{16}\]$/);
  assert.equal(last?.keyAltered, true);
  // A second span in the same batch has its own budget.
  const two = applyContentPolicy(
    traces([
      span({ attributes }),
      span({ spanId: "00f067aa0ba902b8", attributes: attributes.slice(0, 2) }),
    ]),
    HASH_ONLY,
  );
  assert.equal(two.signal === "traces" ? two.spans[1]?.warnings.length : -1, 0);
});

test("metadata strings over 256 bytes are oversize ContentRefs; exactly 256 stays", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("a", s("x".repeat(256))),
          kv("b", s("x".repeat(257))),
          kv("c", s("é".repeat(129))),
        ],
      }),
    ]),
    HASH_ONLY,
  );
  const a = out.signal === "traces" ? (out.spans[0]?.attributes ?? []) : [];
  assert.equal(a[0]?.value.kind, "text");
  assert.equal(a[1]?.value.kind, "content");
  assert.equal(a[2]?.value.kind, "content"); // 258 bytes
});

test("allowlist: only pinned keys keep strings; content keys stay content; numbers kept", () => {
  const out = applyContentPolicy(
    traces(
      [
        span({
          name: "chat gpt",
          attributes: [
            kv("gen_ai.request.model", s("m-1")),
            kv("custom.note", s("hello")),
            kv("custom.count", n(1n)),
            kv("input.value", s("secretive")),
          ],
        }),
      ],
      { resource: [kv("service.name", s("svc")), kv("custom.res", s("r"))] },
    ),
    ALLOW,
  );
  const sp = out.signal === "traces" ? out.spans[0] : undefined;
  assert.ok(sp);
  const m = new Map(sp.attributes.map((x) => [x.key, x.value]));
  // Keys that are not allowlisted are replaced by a deterministic placeholder (G3 B1).
  const ph = (k: string): string => `[key:${sha256Hex(new TextEncoder().encode(k)).slice(0, 16)}]`;
  assert.equal(m.get("gen_ai.request.model")?.kind, "text");
  assert.equal(m.get("custom.note"), undefined);
  assert.equal(m.get(ph("custom.note"))?.kind, "content");
  assert.equal(m.get(ph("custom.count"))?.kind, "int");
  assert.equal(m.get(ph("input.value"))?.kind, "content");
  assert.equal(sp.name.kind, "text"); // structural field
  const r = new Map(sp.resource.attributes.map((x) => [x.key, x.value]));
  assert.equal(r.get("service.name")?.kind, "text");
  assert.equal(r.get(ph("custom.res"))?.kind, "content");
  assert.deepEqual((m.get(ph("custom.note")) as { ref: unknown }).ref, makeContentRef("hello"));
});

test("allowlist leaves status.message hashed (error text), and the default masked mode keeps it", () => {
  const sp = span({ status: { code: 2, message: "boom" } });
  const a = applyContentPolicy(traces([sp]), ALLOW);
  const b = applyContentPolicy(traces([sp]), HASH_ONLY);
  assert.equal(a.signal === "traces" ? a.spans[0]?.status.message.kind : "", "content");
  assert.equal(b.signal === "traces" ? b.spans[0]?.status.message.kind : "", "text");
});

test("attribute keys: control and bidi characters neutralized, flagged, bounded; secrets in keys masked", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("evil‮KEY\n​", s("v")),
          kv(`sk-${"a".repeat(30)}`, s("v")),
          kv("plain.key", s("v")),
          kv("gen_ai.request.model", s("v")),
          kv(`long${"k".repeat(300)}`, s("v")),
          kv("a\\b", s("v")),
        ],
      }),
    ]),
    HASH_ONLY,
  );
  const a = out.signal === "traces" ? (out.spans[0]?.attributes ?? []) : [];
  assert.equal(a[0]?.key, "evil\\u202EKEY\\u000A\\u200B");
  assert.equal(a[0]?.keyAltered, true);
  assert.equal(a[1]?.key, "[REDACTED]");
  assert.equal(a[1]?.keyAltered, true);
  assert.equal(a[2]?.keyAltered, false);
  assert.equal(a[3]?.key, "gen_ai.request.model");
  assert.equal(a[3]?.keyAltered, false);
  assert.ok(new TextEncoder().encode(a[4]?.key ?? "").length <= 256);
  assert.equal(a[4]?.keyAltered, true);
  assert.equal(a[5]?.key, "a\\\\b");
  for (const x of a) assert.doesNotMatch(x.key, /[\p{Cc}\p{Cf}]/u);
});

test("URL rule: userinfo removed, query values replaced, names kept; url.query names only", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("url.full", s("https://user:pw@host.example:8443/a/b?sig=abc&token=xyz&page=2#frag")),
          kv("url.query", s("?sig=abc&token=xyz&flag")),
          kv("http.target", s("/p?x=1&y=2")),
          kv("http.url", s("http://a@h/")),
          kv("custom.link", s("ftp://bob:pw@files.example/x?k=v")),
          kv("custom.text", s("not a url ?a=b")),
        ],
      }),
    ]),
    HASH_ONLY,
  );
  const a = out.signal === "traces" ? (out.spans[0]?.attributes ?? []) : [];
  const text = (i: number): string => {
    const v = a[i]?.value;
    return v?.kind === "text" ? v.value : "<<not text>>";
  };
  // The URL rule leaves `?sig=[REDACTED]&token=[REDACTED]&page=[REDACTED]#frag`; the legacy
  // `token=` masker rule then masks the rest of that value. Over-masking, never under-masking.
  assert.equal(text(0), "https://host.example:8443/a/b?sig=[REDACTED]&token=[REDACTED]");
  assert.equal(text(1), "sig&token&flag");
  assert.equal(text(2), "/p?x=[REDACTED]&y=[REDACTED]");
  assert.equal(text(3), "http://h/");
  assert.equal(text(4), "ftp://files.example/x?k=[REDACTED]");
  assert.equal(text(5), "not a url ?a=b");
});

test("masker extensions apply to kept strings; kept strings carry the best-effort marker", () => {
  const out = applyContentPolicy(
    traces([
      span({
        attributes: [
          kv("note", s("auth Basic dXNlcjpwYXNzd29yZA== end")),
          kv("trace", s("0af7651916cd43dd8448eb211c80319c")),
          kv("uuid", s("123e4567-e89b-42d3-a456-426614174000")),
          kv("note2", s("password=SWAIN-CANARY-metadata")),
        ],
      }),
    ]),
    HASH_ONLY,
  );
  const a = out.signal === "traces" ? (out.spans[0]?.attributes ?? []) : [];
  assert.deepEqual(a[0]?.value, {
    kind: "text",
    value: "auth Basic [REDACTED] end",
    bestEffortMasked: true,
    redactionCount: 1,
  });
  assert.equal(a[1]?.value.kind === "text" && a[1].value.value, "0af7651916cd43dd8448eb211c80319c");
  assert.equal(
    a[2]?.value.kind === "text" && a[2].value.value,
    "123e4567-e89b-42d3-a456-426614174000",
  );
  assert.ok(!dump(out).includes("SWAIN-CANARY"));
});

test("log body is content for every body type; api_error strings are content except correlation keys", () => {
  const out = applyContentPolicy(
    logs([
      log({ body: s(canary("body")) }),
      log({ body: kvs(kv("msg", s(canary("map")))) }),
      log({ body: arr(s(canary("arr"))) }),
      log({ body: bytes(1, 2) }),
      log({ body: null }),
      log({
        eventName: "claude_code.api_error",
        attributes: [
          kv("session.id", s("sess-1")),
          kv("prompt.id", s("p-1")),
          kv("event.sequence", n(4n)),
          kv("error_text", s(canary("err"))),
          kv("status_code", n(500n)),
          kv("detail", kvs(kv("x", s(canary("errmap"))))),
        ],
      }),
      log({
        attributes: [kv("event.name", s("claude_code.api_error")), kv("error", s(canary("err2")))],
      }),
      log({
        eventName: "claude_code.user_prompt",
        attributes: [kv("prompt", s(canary("prompt"))), kv("model", s("m"))],
      }),
    ]),
    HASH_ONLY,
  );
  assert.ok(!dump(out).includes("SWAIN-CANARY"));
  const l = out.signal === "logs" ? out.logs : [];
  assert.deepEqual(
    (l[0]?.body as unknown as { ref: unknown } | undefined)?.ref,
    makeContentRef(canary("body")),
  );
  assert.equal(l[4]?.body, null);
  const attrs = new Map((l[5]?.attributes ?? []).map((x) => [x.key, x.value]));
  assert.equal(attrs.get("session.id")?.kind, "text");
  assert.equal(attrs.get("prompt.id")?.kind, "text");
  assert.equal(attrs.get("event.sequence")?.kind, "int");
  assert.equal(attrs.get("status_code")?.kind, "int");
  assert.equal(attrs.get("error_text")?.kind, "content");
  assert.equal(attrs.get("detail")?.kind, "content");
  assert.equal(l[7]?.attributes.find((x) => x.key === "model")?.value.kind, "text");
});

test("policy input is validated at the boundary", () => {
  const bad: unknown[] = [
    { contentPolicy: "full", maxInlineBytes: 10 },
    { contentPolicy: "inline", maxInlineBytes: 0 },
    { contentPolicy: "inline", maxInlineBytes: 1.5 },
    { contentPolicy: "inline", maxInlineBytes: 1_048_577 },
    { contentPolicy: "hash-only", maxInlineBytes: 10, metadataPolicy: "strict" },
    null,
  ];
  for (const p of bad) {
    assert.throws(
      () => applyContentPolicy(traces([span()]), p as ContentPolicyInput),
      (e: unknown) => e instanceof Error && e.message === "invalid-option",
    );
  }
  assert.throws(() => applyContentPolicy({ signal: "metrics" } as never, HASH_ONLY));
});

test("output is deterministic and carries the hashes computed before the policy", () => {
  const input = traces([span({ attributes: [kv("input.value", s("x")), kv("a", s("b"))] })]);
  const a = applyContentPolicy(input, INLINE);
  const b = applyContentPolicy(input, INLINE);
  assert.equal(dump(a), dump(b));
  const sp = a.signal === "traces" ? a.spans[0] : undefined;
  assert.equal(sp?.recordSha256, "a".repeat(64));
  assert.equal(sp?.resourceSha256, "a".repeat(64));
  assert.equal(sp?.scopeSha256, "a".repeat(64));
});
