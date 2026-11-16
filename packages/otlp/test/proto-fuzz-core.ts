import assert from "node:assert/strict";
import {
  decodeLogsJson,
  decodeLogsProtobuf,
  decodeTracesJson,
  decodeTracesProtobuf,
  OtlpDecodeError,
} from "../src/index.js";
import { injectDefect } from "./proto-defects.js";
import { type EncodeOptions, encodeLogs, encodeTraces, type Rnd } from "./proto-encoder.js";
import { prng, randomLogs, randomTraces } from "./proto-gen.js";

/**
 * Seeded structure-aware fuzzing of the protobuf decoder, shared by the node:test run (10k
 * iterations) and `npm run fuzz:otlp` (1M+ iterations). Iteration `i` of seed `s` is fully
 * determined by (s, i), so any failure is reproducible with `reproduce(s, i)`.
 *
 * Modes (chosen by the iteration's own PRNG):
 * - differential: a random VALID structure is encoded to protobuf (random field order, explicit
 *   defaults, unknown fields) and to JSON; both decoders must return identical models;
 * - field-level: the same encoding with deliberate field corruption (duplicates, wrong wire
 *   types, field 0 / above 2^29-1, bad lengths, groups, overlong varints, truncation);
 * - byte-level: random byte edits of a valid encoding;
 * - raw: random bytes, and random bytes behind a valid-looking prefix.
 * The corrupt modes assert: only `OtlpDecodeError` (never `internal`), and a time budget.
 */

export interface FuzzStats {
  iterations: number;
  differential: number;
  accepted: number;
  rejectedWhole: number;
  recordRejections: number;
  maxMs: number;
  failures: string[];
  codes: Record<string, number>;
  /** Record-level rejection reasons reached (coverage per reject reason). */
  reasons: Record<string, number>;
}

const BUDGET_MS = 750;
const enc = new TextEncoder();

function int(rnd: Rnd, n: number): number {
  return Math.floor(rnd() * n);
}

const TOKENS: readonly (readonly number[])[] = [
  [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01],
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f],
  [0xff, 0xff, 0xff, 0xff, 0x07],
  [0x00],
  [0x0b],
  [0x0c],
  [0x80],
  [0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f],
  [0x08, 0x01],
  [0x12, 0x00],
];

export function mutateBytes(src: Uint8Array, rnd: Rnd): Uint8Array {
  const out = Array.from(src);
  const edits = 1 + int(rnd, 4);
  for (let e = 0; e < edits; e++) {
    const pos = int(rnd, Math.max(1, out.length));
    const kind = int(rnd, 7);
    if (kind === 0) out[pos] = int(rnd, 256);
    else if (kind === 1) out.splice(pos, 1 + int(rnd, 8));
    else if (kind === 2)
      out.splice(pos, 0, ...(TOKENS[int(rnd, TOKENS.length)] as readonly number[]));
    else if (kind === 3) out.length = pos;
    else if (kind === 4) out.splice(pos, 0, ...out.slice(pos, pos + int(rnd, 64)));
    else if (kind === 5) out[pos] = (out[pos] ?? 0) ^ (1 << int(rnd, 8));
    else out.splice(pos, 0, int(rnd, 256));
  }
  return new Uint8Array(out);
}

function encodeOptions(rnd: Rnd): EncodeOptions {
  const o: { -readonly [K in keyof EncodeOptions]: EncodeOptions[K] } = {};
  if (rnd() < 0.4) o.explicitDefaults = true;
  if (rnd() < 0.5) o.shuffle = rnd;
  if (rnd() < 0.3) o.unknownFields = rnd;
  return o;
}

type Decode = (b: Uint8Array) => { readonly rejected: readonly { readonly reason: string }[] };

function checkDecode(stats: FuzzStats, decode: Decode, input: Uint8Array, where: string): void {
  const t0 = performance.now();
  try {
    const d = decode(input);
    stats.accepted++;
    stats.recordRejections += d.rejected.length;
    for (const r of d.rejected) {
      assert.match(r.reason, /^[a-z0-9-]+$/);
      stats.reasons[r.reason] = (stats.reasons[r.reason] ?? 0) + 1;
    }
  } catch (e) {
    if (!(e instanceof OtlpDecodeError)) {
      stats.failures.push(`${where}: untyped throw ${String(e)}`);
    } else if (e.code === "internal") {
      stats.failures.push(`${where}: internal error`);
    } else {
      stats.rejectedWhole++;
      stats.codes[e.code] = (stats.codes[e.code] ?? 0) + 1;
    }
  }
  const ms = performance.now() - t0;
  if (ms > stats.maxMs) stats.maxMs = ms;
  if (ms > BUDGET_MS) stats.failures.push(`${where}: ${ms.toFixed(0)} ms exceeds ${BUDGET_MS} ms`);
}

