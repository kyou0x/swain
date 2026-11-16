/** Prepared statement access by registry name, and typed row accessors. No SQL text appears elsewhere. */
import type { DatabaseSync } from "node:sqlite";
import { DbError } from "../errors.js";
import { toDbError } from "./errors.js";
import { STATEMENTS, type StatementName } from "./statements.js";

type StatementSync = ReturnType<DatabaseSync["prepare"]>;
export type Param = null | number | bigint | string | Uint8Array;
export type Row = Readonly<Record<string, unknown>>;

export class Stmts {
  readonly #db: DatabaseSync;
  readonly #cache = new Map<StatementName, StatementSync>();

  readonly #overrides: Readonly<Partial<Record<StatementName, string>>>;

  /** `overrides` swaps the SQL of named statements: tests only (set only through the internal test factory). */
  constructor(db: DatabaseSync, overrides: Readonly<Partial<Record<StatementName, string>>> = {}) {
    this.#db = db;
    this.#overrides = overrides;
  }

  #prep(name: StatementName): StatementSync {
    let s = this.#cache.get(name);
    if (s === undefined) {
      const def: { readonly bigints?: boolean; readonly sql: string } = STATEMENTS[name];
      s = this.#db.prepare(this.#overrides[name] ?? def.sql);
      if (def.bigints === true) s.setReadBigInts(true);
      this.#cache.set(name, s);
    }
    return s;
  }

  /** Number of rows changed. */
  run(name: StatementName, ...params: Param[]): number {
    try {
      return Number(this.#prep(name).run(...params).changes);
    } catch (e) {
      throw toDbError(e);
    }
  }

  get(name: StatementName, ...params: Param[]): Row | undefined {
    try {
      return this.#prep(name).get(...params) as Row | undefined;
    } catch (e) {
      throw toDbError(e);
    }
  }

  all(name: StatementName, ...params: Param[]): Row[] {
    try {
      return this.#prep(name).all(...params) as Row[];
    } catch (e) {
      throw toDbError(e);
    }
  }

  /** Drop prepared statements (before the connection closes). */
  clear(): void {
    this.#cache.clear();
  }
}

function corrupt(): never {
  throw new DbError("db-corrupt");
}

export function str(r: Row, k: string): string {
  const v = r[k];
  if (typeof v !== "string") return corrupt();
  return v;
}
export function nstr(r: Row, k: string): string | null {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return corrupt();
  return v;
}
export function int(r: Row, k: string): number {
  const v = r[k];
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER))
      return corrupt();
    return Number(v);
  }
  if (typeof v !== "number" || !Number.isSafeInteger(v)) return corrupt();
  return v;
}
export function nint(r: Row, k: string): number | null {
  const v = r[k];
  if (v === null || v === undefined) return null;
  return int(r, k);
}
/** A nanosecond column read through a `bigints` statement. */
export function nbig(r: Row, k: string): bigint | null {
  const v = r[k];
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  return corrupt();
}
