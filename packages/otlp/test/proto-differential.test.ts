import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import {
  decodeLogsJson,
  decodeLogsProtobuf,
  decodeTracesJson,
  decodeTracesProtobuf,
} from "../src/index.js";
import { FIXTURE_DIR, fixture } from "./helpers.js";
import { type EncodeOptions, encodeLogs, encodeTraces, NotEncodable } from "./proto-encoder.js";
import { prng, randomLogs, randomTraces } from "./proto-gen.js";

const text = new TextDecoder();

const VARIANTS: readonly [string, EncodeOptions][] = [
  ["plain", {}],
  ["explicit defaults", { explicitDefaults: true }],
  ["shuffled + unknown fields", { shuffle: prng(5), unknownFields: prng(6) }],
];

function signalOf(json: unknown): "traces" | "logs" {
  return typeof json === "object" && json !== null && "resourceLogs" in json ? "logs" : "traces";
}

function differential(name: string, jsonBytes: Uint8Array, opts: EncodeOptions): boolean {
  const json: unknown = JSON.parse(text.decode(jsonBytes));
  const signal = signalOf(json);
  let proto: Uint8Array;
  try {
    proto = signal === "traces" ? encodeTraces(json, opts) : encodeLogs(json, opts);
  } catch (e) {
    if (e instanceof NotEncodable) return false;
    throw e;
  }
  if (signal === "traces") {
    assert.deepStrictEqual(decodeTracesProtobuf(proto), decodeTracesJson(jsonBytes), name);
  } else {
    assert.deepStrictEqual(decodeLogsProtobuf(proto), decodeLogsJson(jsonBytes), name);
  }
  return true;
}

for (const f of ["traces-genai.json", "traces-openinference.json", "logs-claude-code.json"]) {
  for (const [label, opts] of VARIANTS) {
    test(`differential: ${f} (${label}) gives an identical model and hashes`, () => {
      const bytes = fixture(f);
      assert.ok(differential(f, bytes, opts));
      // The fixtures must actually decode records (not be vacuously identical).
      const d = f.startsWith("logs")
        ? decodeLogsProtobuf(
            encodeLogs(JSON.parse(text.decode(bytes)) as unknown, opts),
          ).resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords))
        : decodeTracesProtobuf(
            encodeTraces(JSON.parse(text.decode(bytes)) as unknown, opts),
          ).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
      assert.ok(d.length > 0);
      for (const r of d) assert.match(r.recordSha256, /^[0-9a-f]{64}$/);
    });
  }
}

/** Hostile JSON fixtures that cannot be expressed as protobuf (not hex, lone surrogate, ...). */
const NOT_REPRESENTABLE = new Set([
  "enum-names.json",
  "int64-number-unsafe.json", // JSON.parse already rounded the number; the encoder cannot see it
  "invalid-utf8.json",
  "lone-surrogate.json",
  "trace-id-31.json",
  "trace-id-33.json",
  "trace-id-non-hex.json",
]);

test("differential: hostile JSON fixtures give the same rejections where representable", () => {
  const names = readdirSync(`${FIXTURE_DIR}/hostile`).filter((n) => n.endsWith(".json"));
  assert.ok(names.length >= 15);
  let compared = 0;
  for (const n of names) {
    if (NOT_REPRESENTABLE.has(n)) continue;
    const ok = differential(n, fixture(`hostile/${n}`), {});
    assert.ok(ok, `${n} unexpectedly not encodable`);
    compared++;
  }
  assert.ok(compared >= 8, `compared ${compared}`);
});

for (const [signal, gen, encode, viaJson, viaProto] of [
  ["traces", randomTraces, encodeTraces, decodeTracesJson, decodeTracesProtobuf],
  ["logs", randomLogs, encodeLogs, decodeLogsJson, decodeLogsProtobuf],
] as const) {
  test(`differential fuzz: 3000 random valid ${signal} structures give identical decoded models`, () => {
    let records = 0;
    for (let i = 0; i < 3000; i++) {
      const rnd = prng(0xd1ff + i);
      const structure = gen(rnd);
      const opts: EncodeOptions =
        i % 3 === 0
          ? {}
          : i % 3 === 1
            ? { explicitDefaults: true }
            : { shuffle: rnd, unknownFields: rnd };
      const json = new TextEncoder().encode(JSON.stringify(structure));
      const a = viaJson(json);
      const b = viaProto(encode(structure, opts));
      assert.deepStrictEqual(b, a, `iteration ${i}`);
      records += a.rejected.length;
      records +=
        a.signal === "traces"
          ? a.resourceSpans.reduce(
              (n, r) => n + r.scopeSpans.reduce((m, s) => m + s.spans.length, 0),
              0,
            )
          : a.resourceLogs.reduce(
              (n, r) => n + r.scopeLogs.reduce((m, s) => m + s.logRecords.length, 0),
              0,
            );
    }
    assert.ok(records > 1000, `only ${records} records compared`);
  });
}
