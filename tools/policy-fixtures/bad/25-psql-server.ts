// as: packages/server/src/db.ts
import { DatabaseSync } from "node:sqlite"; // expect: P-IMPORT P-SQL
import * as sql from "node:sqlite"; // expect: P-IMPORT P-SQL
import sqlite from "sqlite"; // expect: P-IMPORT P-SQL
export { DatabaseSync, sql, sqlite };
