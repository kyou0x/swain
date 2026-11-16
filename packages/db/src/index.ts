export const PACKAGE_NAME = "@swain/db";

export type { DbErrorCode } from "./errors.js";
export { DB_ERROR_CODES, DbError } from "./errors.js";
export type { AgtId, BatchId, KeyId, OrgId, PrjId, RunId, WspId } from "./ids.js";
export type { Migration } from "./migrations/index.js";
export { MIGRATIONS } from "./migrations/index.js";
export { lintMigrationSql } from "./migrations/lint.js";
export {
  hashKeySecret,
  keyIdOfSecret,
  type SqliteStoreOptions,
  SqliteSwainStore,
} from "./sqlite/store.js";
export type { SwainStore } from "./store.js";
export * from "./types.js";
