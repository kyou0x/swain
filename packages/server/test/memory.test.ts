/**
 * Memory precondition (G3-proto / ADR-0006 section 6, F2): N concurrent worst-case bodies must not
 * push the server's peak RSS past a stated bound. The server runs in a child process so its
 * `process.resourceUsage().maxRSS` is its own; the load generator and the bodies stay in this
 * process. Numbers are printed (`# memory ...`) so the report can quote them.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const MIB = 1024 * 1024;

/** Stated bound: server child peak RSS growth over its idle baseline, in MiB, for 16 concurrent bodies. */
const GROWTH_BOUND_MIB = 400;
/** Stated bound: absolute server child peak RSS, in MiB. */
const PEAK_BOUND_MIB = 600;

/** Spans packed with small attributes: the most decoded values per byte, near the 8 MiB cap. */
function manyValues(seed: number, perSpan: number, bytes: number): Uint8Array {
  const attr = '{"key":"k","value":{"intValue":"1"}}';
  const parts: string[] = [];
  let size = 0;
  for (let i = 1; size < bytes && parts.length < 9_900; i++) {
    const id = (seed * 100000 + i).toString(16).padStart(16, "0");
    const t = `{"traceId":"${seed.toString(16).padStart(32, "a")}","spanId":"${id}","name":"s","kind":1,"startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":[${Array(perSpan).fill(attr).join(",")}]}`;
    parts.push(t);
    size += t.length + 1;
  }
  return new TextEncoder().encode(
    `{"resourceSpans":[{"scopeSpans":[{"spans":[${parts.join(",")}]}]}]}`,
  );
}

/** A body that decodes to about 28 MiB of long strings and compresses to a few KiB. */
function bigGzip(seed: number): Uint8Array {
  const filler = "x".repeat(MIB);
  const spans: string[] = [];
  for (let i = 1; i <= 28; i++) {
    const id = (seed * 100 + i).toString(16).padStart(16, "0");
    spans.push(
      `{"traceId":"${seed.toString(16).padStart(32, "b")}","spanId":"${id}","name":"s","kind":1,"startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":[{"key":"gen_ai.input.messages","value":{"stringValue":"${filler}"}}]}`,
    );
  }
  return new Uint8Array(
    gzipSync(Buffer.from(`{"resourceSpans":[{"scopeSpans":[{"spans":[${spans.join(",")}]}]}]}`)),
  );
}

function send(port: number, secret: string, body: Uint8Array, gzip: boolean): Promise<number> {
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/traces",
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          "Content-Length": String(body.length),
          ...(gzip ? { "Content-Encoding": "gzip" } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", () => resolve(0));
    req.end(body);
  });
}

interface Final {
  baseline: number;
  peak: number;
  counters: Record<string, number>;
}

async function scenario(
  name: string,
  bodies: readonly Uint8Array[],
  gzip: boolean,
): Promise<{
  statuses: Record<string, number>;
  baselineMiB: number;
  peakMiB: number;
  final: Final;
}> {
  const child = spawn(process.execPath, [new URL("./memory-child.js", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const lines: string[] = [];
  const waiters: ((l: string) => void)[] = [];
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const w = waiters.shift();
      if (w === undefined) lines.push(line);
      else w(line);
      i = buf.indexOf("\n");
    }
  });
  const next = (): Promise<string> =>
    new Promise((resolve) => {
      const l = lines.shift();
      if (l !== undefined) resolve(l);
      else waiters.push(resolve);
    });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  const hello = JSON.parse(await next()) as { port: number; secret: string };
  const statuses: Record<string, number> = {};
  const results = await Promise.all(bodies.map((b) => send(hello.port, hello.secret, b, gzip)));
  for (const s of results) statuses[String(s)] = (statuses[String(s)] ?? 0) + 1;
  child.stdin.write("done\n");
  const final = JSON.parse(await next()) as Final;
  await exited;
  const baselineMiB = Math.round(final.baseline / 1024);
  const peakMiB = Math.round(final.peak / 1024);
  console.log(
    `# memory ${name}: n=${bodies.length} wire=${Math.round(bodies.reduce((a, b) => a + b.length, 0) / MIB)}MiB ` +
      `baseline=${baselineMiB}MiB peak=${peakMiB}MiB growth=${peakMiB - baselineMiB}MiB ` +
      `statuses=${JSON.stringify(statuses)} busy=${final.counters["busy"]}`,
  );
  return { statuses, baselineMiB, peakMiB, final };
}

test("memory: 16 concurrent worst-case 8 MiB bodies stay under the stated RSS bound", async () => {
  const bodies = Array.from({ length: 16 }, (_v, i) => manyValues(i + 1, 40, 8 * MIB - 8192));
  const r = await scenario("values-8MiB", bodies, false);
  assert.equal(r.statuses["0"], undefined, "no connection failures");
  const answered = Object.values(r.statuses).reduce((a, b) => a + b, 0);
  assert.equal(answered, 16);
  // beyond the decode concurrency of 2 the server answers 503 instead of buffering
  assert.ok((r.statuses["503"] ?? 0) >= 1, JSON.stringify(r.statuses));
  assert.ok(
    r.peakMiB - r.baselineMiB <= GROWTH_BOUND_MIB,
    `growth ${r.peakMiB - r.baselineMiB} MiB`,
  );
  assert.ok(r.peakMiB <= PEAK_BOUND_MIB, `peak ${r.peakMiB} MiB`);
  assert.equal(r.final.counters["internalErrors"], 0);
  assert.equal(r.final.counters["decoderInternalErrors"], 0);
});

test("memory: 16 concurrent bodies sized just under maxValues are decoded two at a time", async () => {
  // About 1 MiB of tiny attributes (about 190k values) is just under the 250,000 value cap.
  const bodies = Array.from({ length: 16 }, (_v, i) => manyValues(i + 1, 40, MIB));
  const r = await scenario("values-1MiB-accepted", bodies, false);
  assert.equal(r.statuses["0"], undefined);
  assert.ok((r.statuses["200"] ?? 0) >= 1, JSON.stringify(r.statuses));
  assert.ok(
    r.peakMiB - r.baselineMiB <= GROWTH_BOUND_MIB,
    `growth ${r.peakMiB - r.baselineMiB} MiB`,
  );
  assert.ok(r.peakMiB <= PEAK_BOUND_MIB, `peak ${r.peakMiB} MiB`);
  assert.equal(r.final.counters["internalErrors"], 0);
});

test("memory: 12 concurrent 28 MiB decoded gzip bodies stay under the stated RSS bound", async () => {
  const bodies = Array.from({ length: 12 }, (_v, i) => bigGzip(i + 1));
  const r = await scenario("gzip-28MiB-decoded", bodies, true);
  assert.equal(r.statuses["0"], undefined);
  assert.ok(
    r.peakMiB - r.baselineMiB <= GROWTH_BOUND_MIB,
    `growth ${r.peakMiB - r.baselineMiB} MiB`,
  );
  assert.ok(r.peakMiB <= PEAK_BOUND_MIB, `peak ${r.peakMiB} MiB`);
  assert.equal(r.final.counters["internalErrors"], 0);
});
