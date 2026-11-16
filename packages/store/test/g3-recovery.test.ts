import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "@swain/core";
import { openStore, realHomeOf } from "../src/index.js";
import { DEPS, loadFixture, metaFor, tempRoot } from "./helpers.js";

// G3 crash recovery: states are built by hand, as a crash between two steps would leave them.
function crashSetup() {
  const t = tempRoot();
  const root = join(t.dir, "store");
  const { record, result } = loadFixture("claude-code");
  const store = openStore(root, DEPS);
  const put = store.put(result, metaFor(record));
  const hex = put.record.importId.slice(4);
  const imports = join(root, "imports");
  return { t, root, result, record, put, hex, imports, dir: join(imports, hex) };
}

function copyDir(from: string, to: string, skip: readonly string[] = []): void {
  mkdirSync(to, { mode: 0o700 });
  for (const n of readdirSync(from)) {
    if (!skip.includes(n)) writeFileSync(join(to, n), readFileSync(join(from, n)));
  }
}

test("cleanup restores .old-<hex> when <hex> is missing (replace crashed between renames)", () => {
  const c = crashSetup();
  try {
    renameSync(c.dir, join(c.imports, `.old-${c.hex}`));
    const again = openStore(c.root, DEPS);
    again.init();
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
    assert.equal(canonicalJson(again.load(c.put.record.importId)), canonicalJson(c.result));
  } finally {
    c.t.done();
  }
});

test("cleanup prefers the old import over a complete .tmp-<hex> when both exist", () => {
  const c = crashSetup();
  try {
    copyDir(c.dir, join(c.imports, `.tmp-${c.hex}`));
    renameSync(c.dir, join(c.imports, `.old-${c.hex}`));
    openStore(c.root, DEPS).init();
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
    assert.equal(readdirSync(c.dir).length, 3);
  } finally {
    c.t.done();
  }
});

test("cleanup rolls a complete .tmp-<hex> forward and deletes an incomplete one", () => {
  const c = crashSetup();
  try {
    renameSync(c.dir, join(c.imports, `.tmp-${c.hex}`));
    openStore(c.root, DEPS).init();
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
    assert.deepEqual(readdirSync(c.dir).sort(), ["events.jsonl", "import.json", "result.json"]);
    // Incomplete: result.json (written last) is missing.
    const hex2 = "b".repeat(32);
    copyDir(c.dir, join(c.imports, `.tmp-${hex2}`), ["result.json"]);
    openStore(c.root, DEPS).init();
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
  } finally {
    c.t.done();
  }
});

test("cleanup deletes leftovers when <hex> exists", () => {
  const c = crashSetup();
  try {
    copyDir(c.dir, join(c.imports, `.old-${c.hex}`));
    copyDir(c.dir, join(c.imports, `.tmp-${c.hex}`));
    openStore(c.root, DEPS).init();
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
  } finally {
    c.t.done();
  }
});

test("put treats an existing <hex> directory without an index entry as a replace", () => {
  const c = crashSetup();
  try {
    writeFileSync(
      join(c.root, "index.json"),
      `${canonicalJson({ format: "atm.index/1", imports: [] })}\n`,
    );
    const store = openStore(c.root, DEPS);
    assert.deepEqual(store.list(), []);
    const r = store.put(c.result, metaFor(c.record));
    assert.equal(r.status, "added");
    assert.equal(store.list().length, 1);
    assert.equal(canonicalJson(store.load(r.record.importId)), canonicalJson(c.result));
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
  } finally {
    c.t.done();
  }
});

test("put on replace with a missing <hex> directory is a plain add", () => {
  const c = crashSetup();
  try {
    for (const n of readdirSync(c.dir)) unlinkSync(join(c.dir, n));
    rmdirSync(c.dir);
    const store = openStore(c.root, DEPS);
    const r = store.put(c.result, metaFor(c.record, { reimport: true }));
    assert.equal(r.status, "replaced");
    assert.equal(canonicalJson(store.load(r.record.importId)), canonicalJson(c.result));
    assert.deepEqual(readdirSync(c.imports), [c.hex]);
  } finally {
    c.t.done();
  }
});

test("realHomeOf resolves a symlinked HOME and ignores plain or missing ones", () => {
  const t = tempRoot();
  try {
    const real = join(t.dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(t.dir, "link"));
    assert.equal(realHomeOf(join(t.dir, "link")), realpathSync(real));
    assert.equal(realHomeOf(realpathSync(real)), null);
    assert.equal(realHomeOf(join(t.dir, "missing")), null);
    assert.equal(realHomeOf(null), null);
  } finally {
    t.done();
  }
});

test("stored display path is masked against the realpath of a symlinked HOME", () => {
  const t = tempRoot();
  try {
    const real = join(t.dir, "real");
    mkdirSync(real);
    symlinkSync(real, join(t.dir, "link"));
    const { record, result } = loadFixture("claude-code");
    const store = openStore(join(t.dir, "store"), { ...DEPS, homeDir: join(t.dir, "link") });
    const sourcePath = join(realpathSync(real), "s", "a.jsonl");
    const r = store.put(result, metaFor(record, { sourcePath }));
    assert.equal(r.record.source.displayPath, "~/s/a.jsonl");
  } finally {
    t.done();
  }
});