/** One iteration. Pure function of (seed, i) apart from the stats it updates. */
export function iterate(seed: number, i: number, stats: FuzzStats): void {
  const rnd = prng((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
  const where = `seed ${seed} iteration ${i}`;
  const traces = rnd() < 0.55;
  const mode = int(rnd, 6);
  stats.iterations++;

  if (mode === 4) {
    // raw bytes
    const n = int(rnd, 200);
    const raw = new Uint8Array(n);
    for (let k = 0; k < n; k++)
      raw[k] =
        rnd() < 0.5
          ? int(rnd, 256)
          : ([0x0a, 0x12, 0x08, 0x10, 0x00, 0x80, 0xff][int(rnd, 7)] as number);
    checkDecode(stats, traces ? decodeTracesProtobuf : decodeLogsProtobuf, raw, where);
    return;
  }

  const structure = traces ? randomTraces(rnd) : randomLogs(rnd);
  const decodeProto = traces ? decodeTracesProtobuf : decodeLogsProtobuf;
  try {
    if (mode === 0 || mode === 5) {
      if (mode === 5) injectDefect(rnd, structure, traces);
      const opts = encodeOptions(rnd);
      const proto = traces ? encodeTraces(structure, opts) : encodeLogs(structure, opts);
      const json = enc.encode(JSON.stringify(structure));
      stats.differential++;
      const t0 = performance.now();
      const viaProto = decodeProto(proto);
      const viaJson = (traces ? decodeTracesJson : decodeLogsJson)(json);
      const ms = performance.now() - t0;
      if (ms > stats.maxMs) stats.maxMs = ms;
      if (ms > BUDGET_MS) stats.failures.push(`${where}: differential ${ms.toFixed(0)} ms`);
      assert.deepStrictEqual(viaProto, viaJson);
      stats.accepted++;
      stats.recordRejections += viaProto.rejected.length;
      for (const r of viaProto.rejected)
        stats.reasons[r.reason] = (stats.reasons[r.reason] ?? 0) + 1;
      return;
    }
    if (mode === 1) {
      const opts: EncodeOptions = {
        ...encodeOptions(rnd),
        corrupt: { rnd, p: 0.02 + rnd() * 0.1 },
      };
      const proto = traces ? encodeTraces(structure, opts) : encodeLogs(structure, opts);
      checkDecode(stats, decodeProto, proto, where);
      return;
    }
    const proto = traces
      ? encodeTraces(structure, encodeOptions(rnd))
      : encodeLogs(structure, encodeOptions(rnd));
    checkDecode(
      stats,
      decodeProto,
      mode === 2
        ? mutateBytes(proto, rnd)
        : mutateBytes(proto.slice(0, int(rnd, proto.length + 1)), rnd),
      where,
    );
  } catch (e) {
    stats.failures.push(`${where}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
  }
}

export function newStats(): FuzzStats {
  return {
    iterations: 0,
    differential: 0,
    accepted: 0,
    rejectedWhole: 0,
    recordRejections: 0,
    maxMs: 0,
    failures: [],
    codes: {},
    reasons: {},
  };
}

export function runFuzz(seed: number, iterations: number, maxFailures = 5): FuzzStats {
  const stats = newStats();
  for (let i = 0; i < iterations; i++) {
    iterate(seed, i, stats);
    if (stats.failures.length >= maxFailures) break;
  }
  return stats;
}

/** Every record-level reason of the frozen model; the fuzz reports which ones it never reached. */
export const ALL_REASONS = [
  "invalid-type",
  "invalid-trace-id",
  "invalid-span-id",
  "invalid-parent-span-id",
  "invalid-int64",
  "invalid-uint32",
  "time-out-of-range",
  "invalid-enum",
  "invalid-double",
  "invalid-base64",
  "invalid-any-value",
  "any-value-too-deep",
  "too-many-entries",
  "invalid-string",
  "duplicate-key",
  "string-too-long",
  "key-too-long",
] as const;

export function mergeStats(total: FuzzStats, s: FuzzStats): void {
  total.iterations += s.iterations;
  total.differential += s.differential;
  total.accepted += s.accepted;
  total.rejectedWhole += s.rejectedWhole;
  total.recordRejections += s.recordRejections;
  total.maxMs = Math.max(total.maxMs, s.maxMs);
  total.failures.push(...s.failures);
  for (const [k, v] of Object.entries(s.codes)) total.codes[k] = (total.codes[k] ?? 0) + v;
  for (const [k, v] of Object.entries(s.reasons)) total.reasons[k] = (total.reasons[k] ?? 0) + v;
}
