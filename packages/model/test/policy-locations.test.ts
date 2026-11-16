import assert from "node:assert/strict";
import { test } from "node:test";
import { makeContentRef } from "@swain/core";
import {
  applyContentPolicy,
  type ContentPolicyInput,
  isPolicyApplied,
  MAX_KEPT_STRING_BYTES,
} from "../src/index.js";
import { allStrings, arr, bytes, dump, kv, kvs, log, logs, s, span, traces } from "./helpers.js";

const HASH_ONLY: ContentPolicyInput = { contentPolicy: "hash-only", maxInlineBytes: 1024 };
const ALLOW: ContentPolicyInput = { ...HASH_ONLY, metadataPolicy: "allowlist" };

/** SPEC-003 section 6.1: the marker secret for one class; long form for unkeyed string fields. */
const LONG = (cls: string): string => `SWAIN-CANARY-${cls}-${"p".repeat(300)}`;

function assertHashedNotPlain(
  out: unknown,
  plain: string,
  where: string,
  hashed: unknown = plain,
): void {
  const text = dump(out);
  assert.ok(!text.includes("SWAIN-CANARY"), `${where}: canary survived`);
  assert.ok(text.includes(makeContentRef(hashed).sha256), `${where}: ContentRef hash missing`);
}

test("traces: a canary in every string-bearing field kind is hash-only (ADR-0005 section 6.1)", () => {
  const cases: [string, string, (c: string) => ReturnType<typeof traces>][] = [
    [
      "resource attribute (content key)",
      "res",
      (c) => traces([span()], { resource: [kv("prompt", s(c))] }),
    ],
    [
      "resource attribute (secret name)",
      "res2",
      (c) => traces([span()], { resource: [kv("db.password", s(c))] }),
    ],
    [
      "resource attribute (long)",
      "res3",
      (c) => traces([span()], { resource: [kv("custom", s(c))] }),
    ],
    [
      "scope attribute",
      "scope",
      (c) => traces([span()], { scope: { attributes: [kv("custom", s(c))] } }),
    ],
    ["scope name", "sname", (c) => traces([span()], { scope: { name: c } })],
    ["scope version", "sver", (c) => traces([span()], { scope: { version: c } })],
    ["resource schemaUrl", "rurl", (c) => traces([span()], { resourceSchemaUrl: c })],
    ["scope schemaUrl", "surl", (c) => traces([span()], { scopeSchemaUrl: c })],
    ["span name", "name", (c) => traces([span({ name: c })])],
    ["status.message", "status", (c) => traces([span({ status: { code: 2, message: c } })])],
    ["traceState", "ts", (c) => traces([span({ traceState: c })])],
    [
      "span event name",
      "ename",
      (c) =>
        traces([
          span({
            events: [{ timeUnixNano: 1n, name: c, attributes: [], droppedAttributesCount: 0 }],
          }),
        ]),
    ],
    [
      "span event attribute",
      "eattr",
      (c) =>
        traces([
          span({
            events: [
              {
                timeUnixNano: 1n,
                name: "e",
                attributes: [kv("exception.message", s(c))],
                droppedAttributesCount: 0,
              },
            ],
          }),
        ]),
    ],
    [
      "link attribute",
      "lattr",
      (c) =>
        traces([
          span({
            links: [
              {
                traceId: "5b8efff798038103d269b633813fc60c",
                spanId: "00f067aa0ba902b7",
                traceState: "",
                attributes: [kv("custom", s(c))],
                droppedAttributesCount: 0,
                flags: 0,
              },
            ],
          }),
        ]),
    ],
    [
      "link traceState",
      "lts",
      (c) =>
        traces([
          span({
            links: [
              {
                traceId: "5b8efff798038103d269b633813fc60c",
                spanId: "00f067aa0ba902b7",
                traceState: c,
                attributes: [],
                droppedAttributesCount: 0,
                flags: 0,
              },
            ],
          }),
        ]),
    ],
    [
      "nested arrayValue of kvlistValue",
      "nest",
      (c) =>
        traces([
          span({ attributes: [kv("outer", arr(kvs(kv("a", arr(kvs(kv("custom", s(c))))))))] }),
        ]),
    ],
  ];
  for (const [where, cls, build] of cases) {
    // Short canaries only for keyed content fields; unkeyed or generic fields use the long form.
    const plain =
      where.includes("(content key)") || where.includes("(secret name)")
        ? `SWAIN-CANARY-${cls}`
        : LONG(cls);
    assertHashedNotPlain(applyContentPolicy(build(plain), HASH_ONLY), plain, where);
    assertHashedNotPlain(applyContentPolicy(build(plain), ALLOW), plain, `${where} (allowlist)`);
  }
});

