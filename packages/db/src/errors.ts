/** Typed database errors (SPEC-003 section 2.3). Messages are static codes: no paths, no SQL, no data. */
export const DB_ERROR_CODES = [
  "db-locked",
  "db-corrupt",
  "db-too-new",
  "db-migration-mismatch",
  "db-permissions",
  "db-symlink",
  "db-io",
  "db-constraint",
  "db-scope-violation",
  /** All 64 idempotency windows of one key are in use (the server maps this to 409). */
  "db-idempotency-exhausted",
] as const;
export type DbErrorCode = (typeof DB_ERROR_CODES)[number];

export class DbError extends Error {
  readonly code: DbErrorCode;
  constructor(code: DbErrorCode) {
    super(code);
    this.name = "DbError";
    this.code = code;
  }
}
