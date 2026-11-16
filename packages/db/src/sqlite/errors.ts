import { DbError } from "../errors.js";

/** Primary SQLite result codes used for classification. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_CONSTRAINT = 19;
const SQLITE_NOTADB = 26;

function errcodeOf(e: unknown): number | null {
  if (typeof e !== "object" || e === null) return null;
  const c = (e as { errcode?: unknown }).errcode;
  return typeof c === "number" ? c : null;
}

export function errnoCodeOf(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : null;
}

/** Map any failure to a typed `DbError`. The original message is dropped (it can hold paths or data). */
export function toDbError(e: unknown): DbError {
  if (e instanceof DbError) return e;
  const code = errcodeOf(e);
  if (code !== null) {
    const primary = code & 0xff;
    if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) return new DbError("db-locked");
    if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) return new DbError("db-corrupt");
    if (primary === SQLITE_CONSTRAINT) return new DbError("db-constraint");
  }
  if (errnoCodeOf(e) === "ELOOP") return new DbError("db-symlink");
  return new DbError("db-io");
}
