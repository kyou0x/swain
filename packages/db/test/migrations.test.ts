import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DbError,
  lintMigrationSql,
  MIGRATIONS,
  type Migration,
  SqliteSwainStore,
} from "../src/index.js";
import { MIGRATION_PRAGMA_ALLOWLIST } from "../src/migrations/lint.js";
import { TABLES_WITHOUT_PROJECT } from "../src/sqlite/lint.js";
import { migrationSha256 } from "../src/sqlite/migrate.js";
import { TENANT_TABLES } from "../src/sqlite/statements.js";
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
    nowMs: () => NOW,
    uid,
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

// ---- lint ---------------------------------------------------------------------------------------
test("migration lint: every forbidden token fails", () => {
  const bad: [string, string][] = [
    ["DROP TABLE a;", "DROP"],
    ["drop index i;", "DROP"],
    ["DELETE FROM a;", "DELETE"],
    ["ALTER TABLE a RENAME TO b;", "ALTER TABLE RENAME"],
    ["ALTER TABLE a RENAME COLUMN x TO y;", "ALTER TABLE RENAME"],
    ["ALTER TABLE a DROP COLUMN x;", "ALTER TABLE DROP"],
    ["REPLACE INTO a VALUES (1);", "REPLACE INTO"],
    ["INSERT OR REPLACE INTO a VALUES (1);", "INSERT OR REPLACE"],
    ["UPDATE a SET x = 1;", "UPDATE"],
    ["CREATE TABLE a (b TEXT PRIMARY KEY ON CONFLICT REPLACE);", "REPLACE"],
    ["CREATE TABLE a (b TEXT PRIMARY KEY ON CONFLICT REPLACE);", "ON CONFLICT"],
    ["CREATE TABLE a (b TEXT UNIQUE ON CONFLICT IGNORE);", "ON CONFLICT"],
    ["INSERT OR REPLACE INTO spans VALUES (1);", "REPLACE"],
    ["REPLACE INTO spans VALUES (1);", "REPLACE"],
    ["SELECT replace(a, 'x', 'y') FROM t;", "REPLACE"],
    ["PRAGMA writable_schema = ON;", "PRAGMA writable_schema"],
    ["CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;", "CREATE TRIGGER"],
    ["ATTACH DATABASE 'x' AS y;", "ATTACH"],
    ["CREATE VIEW v AS SELECT 1;", "CREATE VIEW"],
    ["PRAGMA cache_size = 1;", "PRAGMA"],
    ["PRAGMA trusted_schema = ON;", "PRAGMA"],
    ["PRAGMA journal_mode;", "PRAGMA"],
  ];
  for (const [sql, rule] of bad) {
    assert.ok(lintMigrationSql(sql).includes(rule), `${sql} should violate ${rule}`);
    // The tokens cannot be hidden by case, extra whitespace or a trailing comment.
    assert.ok(lintMigrationSql(`  ${sql.toLowerCase()} -- ok`).length > 0, sql);
  }
  assert.deepEqual(MIGRATION_PRAGMA_ALLOWLIST, ["foreign_keys", "user_version"]);
  assert.deepEqual(lintMigrationSql("PRAGMA user_version = 2;"), []);
});

test("migration lint: comments and quoted text are not code, and 0001 is clean", () => {
  assert.deepEqual(
    lintMigrationSql("CREATE TABLE a (x TEXT DEFAULT 'DROP DELETE UPDATE') STRICT;"),
    [],
  );
  assert.deepEqual(
    lintMigrationSql("/* DROP TABLE */ -- UPDATE\nCREATE TABLE a (b INTEGER) STRICT;"),
    [],
  );
  assert.deepEqual(lintMigrationSql('CREATE TABLE a ("UPDATE" TEXT) STRICT;'), []);
  for (const m of MIGRATIONS) assert.deepEqual(lintMigrationSql(m.sql), [], m.name);
});

test("migration registry: versions 1..n in order, every table STRICT", () => {
  MIGRATIONS.forEach((m, i) => {
    assert.equal(m.version, i + 1);
  });
  const sql = MIGRATIONS.map((m) => m.sql).join("\n");
  const creates = [...sql.matchAll(/CREATE TABLE (\w+) \(/g)].map((m) => m[1]);
  assert.ok(creates.length >= 20);
  const stricts = [...sql.matchAll(/\) STRICT;/g)].length;
  assert.equal(stricts, creates.length);
});

