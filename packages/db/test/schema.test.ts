import assert from "node:assert/strict";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DbError, MIGRATIONS, type Migration, SqliteSwainStore } from "../src/index.js";
import { confinedCopy } from "../src/sqlite/open.js";
import { counterRandom, NOW, NOW_ISO, tempDir, uid } from "./helpers.js";

const EXTRA: Migration = {
  version: 2,
  name: "extra",
  sql: "CREATE TABLE extra (a INTEGER NOT NULL) STRICT;",
};

function open(path: string, migrations?: readonly Migration[]): SqliteSwainStore {
  return SqliteSwainStore.open(path, {
    randomBytes: counterRandom(),
    sessionMode: "team",
    uid,
    nowMs: () => NOW,
    ...(migrations === undefined ? {} : { migrations }),
  });
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof DbError, String(e));
    return e.code;
  }
  return "no-error";
}

function migrated(path: string): void {
  const s = open(path);
  s.migrate({ nowIso: () => NOW_ISO });
  s.close();
}

function sql(path: string, text: string): void {
  const raw = new DatabaseSync(path);
  raw.exec(text);
  raw.close();
}

test("schema integrity: an unexpected table, a missing table or index, a trigger or a view refuses open", () => {
  const cases: [string, string][] = [
    ["extra table", "CREATE TABLE evil (a TEXT)"],
    ["extra index", "CREATE INDEX evil_idx ON orgs (name)"],
    ["trigger", "CREATE TRIGGER evil AFTER INSERT ON orgs BEGIN SELECT 1; END"],
    ["view", "CREATE VIEW evil AS SELECT * FROM orgs"],
    ["missing index", "DROP INDEX runs_agent_recent"],
    ["missing table", "DROP TABLE usage"],
  ];
  for (const [label, stmt] of cases) {
    const t = tempDir();
    try {
      const path = join(t.dir, "a.sqlite");
      migrated(path);
      sql(path, stmt);
      assert.equal(
        code(() => open(path)),
        "db-corrupt",
        label,
      );
    } finally {
      t.done();
    }
  }
});

test("schema integrity: a changed DDL text (a CHECK, a default) refuses open; ANALYZE output is tolerated", () => {
  const tampered = (what: string, from: string, to: string): void => {
    const t = tempDir();
    try {
      const path = join(t.dir, "a.sqlite");
      const first = MIGRATIONS[0];
      assert.ok(first?.sql.includes(from), what);
      if (first === undefined) throw new Error(what);
      // a database built from altered DDL, opened by the real binary
      const s = open(path, [{ ...first, sql: first.sql.replace(from, to) }]);
      s.migrate({ nowIso: () => NOW_ISO });
      s.close();
      assert.equal(
        code(() => open(path)),
        "db-corrupt",
        what,
      );
    } finally {
      t.done();
    }
  };
  tampered("widened CHECK", "('hash-only','full')", "('hash-only','full','leak')");
  tampered("changed default", "DEFAULT 'hash-only'", "DEFAULT 'full'");
  const t = tempDir();
  try {
    const path = join(t.dir, "b.sqlite");
    migrated(path);
    sql(path, "ANALYZE");
    const s = open(path);
    s.close();
  } finally {
    t.done();
  }
});

test("schema integrity: a clean migrated DB opens; an older binary sees a newer DB only at migrate (db-too-new)", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    migrated(path);
    const s = open(path);
    s.migrate({ nowIso: () => NOW_ISO });
    s.close();
    // a v2 migration is expected to add `extra`: opening with the v1 list is db-too-new territory,
    // opening with the v2 list before migrating is fine, and after migrating `extra` is expected
    const v2 = open(path, [...MIGRATIONS, EXTRA]);
    v2.migrate({ nowIso: () => NOW_ISO });
    v2.close();
    assert.doesNotThrow(() => open(path, [...MIGRATIONS, EXTRA]).close());
    assert.equal(
      code(() => open(path)),
      "no-error",
      "an older binary sees a newer DB only at migrate",
    );
    const older = open(path);
    assert.equal(
      code(() => older.migrate({ nowIso: () => NOW_ISO })),
      "db-too-new",
    );
    older.close();
  } finally {
    t.done();
  }
});

test("a DB that is not ours (foreign tables, no schema_migrations) is refused", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "foreign.sqlite");
    sql(path, "CREATE TABLE notes (a TEXT)");
    chmodSync(path, 0o600);
    assert.equal(
      code(() => open(path)),
      "db-corrupt",
    );
  } finally {
    t.done();
  }
});

test("backup: the temp file is gone, only the final 0600 backup remains, and the DB dir has no stray files", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    migrated(path);
    const v2 = open(path, [...MIGRATIONS, EXTRA]);
    const report = v2.migrate({ nowIso: () => NOW_ISO });
    v2.close();
    assert.equal(report.backupPath, `${path}.pre-v0002.sqlite`);
    const names = readdirSync(t.dir).sort();
    assert.equal(
      names.some((n) => n.endsWith(".tmp")),
      false,
      names.join(),
    );
    assert.equal(statSync(report.backupPath as string).mode & 0o777, 0o600);
    assert.equal(statSync(report.backupPath as string).uid, uid);
  } finally {
    t.done();
  }
});

test("confinedCopy: never overwrites, refuses a foreign-owned source, and writes 0600", () => {
  const t = tempDir();
  try {
    const src = join(t.dir, "src");
    const dst = join(t.dir, "dst");
    const raw = new DatabaseSync(src);
    raw.exec("CREATE TABLE a (b TEXT)");
    raw.close();
    assert.equal(confinedCopy(src, dst, uid), true);
    assert.equal(statSync(dst).mode & 0o777, 0o600);
    assert.equal(statSync(dst).size, statSync(src).size);
    assert.equal(confinedCopy(src, dst, uid), false, "an existing destination is left alone");
    assert.equal(
      code(() => confinedCopy(src, join(t.dir, "dst2"), uid + 1)),
      "db-permissions",
    );
  } finally {
    t.done();
  }
});
