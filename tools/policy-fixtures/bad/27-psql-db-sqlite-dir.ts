// as: packages/db/src/sqlite/x.ts
import { DatabaseSync } from "node:sqlite";
import { StatementSync } from "node:sqlite"; // expect: P-IMPORT P-SQL
import { backup, constants } from "node:sqlite"; // expect: P-IMPORT P-SQL
import * as sql from "node:sqlite"; // expect: P-IMPORT P-SQL
import d from "node:sqlite"; // expect: P-IMPORT P-SQL
declare const db: DatabaseSync;
db.loadExtension("x"); // expect: P-SQL
db.enableLoadExtension(true); // expect: P-SQL
db["loadExtension"]("x"); // expect: P-SQL
db[`enableLoadExtension`](false); // expect: P-SQL
const { loadExtension } = db; // expect: P-SQL
const { enableLoadExtension: e } = db; // expect: P-SQL
({ loadExtension: db.loadExtension } = db); // expect: P-SQL
export { StatementSync, backup, constants, sql, d, loadExtension, e };
