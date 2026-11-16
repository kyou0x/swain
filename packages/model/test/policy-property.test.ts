import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyContentPolicy,
  type InputAnyValue,
  type InputKeyValue,
  type InputLogRecord,
  type InputSpan,
  METADATA_CAP_BYTES,
} from "../src/index.js";
import { allStrings, dump, log, logs, span, traces } from "./helpers.js";

const CANARY = "SWAIN-CANARY-prop";
const SEED = 0x5eed_c0de;

/** mulberry32: small, seeded, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTENT_KEYS = [
  "gen_ai.input.messages",
  "input.value",
  "llm.input_messages.3.message.content",
  "ai.prompt",
  "traceloop.entity.input",
  "db.statement",
  "prompt",
  "gcp.vertex.agent.x",
  "http.request.header.authorization",
  "my.password",
  "x.api_key",
];
const META_KEYS = [
  "custom.a",
  "custom.b",
  "gen_ai.request.model",
  "service.name",
  "url.full",
  "a",
  "region",
  "gen_ai.usage.input_tokens",
  "llm.token_count.prompt",
];
const ALPHABET = ["a", "Z", "9", "-", "_", " ", "é", "😀", "\n", "‮", "=", ":", "/", "?", "&", "@"];

function pad(r: () => number, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)] ?? "a";
  return out;
}

/** A string that, if it contains the canary, may only sit where the policy must hide it. */
function str(r: () => number, mustHide: boolean): string {
  const len = Math.floor(r() * 700);
  const base = pad(r, len);
  if (r() < 0.4) {
    // Under a metadata key the canary string must exceed 256 bytes so it is oversize.
    return mustHide ? `${base}${CANARY}${base}` : `${CANARY}${"~".repeat(260)}${base}`;
  }
  return mustHide || r() < 0.5 ? base : base.slice(0, 200);
}

function value(r: () => number, depth: number, hide: boolean): InputAnyValue {
  const t = Math.floor(r() * (depth > 3 ? 5 : 7));
  switch (t) {
    case 0:
    case 1:
      return { kind: "string", value: str(r, hide) };
    case 2:
      return { kind: "int", value: BigInt(Math.floor(r() * 1e9)) };
    case 3:
      return { kind: "double", value: r() * 100 };
    case 4:
      return r() < 0.5
        ? { kind: "bool", value: r() < 0.5 }
        : {
            kind: "bytes",
            value: Uint8Array.from(new TextEncoder().encode(`${CANARY}${pad(r, 5)}`)),
          };
    case 5:
      return {
        kind: "array",
        values: Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth + 1, hide)),
      };
    default:
      return {
        kind: "kvlist",
        values: Array.from({ length: Math.floor(r() * 4) }, () => ({
          key: keyOf(r, r() < 0.5 ? META_KEYS : CONTENT_KEYS),
          value: value(r, depth + 1, hide),
        })),
      };
  }
}

/** Keys are metadata: a canary may only sit in a key that is oversize (replaced by a placeholder). */
function keyOf(r: () => number, pool: readonly string[]): string {
  return r() < 0.15 ? `${CANARY}-key-${"k".repeat(260)}` : pick(r, pool);
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}

function attrs(r: () => number): InputKeyValue[] {
  return Array.from({ length: Math.floor(r() * 12) }, () => {
    const content = r() < 0.4;
    const key = keyOf(r, content ? CONTENT_KEYS : META_KEYS);
    // Under content keys any value type (and the canary at any length) must be hidden. Under
    // metadata keys only canary strings > 256 bytes are generated (see `str`), nested kvlists
    // may switch to content keys on their own.
    if (key.includes("tokens") || key === "llm.token_count.prompt") {
      return { key, value: { kind: "int", value: BigInt(Math.floor(r() * 1000)) } };
    }
    return { key, value: value(r, 0, content && CONTENT_KEYS.includes(key)) };
  });
}

