/**
 * TESTS ONLY. Opens a store with the SQL of some registry statements replaced, so a test can show
 * that `assertRowScope` catches a statement that lost its scope predicate. Not exported from the
 * package entry or `package.json` "exports"; no source file may import this module (a unit test
 * and a policy-check rule enforce it).
 */

import type { StatementName } from "./statements.js";
import {
  internalOpenWithOverrides,
  type SqliteStoreOptions,
  type SqliteSwainStore,
} from "./store.js";

export function openWithStatementOverrides(
  path: string,
  options: SqliteStoreOptions,
  overrides: Readonly<Partial<Record<StatementName, string>>>,
): SqliteSwainStore {
  return internalOpenWithOverrides(path, options, overrides);
}
