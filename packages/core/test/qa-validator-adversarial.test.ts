// Independent G2 (QA) adversarial validator tests. Fixtures are read from disk and mutated;
// expected outcomes come from ADR-0002 / SPEC-001 text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Issue, validateEvent, validateEvents } from "../src/index.js";

const dir = fileURLToPath(new URL("../../../../fixtures/canonical/valid/", import.meta.url));
type Rec = Record<string, unknown>;
const load = (n: string): Rec => JSON.parse(readFileSync(`${dir}${n}.json`, "utf8")) as Rec;
const toolReq = (): Rec => load("tool.requested");
const rec = (v: unknown): Rec => v as Rec;

function codes(v: unknown): string[] {
  const r = validateEvent(v);
  return r.ok ? [] : r.issues.map((i) => i.code);
}
function issues(v: unknown): Issue[] {
  const r = validateEvent(v);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.issues;
}

const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
test.after(() => {
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(","), protoBefore);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("baseline: the fixture is valid and the result is a fresh deep copy", () => {
  const input = toolReq();
  const r = validateEvent(input);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.event, input);
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      assert.equal(seen.has(v), false);
      seen.add(v);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(input);
  const outSeen = new Set<unknown>();
  const walkOut = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      assert.equal(seen.has(v), false, "output shares an object with input");
      outSeen.add(v);
      for (const x of Object.values(v)) walkOut(x);
    }
  };
  walkOut(r.event);
  // Output key order is the ADR field order, regardless of input order.
  const shuffled = Object.fromEntries(Object.entries(input).reverse());
  const r2 = validateEvent(shuffled);
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.deepEqual(Object.keys(r2.event), Object.keys(input));
  }
});

test("a deep-frozen valid input validates and is not mutated", () => {
  const input = toolReq();
  const freeze = (v: unknown): void => {
    if (v !== null && typeof v === "object") {
      Object.freeze(v);
      for (const x of Object.values(v)) freeze(x);
    }
  };
  freeze(input);
  const before = JSON.stringify(input);
  assert.equal(validateEvent(input).ok, true);
  assert.equal(JSON.stringify(input), before);
});

// ---- depth -----------------------------------------------------------------

function nestedObj(levels: number): Rec {
  // `levels` object levels below the carrier, innermost holds a scalar.
  let v: Rec = { leaf: 1 };
  for (let i = 1; i < levels; i++) v = { n: v };
  return v;
}

test("depth: root + 31 nested levels is the limit (32); 32 nested levels is depth-exceeded", () => {
  const atLimit = toolReq();
  atLimit["extra"] = nestedObj(31); // extra at depth 1 ... deepest object at depth 31
  assert.deepEqual(codes(atLimit), ["unknown-key"]); // accepted by the snapshot, rejected by schema
  const over = toolReq();
  over["extra"] = nestedObj(32);
  assert.ok(codes(over).includes("depth-exceeded"));
  assert.ok(!codes(atLimit).includes("depth-exceeded"));
});

test("depth: arrays count toward the limit the same way", () => {
  const wrap = (n: number): unknown => {
    let v: unknown = [];
    for (let i = 1; i < n; i++) v = [v];
    return v;
  };
  const atLimit = toolReq();
  atLimit["extra"] = wrap(31);
  assert.ok(!codes(atLimit).includes("depth-exceeded"));
  const over = toolReq();
  over["extra"] = wrap(32);
  assert.ok(codes(over).includes("depth-exceeded"));
});

test("depth: 100000 levels and cycles are rejected without stack overflow", () => {
  const e = toolReq();
  let v: Rec = {};
  const head = v;
  for (let i = 0; i < 100_000; i++) {
    const n: Rec = {};
    v["n"] = n;
    v = n;
  }
  e["extra"] = head;
  assert.ok(codes(e).includes("depth-exceeded"));
  const c = toolReq();
  const loop: Rec = {};
  loop["self"] = loop;
  c["attributes"] = loop;
  assert.ok(codes(c).includes("depth-exceeded"));
  const a: unknown[] = [];
  a.push(a);
  const d = toolReq();
  d["links"] = a;
  assert.ok(codes(d).includes("depth-exceeded"));
  // mutual cycle
  const x: Rec = {};
  const y: Rec = { x };
  x["y"] = y;
  const f = toolReq();
  f["payload"] = x;
  assert.ok(codes(f).includes("depth-exceeded"));
});

