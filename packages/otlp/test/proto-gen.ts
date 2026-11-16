import type { Rnd } from "./proto-encoder.js";

/** mulberry32: a small seeded PRNG. No other source of randomness is used. */
export function prng(seed: number): Rnd {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type J = Record<string, unknown>;

const int = (rnd: Rnd, n: number): number => Math.floor(rnd() * n);
const pick = <T>(rnd: Rnd, xs: readonly T[]): T => xs[int(rnd, xs.length)] as T;

const WORDS = [
  "",
  "a",
  "agent",
  "gen_ai.operation.name",
  "chat",
  "tool\u0000call",
  "﻿bom",
  "café",
  "\u{1f600}",
  "‮RLO",
  "<script>x</script>",
  "__proto__",
  "constructor",
  "line\nbreak",
  "ÿ߿ࠀ￿",
];

function text(rnd: Rnd): string {
  const r = rnd();
  if (r < 0.7) return pick(rnd, WORDS);
  let s = "";
  const n = int(rnd, 40);
  for (let i = 0; i < n; i++) {
    const c = int(rnd, 4);
    s +=
      c === 0
        ? String.fromCodePoint(0x20 + int(rnd, 0x5f))
        : c === 1
          ? String.fromCodePoint(0x80 + int(rnd, 0x700))
          : c === 2
            ? String.fromCodePoint(0x1000 + int(rnd, 0xd000 - 0x1000))
            : String.fromCodePoint(0x10000 + int(rnd, 0x1000));
  }
  return s;
}

function key(rnd: Rnd): string {
  return rnd() < 0.05 ? "k".repeat(int(rnd, 257)) : text(rnd);
}

const hexByte = (rnd: Rnd): string => int(rnd, 256).toString(16).padStart(2, "0");

/** Hex of `bytes` bytes, never all zero, random letter case (JSON normalizes to lowercase). */
export function randomId(rnd: Rnd, bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes; i++) s += hexByte(rnd);
  if (/^0+$/.test(s)) s = `01${s.slice(2)}`;
  return rnd() < 0.5 ? s : s.toUpperCase();
}

function bigInt64(rnd: Rnd): bigint {
  const r = rnd();
  if (r < 0.3) return BigInt(int(rnd, 1000) - 500);
  if (r < 0.4) return 9223372036854775807n;
  if (r < 0.5) return -9223372036854775808n;
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(int(rnd, 256));
  return BigInt.asIntN(64, v);
}

function time(rnd: Rnd): string {
  const r = rnd();
  if (r < 0.2) return "0";
  if (r < 0.3) return "9223372036854775807";
  if (r < 0.6) return String(1_700_000_000_000_000_000n + BigInt(int(rnd, 1e9)));
  return String(BigInt(int(rnd, 2 ** 31)) * BigInt(int(rnd, 2 ** 31)));
}

const uint32 = (rnd: Rnd): number => {
  const r = rnd();
  return r < 0.5 ? 0 : r < 0.6 ? 4294967295 : int(rnd, 100000);
};

export function anyValue(rnd: Rnd, depth: number): J {
  const maxKind = depth >= 16 ? 5 : 7;
  switch (int(rnd, maxKind)) {
    case 0:
      return { stringValue: text(rnd) };
    case 1:
      return { boolValue: rnd() < 0.5 };
    case 2:
      return { intValue: rnd() < 0.5 ? int(rnd, 2000) - 1000 : bigInt64(rnd).toString() };
    case 3: {
      const d = pick(rnd, [0.5, -1.25, 1e300, 5e-324, Math.PI, 1e21, 123456789.125]);
      return { doubleValue: d };
    }
    case 4: {
      const n = int(rnd, 12);
      const bytes = Array.from({ length: n }, () => int(rnd, 256));
      return { bytesValue: btoa(String.fromCharCode(...bytes)) };
    }
    case 5:
      return { arrayValue: { values: list(rnd, 4, () => anyValue(rnd, depth + 1)) } };
    default:
      return { kvlistValue: { values: list(rnd, 4, () => kv(rnd, depth + 1)) } };
  }
}

function list<T>(rnd: Rnd, max: number, f: () => T): T[] {
  const n = int(rnd, max + 1);
  return Array.from({ length: n }, f);
}

function kv(rnd: Rnd, depth: number): J {
  return { key: key(rnd), value: anyValue(rnd, depth) };
}

function attributes(rnd: Rnd, big: boolean): J[] {
  const n = big && rnd() < 0.02 ? 129 + int(rnd, 20) : int(rnd, 5);
  return Array.from({ length: n }, () => kv(rnd, 1));
}

function maybe(rnd: Rnd, p: number, o: J, name: string, value: () => unknown): void {
  if (rnd() < p) o[name] = value();
}

function resource(rnd: Rnd): J {
  const o: J = {};
  maybe(rnd, 0.8, o, "attributes", () => attributes(rnd, true));
  maybe(rnd, 0.2, o, "droppedAttributesCount", () => uint32(rnd));
  return o;
}

