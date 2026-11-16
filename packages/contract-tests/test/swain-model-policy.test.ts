/**
 * SPEC-003 N1.4 acceptance, cross-package part: the real `@swain/otlp` JSON decoder output goes
 * through the `@swain/model` content policy. `@swain/model` cannot import `@swain/otlp` (policy
 * profile), so this is also the compile-time check that `DecodedTraces`/`DecodedLogs` are
 * assignable to the applier's structural input types.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyContentPolicy,
  type ContentPolicyInput,
  deriveAgentIdentity,
  deriveParentOfEdges,
  normalizeSpan,
} from "@swain/model";
import {
  type DecodedLogs,
  type DecodedTraces,
  decodeLogsJson,
  decodeTracesJson,
  OtlpDecodeError,
} from "@swain/otlp";

const dir = fileURLToPath(new URL("../../../../fixtures/otlp/", import.meta.url));
const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(`${dir}${rel}`));
const PRJ = "prj_00000000000000000000000000000001";

const POLICIES: readonly (readonly [string, ContentPolicyInput])[] = [
  ["hash-only", { contentPolicy: "hash-only", maxInlineBytes: 1024 }],
  ["inline", { contentPolicy: "inline", maxInlineBytes: 1024 }],
  ["allowlist", { contentPolicy: "hash-only", maxInlineBytes: 1024, metadataPolicy: "allowlist" }],
];

function dump(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
}

function keptStrings(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keptStrings(x, out);
  else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (o["kind"] === "text" && typeof o["value"] === "string") out.push(o["value"]);
    if (typeof o["key"] === "string" && "keyAltered" in o) out.push(o["key"]);
    for (const x of Object.values(o)) keptStrings(x, out);
  }
  return out;
}

function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (typeof o["key"] === "string" && "keyAltered" in o) out.push(o["key"]);
    for (const x of Object.values(o)) keysOf(x, out);
  }
  return out;
}

function checkApplied(out: unknown, name: string, hashOnly: boolean): void {
  for (const x of keptStrings(out)) {
    assert.ok(new TextEncoder().encode(x).length <= 256, `${name}: kept string over 256 bytes`);
  }
  if (hashOnly) assert.ok(!/"inline":/.test(dump(out)), `${name}: inline under hash-only`);
}

function decodeAny(name: string): DecodedTraces | DecodedLogs | null {
  const bytes = read(name);
  try {
    return name.startsWith("logs-") ? decodeLogsJson(bytes) : decodeTracesJson(bytes);
  } catch (e) {
    if (e instanceof OtlpDecodeError) return null; // whole-request rejection is the hostile case
    throw e;
  }
}

test("the policy accepts every fixtures/otlp/*.json (decoded) under every policy", () => {
  const files = [
    ...readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "FIXTURE.json"),
    ...readdirSync(`${dir}hostile`)
      .filter((n) => n.endsWith(".json"))
      .map((n) => `hostile/${n}`),
  ].sort();
  assert.ok(files.length >= 18);
  let applied = 0;
  for (const f of files) {
    const decoded = decodeAny(f);
    if (decoded === null) continue;
    for (const [pname, policy] of POLICIES) {
      const out =
        decoded.signal === "traces"
          ? applyContentPolicy(decoded, policy)
          : applyContentPolicy(decoded, policy);
      checkApplied(out, `${f} ${pname}`, policy.contentPolicy === "hash-only");
      applied++;
    }
  }
  assert.ok(applied >= 30);
});

test("hostile secrets fixture: the sender's content and secret-name values never survive hash-only", () => {
  const decoded = decodeTracesJson(read("hostile/secrets.json"));
  const out = applyContentPolicy(decoded, POLICIES[0]?.[1] as ContentPolicyInput);
  const text = dump(out);
  assert.ok(!text.includes("sk-synthetic"));
  assert.ok(!text.includes("synthetic-secret-token"));
  assert.equal(out.spans.length, 1);
  // The decoder-computed hashes ride along unchanged.
  const original = decoded.resourceSpans[0]?.scopeSpans[0]?.spans[0];
  assert.equal(out.spans[0]?.recordSha256, original?.recordSha256);
  assert.equal(out.spans[0]?.path, original?.path);
  assert.equal(out.spans[0]?.resourceSha256, decoded.resourceSpans[0]?.resourceSha256);
});

test("hostile injection strings: control and bidi characters in attribute keys are neutralized (values are escaped at render)", () => {
  const decoded = decodeTracesJson(read("hostile/injection-strings.json"));
  const out = applyContentPolicy(decoded, POLICIES[0]?.[1] as ContentPolicyInput);
  const keys = keysOf(out);
  assert.ok(keys.length > 0);
  for (const k of keys) {
    assert.doesNotMatch(k, /[\p{Cc}\p{Cf}]/u);
  }
});

test("GenAI fixture end to end: operations, agent identity and parent-of edges", () => {
  const decoded = decodeTracesJson(read("traces-genai.json"));
  const out = applyContentPolicy(decoded, POLICIES[0]?.[1] as ContentPolicyInput);
  assert.deepEqual(
    out.spans.map((s) => normalizeSpan(s).operation),
    ["agent", "llm", "tool"],
  );
  const root = out.spans[0];
  assert.ok(root);
  const id = deriveAgentIdentity(PRJ, {
    attributes: root.attributes,
    resourceAttributes: root.resource.attributes,
  });
  assert.equal(id.keyBasis, "attr:gen_ai.agent.id");
  const edges = deriveParentOfEdges(
    PRJ,
    out.spans.map((s) => ({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId,
      keyId: "key_a",
      ref: s.path,
    })),
  );
  assert.equal(edges.edges.length, 2);
  assert.equal(edges.missingParents.length, 0);
  assert.ok(edges.edges.every((e) => !e.crossCredential));
  // Content under GenAI content keys in the fixture is hash-only.
  assert.ok(!/"inline":/.test(dump(out)));
});

test("OpenInference fixture: classified by openinference.span.kind, prompts hash-only", () => {
  const decoded = decodeTracesJson(read("traces-openinference.json"));
  const out = applyContentPolicy(decoded, POLICIES[0]?.[1] as ContentPolicyInput);
  const ops = out.spans.map((s) => normalizeSpan(s).detector.basis);
  assert.ok(ops.includes("openinference.span.kind"));
  assert.ok(out.spans.some((s) => normalizeSpan(s).operation !== "generic"));
});

test("Claude Code logs fixture: bodies are always ContentRefs; session.id stays readable", () => {
  const decoded = decodeLogsJson(read("logs-claude-code.json"));
  const out = applyContentPolicy(decoded, POLICIES[0]?.[1] as ContentPolicyInput);
  assert.ok(out.logs.length > 0);
  for (const l of out.logs) {
    assert.ok(l.body === null || l.body.kind === "content");
    const sid = l.attributes.find((a) => a.key === "session.id");
    assert.equal(sid?.value.kind, "text");
  }
});
