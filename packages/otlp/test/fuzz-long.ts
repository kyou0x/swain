/**
 * `npm run fuzz:otlp [iterations] [seed]`: the long protobuf decoder fuzz (default 1,000,000
 * iterations, seed 20261116). Prints a summary and exits 1 on any failure. This file is not a
 * `*.test.js`, so `npm test` does not run it.
 */
import { ALL_REASONS, mergeStats, newStats, runFuzz } from "./proto-fuzz-core.js";

const iterations = Number(process.argv[2] ?? "1000000");
const seed = Number(process.argv[3] ?? "20261116");
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(seed)) {
  console.error("usage: fuzz-long [iterations] [seed]");
  process.exit(2);
}

const CHUNK = 50_000;
const total = newStats();
const t0 = performance.now();
for (let done = 0; done < iterations; done += CHUNK) {
  const n = Math.min(CHUNK, iterations - done);
  // Chunks use derived seeds so that each is reproducible on its own.
  const s = runFuzz((seed + done / CHUNK) >>> 0, n);
  mergeStats(total, s);
  console.log(`progress ${total.iterations}/${iterations} failures=${total.failures.length}`);
  if (total.failures.length > 0) break;
}
const seconds = (performance.now() - t0) / 1000;
console.log(
  JSON.stringify(
    {
      iterations: total.iterations,
      seed,
      seconds: Number(seconds.toFixed(1)),
      differentialChecks: total.differential,
      decodedOk: total.accepted,
      wholeRequestRejections: total.rejectedWhole,
      recordRejections: total.recordRejections,
      maxIterationMs: Number(total.maxMs.toFixed(2)),
      rejectionCodes: total.codes,
      recordReasonCoverage: total.reasons,
      reasonsNeverReached: ALL_REASONS.filter((r) => (total.reasons[r] ?? 0) === 0),
      failures: total.failures,
    },
    null,
    2,
  ),
);
process.exit(total.failures.length === 0 ? 0 : 1);