// ---- numeric edge cases -----------------------------------------------------

test("numeric edges: NaN, Infinity, 1e400 text, 1e21, fractions are never accepted as integers", () => {
  for (const bad of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e21,
    0.5,
    2 ** 53,
    2 ** 53 + 2,
    -(2 ** 53),
  ]) {
    const e = toolReq();
    e["sourceSequence"] = bad;
    assert.equal(validateEvent(e).ok, false, String(bad));
  }
  // 1e400 as parsed JSON text is Infinity
  const parsed = JSON.parse('{"x":1e400,"y":-1e400,"z":1e-400}') as Rec;
  assert.equal(parsed["x"], Number.POSITIVE_INFINITY);
  const e = toolReq();
  e["sourceSequence"] = parsed["x"];
  assert.deepEqual(codes(e), ["not-integer"]);
  const u = load("model.usage");
  rec(u["payload"])["costUsdEstimate"] = parsed["x"];
  assert.deepEqual(codes(u), ["out-of-range"]);
  rec(u["payload"])["costUsdEstimate"] = Number.NaN;
  assert.deepEqual(codes(u), ["out-of-range"]);
  rec(u["payload"])["costUsdEstimate"] = 5e-324;
  assert.equal(validateEvent(u).ok, true);
  rec(u["payload"])["costUsdEstimate"] = Number.MAX_VALUE;
  assert.equal(validateEvent(u).ok, true);
  // integers only for token counts, but 1e2 from JSON text is the integer 100
  const t = load("model.usage");
  rec(t["payload"])["inputTokens"] = JSON.parse("1e2");
  assert.equal(validateEvent(t).ok, true);
  rec(t["payload"])["inputTokens"] = JSON.parse("1.0");
  assert.equal(validateEvent(t).ok, true); // JSON.parse projection: 1.0 === 1
  rec(t["payload"])["inputTokens"] = 0.1 + 0.2;
  assert.deepEqual(codes(t), ["not-integer"]);
  rec(t["payload"])["inputTokens"] = "1";
  assert.deepEqual(codes(t), ["wrong-type"]);
  rec(t["payload"])["inputTokens"] = null;
  assert.deepEqual(codes(t), ["wrong-type"]);
  rec(t["payload"])["inputTokens"] = 10n;
  assert.deepEqual(codes(t), ["wrong-type"]);
  rec(t["payload"])["inputTokens"] = new Number(1);
  assert.deepEqual(codes(t), ["not-plain-data"]);
  rec(t["payload"])["inputTokens"] = Number.MAX_SAFE_INTEGER;
  assert.equal(validateEvent(t).ok, true);
});

test("numeric edge: -0 never throws; result (accepted or rejected) is stable", () => {
  const e = toolReq();
  e["sourceSequence"] = -0;
  const r = validateEvent(e);
  // ADR: "integer >=0". -0 === 0, so acceptance is defensible; record the observed behaviour.
  assert.equal(typeof r.ok, "boolean");
});

test("attribute numbers: safe negative integers ok, floats/NaN/Infinity rejected", () => {
  const e = toolReq();
  e["attributes"] = { "codex-cli.a": -5, "codex-cli.b": Number.MAX_SAFE_INTEGER };
  assert.equal(validateEvent(e).ok, true);
  for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, -(2 ** 53)]) {
    e["attributes"] = { "codex-cli.a": bad };
    assert.deepEqual(codes(e), ["not-integer"], String(bad));
  }
  e["attributes"] = { "codex-cli.a": {} };
  assert.deepEqual(codes(e), ["wrong-type"]);
  e["attributes"] = { "codex-cli.a": [] };
  assert.deepEqual(codes(e), ["wrong-type"]);
  e["attributes"] = { "codex-cli.a": undefined };
  assert.deepEqual(codes(e), ["wrong-type"]);
});

// ---- hostile key names ------------------------------------------------------

const HOSTILE_KEYS = [
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "constructor",
  "__proto__",
  "__defineGetter__",
  "__lookupGetter__",
  "prototype",
  "length",
  "then",
  "",
];