test("tenant table list equals the tables with an org_id column; project list likewise", () => {
  const t = tempDir();
  try {
    const s = open(join(t.dir, "a.sqlite"));
    s.migrate({ nowIso: () => NOW_ISO });
    const raw = new DatabaseSync(s.path, { readOnly: true });
    const tables = raw
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => String(r["name"]));
    const withCol = (col: string): string[] =>
      tables
        .filter(
          (n) =>
            raw.prepare(`SELECT 1 FROM pragma_table_info('${n}') WHERE name = '${col}'`).get() !==
            undefined,
        )
        .sort();
    assert.deepEqual(withCol("org_id"), [...TENANT_TABLES].sort());
    assert.deepEqual(
      withCol("org_id").filter((n) => !withCol("project_id").includes(n)),
      [...TABLES_WITHOUT_PROJECT].sort(),
    );
    // F6: a direct key_id on every L1 row table.
    for (const n of ["spans", "span_conflicts", "log_records", "imports", "events"]) {
      assert.ok(withCol("key_id").includes(n), `${n}.key_id`);
    }
    raw.close();
    s.close();
  } finally {
    t.done();
  }
});

// ---- runner -------------------------------------------------------------------------------------
test("migrate: new DB gets 0001, no backup; running again is a no-op", () => {
  const t = tempDir();
  try {
    const s = open(join(t.dir, "a.sqlite"));
    const r1 = s.migrate({ nowIso: () => NOW_ISO });
    assert.equal(r1.fromVersion, 0);
    assert.equal(r1.toVersion, 1);
    assert.equal(r1.backupPath, null);
    assert.equal(r1.applied[0]?.sha256, migrationSha256(MIGRATIONS[0] as Migration));
    const r2 = s.migrate({ nowIso: () => NOW_ISO });
    assert.deepEqual(
      [r2.fromVersion, r2.toVersion, r2.applied.length, r2.backupPath],
      [1, 1, 0, null],
    );
    s.close();
  } finally {
    t.done();
  }
});

test("migrate: a checksum mismatch is refused (db-migration-mismatch)", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    open(path).close();
    const first = open(path);
    first.migrate({ nowIso: () => NOW_ISO });
    first.close();
    const tampered: Migration = {
      ...(MIGRATIONS[0] as Migration),
      sql: `${MIGRATIONS[0]?.sql}\n-- edited`,
    };
    const s = open(path, [tampered]);
    assert.equal(
      code(() => s.migrate({ nowIso: () => NOW_ISO })),
      "db-migration-mismatch",
    );
    s.close();
    const renamed: Migration = { ...(MIGRATIONS[0] as Migration), name: "other" };
    const s2 = open(path, [renamed]);
    assert.equal(
      code(() => s2.migrate({ nowIso: () => NOW_ISO })),
      "db-migration-mismatch",
    );
    s2.close();
    // and a database edited behind our back
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET sha256 = 'x' WHERE version = 1");
    raw.close();
    const s3 = open(path);
    assert.equal(
      code(() => s3.migrate({ nowIso: () => NOW_ISO })),
      "db-migration-mismatch",
    );
    s3.close();
  } finally {
    t.done();
  }
});

test("migrate: a database newer than the binary is refused (db-too-new)", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    const newer = open(path, [...MIGRATIONS, EXTRA]);
    newer.migrate({ nowIso: () => NOW_ISO });
    newer.close();
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

test("migrate: a non-empty DB is backed up first with mode 0600, via VACUUM INTO", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    const v1 = open(path);
    v1.migrate({ nowIso: () => NOW_ISO });
    v1.ensureLocalTenancy(NOW_ISO);
    v1.close();
    const v2 = open(path, [...MIGRATIONS, EXTRA]);
    const report = v2.migrate({ nowIso: () => NOW_ISO });
    v2.close();
    assert.equal(report.toVersion, 2);
    assert.equal(report.backupPath, `${path}.pre-v0002.sqlite`);
    assert.equal(statSync(report.backupPath as string).mode & 0o777, 0o600);
    // The backup is the pre-migration state: it has the data and not the new table.
    const b = new DatabaseSync(report.backupPath as string, { readOnly: true });
    assert.equal(b.prepare("SELECT COUNT(*) AS n FROM orgs").get()?.["n"], 1);
    assert.equal(b.prepare("SELECT name FROM sqlite_schema WHERE name = 'extra'").get(), undefined);
    b.close();
  } finally {
    t.done();
  }
});

