/**
 * The open sequence (SPEC-003 r2 section 2.1, ADR-0004 r2 section 2, G0 F11/F21). The only place
 * that constructs a `DatabaseSync`. `allowExtension` is always false and nothing here can enable it.
 *
 * Steps 1 to 3 run before any PRAGMA or statement:
 *  1. the parent directory is created 0700 if missing; it must not be a symlink, must be owned by
 *     the current uid (injected: the policy bans `process`) and must not be group/world writable;
 *  2. the DB file is pre-created `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` 0600 when missing; when
 *     present it must be a regular file, not a symlink, owned by the uid, mode exactly 0600
 *     (an existing file is never chmodded);
 *  3. `new DatabaseSync`, mode re-checked, then the PRAGMAs, then `enableDefensive(true)`;
 *  4. `-wal` / `-shm` are lstat-checked (no symlinks, owned by the uid) and chmodded 0600;
 *  5. the caller verifies the schema (`migrate.ts`): no triggers, no views, no unexpected objects.
 *
 * Limit: Node offers no `O_NOFOLLOW` for `DatabaseSync`, so a swap between our check and SQLite's
 * own open is narrowed (we created the file ourselves and re-verify it) and excluded by the
 * private parent directory rather than eliminated.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DbError } from "../errors.js";
import { MIGRATIONS } from "../migrations/index.js";
import { errnoCodeOf, toDbError } from "./errors.js";

const MODE_MASK = 0o777;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const GROUP_WORLD_WRITE = 0o022;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const COPY_CHUNK = 1_048_576;

interface Stat {
  readonly mode: number;
  readonly uid: number;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}

export function lstatOrNull(path: string): Stat | null {
  try {
    return (lstatSync(path, { throwIfNoEntry: false }) as Stat | undefined) ?? null;
  } catch (e) {
    throw toDbError(e);
  }
}

/**
 * Create `path` exclusively (`wx | O_NOFOLLOW`) with mode 0600. Returns false when it already
 * exists. Used for the database file and for backup temp files.
 */
export function createExclusive(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, CREATE_FLAGS, FILE_MODE);
  } catch (e) {
    if (errnoCodeOf(e) === "EEXIST") return false;
    throw toDbError(e);
  }
  try {
    // By descriptor: the path may have been swapped since the open. We created this file, so
    // undoing any umask narrowing is safe; an existing file is never chmodded.
    fchmodSync(fd, FILE_MODE);
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // The original failure is the one to report.
    }
    throw toDbError(e);
  }
  try {
    closeSync(fd);
  } catch (e) {
    throw toDbError(e);
  }
  return true;
}

/** `path` must be a regular file, not a symlink, owned by `uid`, mode exactly 0600. */
export function assertPrivateFile(path: string, uid: number): void {
  const st = lstatOrNull(path);
  if (st === null) throw new DbError("db-io");
  if (st.isSymbolicLink()) throw new DbError("db-symlink");
  if (!st.isFile()) throw new DbError("db-io");
  if (st.uid !== uid || (st.mode & MODE_MASK) !== FILE_MODE) throw new DbError("db-permissions");
}

/** chmod 0600 and verify every WAL/SHM/journal sidecar that exists; refuses symlinks. */
export function secureSidecars(abs: string, uid: number): void {
  for (const suffix of SIDECARS) {
    const p = `${abs}${suffix}`;
    const st = lstatOrNull(p);
    if (st === null) continue;
    if (st.isSymbolicLink() || !st.isFile()) throw new DbError("db-symlink");
    if (st.uid !== uid) throw new DbError("db-permissions");
    try {
      chmodSync(p, FILE_MODE);
    } catch (e) {
      throw toDbError(e);
    }
    assertPrivateFile(p, uid);
  }
}

/**
 * The confined writer (ADR-0004 r2 section 2): copy `src` (checked with `fstat` on the opened
 * descriptor: regular file, owned by `uid`) to a new `dst` created `wx | O_NOFOLLOW` 0600, fsync
 * it, and close both. Returns false when `dst` already exists. Never overwrites.
 */
