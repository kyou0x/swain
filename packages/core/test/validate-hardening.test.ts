import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { validateEvent } from "../src/validate/index.js";

const root = new URL("../../../../fixtures/canonical/valid/", import.meta.url);
const validFixtures: Record<string, unknown>[] = readdirSync(root)
  .filter((n) => n.endsWith(".json") && n !== "events-with-links.json")
  .sort()
  .map((n) => JSON.parse(readFileSync(new URL(n, root), "utf8")) as Record<string, unknown>);

function valid(): Record<string, unknown> {
  const e = validFixtures.find((x) => x["kind"] === "tool.requested");
  assert.ok(e);
  return structuredClone(e);
}

function codesOf(v: unknown): string[] {
  const r = validateEvent(v);
  return r.ok ? [] : r.issues.map((i) => i.code);
}

function collectObjects(v: unknown, out: Set<object>): void {
  if (v !== null && typeof v === "object") {
    out.add(v);
    for (const c of Object.values(v)) collectObjects(c, out);
  }
}

test("returned event is a deep copy sharing no references with the input", () => {
  for (const input of validFixtures) {
    const r = validateEvent(input);
    assert.ok(r.ok);
    if (!r.ok) continue;
    assert.notEqual(r.event as unknown, input);
    assert.deepStrictEqual(r.event, input);
    const a = new Set<object>();
    const b = new Set<object>();
    collectObjects(input, a);
    collectObjects(r.event, b);
    for (const o of b) assert.equal(a.has(o), false);
  }
});

test("validator does not mutate its input", () => {
  const e = valid();
  const before = JSON.stringify(e);
  validateEvent(e);
  assert.equal(JSON.stringify(e), before);
});

test("proxy with throwing traps returns internal", () => {
  const boom = () => {
    throw new Error("trap");
  };
  const p = new Proxy(
    {},
    { ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom, get: boom },
  );
  const r = validateEvent(p);
  assert.deepEqual(r, { ok: false, issues: [{ path: "", code: "internal" }] });
  const p2 = new Proxy(valid(), { getOwnPropertyDescriptor: boom });
  assert.deepEqual(codesOf(p2), ["internal"]);
});

test("proxy returning different descriptors per call: one trap call per key, single snapshot", () => {
  const target = valid();
  const calls = new Map<string, number>();
  const p = new Proxy(target, {
    getOwnPropertyDescriptor(t, k) {
      const key = String(k);
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      const real = Object.getOwnPropertyDescriptor(t, k);
      if (real === undefined) return undefined;
      // first read is the truth; any later read would be garbage
      return n === 1 ? real : { ...real, value: 12345 };
    },
  });
  const r = validateEvent(p);
  for (const n of calls.values()) assert.ok(n <= 1);
  assert.ok(r.ok);
  if (r.ok) assert.deepStrictEqual(r.event, target);

  let flip = 0;
  const q = new Proxy(valid(), {
    getOwnPropertyDescriptor(t, k) {
      const real = Object.getOwnPropertyDescriptor(t, k);
      if (real === undefined) return undefined;
      flip++;
      return { ...real, value: flip % 2 === 0 ? 1 : "x" };
    },
  });
  assert.doesNotThrow(() => validateEvent(q));
  assert.equal(validateEvent(q).ok, false);
});

test("getter is rejected as accessor-property", () => {
  const e = valid();
  Object.defineProperty(e, "kind", { get: () => "tool.requested", enumerable: true });
  assert.deepEqual(codesOf(e), ["accessor-property"]);
  const nested = valid();
  Object.defineProperty(nested["payload"], "toolName", { get: () => "x", enumerable: true });
  assert.deepEqual(codesOf(nested), ["accessor-property"]);
});

test("self-cycle yields depth-exceeded", () => {
  const e = valid();
  e["payload"] = e;
  assert.ok(codesOf(e).includes("depth-exceeded"));
  const c: Record<string, unknown> = {};
  c["self"] = c;
  assert.deepEqual(codesOf(c), ["depth-exceeded"]);
});

test("1,000,000-key object is rejected before iterating keys", () => {
  const big: Record<string, number> = {};
  for (let i = 0; i < 1_000_000; i++) big[`k${i}`] = i;
  assert.deepEqual(codesOf(big), ["too-many-keys"]);
  const e = valid();
  e["attributes"] = big;
  assert.deepEqual(codesOf(e), ["too-many-keys"]);
});

test("non-plain data is rejected", () => {
  class C {
    kind = "tool.requested";
  }
  assert.deepEqual(codesOf(Object.create(Array.prototype)), ["not-plain-data"]);
  assert.deepEqual(codesOf(new C()), ["not-plain-data"]);
  assert.deepEqual(codesOf(new String("x")), ["not-plain-data"]);
  assert.deepEqual(codesOf(new Date(0)), ["not-plain-data"]);
  const e = valid();
  e["links"] = Object.create(Array.prototype);
  assert.deepEqual(codesOf(e), ["not-plain-data"]);
  assert.deepEqual(codesOf(Object.assign(Object.create(null), valid())), []);
  assert.deepEqual(codesOf([]), ["wrong-type"]);
  assert.deepEqual(codesOf(null), ["wrong-type"]);
  assert.deepEqual(codesOf(undefined), ["wrong-type"]);
});

