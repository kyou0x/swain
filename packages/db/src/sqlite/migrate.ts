/**
 * The migration runner (SPEC-003 r2 section 2.1): forward only, checksum pinned, `db-too-new`
 * refusal, a backup before touching a non-empty database, and one transaction per migration
 * followed by its `schema_migrations` row. Also the schema integrity check of the open sequence.
 */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "@swain/core";
import { DbError } from "../errors.js";
import type { Migration } from "../migrations/index.js";
import type { MigrationReport } from "../types.js";
import { int, type Stmts, str } from "./db.js";
import { toDbError } from "./errors.js";
import {
  assertPrivateFile,
  confinedCopy,
  createExclusive,
  lstatOrNull,
  publishLink,
  removeFile,
  secureSidecars,
} from "./open.js";

const encoder = new TextEncoder();
const MAX_BACKUP_NAMES = 100;

export function migrationSha256(m: Migration): string {
  return sha256Hex(encoder.encode(m.sql));
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export interface MigrateContext {
  readonly db: DatabaseSync;
  readonly stmts: Stmts;
  readonly path: string;
  readonly uid: number;
}

/**
 * Backup (ADR-0004 r2 section 2, G3 F2): `VACUUM INTO ?` with the path bound as a parameter, into
 * a fresh `.<16 hex>.tmp` file created `wx | O_NOFOLLOW` 0600 in the DB directory; the temp file is
 * checked and copied by the confined writer to a `.<16 hex>.partial` file, which is published to
 * `<db>.pre-v<NNNN>.sqlite` with a hard link (so an existing backup is never overwritten: the next
 * free `-N` suffix is used). Both scratch files are removed on success and on failure, so a
 * half-written backup never carries the final name. Scratch names come from `node:crypto`.
 */
function backup(ctx: MigrateContext, firstPending: number): string {
  const dir = dirname(ctx.path);
  const temp = join(dir, `.${hex(randomBytes(8))}.tmp`);
  const partial = join(dir, `.${hex(randomBytes(8))}.partial`);
  if (!createExclusive(temp)) throw new DbError("db-io");
  let target: string | null = null;
  try {
    ctx.stmts.run("mig.backup", temp);
    assertPrivateFile(temp, ctx.uid);
    if (!confinedCopy(temp, partial, ctx.uid)) throw new DbError("db-io");
    const base = `${ctx.path}.pre-v${pad4(firstPending)}`;
    for (let n = 0; n < MAX_BACKUP_NAMES && target === null; n++) {
      const candidate = n === 0 ? `${base}.sqlite` : `${base}-${n}.sqlite`;
      if (publishLink(partial, candidate)) target = candidate;
    }
    if (target === null) throw new DbError("db-io");
    assertPrivateFile(target, ctx.uid);
  } catch (e) {
    for (const scratch of [partial, temp]) {
      try {
        if (lstatOrNull(scratch) !== null) removeFile(scratch, dir);
      } catch {
        // Best effort; the failure below is the one to report.
      }
    }
    throw e instanceof DbError && e.code === "db-permissions" ? e : new DbError("db-io");
  }
  removeFile(partial, dir);
  removeFile(temp, dir);
  return target;
}

/**
 * SQL statements split at top-level `;` and normalised for comparison: comments removed,
 * whitespace collapsed (and dropped next to `(`, `)` and `,`), keywords and identifiers lower-cased,
 * string literals kept verbatim so a changed CHECK or DEFAULT value is a difference.
 */
export function normalizedStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let space = false;
  const push = (s: string): void => {
    if (space && cur !== "" && !"(,".includes(cur.slice(-1)) && !"),".includes(s.charAt(0))) {
      cur += " ";
    }
    space = false;
    cur += s;
  };
  for (let i = 0; i < sql.length; ) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === "-" && next === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i++;
      space = true;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      space = true;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      push(sql.slice(i, j + 1));
      i = j + 1;
    } else if (c === ";") {
      if (cur !== "") out.push(cur);
      cur = "";
      space = false;
      i++;
    } else if (/\s/.test(c)) {
      space = true;
      i++;
    } else {
      push(c.toLowerCase());
      i++;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** `type:name` to normalised DDL for every table and index the migrations create. */
function expectedObjects(migrations: readonly Migration[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of migrations) {
    for (const stmt of normalizedStatements(m.sql)) {
      const x = /^create (?:unique )?(table|index) (\w+)/.exec(stmt);
      if (x !== null) out.set(`${x[1]}:${x[2]}`, stmt);
    }
  }
  return out;
}

/**
 * Schema integrity (F21, G3 F3): no trigger and no view, whatever the applied version; and
 * `sqlite_schema` holds exactly the tables and indexes of the applied migrations, each with the
 * same normalised DDL text as the migration (a changed CHECK, DEFAULT or key is caught).
 * Implicit `sqlite_autoindex_*` entries (no SQL) and `sqlite_stat1` (written by `ANALYZE`) are
 * tolerated. A database newer than this binary is left to `runMigrations` (`db-too-new`).
 */
export function verifySchema(stmts: Stmts, migrations: readonly Migration[]): void {
  const rows = stmts.all("schema.objects");
  for (const r of rows) {
    const type = str(r, "type");
    if (type === "trigger" || type === "view") throw new DbError("db-corrupt");
  }
  const applied = stmts.get("mig.hasTable") === undefined ? 0 : stmts.all("mig.applied").length;
  if (applied > migrations.length) return;
  const expected = expectedObjects(migrations.slice(0, applied));
  const seen = new Set<string>();
  for (const r of rows) {
    const type = str(r, "type");
    const name = str(r, "name");
    if (name === "sqlite_stat1" || (type === "index" && name.startsWith("sqlite_autoindex_"))) {
      continue;
    }
    const key = `${type}:${name}`;
    const want = expected.get(key);
    const have = r["sql"];
    if (want === undefined || typeof have !== "string") throw new DbError("db-corrupt");
    const norm = normalizedStatements(have);
    if (norm.length !== 1 || norm[0] !== want) throw new DbError("db-corrupt");
    seen.add(key);
  }
  if (seen.size !== expected.size) throw new DbError("db-corrupt");
}

export function runMigrations(
  ctx: MigrateContext,
  migrations: readonly Migration[],
  nowIso: () => string,
): MigrationReport {
  const { db, stmts, path } = ctx;
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new DbError("db-migration-mismatch");
  });
  const applied =
    stmts.get("mig.hasTable") === undefined
      ? []
      : stmts.all("mig.applied").map((r) => ({
          version: int(r, "version"),
          name: str(r, "name"),
          sha256: str(r, "sha256"),
        }));
  // Newer than this binary knows: refuse before judging anything else.
  if (applied.some((a) => a.version > migrations.length)) throw new DbError("db-too-new");
  applied.forEach((a, i) => {
    const m = migrations[i];
    if (a.version !== i + 1 || m === undefined) throw new DbError("db-migration-mismatch");
    if (a.name !== m.name || a.sha256 !== migrationSha256(m)) {
      throw new DbError("db-migration-mismatch");
    }
  });
  const fromVersion = applied.length;
  const pending = migrations.slice(fromVersion);
  let backupPath: string | null = null;
  const first = pending[0];
  if (first !== undefined) {
    const tables = stmts.get("mig.userTables");
    if (tables !== undefined && int(tables, "n") > 0) backupPath = backup(ctx, first.version);
  }
  const done: { version: number; name: string; sha256: string }[] = [];
  for (const m of pending) {
    const sha = migrationSha256(m);
    stmts.run("tx.begin");
    try {
      db.exec(m.sql);
      stmts.run("mig.insert", m.version, m.name, sha, nowIso());
      stmts.run("tx.commit");
    } catch (e) {
      try {
        stmts.run("tx.rollback");
      } catch {
        // The original failure is the one to report.
      }
      throw toDbError(e);
    }
    done.push({ version: m.version, name: m.name, sha256: sha });
  }
  secureSidecars(path, ctx.uid);
  return {
    fromVersion,
    toVersion: fromVersion + done.length,
    applied: done,
    backupPath,
  };
}