test("migrate: the backup path is bound, never quoted (a path with ' works), and nothing is overwritten", () => {
  const t = tempDir();
  try {
    const dir = join(t.dir, 'it\'s a "dir"; DROP TABLE orgs; --');
    mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, "n'erve.sqlite");
    const v1 = open(path);
    v1.migrate({ nowIso: () => NOW_ISO });
    v1.ensureLocalTenancy(NOW_ISO);
    v1.close();
    const v2 = open(path, [...MIGRATIONS, EXTRA]);
    const r = v2.migrate({ nowIso: () => NOW_ISO });
    v2.close();
    assert.equal(r.backupPath, `${path}.pre-v0002.sqlite`);
    assert.equal(statSync(r.backupPath as string).mode & 0o777, 0o600);
    assert.ok(readdirSync(dir).includes("n'erve.sqlite.pre-v0002.sqlite"));
    // the orgs table survived the hostile directory name
    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM orgs").get()?.["n"], 1);
    check.close();
  } finally {
    t.done();
  }
});

test("migrate: an existing backup is never overwritten; a failed migration rolls back whole", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    const v1 = open(path);
    v1.migrate({ nowIso: () => NOW_ISO });
    v1.ensureLocalTenancy(NOW_ISO);
    v1.close();
    const broken: Migration = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE half (a INTEGER NOT NULL) STRICT;\nCREATE TABLE half (a INTEGER NOT NULL) STRICT;",
    };
    const v2 = open(path, [...MIGRATIONS, broken]);
    assert.equal(
      code(() => v2.migrate({ nowIso: () => NOW_ISO })),
      "db-io",
    );
    v2.close();
    // one transaction per migration: nothing of the failed one remains, version stays 1
    const raw = new DatabaseSync(path, { readOnly: true });
    assert.equal(
      raw.prepare("SELECT name FROM sqlite_schema WHERE name = 'half'").get(),
      undefined,
    );
    assert.equal(raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.["v"], 1);
    raw.close();
    // the first attempt left a backup; the retry takes a new name instead of overwriting it
    const v3 = open(path, [...MIGRATIONS, EXTRA]);
    const r = v3.migrate({ nowIso: () => NOW_ISO });
    v3.close();
    assert.equal(r.backupPath, `${path}.pre-v0002-1.sqlite`);
    assert.equal(statSync(`${path}.pre-v0002.sqlite`).mode & 0o777, 0o600);
  } finally {
    t.done();
  }
});

test("backup (F2): a failed backup leaves no .tmp/.partial and no file under the final name", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    const v1 = open(path);
    v1.migrate({ nowIso: () => NOW_ISO });
    v1.ensureLocalTenancy(NOW_ISO);
    v1.close();
    // every candidate backup name is taken, so the publish step fails after the copy succeeded
    for (let n = 0; n < 100; n++) {
      writeFileSync(n === 0 ? `${path}.pre-v0002.sqlite` : `${path}.pre-v0002-${n}.sqlite`, "x");
    }
    const before = readdirSync(t.dir).sort();
    const v2 = open(path, [...MIGRATIONS, EXTRA]);
    assert.equal(
      code(() => v2.migrate({ nowIso: () => NOW_ISO })),
      "db-io",
    );
    v2.close();
    assert.deepEqual(readdirSync(t.dir).sort(), before, "no scratch file remains");
    assert.equal(readFileSync(`${path}.pre-v0002.sqlite`, "utf8"), "x", "never overwritten");
  } finally {
    t.done();
  }
});

test("migrate: a bad migration list is refused", () => {
  const t = tempDir();
  try {
    const s = open(join(t.dir, "a.sqlite"), [{ ...(MIGRATIONS[0] as Migration), version: 2 }]);
    assert.equal(
      code(() => s.migrate({ nowIso: () => NOW_ISO })),
      "db-migration-mismatch",
    );
    s.close();
  } finally {
    t.done();
  }
});

test("a store refuses to work before migrate", () => {
  const t = tempDir();
  try {
    const s = open(join(t.dir, "a.sqlite"));
    assert.equal(
      code(() => s.listProjects({ orgId: `org_${"0".repeat(32)}` })),
      "db-io",
    );
    s.close();
  } finally {
    t.done();
  }
});

test("open: a trigger or view in the file is refused (F21)", () => {
  const t = tempDir();
  try {
    const path = join(t.dir, "a.sqlite");
    const s = open(path);
    s.migrate({ nowIso: () => NOW_ISO });
    s.close();
    chmodSync(path, 0o600);
    const raw = new DatabaseSync(path);
    raw.exec("CREATE VIEW v AS SELECT 1 AS x");
    raw.close();
    assert.equal(
      code(() => open(path)),
      "db-corrupt",
    );
    const raw2 = new DatabaseSync(path);
    raw2.exec("DROP VIEW v");
    raw2.exec("CREATE TRIGGER trg AFTER INSERT ON orgs BEGIN SELECT 1; END");
    raw2.close();
    assert.equal(
      code(() => open(path)),
      "db-corrupt",
    );
  } finally {
    t.done();
  }
});