test("symbol keys are ignored; primitives must be typeof-exact", () => {
  const e = valid();
  (e as Record<symbol, unknown>)[Symbol("x")] = 1;
  assert.deepEqual(codesOf(e), []);
  const f = valid();
  f["sourceSequence"] = new Number(1);
  assert.deepEqual(codesOf(f), ["not-plain-data"]);
  const g = valid();
  g["sourceSequence"] = 1n;
  assert.deepEqual(codesOf(g), ["wrong-type"]);
});

test("long hostile unknown key: bounded, escaped, flagged path", () => {
  const e = valid();
  const key = `/~\u001b${"x".repeat(9990)}`;
  e[key] = 1;
  const r = validateEvent(e);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.equal(r.issues.length, 1);
  const issue = r.issues[0];
  assert.ok(issue);
  assert.equal(issue.code, "unknown-key");
  assert.equal(issue.pathTruncated, true);
  assert.ok(new TextEncoder().encode(issue.path).length <= 512);
  assert.ok(issue.path.startsWith("/~1~0\\u001B"));
  assert.ok(!issue.path.includes("\u001b"));
  // distinct long keys collapsing to the same truncated path are both flagged
  const f = valid();
  f[`${"y".repeat(100)}A`] = 1;
  f[`${"y".repeat(100)}B`] = 1;
  const r2 = validateEvent(f);
  assert.ok(!r2.ok);
  if (!r2.ok) for (const i of r2.issues) assert.equal(i.pathTruncated, true);
});

test("short paths are not flagged", () => {
  const e = valid();
  e["bogus"] = 1;
  assert.deepEqual(validateEvent(e), {
    ok: false,
    issues: [{ path: "/bogus", code: "unknown-key" }],
  });
});

test("at most 100 issues", () => {
  const e = valid();
  const attrs: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) attrs[`bad${i}`] = [];
  e["attributes"] = attrs;
  for (let i = 0; i < 60; i++) e[`extra${i}`] = 1;
  const r = validateEvent(e);
  assert.ok(!r.ok);
  if (!r.ok) assert.ok(r.issues.length <= 100);
});

// ---- seeded mutation fuzz (C7, C12)
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickPaths(v: unknown, path: (string | number)[], out: (string | number)[][]): void {
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const p = [...path, k];
      out.push(p);
      pickPaths((v as Record<string, unknown>)[k], p, out);
    }
  }
}

function at(root: unknown, path: (string | number)[]): Record<string, unknown> | undefined {
  let cur: unknown = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>) : undefined;
}

test("seeded mutation fuzz: 10,000 variants never throw, <=100 issues, no pollution", () => {
  const rnd = mulberry32(0xa7e5);
  const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(",");
  let okCount = 0;
  let deepCount = 0;
  let bigCount = 0;
  const swaps: unknown[] = [
    null,
    undefined,
    1,
    -1,
    1.5,
    "",
    "x",
    true,
    [],
    {},
    2 ** 60,
    Number.NaN,
  ];
  for (let n = 0; n < 10_000; n++) {
    const e = structuredClone(validFixtures[Math.floor(rnd() * validFixtures.length)]);
    const paths: (string | number)[][] = [];
    pickPaths(e, [], paths);
    const mutations = 1 + Math.floor(rnd() * 3);
    for (let m = 0; m < mutations; m++) {
      const p = paths[Math.floor(rnd() * paths.length)];
      if (p === undefined || p.length === 0) continue;
      const parent = at(e, p.slice(0, -1));
      if (parent === undefined) continue;
      const key = p[p.length - 1] as string;
      const op = Math.floor(rnd() * 8);
      if (op === 0) parent[key] = swaps[Math.floor(rnd() * swaps.length)];
      else if (op === 1) delete parent[key];
      else if (op === 2) parent[`added${Math.floor(rnd() * 5)}`] = 1;
      else if (op === 3) {
        Object.defineProperty(parent, rnd() < 0.5 ? "__proto__" : "constructor", {
          value: { polluted: true },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else if (op === 4 && n % 997 === 0) {
        let deep: unknown = {};
        for (let i = 0; i < 10_000; i++) deep = { a: deep };
        parent[key] = deep;
        deepCount++;
      } else if (op === 5 && n % 1499 === 0) {
        parent[key] = "z".repeat(10 * 1024 * 1024);
        bigCount++;
      } else if (op === 6) parent[key] = `${String(parent[key]).slice(0, 1)}\ud800`;
      else parent[key] = typeof parent[key] === "string" ? `${parent[key]}x` : parent[key];
    }
    let r: ReturnType<typeof validateEvent> | undefined;
    assert.doesNotThrow(() => {
      r = validateEvent(e);
    });
    assert.ok(r);
    if (r?.ok) okCount++;
    else if (r) assert.ok(r.issues.length <= 100);
  }
  assert.ok(deepCount > 0 && bigCount > 0);
  assert.ok(okCount > 0);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).sort().join(","), protoKeysBefore);
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
});