test("hostile keys as unknown keys at every object level are unknown-key, never prototype lookups", () => {
  for (const k of HOSTILE_KEYS) {
    for (const where of [
      [],
      ["payload"],
      ["time"],
      ["actor"],
      ["provenance"],
      ["provenance", "adapter"],
      ["completeness"],
      ["links", "0"],
    ]) {
      const e = toolReq();
      if (where[0] === "links") e["links"] = [{ rel: "gap-for", target: `evt_${"0".repeat(32)}` }];
      let o: Rec = e;
      for (const w of where) o = rec(Array.isArray(o) ? o[Number(w)] : o[w]);
      Object.defineProperty(o, k, {
        value: 1,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      const c = codes(e);
      assert.ok(c.includes("unknown-key"), `${k} at ${where.join("/")} -> ${c.join(",")}`);
    }
  }
});

test("JSON.parse own __proto__ key does not pollute and is reported", () => {
  const e = JSON.parse(`{"__proto__":{"polluted":true}}`) as Rec;
  assert.equal(validateEvent(e).ok, false);
  assert.equal(({} as Rec)["polluted"], undefined);
  const t = JSON.parse(JSON.stringify(toolReq()).replace('"codex-cli.note"', '"__proto__"')) as Rec;
  assert.ok(codes(t).length > 0);
  assert.equal(({} as Rec)["polluted"], undefined);
});

test("hostile keys in attributes are bad-pattern (namespace dot required)", () => {
  for (const k of ["toString", "hasOwnProperty", "constructor", "__proto__", "valueOf"]) {
    const e = toolReq();
    const attrs: Rec = {};
    Object.defineProperty(attrs, k, {
      value: "x",
      enumerable: true,
      writable: true,
      configurable: true,
    });
    e["attributes"] = attrs;
    assert.deepEqual(codes(e), ["bad-pattern"], k);
  }
});

test("hostile VALUES for enum fields never match inherited properties", () => {
  for (const v of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    for (const [path, field] of [
      [[], "kind"],
      [[], "provider"],
      [[], "status"],
      [["actor"], "role"],
      [["time"], "origin"],
      [["time"], "status"],
      [["payload"], "toolNamespace"],
    ] as const) {
      const e = toolReq();
      let o: Rec = e;
      for (const p of path) o = rec(o[p]);
      o[field] = v;
      const c = codes(e);
      assert.ok(c.length >= 1 && !c.includes("internal"), `${field}=${v}: ${c.join(",")}`);
    }
  }
  const e = toolReq();
  e["completeness"] = { toString: { state: "captured" } };
  assert.ok(codes(e).includes("unknown-key"));
  const f = toolReq();
  rec(f["completeness"])["inputs"] = { state: "toString" };
  assert.deepEqual(codes(f), ["bad-enum"]);
});

// ---- Unicode ---------------------------------------------------------------

test("Unicode: lone surrogates in values, keys and attribute strings", () => {
  for (const s of ["\ud800", "\udc00", "a\ud800b", "\udc00\ud800", "\ud83d", "\ude00\ud83d"]) {
    const e = toolReq();
    rec(e["payload"])["toolName"] = s;
    assert.deepEqual(codes(e), ["ill-formed-string"], JSON.stringify(s));
    const a = toolReq();
    a["attributes"] = { "codex-cli.k": s };
    assert.deepEqual(codes(a), ["ill-formed-string"]);
    const k = toolReq();
    k["attributes"] = { [`codex-cli.${s}`]: "x" };
    assert.ok(codes(k).length >= 1);
    const u = toolReq();
    u[s] = 1;
    const is = issues(u);
    assert.ok(is.every((i) => !/[\ud800-\udfff]/.test(i.path) || i.path.isWellFormed()));
    assert.ok(
      is.every((i) => i.path.isWellFormed()),
      "path must be well-formed",
    );
  }
});

test("Unicode: byte-length bounds are UTF-8 bytes, not UTF-16 units or code points", () => {
  const cases: [string, string, number][] = [
    ["é", "2-byte", 128],
    ["€", "3-byte", 85],
    ["\u{1F600}", "4-byte", 64],
  ];
  for (const [ch, , n] of cases) {
    const ok = toolReq();
    rec(ok["payload"])["toolName"] = ch.repeat(n);
    assert.equal(validateEvent(ok).ok, true, `${ch}x${n}`);
    const over = toolReq();
    rec(over["payload"])["toolName"] = ch.repeat(n + 1);
    assert.deepEqual(codes(over), ["too-long"], `${ch}x${n + 1}`);
  }
  // 255 bytes of 3-byte chars + 1 ASCII = 256 ok; +2 ASCII = 257 rejected
  const e = toolReq();
  rec(e["payload"])["toolName"] = `${"€".repeat(85)}a`;
  assert.equal(validateEvent(e).ok, true);
  rec(e["payload"])["toolName"] = `${"€".repeat(85)}aa`;
  assert.deepEqual(codes(e), ["too-long"]);
  // a very long string is rejected quickly (10 MB)
  rec(e["payload"])["toolName"] = "a".repeat(10_000_000);
  assert.deepEqual(codes(e), ["too-long"]);
});

test("Unicode: noncharacters, BOM, bidi controls, combining marks and NUL are allowed in free text (S13 owns neutralization)", () => {
  for (const s of ["￿", "﻿", "‮", "⁦x⁩", "é́́", "\u0000", "  ", "\u{10FFFF}", "\u0085"]) {
    const e = toolReq();
    rec(e["payload"])["toolName"] = s;
    assert.equal(validateEvent(e).ok, true, JSON.stringify(s));
  }
});

test("Unicode: a NUL is rejected where the ADR forbids it (file path), accepted in attribute values", () => {
  const f = load("file.changed");
  rec(f["payload"])["path"] = "a\u0000b";
  assert.deepEqual(codes(f), ["forbidden-char"]);
  rec(f["payload"])["path"] = "‮/evil";
  assert.equal(validateEvent(f).ok, true);
  rec(f["payload"])["path"] = "";
  assert.equal(validateEvent(f).ok, true);
  rec(f["payload"])["path"] = "a".repeat(4096);
  assert.equal(validateEvent(f).ok, true);
  rec(f["payload"])["path"] = `${"€".repeat(1365)}ab`; // 4097 bytes
  assert.deepEqual(codes(f), ["too-long"]);
});

test("Unicode: anchors are not fooled by trailing newline or look-alike digits", () => {
  const e = toolReq();
  e["schemaVersion"] = "0.1.0\n";
  assert.ok(codes(e).length > 0);
  e["schemaVersion"] = "0.1.０";
  assert.ok(codes(e).length > 0);
  e["schemaVersion"] = "0.1.0";
  e["eventId"] = `evt_${"a".repeat(32)}\n`;
  assert.ok(codes(e).length > 0);
  e["eventId"] = `evt_${"ａ".repeat(32)}`;
  assert.ok(codes(e).length > 0);
  const p = toolReq();
  p["providerVersion"] = "1.0\n";
  assert.deepEqual(codes(p), ["bad-pattern"]);
  p["providerVersion"] = "1.0é";
  assert.deepEqual(codes(p), ["bad-pattern"]);
  p["providerVersion"] = "!".repeat(64);
  assert.equal(validateEvent(p).ok, true);
  p["providerVersion"] = "!".repeat(65);
  assert.deepEqual(codes(p), ["too-long"]);
  p["providerVersion"] = "";
  assert.deepEqual(codes(p), ["bad-pattern"]);
});

test("schemaVersion: 0.1.N accepted for N up to 6 digits, nothing else", () => {
  for (const [v, ok] of [
    ["0.1.0", true],
    ["0.1.999999", true],
    ["0.1.1000000", false],
    ["0.2.0", false],
    ["1.0.0", false],
    ["0.1", false],
    ["0.1.", false],
    ["00.1.0", false],
    ["0.1.0-rc", false],
    [" 0.1.0", false],
    ["", false],
  ] as const) {
    const e = toolReq();
    e["schemaVersion"] = v;
    assert.equal(validateEvent(e).ok, ok, v);
  }
});

// ---- exotic JS values ---------------------------------------------------------

test("exotic values at the event root and in fields are rejected without throwing", () => {
  for (const v of [
    undefined,
    null,
    1,
    "x",
    true,
    10n,
    Symbol("s"),
    () => 1,
    [],
    [toolReq()],
    new Map(),
    new Set(),
    new Date(0),
    /x/,
    new Uint8Array(4),
    Object.create(null) as unknown,
    new (class X {})(),
    Object.create({ kind: "turn.ended" }),
    new Error("x"),
    Promise.resolve(1),
    new WeakMap(),
    new ArrayBuffer(8),
    globalThis,
  ]) {
    const r = validateEvent(v);
    assert.equal(r.ok, false);
  }
  for (const v of [
    new Number(1),
    new String("x"),
    new Boolean(true),
    Object(10n),
    Object(Symbol("q")),
  ]) {
    const e = toolReq();
    rec(e["payload"])["toolName"] = v;
    const c = codes(e);
    assert.ok(c.length >= 1 && !c.includes("internal"), String(c));
  }
});

test("null-prototype objects are accepted as input", () => {
  const e = toolReq();
  const np = (o: Rec): Rec => Object.assign(Object.create(null) as Rec, o);
  e["actor"] = np(rec(e["actor"]));
  assert.equal(validateEvent(np(e)).ok, true);
});

test("arrays: sparse, extra props, subclass, getters, wrong length bound", () => {
  const sparse: unknown[] = new Array(1);
  const e = toolReq();
  e["links"] = sparse;
  assert.ok(codes(e).includes("not-plain-data"));
  const extra: unknown[] = [];
  Object.defineProperty(extra, "foo", { value: 1, enumerable: true });
  e["links"] = extra;
  assert.ok(codes(e).includes("not-plain-data"));
  const hidden: unknown[] = [];
  Object.defineProperty(hidden, "foo", { value: 1, enumerable: false });
  e["links"] = hidden;
  assert.ok(codes(e).includes("not-plain-data"));
  class A extends Array {}
  e["links"] = new A();
  assert.ok(codes(e).includes("not-plain-data"));
  const g: unknown[] = [];
  Object.defineProperty(g, "0", { get: () => 1, enumerable: true });
  e["links"] = g;
  assert.ok(codes(e).includes("accessor-property"));
  e["links"] = Object.setPrototypeOf([], null);
  assert.ok(codes(e).includes("not-plain-data"));
  const big = new Array(1_000_000).fill(0);
  e["links"] = big;
  assert.deepEqual(codes(e), ["too-many-items"]);
  e["links"] = new Array(17).fill({ rel: "gap-for", target: `evt_${"0".repeat(32)}` });
  assert.deepEqual(codes(e), ["too-many-items"]);
  e["links"] = new Array(16).fill({ rel: "gap-for", target: `evt_${"0".repeat(32)}` });
  assert.equal(validateEvent(e).ok, true);
});

test("objects: symbol keys ignored, non-enumerable data props skipped, accessors flagged (even hidden)", () => {
  const e = toolReq();
  Object.defineProperty(e, Symbol("s"), { value: 1, enumerable: true });
  assert.equal(validateEvent(e).ok, true);
  const hidden = toolReq();
  Object.defineProperty(hidden, "hiddenData", { value: 1, enumerable: false });
  const r = validateEvent(hidden);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(Object.hasOwn(r.event, "hiddenData"), false);
  const acc = toolReq();
  Object.defineProperty(acc, "hiddenAcc", { get: () => 1, enumerable: false });
  assert.ok(codes(acc).includes("accessor-property"));
  const acc2 = toolReq();
  Object.defineProperty(rec(acc2["payload"]), "toolName", { get: () => "x", enumerable: true });
  assert.ok(codes(acc2).includes("accessor-property"));
  const setter = toolReq();
  Object.defineProperty(setter, "w", { set: () => undefined, enumerable: true });
  assert.ok(codes(setter).includes("accessor-property"));
});

test("object key-count bound: 64 keys pass the pre-check, 65 and 1,000,000 are too-many-keys", () => {
  const many = (n: number): Rec => {
    const o: Rec = {};
    for (let i = 0; i < n; i++) o[`k${i}`] = 0;
    return o;
  };
  assert.ok(!codes(many(64)).includes("too-many-keys"));
  assert.deepEqual(codes(many(65)), ["too-many-keys"]);
  assert.deepEqual(codes(many(1_000_000)), ["too-many-keys"]);
  const e = toolReq();
  e["attributes"] = many(33);
  assert.deepEqual(codes(e), ["too-many-keys"]);
});

test("issue cap: never more than 100 issues, even with hundreds of problems", () => {
  const e = toolReq();
  const junk = (): Rec => {
    const o: Rec = {};
    for (let i = 0; i < 60; i++) o[`u${i}`] = 1;
    return o;
  };
  e["payload"] = { ...junk(), toolName: 1 };
  e["time"] = junk();
  e["actor"] = junk();
  e["provenance"] = junk();
  const is = issues(e);
  assert.ok(is.length <= 100);
  assert.ok(is.length >= 90);
  const arr: unknown[] = Array.from({ length: 64 }, () => 1);
  const r = validateEvents(Array.from({ length: 50 }, () => arr));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.length <= 100);
});

// ---- Proxy ------------------------------------------------------------------

test("Proxy: throwing traps give a single internal issue; revoked proxies do not throw", () => {
  for (const trap of [
    "ownKeys",
    "getOwnPropertyDescriptor",
    "getPrototypeOf",
    "get",
    "has",
  ] as const) {
    const p = new Proxy(toolReq(), {
      [trap]: () => {
        throw new Error("boom \u001b[2J");
      },
    });
    const r = validateEvent(p);
    // `get`/`has` are never used by the validator (descriptor reads only), so they cannot fail it.
    assert.equal(r.ok, trap === "get" || trap === "has", trap);
    if (!r.ok) {
      assert.ok(r.issues.length >= 1);
      assert.ok(r.issues.every((i) => i.code === "internal" || typeof i.code === "string"));
      assert.ok(JSON.stringify(r.issues).indexOf("boom") === -1, "no thrown text in issues");
    }
  }
  const { proxy, revoke } = Proxy.revocable(toolReq(), {});
  revoke();
  assert.deepEqual(validateEvent(proxy), { ok: false, issues: [{ path: "", code: "internal" }] });
  const rp = Proxy.revocable([], {});
  rp.revoke();
  const e = toolReq();
  e["links"] = rp.proxy;
  assert.equal(validateEvent(e).ok, false);
  assert.equal(validateEvents(rp.proxy).ok, false);
});

test("Proxy: each trap is invoked at most once per key, per validation, and nested proxies too", () => {
  const counts = new Map<string, number>();
  const wrap = (o: Rec, label: string): Rec =>
    new Proxy(o, {
      getOwnPropertyDescriptor(t, k) {
        const key = `${label}.${String(k)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      get(t, k, r) {
        const key = `get:${label}.${String(k)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return Reflect.get(t, k, r);
      },
    });
  const e = toolReq();
  e["actor"] = wrap(rec(e["actor"]), "actor");
  e["payload"] = wrap(rec(e["payload"]), "payload");
  const p = wrap(e, "root");
  assert.equal(validateEvent(p).ok, true);
  for (const [k, n] of counts) {
    assert.ok(n <= 1, `${k} called ${n} times`);
  }
  assert.ok([...counts.keys()].some((k) => k.startsWith("actor.")));
});

test("Proxy: a descriptor that flips between calls is read once and the output equals one snapshot", () => {
  let n = 0;
  const base = toolReq();
  const flip = new Proxy(rec(base["payload"]), {
    getOwnPropertyDescriptor(t, k) {
      const d = Reflect.getOwnPropertyDescriptor(t, k);
      if (d === undefined || k !== "toolName") return d;
      n++;
      return { ...d, value: n === 1 ? "first" : "x".repeat(1000) };
    },
  });
  base["payload"] = flip;
  const r = validateEvent(base);
  assert.equal(r.ok, true);
  assert.equal(n, 1);
  if (r.ok) assert.equal(rec(r.event.payload)["toolName"], "first");
});

test("Proxy: lying ownKeys (key without descriptor, descriptor for unlisted key) never throws", () => {
  const base = toolReq();
  const p = new Proxy(rec(base["payload"]), {
    ownKeys: (t) => [...Reflect.ownKeys(t), "ghost"],
    getOwnPropertyDescriptor(t, k) {
      if (k === "ghost") return undefined;
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  });
  base["payload"] = p;
  const r = validateEvent(base);
  assert.equal(typeof r.ok, "boolean");
  const big = new Proxy(
    {},
    { ownKeys: () => Array.from({ length: 1_000_000 }, (_, i) => `k${i}`) },
  );
  const t = toolReq();
  t["payload"] = big;
  assert.equal(validateEvent(t).ok, false);
});

// ---- validateEvents ------------------------------------------------------------

test("validateEvents: container hostility", () => {
  assert.equal(validateEvents(undefined).ok, false);
  assert.equal(validateEvents({}).ok, false);
  assert.equal(validateEvents("x").ok, false);
  assert.equal(validateEvents([]).ok, true);
  const tooMany = validateEvents(new Array(2_000_001));
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok)
    assert.deepEqual(
      tooMany.issues.map((i) => i.code),
      ["too-many-elements"],
    );
  const sparse = validateEvents(new Array(5));
  assert.equal(sparse.ok, false);
  assert.equal(validateEvents(Object.setPrototypeOf([], null)).ok, false);
  const g: unknown[] = [];
  Object.defineProperty(g, "0", { get: () => toolReq(), enumerable: true });
  const gr = validateEvents(g);
  assert.equal(gr.ok, false);
  if (!gr.ok)
    assert.deepEqual(
      gr.issues.map((i) => i.code),
      ["accessor-property"],
    );
  assert.deepEqual(
    validateEvents(
      new Proxy([], {
        ownKeys: () => {
          throw new Error("x");
        },
      }),
    ),
    {
      ok: false,
      issues: [{ path: "", code: "internal" }],
    },
  );
  const one = validateEvents([toolReq()]);
  assert.equal(one.ok, true);
});

test("validateEvents: same event object twice is a duplicate; a link to a later event resolves", () => {
  const a = toolReq();
  const dup = validateEvents([a, a]);
  assert.equal(dup.ok, false);
  if (!dup.ok)
    assert.ok(dup.issues.some((i) => i.code === "duplicate-event-id" && i.path === "/1/eventId"));
  const set = JSON.parse(readFileSync(`${dir}events-with-links.json`, "utf8")) as Rec[];
  assert.equal(validateEvents(set).ok, true);
  // reorder: swapping the 2nd and 3rd events by sequence is out-of-order
  const swapped = [set[0], set[2], set[1]];
  const r = validateEvents(swapped);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.issues.some((i) => i.code === "out-of-order"));
  // equal (sequence, subIndex) is non-decreasing and therefore allowed by ordering (ids differ)
  const same = JSON.parse(JSON.stringify(set)) as Rec[];
  rec(same[1])["sourceSequence"] = rec(same[0])["sourceSequence"];
  const rs = validateEvents(same);
  if (!rs.ok)
    assert.ok(!rs.issues.some((i) => i.code === "out-of-order" && i.path === "/1/sourceSequence"));
  // subIndex ordering: 1 then 0 at the same sequence is out-of-order
  const sub = JSON.parse(JSON.stringify(set)) as Rec[];
  rec(sub[0])["subIndex"] = 1;
  rec(sub[1])["sourceSequence"] = rec(sub[0])["sourceSequence"];
  rec(sub[1])["subIndex"] = 0;
  const rsub = validateEvents(sub);
  assert.equal(rsub.ok, false);
  if (!rsub.ok) assert.ok(rsub.issues.some((i) => i.code === "out-of-order"));
});

// ---- Issue.path ------------------------------------------------------------------

const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

test("Issue.path: RFC 6901 escaping, control escaping, 64 code point segment cut, 512 byte total", () => {
  const e = toolReq();
  e["a/b~c"] = 1;
  const small = issues(e);
  assert.deepEqual(small, [{ path: "/a~1b~0c", code: "unknown-key" }]);
  assert.equal("pathTruncated" in rec(small[0]), false);

  const hostile = toolReq();
  hostile["\u001b]8;;http://x\u0007‮⁦\u009b\u0000\\"] = 1;
  const h = issues(hostile)[0];
  assert.ok(h);
  assert.equal(h.path, "/\\u001B]8;;http:~1~1x\\u0007\\u202E\\u2066\\u009B\\u0000\\\\");
  assert.equal(h.pathTruncated, undefined);

  const long = toolReq();
  long[`${"\u{1F600}".repeat(100)}/${"~".repeat(10_000)}\u001b`] = 1;
  const l = issues(long)[0];
  assert.ok(l);
  assert.equal(l.pathTruncated, true);
  assert.ok(Buffer.byteLength(l.path) <= 512);
  assert.ok(l.path.isWellFormed());
  assert.equal(l.path, `/${"\u{1F600}".repeat(64)}`);

  // Exactly 64 code points is not truncated; 65 is.
  const k64 = toolReq();
  k64["k".repeat(64)] = 1;
  assert.equal(issues(k64)[0]?.pathTruncated, undefined);
  const k65 = toolReq();
  k65["k".repeat(65)] = 1;
  assert.equal(issues(k65)[0]?.pathTruncated, true);
  // Two distinct long keys collapse to the same path but are both flagged (R2/N2).
  const twin = toolReq();
  twin[`${"k".repeat(64)}A`] = 1;
  twin[`${"k".repeat(64)}B`] = 1;
  const t = issues(twin);
  assert.equal(t.length, 2);
  assert.equal(t[0]?.path, t[1]?.path);
  assert.ok(t.every((i) => i.pathTruncated === true));
});

test("Issue.path: total cut never leaves a dangling '~', stays a valid RFC 6901 pointer and <= 512 bytes", () => {
  for (let prefix = 0; prefix <= 6; prefix++) {
    const e = toolReq();
    let v: unknown = () => 1; // a function value yields wrong-type at the innermost path
    const key = "~".repeat(64);
    for (let i = 0; i < 6; i++) v = { [key]: v };
    e[`${"p".repeat(prefix)}x`] = v;
    for (const i of issues(e)) {
      assert.ok(Buffer.byteLength(i.path) <= 512, `${prefix}: ${Buffer.byteLength(i.path)}`);
      assert.ok(i.path.isWellFormed());
      assert.ok(POINTER.test(i.path), `${prefix}: ${i.path.slice(-10)}`);
      assert.ok(!/~$/.test(i.path));
    }
  }
});

test("Issue.path: deep array indices and nested keys appear as pointer segments", () => {
  const e = toolReq();
  e["links"] = [{ rel: "gap-for", target: "bad" }];
  const i = issues(e)[0];
  assert.deepEqual(i, { path: "/links/0/target", code: "wrong-length" });
});

// ---- mutation sweep (independent seed) ------------------------------------------

test("seeded mutation sweep over every valid fixture: never throws, <=100 issues, prototype intact", () => {
  let seed = 0x9e3779b9;
  const rnd = (): number => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x7f4a7c15) >>> 0;
    return seed / 0x100000000;
  };
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
  const junk: unknown[] = [
    null,
    undefined,
    0,
    -1,
    1.5,
    Number.NaN,
    "",
    "x",
    "\ud800",
    [],
    {},
    true,
    10n,
    Symbol.for("z"),
    () => 1,
    "e".repeat(5000),
    { __proto__: 1 },
    Object.create(null),
  ];
  const names = [
    "tool.requested",
    "tool.completed",
    "tool.failed",
    "model.usage",
    "file.changed",
    "capture.gap",
    "source.unknown",
    "permission.decided",
    "message.observed",
    "session.started",
  ];
  for (const n of names) {
    const base = JSON.stringify(load(n));
    for (let i = 0; i < 400; i++) {
      const doc = JSON.parse(base) as Rec;
      const targets: Rec[] = [doc];
      const collect = (o: unknown): void => {
        if (o !== null && typeof o === "object") {
          for (const x of Object.values(o)) {
            if (x !== null && typeof x === "object" && !Array.isArray(x)) targets.push(x as Rec);
            collect(x);
          }
        }
      };
      collect(doc);
      for (let m = 0; m < 1 + Math.floor(rnd() * 3); m++) {
        const t = pick(targets);
        const ks = Object.keys(t);
        const op = Math.floor(rnd() * 4);
        if (op === 0 && ks.length > 0) t[pick(ks)] = pick(junk);
        else if (op === 1 && ks.length > 0) delete t[pick(ks)];
        else if (op === 2)
          t[pick(["extra", "__proto__", "constructor", "toString", "x/y"])] = pick(junk);
        else
          t[pick(ks.length > 0 ? ks : ["k"])] = JSON.parse(
            JSON.stringify(pick([1, "a", [1], { a: 1 }])),
          );
      }
      const r = validateEvent(doc);
      if (!r.ok) {
        assert.ok(r.issues.length >= 1 && r.issues.length <= 100);
        for (const is of r.issues) {
          assert.ok(Buffer.byteLength(is.path) <= 512);
          assert.ok(
            ![...is.path].some(
              (c) =>
                (c.codePointAt(0) ?? 0) <= 0x1f ||
                ((c.codePointAt(0) ?? 0) >= 0x7f && (c.codePointAt(0) ?? 0) <= 0x9f),
            ),
            "raw control char in issue path",
          );
        }
      }
    }
  }
  assert.equal(({} as Rec)["extra"], undefined);
});
