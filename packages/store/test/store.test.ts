import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "@swain/core";
import { openStore, StoreError } from "../src/index.js";
import { DEPS, loadFixture, metaFor, tempRoot } from "./helpers.js";

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof StoreError && e.code === code);
}

test("put, list, load round-trip; modes 0700/0600; masked display path", () => {
  const t = tempRoot();
  try {
    const root = join(t.dir, "store");
    const { record, result } = loadFixture("claude-code");
    const store = openStore(root, DEPS);
    assert.deepEqual(store.list(), []);
    const r = store.put(result, metaFor(record));
    assert.equal(r.status, "added");
    assert.match(r.record.importId, /^imp_[0-9a-f]{32}$/);
    assert.equal(r.record.source.displayPath, "~/sessions/a.jsonl");
    assert.equal(r.record.importedAt, "2023-11-14T22:13:20.000Z");
    assert.equal(r.record.counts.events, result.events.length);
    assert.equal(store.list().length, 1);
    const loaded = store.load(r.record.importId);
    assert.equal(canonicalJson(loaded), canonicalJson(result));
    assert.equal(statSync(root).mode & 0o777, 0o700);
    const dir = join(root, "imports", r.record.importId.slice(4));
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const f of ["import.json", "events.jsonl", "result.json"]) {
      assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
    }
    assert.equal(statSync(join(root, "index.json")).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root).sort(), ["STORE.json", "imports", "index.json"]);
    // events.jsonl is one canonicalJson event per line.
    const lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n");
    assert.equal(lines.length, result.events.length + 1);
    assert.equal(lines[0], canonicalJson(result.events[0]));
  } finally {
    t.done();
  }
});

test("dedupe by (adapter, source sha256), version skip and --reimport", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("codex-cli");
    const store = openStore(join(t.dir, "s"), DEPS);
    const first = store.put(result, metaFor(record));
    assert.equal(first.status, "added");
    assert.equal(store.put(result, metaFor(record)).status, "unchanged");
    const newer = metaFor(record, { adapter: { ...record.adapter, version: "9.9.9" } });
    const skipped = store.put(result, newer);
    assert.equal(skipped.status, "skipped-version");
    assert.equal(skipped.record.adapter.version, record.adapter.version);
    const replaced = store.put(result, { ...newer, reimport: true });
    assert.equal(replaced.status, "replaced");
    assert.equal(replaced.record.adapter.version, "9.9.9");
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0]?.adapter.version, "9.9.9");
    // No leftovers after a replace.
    assert.deepEqual(readdirSync(join(t.dir, "s", "imports")), [first.record.importId.slice(4)]);
    // The same bytes with a different adapter id is a different import.
    const other = metaFor(record, { adapter: { ...record.adapter, id: "codex-cli.other" } });
    assert.equal(store.put(result, other).status, "added");
    const ids = store.list().map((r) => r.importId);
    assert.deepEqual(ids, [...ids].sort());
  } finally {
    t.done();
  }
});

test("resolve: unique prefix, session id, ambiguity, not-found", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("gemini-cli");
    const store = openStore(join(t.dir, "s"), DEPS);
    const a = store.put(result, metaFor(record)).record;
    const found = store.resolve(a.importId.slice(0, 10));
    assert.equal(found.ok && found.record.importId, a.importId);
    assert.deepEqual(store.resolve("imp_abc"), {
      ok: false,
      reason: "not-found",
      candidates: [],
    });
    assert.equal(store.resolve("nonsense").ok, false);
    const bySession = store.resolve(a.sessionId);
    assert.equal(bySession.ok, true);
    const b = store.put(result, metaFor(record, { adapter: { ...record.adapter, id: "x.y" } }));
    const amb = store.resolve(a.sessionId);
    assert.equal(amb.ok, false);
    assert.equal(!amb.ok && amb.reason, "ambiguous");
    assert.equal(!amb.ok && amb.candidates.length, 2);
    assert.ok(b.record.importId);
  } finally {
    t.done();
  }
});

test("a held lock yields locked and is not removed; the lock is removed after success", () => {
  const t = tempRoot();
  try {
    const root = join(t.dir, "s");
    const { record, result } = loadFixture("opencode");
    const store = openStore(root, DEPS);
    store.put(result, metaFor(record));
    assert.equal(readdirSync(root).includes("store.lock"), false);
    writeFileSync(join(root, "store.lock"), "");
    throwsCode(() => store.put(result, metaFor(record, { reimport: true })), "locked");
    assert.equal(readdirSync(root).includes("store.lock"), true);
  } finally {
    t.done();
  }
});

test("a symlinked store root is an error", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("claude-code");
    const real = join(t.dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(t.dir, "link"));
    throwsCode(() => openStore(join(t.dir, "link"), DEPS).put(result, metaFor(record)), "symlink");
    throwsCode(() => openStore(join(t.dir, "link"), DEPS).list(), "symlink");
    assert.deepEqual(readdirSync(real), []);
  } finally {
    t.done();
  }
});