function randomSpan(r: () => number, i: number): InputSpan {
  const text = (): string => str(r, false);
  return span({
    spanId: i
      .toString(16)
      .padStart(16, "0")
      .replace(/^0{16}$/, "0000000000000001"),
    name: text(),
    traceState: text(),
    attributes: attrs(r),
    status: { code: 2, message: text() },
    events: Array.from({ length: Math.floor(r() * 3) }, () => ({
      timeUnixNano: 1n,
      name: text(),
      attributes: attrs(r),
      droppedAttributesCount: 0,
    })),
    links: Array.from({ length: Math.floor(r() * 3) }, () => ({
      traceId: "5b8efff798038103d269b633813fc60c",
      spanId: "00f067aa0ba902b7",
      traceState: text(),
      attributes: attrs(r),
      droppedAttributesCount: 0,
      flags: 0,
    })),
  });
}

function randomLog(r: () => number): InputLogRecord {
  const text = (): string => str(r, false);
  return log({
    severityText: text(),
    eventName: r() < 0.2 ? "claude_code.api_error" : text(),
    body: r() < 0.8 ? value(r, 0, true) : null,
    attributes: attrs(r),
  });
}

function assertInvariants(out: unknown, where: string): void {
  const text = dump(out);
  assert.ok(!text.includes(CANARY), `${where}: canary survived as plain text`);
  for (const x of allStrings(out)) {
    assert.ok(new TextEncoder().encode(x).length <= 256, `${where}: kept string over 256 bytes`);
  }
  // Under hash-only, no ContentRef carries inline text.
  assert.ok(!/"inline":/.test(text), `${where}: inline text under hash-only`);
}

test("seeded property: random batches under hash-only keep nothing > 256 bytes and no canary", () => {
  const r = rng(SEED);
  for (let i = 0; i < 300; i++) {
    const groupResource = attrs(r);
    const policy = { contentPolicy: "hash-only", maxInlineBytes: 1024 } as const;
    const t = traces(
      Array.from({ length: 1 + Math.floor(r() * 3) }, (_, j) => randomSpan(r, j + 1)),
      {
        resource: groupResource,
        scope: { name: str(r, false), version: str(r, false), attributes: attrs(r) },
        resourceSchemaUrl: str(r, false),
      },
    );
    const out = applyContentPolicy(t, policy);
    assertInvariants(out, `traces #${i}`);
    for (const sp of out.spans) assert.ok(sp.metadataBytes <= METADATA_CAP_BYTES);
    assert.equal(dump(applyContentPolicy(t, policy)), dump(out), "deterministic");

    const l = logs(
      Array.from({ length: 1 + Math.floor(r() * 3) }, () => randomLog(r)),
      { resource: attrs(r), scope: { attributes: attrs(r) } },
    );
    const lo = applyContentPolicy(l, policy);
    assertInvariants(lo, `logs #${i}`);
    for (const rec of lo.logs) assert.ok(rec.metadataBytes <= METADATA_CAP_BYTES);
  }
});

test("seeded property: under the allowlist a canary in ANY non-allowlisted key, nested included, never survives", () => {
  const r = rng(SEED ^ 0xabcd);
  for (let i = 0; i < 100; i++) {
    const keyed = (): InputKeyValue[] =>
      Array.from({ length: 1 + Math.floor(r() * 6) }, (_, j) => ({
        key: `${CANARY}-short-${i}-${j}`,
        value:
          r() < 0.4
            ? {
                kind: "kvlist",
                values: [{ key: `${CANARY}-nested-${j}`, value: { kind: "bool", value: true } }],
              }
            : r() < 0.5
              ? {
                  kind: "array",
                  values: [
                    {
                      kind: "kvlist",
                      values: [{ key: `${CANARY}-deep`, value: { kind: "int", value: 1n } }],
                    },
                  ],
                }
              : { kind: "bool", value: true },
      }));
    const out = applyContentPolicy(
      traces([span({ attributes: keyed() })], {
        resource: keyed(),
        scope: { attributes: keyed() },
      }),
      { contentPolicy: "hash-only", maxInlineBytes: 64, metadataPolicy: "allowlist" },
    );
    assertInvariants(out, `allowlist keys #${i}`);
  }
});

test("seeded property under the allowlist policy gives the same guarantees", () => {
  const r = rng(SEED ^ 0xffff);
  for (let i = 0; i < 100; i++) {
    const out = applyContentPolicy(
      traces([randomSpan(r, 1), randomSpan(r, 2)], { resource: attrs(r) }),
      { contentPolicy: "hash-only", maxInlineBytes: 64, metadataPolicy: "allowlist" },
    );
    assertInvariants(out, `allowlist #${i}`);
  }
});