test("logs: a canary in every log field kind is hash-only", () => {
  const cases: [string, string, (c: string) => ReturnType<typeof logs>][] = [
    ["body string", "body", (c) => logs([log({ body: s(c) })])],
    ["body map", "bodymap", (c) => logs([log({ body: kvs(kv("k", s(c))) })])],
    ["body array of map", "bodyarr", (c) => logs([log({ body: arr(kvs(kv("k", s(c)))) })])],
    ["eventName", "evn", (c) => logs([log({ eventName: c })])],
    ["severityText", "sev", (c) => logs([log({ severityText: c })])],
    ["attribute content key", "attr", (c) => logs([log({ attributes: [kv("tool_input", s(c))] })])],
    ["attribute long", "attr2", (c) => logs([log({ attributes: [kv("custom", s(c))] })])],
    ["resource attribute", "lres", (c) => logs([log()], { resource: [kv("custom", s(c))] })],
    [
      "scope attribute",
      "lscope",
      (c) => logs([log()], { scope: { attributes: [kv("custom", s(c))] } }),
    ],
  ];
  for (const [where, cls, build] of cases) {
    const plain =
      where === "attribute content key" || where.startsWith("body")
        ? `SWAIN-CANARY-${cls}`
        : LONG(cls);
    const hashed =
      where === "body map"
        ? { kv: [["k", plain]] }
        : where === "body array of map"
          ? [{ kv: [["k", plain]] }]
          : plain;
    assertHashedNotPlain(applyContentPolicy(build(plain), HASH_ONLY), plain, where, hashed);
  }
});

test("a canary as a bytesValue never appears, in base64 or raw, under any policy", () => {
  const raw = Array.from(new TextEncoder().encode("SWAIN-CANARY-bytes"));
  const b64 = "U1dBSU4tQ0FOQVJZLWJ5dGVz";
  for (const policy of [
    HASH_ONLY,
    { contentPolicy: "inline" as const, maxInlineBytes: 4096 },
    ALLOW,
  ]) {
    const t = dump(
      applyContentPolicy(
        traces([
          span({ attributes: [kv("blob", bytes(...raw)), kv("input.value", bytes(...raw))] }),
        ]),
        policy,
      ),
    );
    assert.ok(!t.includes(b64));
    assert.ok(!t.includes("SWAIN-CANARY"));
    assert.ok(t.includes(makeContentRef({ bytes: b64 }).sha256));
  }
  assert.ok(
    !dump(applyContentPolicy(logs([log({ body: bytes(...raw) })]), HASH_ONLY)).includes(b64),
  );
});

test("over-deep AnyValue (beyond the OTLP bound) is hashed and flagged, never walked", () => {
  let v = s("SWAIN-CANARY-deep");
  for (let i = 0; i < 40; i++) v = arr(v);
  const out = applyContentPolicy(traces([span({ attributes: [kv("custom", v)] })]), HASH_ONLY);
  assert.ok(!dump(out).includes("SWAIN-CANARY"));
  const sp = out.spans[0];
  assert.deepEqual(
    sp?.warnings.map((w) => w.code),
    ["over-bounds"],
  );
});

test("rejected and warnings from the decoder are passed through; only the applier can stamp outputs", () => {
  const input = {
    ...traces([span()]),
    rejected: [{ path: "/resourceSpans/0/scopeSpans/0/spans/1", reason: "invalid-trace-id" }],
    warnings: [{ path: "/x", code: "over-bounds" as const }],
  };
  const out = applyContentPolicy(input, HASH_ONLY);
  assert.deepEqual(out.rejected, input.rejected);
  assert.deepEqual(out.warnings, input.warnings);
  assert.ok(isPolicyApplied(out));
  assert.ok(isPolicyApplied(out.spans[0]));
  assert.ok(!isPolicyApplied({ ...out.spans[0] }));
  assert.ok(!isPolicyApplied(input));
  assert.equal(out.policy.contentPolicy, "hash-only");
  assert.equal(out.policy.contentKeysVersion, "swain.content-keys/1");
});

test("allStrings helper sanity: kept strings are at most 256 bytes for every field", () => {
  const out = applyContentPolicy(
    traces(
      [
        span({
          name: "n".repeat(300),
          attributes: [kv("a", s("v".repeat(300))), kv("b", s("ok"))],
        }),
      ],
      { resource: [kv("r", s("w".repeat(500)))] },
    ),
    HASH_ONLY,
  );
  for (const x of allStrings(out)) {
    assert.ok(new TextEncoder().encode(x).length <= MAX_KEPT_STRING_BYTES);
  }
});
