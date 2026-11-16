import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStats, newStats, runFuzz } from "./proto-fuzz-core.js";

/**
 * 10,000 iterations in the normal run (SPEC-003 N1.3; ADR-0006 section 3). The long run is
 * `npm run fuzz:otlp` (default 1,000,000). Failures print the (seed, iteration) pair.
 */
const SEEDS = [1, 20261116] as const;
const PER_SEED = 5_000;

test("protobuf fuzz: 10,000 seeded iterations, only typed errors, per-iteration time budget", () => {
  const total = newStats();
  for (const seed of SEEDS) {
    const s = runFuzz(seed, PER_SEED);
    mergeStats(total, s);
  }
  assert.deepEqual(total.failures, []);
  assert.equal(total.iterations, SEEDS.length * PER_SEED);
  // the generator must reach every outcome, or the fuzz proves nothing
  assert.ok(total.differential > 1_000, `differential checks: ${total.differential}`);
  assert.ok(total.accepted > 1_000, `accepted: ${total.accepted}`);
  assert.ok(total.rejectedWhole > 500, `whole-request rejections: ${total.rejectedWhole}`);
  assert.ok(total.recordRejections > 0, "record-level rejections");
  // coverage per reject reason: framing-preserving and semantic mutations must reach most of them
  assert.ok(
    Object.keys(total.reasons).length >= 12,
    `reasons reached: ${JSON.stringify(total.reasons)}`,
  );
});

test("protobuf fuzz: a run is reproducible from its seed", () => {
  const x = runFuzz(77, 300);
  const y = runFuzz(77, 300);
  assert.deepEqual({ ...x, maxMs: 0 }, { ...y, maxMs: 0 });
});