test("a planted symlink at imports/<hex>, index.json or events.jsonl is refused", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("claude-code");
    const root = join(t.dir, "s");
    const store = openStore(root, DEPS);
    const id = store.put(result, metaFor(record)).record.importId;
    const hex = id.slice(4);
    const victim = join(t.dir, "victim");
    mkdirSync(victim);
    writeFileSync(join(victim, "x"), "untouched");

    const ev = join(root, "imports", hex, "events.jsonl");
    unlinkSync(ev);
    symlinkSync(join(victim, "x"), ev);
    throwsCode(() => store.load(id), "symlink");
    unlinkSync(ev);

    const dir = join(root, "imports", hex);
    renameSync(dir, join(t.dir, "moved"));
    symlinkSync(victim, dir);
    throwsCode(() => store.load(id), "symlink");
    unlinkSync(dir);
    renameSync(join(t.dir, "moved"), dir);

    const idx = join(root, "index.json");
    renameSync(idx, join(t.dir, "idx.bak"));
    symlinkSync(join(victim, "x"), idx);
    throwsCode(() => store.list(), "symlink");
    throwsCode(() => store.put(result, metaFor(record, { reimport: true })), "symlink");
    assert.equal(readFileSync(join(victim, "x"), "utf8"), "untouched");
  } finally {
    t.done();
  }
});

test("load re-validates: tampered events and corrupt index are rejected", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("codex-cli");
    const root = join(t.dir, "s");
    const store = openStore(root, DEPS);
    const id = store.put(result, metaFor(record)).record.importId;
    const ev = join(root, "imports", id.slice(4), "events.jsonl");
    const good = readFileSync(ev, "utf8");
    writeFileSync(ev, good.replace('"kind":"session.started"', '"kind":"bogus.kind"'));
    throwsCode(() => store.load(id), "corrupt");
    writeFileSync(ev, "not json\n");
    throwsCode(() => store.load(id), "corrupt");
    writeFileSync(ev, good.split("\n").slice(1).join("\n"));
    throwsCode(() => store.load(id), "corrupt");
    writeFileSync(ev, good);
    assert.equal(canonicalJson(store.load(id)), canonicalJson(result));
    throwsCode(() => store.load("imp_../../x"), "corrupt");
    writeFileSync(
      join(root, "index.json"),
      '{"format":"atm.index/1","imports":[{"importId":"x"}]}',
    );
    throwsCode(() => store.list(), "corrupt");
    writeFileSync(join(root, "index.json"), "{");
    throwsCode(() => store.list(), "corrupt");
  } finally {
    t.done();
  }
});

test("a non-empty directory without STORE.json is never adopted", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("claude-code");
    const root = join(t.dir, "s");
    mkdirSync(root);
    writeFileSync(join(root, "precious.txt"), "keep");
    throwsCode(() => openStore(root, DEPS).put(result, metaFor(record)), "corrupt");
    throwsCode(() => openStore(root, DEPS).list(), "corrupt");
    assert.deepEqual(readdirSync(root), ["precious.txt"]);
    // A missing parent is invalid-root, not a recursive mkdir.
    throwsCode(
      () => openStore(join(t.dir, "no", "such"), DEPS).put(result, metaFor(record)),
      "invalid-root",
    );
    throwsCode(() => openStore("", DEPS), "invalid-root");
  } finally {
    t.done();
  }
});

test("crash leftovers (.tmp-/.old-) are removed under the lock, unknown content is kept", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("opencode");
    const root = join(t.dir, "s");
    const store = openStore(root, DEPS);
    store.put(result, metaFor(record));
    const hex = "0123456789abcdef0123456789abcdef";
    const tmp = join(root, "imports", `.tmp-${hex}`);
    mkdirSync(tmp);
    writeFileSync(join(tmp, "events.jsonl"), "partial");
    const odd = join(root, "imports", `.old-${hex}`);
    mkdirSync(odd);
    writeFileSync(join(odd, "surprise.txt"), "x");
    store.put(result, metaFor(record));
    assert.equal(readdirSync(join(root, "imports")).includes(`.tmp-${hex}`), false);
    assert.equal(readdirSync(odd).join(), "surprise.txt");
  } finally {
    t.done();
  }
});

test("put rejects invalid results at the boundary", () => {
  const t = tempRoot();
  try {
    const { record, result } = loadFixture("claude-code");
    const store = openStore(join(t.dir, "s"), DEPS);
    throwsCode(() => store.put({ ...result, events: [] }, metaFor(record)), "invalid-result");
    const bad = JSON.parse(JSON.stringify(result)) as typeof result;
    (bad.events[1] as { kind: string }).kind = "nope";
    throwsCode(() => store.put(bad, metaFor(record)), "invalid-result");
    assert.deepEqual(store.list(), []);
  } finally {
    t.done();
  }
});