export function confinedCopy(src: string, dst: string, uid: number): boolean {
  let from = -1;
  let to = -1;
  try {
    from = openSync(src, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(from);
    if (!st.isFile() || st.uid !== uid) throw new DbError("db-permissions");
    try {
      to = openSync(dst, CREATE_FLAGS, FILE_MODE);
    } catch (e) {
      if (errnoCodeOf(e) === "EEXIST") return false;
      throw e;
    }
    const buf = new Uint8Array(COPY_CHUNK);
    for (;;) {
      const n = readSync(from, buf, 0, buf.length, null);
      if (n === 0) break;
      let off = 0;
      while (off < n) off += writeSync(to, buf, off, n - off);
    }
    fsyncSync(to);
    return true;
  } catch (e) {
    throw toDbError(e);
  } finally {
    if (from !== -1) closeSync(from);
    if (to !== -1) closeSync(to);
  }
}

/** Only our own scratch names may be removed: `.<16 hex>.tmp` or `.partial`, inside `dir`. */
const SCRATCH_NAME = /^\.[0-9a-f]{16}\.(?:tmp|partial)$/;

export function removeFile(path: string, dir: string): void {
  if (dirname(resolve(path)) !== resolve(dir) || !SCRATCH_NAME.test(basename(path))) {
    throw new DbError("db-io");
  }
  try {
    unlinkSync(path);
  } catch (e) {
    throw toDbError(e);
  }
}

/** Publish `partial` as `final` with a hard link; false when `final` exists (never overwrites). */
export function publishLink(partial: string, final: string): boolean {
  try {
    linkSync(partial, final);
    return true;
  } catch (e) {
    if (errnoCodeOf(e) === "EEXIST") return false;
    throw toDbError(e);
  }
}

function checkDirectory(dir: string, uid: number): void {
  let st = lstatOrNull(dir);
  if (st === null) {
    try {
      mkdirSync(dir, { mode: DIR_MODE });
    } catch (e) {
      throw toDbError(e);
    }
    st = lstatOrNull(dir);
    if (st === null) throw new DbError("db-io");
  }
  if (st.isSymbolicLink()) throw new DbError("db-symlink");
  if (!st.isDirectory()) throw new DbError("db-io");
  if (st.uid !== uid || (st.mode & GROUP_WORLD_WRITE) !== 0) throw new DbError("db-permissions");
}

export interface OpenOptions {
  /** The effective uid of this process (injected; the policy bans `process` here). */
  readonly uid: number;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  /** Absolute path of the database file. */
  readonly path: string;
  /** True when this call created the file. */
  readonly created: boolean;
}

export function openDatabase(path: string, options: OpenOptions): OpenedDatabase {
  if (typeof path !== "string" || path === "" || path.includes("\0")) throw new DbError("db-io");
  if (!Number.isSafeInteger(options.uid) || options.uid < 0) throw new DbError("db-io");
  const { uid } = options;
  const abs = resolve(path);
  checkDirectory(dirname(abs), uid);

  const created = createExclusive(abs);
  assertPrivateFile(abs, uid);
  for (const suffix of SIDECARS) {
    const s = lstatOrNull(`${abs}${suffix}`);
    if (s?.isSymbolicLink() === true) throw new DbError("db-symlink");
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(abs, { allowExtension: false, enableForeignKeyConstraints: true });
  } catch (e) {
    throw toDbError(e);
  }
  try {
    assertPrivateFile(abs, uid); // before any PRAGMA
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA trusted_schema=OFF");
    db.enableDefensive(true);
    assertPrivateFile(abs, uid);
    secureSidecars(abs, uid);
  } catch (e) {
    try {
      db.close();
    } catch {
      // Already failing; the original error is the one to report.
    }
    throw toDbError(e);
  }
  return { db, path: abs, created };
}

/** Table to column names of a fresh in-memory database built from the migrations (lint schema). */
export function migratedSchemaColumns(): Map<string, Set<string>> {
  const db = new DatabaseSync(":memory:");
  const out = new Map<string, Set<string>>();
  try {
    for (const m of MIGRATIONS) db.exec(m.sql);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
      name: string;
    }[];
    for (const tb of tables) {
      const cols = db.prepare("SELECT name FROM pragma_table_info(?)").all(tb.name) as {
        name: string;
      }[];
      out.set(tb.name, new Set(cols.map((c) => c.name)));
    }
  } finally {
    db.close();
  }
  return out;
}
