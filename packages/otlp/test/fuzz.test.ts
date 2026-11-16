import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeLogsJson, decodeTracesJson, OtlpDecodeError } from "../src/index.js";
import { fixture } from "./helpers.js";

/** mulberry32: a small seeded PRNG. No other source of randomness is used. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  '"',
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  "null",
  "-1",
  "1e999",
  "9007199254740993",
  '"\\ud800"',
  "\\u0000",
];

function mutate(src: Uint8Array, rnd: () => number): Uint8Array {
  const out = Array.from(src);
  const edits = 1 + Math.floor(rnd() * 4);
  for (let e = 0; e < edits; e++) {
    const pos = Math.floor(rnd() * Math.max(1, out.length));
    const kind = Math.floor(rnd() * 6);
    if (kind === 0) out[pos] = Math.floor(rnd() * 256);
    else if (kind === 1) out.splice(pos, 1 + Math.floor(rnd() * 8));
    else if (kind === 2) {
      const tok = new TextEncoder().encode(TOKENS[Math.floor(rnd() * TOKENS.length)] ?? "");
      out.splice(pos, 0, ...tok);
    } else if (kind === 3) out.length = pos;
    else if (kind === 4) {
      const len = Math.floor(rnd() * 64);
      out.splice(pos, 0, ...out.slice(pos, pos + len));
    } else out[pos] = (out[pos] ?? 0) ^ (1 << Math.floor(rnd() * 8));
  }
  return new Uint8Array(out);
}

const SEEDS = [1, 20260101, 0xc0ffee];
const ITERATIONS = 1500;
/** Per-iteration time budget (SPEC-003 N1.3 review F6); generous, a hang or a quadratic blow-up fails it. */
const MAX_ITERATION_MS = 750;

for (const [name, decode] of [
  ["traces-genai.json", decodeTracesJson],
  ["traces-openinference.json", decodeTracesJson],
  ["logs-claude-code.json", decodeLogsJson],
] as const) {
  test(`seeded mutation fuzz over ${name}: only typed errors`, () => {
    const src = fixture(name);
    let ok = 0;
    let typed = 0;
    for (const seed of SEEDS) {
      const rnd = prng(seed);
      for (let i = 0; i < ITERATIONS; i++) {
        const input = mutate(src, rnd);
        const t0 = performance.now();
        try {
          const d = decode(input);
          ok++;
          for (const r of d.rejected) assert.match(r.reason, /^[a-z0-9-]+$/);
        } catch (e) {
          assert.ok(e instanceof OtlpDecodeError, `untyped error at seed ${seed} iteration ${i}`);
          assert.notEqual(e.code, "internal", `internal error at seed ${seed} iteration ${i}`);
          typed++;
        }
        const ms = performance.now() - t0;
        assert.ok(ms < MAX_ITERATION_MS, `seed ${seed} iteration ${i} took ${ms.toFixed(0)} ms`);
      }
    }
    assert.equal(ok + typed, SEEDS.length * ITERATIONS);
    assert.ok(ok > 0 && typed > 0, "the fuzzer should reach both outcomes");
  });
}

test("fuzz mutation is deterministic for a seed", () => {
  const src = fixture("traces-genai.json");
  assert.deepEqual(mutate(src, prng(7)), mutate(src, prng(7)));
});
