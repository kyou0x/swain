/**
 * Child process for heap.test.ts: builds ONE worst-case-density body, decodes it at default
 * limits and prints the peak resident set size (`maxRSS`, the high-water mark of the whole
 * process including the transient allocations of the decode) and the retained heap.
 * Usage: node heap-child.js <case>
 */
import { decodeTracesJson, decodeTracesProtobuf } from "../src/index.js";
import { lenField, varint } from "./proto-encoder.js";

const TRACE = Array.from({ length: 16 }, (_, i) => i + 1);
const SPAN = Array.from({ length: 8 }, (_, i) => i + 1);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u8 = (a: readonly number[]): Uint8Array => new Uint8Array(a);

/** tag + length + payload, for payloads too big for number[] helpers. */
function wrap(num: number, payload: Uint8Array): Uint8Array {
  return concat([u8([(num << 3) | 2, ...varint(payload.length)]), payload]);
}

function repeat(unit: readonly number[], times: number): Uint8Array {
  const out = new Uint8Array(unit.length * times);
  for (let i = 0; i < times; i++) out.set(unit, i * unit.length);
  return out;
}

/** Request > ResourceSpans > ScopeSpans > the given span messages. */
function request(spans: readonly Uint8Array[]): Uint8Array {
  const ss = concat(spans.map((s) => wrap(2, s)));
  return wrap(1, wrap(2, ss));
}

const ids = u8([...lenField(1, TRACE), ...lenField(2, SPAN)]);

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const cases: Record<string, () => { run: (b: Uint8Array) => unknown; body: Uint8Array }> = {
  // 330k minimal attributes on one span: ~990k fields, 2 MB
  "proto-attributes": () => ({
    run: decodeTracesProtobuf,
    body: request([concat([ids, repeat([0x4a, 0x04, 0x12, 0x02, 0x0a, 0x00], 330_000)])]),
  }),
  // 990k empty unknown fields inside one span: 2 MB
  "proto-unknown-flood": () => ({
    run: decodeTracesProtobuf,
    body: request([concat([ids, repeat([0x7a, 0x00], 990_000)])]),
  }),
  // 10,000 spans with 30 attributes each: 6 MB
  "proto-many-spans": () => ({
    run: decodeTracesProtobuf,
    body: request(
      Array.from({ length: 10_000 }, () =>
        concat([ids, repeat([0x4a, 0x04, 0x12, 0x02, 0x0a, 0x00], 30)]),
      ),
    ),
  }),
  // one array AnyValue with 1,024 entries, nested through 330 attributes: ~1M fields
  "proto-nested-arrays": () => {
    const entry = [0x0a, 0x02, 0x0a, 0x00]; // ArrayValue.values[0] = AnyValue{string ""}
    const arr = wrap(5, repeat(entry, 1024));
    const attr = wrap(9, concat([u8([0x0a, 0x01, 0x6b]), wrap(2, arr)]));
    return { run: decodeTracesProtobuf, body: request([concat([ids, repeat([...attr], 320)])]) };
  },
  // ~140k attributes in OTLP/JSON: 1M values, 5 MB
  "json-attributes": () => {
    const attr = '{"key":"","value":{"stringValue":""}},';
    const body = `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"00f067aa0ba902b7","attributes":[${attr.repeat(140_000)}{"key":"","value":{"stringValue":""}}]}]}]}]}`;
    return { run: decodeTracesJson, body: text(body) };
  },
  // a flat array of 990k numbers in an unknown field: 2 MB
  "json-flat-array": () => ({
    run: decodeTracesJson,
    body: text(`{"x":[${"0,".repeat(989_990)}0]}`),
  }),
  // 10,000 spans with 30 attributes each in JSON: ~10 MB
  "json-many-spans": () => {
    const attr = '{"key":"","value":{"stringValue":""}}';
    const span = `{"traceId":"5b8efff798038103d269b633813fc60c","spanId":"00f067aa0ba902b7","attributes":[${Array(30).fill(attr).join(",")}]}`;
    return {
      run: decodeTracesJson,
      body: text(
        `{"resourceSpans":[{"scopeSpans":[{"spans":[${Array(10_000).fill(span).join(",")}]}]}]}`,
      ),
    };
  },
};

const name = process.argv[2] ?? "";
const make = cases[name];
if (make === undefined) {
  console.error(`unknown case ${name}`);
  process.exit(2);
}
const { run, body } = make();
const before = process.resourceUsage().maxRSS;
const t0 = performance.now();
let outcome = "ok";
let kept: unknown;
try {
  kept = run(body);
} catch (e) {
  outcome = e instanceof Error ? e.message : "throw";
}
const ms = performance.now() - t0;
console.log(
  JSON.stringify({
    case: name,
    outcome,
    bodyMB: Number((body.length / 1048576).toFixed(2)),
    ms: Math.round(ms),
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    maxRssBeforeDecodeMB: Math.round(before / 1024),
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
    retained: kept !== undefined,
  }),
);
