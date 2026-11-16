import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DbError, SqliteSwainStore } from "../src/index.js";
import { openDatabase } from "../src/sqlite/open.js";
import { counterRandom, NOW, NOW_ISO, tempDir, uid } from "./helpers.js";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DbError, String(e));
    return e.code;
  }
  return "no-error";
}

const open = (path: string): SqliteSwainStore =>
  SqliteSwainStore.open(path, {
    randomBytes: counterRandom(),
    sessionMode: "team",
    uid,
    nowMs: () => NOW,
  });

test("a symlinked DB directory is refused (db-symlink)", () => {
  const t = tempDir();
  try {
    const real = join(t.dir, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(t.dir, "link");
    symlinkSync(real, link);
    assert.equal(
      code(() => open(join(link, "swain.sqlite"))),
      "db-symlink",
    );
    assert.deepEqual(readdirSync(real), []);
  } finally {
    t.done();
  }
});

test("a symlinked DB file is refused, existing target or dangling (db-symlink)", () => {
  const t = tempDir();
  try {
    const target = join(t.dir, "target.sqlite");
    closeSync(openSync(target, "w", 0o600));
    symlinkSync(target, join(t.dir, "a.sqlite"));
    assert.equal(
      code(() => open(join(t.dir, "a.sqlite"))),
      "db-symlink",
    );
    symlinkSync(join(t.dir, "nowhere"), join(t.dir, "b.sqlite"));
    assert.equal(
      code(() => open(join(t.dir, "b.sqlite"))),
      "db-symlink",
    );
    assert.equal(statSync(target).size, 0, "the target was not written through the link");
  } finally {
    t.done();
  }
});

test("a symlinked WAL sidecar is refused", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    open(path).close();
    symlinkSync(join(t.dir, "elsewhere"), `${path}-wal`);
    assert.equal(
      code(() => open(path)),
      "db-symlink",
    );
  } finally {
    t.done();
  }
});

test("a new DB file is created 0600 and its WAL sidecars are 0600 after writes", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    const s = open(path);
    assert.equal(s.created, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    s.migrate({ nowIso: () => NOW_ISO });
    s.ensureLocalTenancy(NOW_ISO);
    for (const suffix of ["-wal", "-shm"]) {
      assert.equal(statSync(`${path}${suffix}`).mode & 0o777, 0o600, suffix);
    }
    s.close();
    assert.equal(open(path).created, false);
  } finally {
    t.done();
  }
});

test("an existing DB with wider permissions is refused before any PRAGMA runs (db-permissions)", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    closeSync(openSync(path, "w", 0o644));
    chmodSync(path, 0o644);
    assert.equal(
      code(() => open(path)),
      "db-permissions",
    );
    // no PRAGMA ran: no WAL switch, nothing written
    assert.deepEqual(readdirSync(t.dir), ["a.sqlite"]);
    assert.equal(readFileSync(path).length, 0);
    chmodSync(path, 0o640);
    assert.equal(
      code(() => open(path)),
      "db-permissions",
    );
  } finally {
    t.done();
  }
});

test("the parent directory must be private: group/world writable and foreign owner are refused", () => {
  const t = tempDir();
  try {
    const dir = join(t.dir, "d");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o770);
    assert.equal(
      code(() => open(join(dir, "a.sqlite"))),
      "db-permissions",
    );
    chmodSync(dir, 0o707);
    assert.equal(
      code(() => open(join(dir, "a.sqlite"))),
      "db-permissions",
    );
    chmodSync(dir, 0o700);
    open(join(dir, "a.sqlite")).close();
    if (uid !== null) {
      const foreign = uid + 1;
      assert.equal(
        code(() =>
          SqliteSwainStore.open(join(dir, "a.sqlite"), {
            randomBytes: counterRandom(),
            sessionMode: "team",
            uid: foreign,
            nowMs: () => NOW,
          }),
        ),
        "db-permissions",
      );
    }
    // a missing directory is created 0700
    const fresh = join(t.dir, "fresh");
    open(join(fresh, "a.sqlite")).close();
    assert.equal(statSync(fresh).mode & 0o777, 0o700);
  } finally {
    t.done();
  }
});

test("non-file targets and bad paths are refused", () => {
  const t = tempDir();
  try {
    mkdirSync(join(t.dir, "adir"), { mode: 0o700 });
    assert.equal(
      code(() => open(join(t.dir, "adir"))),
      "db-io",
    );
    assert.equal(
      code(() => open("")),
      "db-io",
    );
    assert.equal(
      code(() => open(join(t.dir, "a\0b"))),
      "db-io",
    );
    // an empty 0600 file is simply a new database
    const empty = join(t.dir, "empty.sqlite");
    closeSync(openSync(empty, "w", 0o600));
    chmodSync(empty, 0o600);
    assert.equal(
      code(() => open(empty)),
      "no-error",
    );
  } finally {
    t.done();
  }
});

test("pragmas: WAL, foreign keys, busy timeout, trusted_schema off, defensive on", () => {
  const t = tempDir();
  try {
    const { db } = openDatabase(join(t.dir, "a.sqlite"), { uid });
    const one = (sql: string): unknown => Object.values(db.prepare(sql).get() ?? {})[0];
    assert.equal(one("PRAGMA journal_mode"), "wal");
    assert.equal(one("PRAGMA foreign_keys"), 1);
    assert.equal(one("PRAGMA busy_timeout"), 5000);
    assert.equal(one("PRAGMA trusted_schema"), 0);
    db.exec("CREATE TABLE t (a INTEGER) STRICT");
    // defensive mode: the schema table cannot be edited even with writable_schema
    db.exec("PRAGMA writable_schema=ON");
    assert.throws(() => db.exec("UPDATE sqlite_schema SET name = 'x' WHERE name = 't'"));
    db.close();
  } finally {
    t.done();
  }
});

test("allowExtension can never be enabled: loadExtension and enableLoadExtension throw", () => {
  const t = tempDir();
  try {
    const { db } = openDatabase(join(t.dir, "a.sqlite"), { uid });
    for (const fn of [
      () => db.loadExtension("/nonexistent/ext.so"),
      () => db.enableLoadExtension(true),
    ]) {
      assert.throws(fn, (e: unknown) => (e as { code?: string }).code === "ERR_INVALID_STATE");
    }
    // SQL-level loading is off too
    assert.throws(() => db.exec("SELECT load_extension('/nonexistent/ext.so')"));
    db.close();
  } finally {
    t.done();
  }
});

test("source guard: no code path sets allowExtension true or touches extension APIs", () => {
  const dir = new URL("../../src/sqlite/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const text = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/allowExtension:\s*true/.test(text), f);
    assert.ok(!/loadExtension|enableLoadExtension/.test(text), f);
    if (f !== "open.ts")
      assert.ok(
        !/new DatabaseSync|from "node:sqlite"/.test(text.replace(/import type[^\n]*\n/g, "")),
        f,
      );
  }
});