function scope(rnd: Rnd): J {
  const o: J = {};
  maybe(rnd, 0.8, o, "name", () => text(rnd));
  maybe(rnd, 0.5, o, "version", () => text(rnd));
  maybe(rnd, 0.5, o, "attributes", () => attributes(rnd, true));
  maybe(rnd, 0.2, o, "droppedAttributesCount", () => uint32(rnd));
  return o;
}

function span(rnd: Rnd): J {
  const o: J = { traceId: randomId(rnd, 16), spanId: randomId(rnd, 8) };
  maybe(rnd, 0.3, o, "traceState", () => text(rnd));
  maybe(rnd, 0.6, o, "parentSpanId", () => (rnd() < 0.1 ? "" : randomId(rnd, 8)));
  maybe(rnd, 0.3, o, "flags", () => uint32(rnd));
  maybe(rnd, 0.9, o, "name", () => text(rnd));
  maybe(rnd, 0.8, o, "kind", () => int(rnd, 6));
  maybe(rnd, 0.9, o, "startTimeUnixNano", () => time(rnd));
  maybe(rnd, 0.9, o, "endTimeUnixNano", () => time(rnd));
  maybe(rnd, 0.8, o, "attributes", () => attributes(rnd, true));
  maybe(rnd, 0.2, o, "droppedAttributesCount", () => uint32(rnd));
  maybe(rnd, 0.4, o, "events", () =>
    list(rnd, rnd() < 0.02 ? 140 : 3, () => {
      const e: J = {};
      maybe(rnd, 0.9, e, "timeUnixNano", () => time(rnd));
      maybe(rnd, 0.9, e, "name", () => text(rnd));
      maybe(rnd, 0.6, e, "attributes", () => attributes(rnd, false));
      maybe(rnd, 0.1, e, "droppedAttributesCount", () => uint32(rnd));
      return e;
    }),
  );
  maybe(rnd, 0.1, o, "droppedEventsCount", () => uint32(rnd));
  maybe(rnd, 0.3, o, "links", () =>
    list(rnd, rnd() < 0.02 ? 140 : 3, () => {
      const l: J = { traceId: randomId(rnd, 16), spanId: randomId(rnd, 8) };
      maybe(rnd, 0.3, l, "traceState", () => text(rnd));
      maybe(rnd, 0.5, l, "attributes", () => attributes(rnd, false));
      maybe(rnd, 0.1, l, "droppedAttributesCount", () => uint32(rnd));
      maybe(rnd, 0.3, l, "flags", () => uint32(rnd));
      return l;
    }),
  );
  maybe(rnd, 0.1, o, "droppedLinksCount", () => uint32(rnd));
  maybe(rnd, 0.6, o, "status", () => {
    const s: J = {};
    maybe(rnd, 0.8, s, "code", () => int(rnd, 3));
    maybe(rnd, 0.5, s, "message", () => text(rnd));
    return s;
  });
  return o;
}

function logRecord(rnd: Rnd): J {
  const o: J = {};
  maybe(rnd, 0.9, o, "timeUnixNano", () => time(rnd));
  maybe(rnd, 0.6, o, "observedTimeUnixNano", () => time(rnd));
  maybe(rnd, 0.8, o, "severityNumber", () => int(rnd, 25));
  maybe(rnd, 0.6, o, "severityText", () => text(rnd));
  maybe(rnd, 0.8, o, "body", () => anyValue(rnd, 1));
  maybe(rnd, 0.8, o, "attributes", () => attributes(rnd, true));
  maybe(rnd, 0.2, o, "droppedAttributesCount", () => uint32(rnd));
  maybe(rnd, 0.3, o, "flags", () => uint32(rnd));
  maybe(rnd, 0.5, o, "traceId", () => (rnd() < 0.1 ? "" : randomId(rnd, 16)));
  maybe(rnd, 0.5, o, "spanId", () => (rnd() < 0.1 ? "" : randomId(rnd, 8)));
  maybe(rnd, 0.6, o, "eventName", () => text(rnd));
  return o;
}

function request(rnd: Rnd, names: readonly [string, string, string], rec: (r: Rnd) => J): J {
  const groups = list(rnd, 2, () => {
    const g: J = {};
    maybe(rnd, 0.8, g, "resource", () => resource(rnd));
    maybe(rnd, 0.3, g, "schemaUrl", () => text(rnd));
    g[names[1]] = list(rnd, 2, () => {
      const s: J = {};
      maybe(rnd, 0.8, s, "scope", () => scope(rnd));
      maybe(rnd, 0.3, s, "schemaUrl", () => text(rnd));
      s[names[2]] = list(rnd, 3, () => rec(rnd));
      return s;
    });
    return g;
  });
  return { [names[0]]: groups };
}

/** A random VALID OTLP/JSON-shaped traces request (the decoders accept every record). */
export function randomTraces(rnd: Rnd): J {
  return request(rnd, ["resourceSpans", "scopeSpans", "spans"], span);
}

export function randomLogs(rnd: Rnd): J {
  return request(rnd, ["resourceLogs", "scopeLogs", "logRecords"], logRecord);
}
