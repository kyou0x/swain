/**
 * Fail-closed lint (round 4): negative tests for every B1/B2 form, a seeded statement generator,
 * and a differential run against SQLite itself.
 *
 * The generator builds tenant SELECTs from fragments and knows by construction whether every table
 * reference is scoped. Properties: (1) every statement with an unscoped reference is rejected;
 * (2) every well-scoped statement is accepted (the generator is not vacuous); (3) no statement the
 * lint accepts returns a row of the other org when run on a two-org in-memory database; (4) the
 * same holds for randomly mutated statements, and the rejected set does contain statements that
 * really would leak (the differential can fail).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS } from "../src/index.js";
import { lintStatement, RESERVED, schemaColumns } from "../src/sqlite/lint.js";
import type { StatementDef } from "../src/sqlite/statements.js";

const T = (sql: string): StatementDef => ({ tenant: true, sql });
const SCOPE = "s.org_id = ? AND s.project_id = ?";

// ---- B1 / B2 negatives ---------------------------------------------------------------------------
const NEGATIVES: [string, string, string][] = [
  // B4: a CTE name must never hide a real table; WITH is refused at every level
  [
    "B4 repro 1: a CTE named like a table inside a scalar subquery, a real FROM spans after it",
    "SELECT (WITH spans AS (SELECT 1 AS org_id) SELECT org_id FROM spans) AS q, spans.attrs_json FROM spans JOIN runs r ON r.org_id = ? AND r.project_id = ?",
    "unsupported-construct",
  ],
  [
    "WITH at the top",
    "WITH x AS (SELECT 1) SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = ?",
    "unsupported-construct",
  ],
  [
    "WITH RECURSIVE",
    "WITH RECURSIVE x AS (SELECT 1) SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = ?",
    "unsupported-construct",
  ],
  [
    "B4 repro 3: a CTE inside EXISTS in arm 1 hides FROM spans in arm 2",
    "SELECT 1 FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND EXISTS (WITH spans AS (SELECT 1 AS k) SELECT 1 FROM spans) UNION SELECT 1 FROM spans",
    "unsupported-construct",
  ],
  [
    "WITH in an IN subquery",
    "SELECT 1 FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND r.run_id IN (WITH x AS (SELECT 1) SELECT 1 FROM runs q WHERE q.org_id = ? AND q.project_id = ?)",
    "unsupported-construct",
  ],
  [
    "WITH in a derived table",
    "SELECT 1 FROM (WITH x AS (SELECT 1) SELECT 1 AS k) d JOIN runs r ON r.org_id = ? AND r.project_id = ?",
    "unsupported-construct",
  ],
  // N2: a duplicate alias within one level
  [
    "duplicate alias in one level",
    "SELECT 1 FROM spans s JOIN runs s ON s.org_id = ? AND s.project_id = ? WHERE s.org_id = ? AND s.project_id = ?",
    "duplicate-alias:s",
  ],
  [
    "the same table twice without aliases",
    "SELECT 1 FROM spans JOIN spans ON spans.org_id = ? WHERE spans.org_id = ? AND spans.project_id = ?",
    "duplicate-alias:spans",
  ],
  // N1: only [ \t\n\v\f\r] is whitespace
  [
    "U+00A0 is not whitespace",
    "SELECT\u00A01 FROM spans s WHERE s.org_id = ? AND s.project_id = ?",
    "unsupported-construct",
  ],
  [
    "U+2028 is not whitespace",
    "SELECT\u20281 FROM spans s WHERE s.org_id = ? AND s.project_id = ?",
    "unsupported-construct",
  ],
  [
    "U+FEFF is not whitespace",
    "\uFEFFSELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = ?",
    "unsupported-construct",
  ],

  [
    "comma after a subquery in FROM",
    `SELECT 1 FROM (SELECT 1 AS k) x, spans s WHERE ${SCOPE}`,
    "comma-join",
  ],
  [
    "comma after a table with an alias",
    `SELECT 1 FROM spans s, runs r WHERE ${SCOPE}`,
    "comma-join",
  ],
  [
    "comma after a JOIN ON",
    `SELECT 1 FROM runs r JOIN agents a ON a.org_id = ? AND a.project_id = r.project_id, spans s WHERE r.org_id = ? AND r.project_id = ? AND ${SCOPE}`,
    "comma-join",
  ],
  [
    "comma after INDEXED BY",
    `SELECT 1 FROM spans s INDEXED BY spans_run, runs r WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  [
    "comma after NOT INDEXED",
    `SELECT 1 FROM spans s NOT INDEXED, runs r WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  [
    "INDEXED BY alone",
    `SELECT 1 FROM spans s INDEXED BY spans_run WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  [
    "NOT INDEXED alone",
    `SELECT 1 FROM spans s NOT INDEXED WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  ["AS end", `SELECT s.span_id AS end FROM spans s WHERE ${SCOPE}`, "reserved-identifier:end"],
  [
    "end as a table alias",
    `SELECT 1 FROM spans end WHERE ${SCOPE.replaceAll("s.", "end.")}`,
    "unsupported-construct",
  ],
  [
    "end as an explicit table alias",
    `SELECT 1 FROM spans AS end WHERE ${SCOPE.replaceAll("s.", "end.")}`,
    "reserved-identifier:end",
  ],
  [
    "case as an alias",
    `SELECT 1 FROM spans AS case WHERE ${SCOPE.replaceAll("s.", "case.")}`,
    "reserved-identifier:case",
  ],
  [
    "select as an output alias",
    `SELECT 1 AS select FROM spans s WHERE ${SCOPE}`,
    "reserved-identifier:select",
  ],
  [
    "from as an output alias",
    `SELECT 1 AS from FROM spans s WHERE ${SCOPE}`,
    "reserved-identifier:from",
  ],
  [
    "where as an output alias",
    `SELECT 1 AS where FROM spans s WHERE ${SCOPE}`,
    "reserved-identifier:where",
  ],
  ["on as an output alias", `SELECT 1 AS on FROM spans s WHERE ${SCOPE}`, "reserved-identifier:on"],
  [
    "join as an output alias",
    `SELECT 1 AS join FROM spans s WHERE ${SCOPE}`,
    "reserved-identifier:join",
  ],
  [
    "union as an output alias",
    `SELECT 1 AS union FROM spans s WHERE ${SCOPE}`,
    "reserved-identifier:union",
  ],
  [
    "values as an output alias",
    `SELECT 1 AS values FROM spans s WHERE ${SCOPE}`,
    "reserved-identifier:values",
  ],
  ["END without a CASE", `SELECT 1 FROM spans s WHERE ${SCOPE} AND END`, "reserved-identifier:end"],
  [
    "CASE that never ends",
    `SELECT 1 FROM spans s WHERE ${SCOPE} AND CASE WHEN 1 THEN 1`,
    "unsupported-construct",
  ],
  [
    "a second END",
    `SELECT CASE WHEN 1 THEN 1 END END FROM spans s WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  ["an unclosed parenthesis", `SELECT 1 FROM spans s WHERE (${SCOPE}`, "unsupported-construct"],
  [
    "an extra closing parenthesis",
    `SELECT 1 FROM spans s WHERE ${SCOPE})`,
    "unsupported-construct",
  ],
  ["a second statement", `SELECT 1 FROM spans s WHERE ${SCOPE}; SELECT 1`, "unsupported-construct"],
  [
    "an unknown function",
    `SELECT lower(s.span_id) FROM spans s WHERE ${SCOPE}`,
    "unknown-function:lower",
  ],
  [
    "replace() as a function",
    `SELECT replace(s.span_id, 'a', 'b') FROM spans s WHERE ${SCOPE}`,
    "replace",
  ],
  [
    "a table-valued function",
    `SELECT 1 FROM json_each(?) j JOIN spans s ON 1 = 1 WHERE ${SCOPE}`,
    "unparsed-table-reference",
  ],
  ["an unknown column", `SELECT s.bogus FROM spans s WHERE ${SCOPE}`, "unknown-identifier:s.bogus"],
  ["an unknown table", `SELECT 1 FROM bogus s WHERE ${SCOPE}`, "unknown-table:bogus"],
  [
    "an undeclared qualifier",
    `SELECT z.span_id FROM spans s WHERE ${SCOPE}`,
    "unknown-identifier:z.span_id",
  ],
  [
    "RIGHT JOIN",
    `SELECT 1 FROM runs r RIGHT JOIN spans s ON 1 = 1 WHERE ${SCOPE}`,
    "right-full-join",
  ],
  ["CROSS JOIN", `SELECT 1 FROM runs r CROSS JOIN spans s WHERE ${SCOPE}`, "unsupported-construct"],
  [
    "NATURAL JOIN",
    `SELECT 1 FROM runs r NATURAL JOIN spans s WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  [
    "JOIN ... USING",
    `SELECT 1 FROM runs r JOIN spans s USING (run_id) WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  [
    "a window clause",
    `SELECT count(*) OVER () FROM spans s WHERE ${SCOPE}`,
    "unsupported-construct",
  ],
  ["a double-quoted string", `SELECT "x" FROM spans s WHERE ${SCOPE}`, "quoted-identifier"],
];

for (const [label, sql, code] of NEGATIVES) {
  test(`fail-closed lint: ${label}`, () => {
    const v = lintStatement(T(sql));
    assert.ok(v.includes(code), `expected ${code}, got ${v.join(",") || "nothing"}: ${sql}`);
  });
}

test("fail-closed lint: reserved words are never schema identifiers", () => {
  for (const [table, cols] of schemaColumns()) {
    assert.ok(!RESERVED.has(table.toUpperCase()), table);
    for (const c of cols) assert.ok(!RESERVED.has(c.toUpperCase()), `${table}.${c}`);
  }
});

// ---- the generator -------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gen {
  sql: string;
  /** True when every table reference in the statement is scoped by construction. */
  ok: boolean;
  /** Fixed parameters for statements the context binder cannot bind (UPDATE, upsert). */
  params?: string[];
  /** True for a statement that writes. */
  write?: boolean;
}

const KEYWORD_ALIASES = ["end", "case", "select", "from", "where", "on", "join", "union", "values"];
/** Tables of the differential, with the link columns each has. */
const TABLES = {
  agents: ["agent_id"],
  run_agents: ["run_id", "agent_id"],
  spans: ["run_id", "agent_id"],
  runs: ["run_id"],
  log_records: ["run_id"],
  imports: ["run_id"],
} as const;
type TableName = keyof typeof TABLES;
const TABLE_NAMES = Object.keys(TABLES) as TableName[];

class Builder {
  readonly rnd: () => number;
  n = 0;
  constructor(seed: number) {
    this.rnd = rng(seed);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rnd() * xs.length)] as T;
  }
  chance(p: number): boolean {
    return this.rnd() < p;
  }
  alias(): { alias: string; keyword: boolean } {
    this.n++;
    if (this.chance(0.06)) return { alias: this.pick(KEYWORD_ALIASES), keyword: true };
    return { alias: `t${this.n}`, keyword: false };
  }

  /** Scope conjuncts for `al`, possibly broken. `projectFrom` builds the project part by equality. */
  scope(al: string, projectFrom: string | null): { text: string; ok: boolean } {
    const prj =
      projectFrom === null
        ? `${al}.project_id = ?`
        : `${al}.project_id = ${projectFrom}.project_id`;
    const kind = this.pick([
      "ok",
      "ok",
      "ok",
      "ok",
      "omitOrg",
      "omitPrj",
      "not",
      "orOne",
      "caseWrap",
      "caseNested",
      "neq",
      "none",
      "orgOnlyInOr",
      "notWrapped",
    ] as const);
    switch (kind) {
      case "ok":
        return { text: `${al}.org_id = ? AND ${prj}`, ok: true };
      case "omitOrg":
        return { text: prj, ok: false };
      case "omitPrj":
        return { text: `${al}.org_id = ?`, ok: false };
      case "not":
        return { text: `NOT ${al}.org_id = ? AND ${prj}`, ok: false };
      case "notWrapped":
        return { text: `NOT (${al}.org_id = ?) AND ${prj}`, ok: false };
      case "orOne":
        return { text: `(${al}.org_id = ? OR 1 = 1) AND ${prj}`, ok: false };
      case "orgOnlyInOr":
        return { text: `(${al}.org_id = ? OR ${al}.run_id <> ?) AND ${prj}`, ok: false };
      case "caseWrap":
        return { text: `CASE WHEN 0 THEN 1 AND ${al}.org_id = ? AND ${prj} ELSE 1 END`, ok: false };
      case "caseNested":
        return {
          text: `CASE WHEN 1 THEN CASE WHEN 0 THEN 1 AND ${al}.org_id = ? ELSE 1 END ELSE 1 END AND ${prj}`,
          ok: false,
        };
      case "neq":
        return { text: `${al}.org_id <> ? AND ${prj}`, ok: false };
      default:
        return { text: "1 = 1", ok: false };
    }
  }

  single(
    projectFrom: string | null = null,
    table: TableName = this.pick(TABLE_NAMES),
  ): Gen & { alias: string; table: TableName } {
    const { alias, keyword } = this.alias();
    const sc = this.scope(alias, projectFrom);
    const link = TABLES[table][0];
    const sql = `SELECT ${alias}.org_id AS o0, ${alias}.project_id AS o1, ${alias}.${link} AS k FROM ${table} ${alias} WHERE ${sc.text}`;
    return { sql, ok: sc.ok && !keyword, alias, table };
  }

  /** A pair of tables with a common link column. */
  pair(): { a: TableName; b: TableName; col: string } {
    for (;;) {
      const a = this.pick(TABLE_NAMES);
      const b = this.pick(TABLE_NAMES);
      const col = (TABLES[a] as readonly string[]).find((c) =>
        (TABLES[b] as readonly string[]).includes(c),
      );
      if (col !== undefined) return { a, b, col };
    }
  }

  join(): Gen {
    const { a, b, col } = this.pair();
    const x = this.alias();
    const y = this.alias();
    const sa = this.scope(x.alias, null);
    const style = this.pick([
      "whereB",
      "onB",
      "omitB",
      "leftOnA",
      "comma",
      "leftWhereB",
      "leftOnB",
    ] as const);
    const link = `${y.alias}.project_id = ${x.alias}.project_id AND ${y.alias}.${col} = ${x.alias}.${col}`;
    const left = style.startsWith("left");
    const kw = left ? "LEFT JOIN" : "JOIN";
    const sel = `SELECT ${x.alias}.org_id AS o0, ${y.alias}.org_id AS o1, ${x.alias}.${col} AS k FROM ${a} ${x.alias}`;
    let sql: string;
    let okB = true;
    let okA = sa.ok;
    switch (style) {
      case "comma":
        sql = `${sel}, ${b} ${y.alias} WHERE ${sa.text} AND ${link} AND ${y.alias}.org_id = ?`;
        okB = false;
        break;
      case "omitB":
        sql = `${sel} ${kw} ${b} ${y.alias} ON ${link} WHERE ${sa.text}`;
        okB = false;
        break;
      case "leftOnA":
        sql = `${sel} LEFT JOIN ${b} ${y.alias} ON ${link} AND ${x.alias}.org_id = ? AND ${y.alias}.org_id = ? WHERE ${x.alias}.project_id = ?`;
        okA = false;
        break;
      case "onB":
        sql = `${sel} JOIN ${b} ${y.alias} ON ${link} AND ${y.alias}.org_id = ? WHERE ${sa.text}`;
        break;
      case "leftOnB":
        sql = `${sel} LEFT JOIN ${b} ${y.alias} ON ${link} AND ${y.alias}.org_id = ? WHERE ${sa.text}`;
        break;
      case "leftWhereB":
        sql = `${sel} LEFT JOIN ${b} ${y.alias} ON ${link} WHERE ${sa.text} AND ${y.alias}.org_id = ?`;
        break;
      default:
        sql = `${sel} JOIN ${b} ${y.alias} ON ${link} WHERE ${sa.text} AND ${y.alias}.org_id = ?`;
    }
    // a self-join without distinct aliases is refused by the duplicate-alias rule (the aliases differ here)
    return { sql, ok: okA && okB && !x.keyword && !y.keyword };
  }

  compound(): Gen {
    const l = this.single();
    const r = this.single();
    const op = this.pick(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"]);
    return { sql: `${l.sql} ${op} ${r.sql}`, ok: l.ok && r.ok };
  }

  subIn(): Gen {
    const o = this.single();
    const t = this.pick(
      TABLE_NAMES.filter((n) => (TABLES[n] as readonly string[]).includes(TABLES[o.table][0])),
    );
    const col = TABLES[o.table][0];
    const inner = this.single(this.chance(0.5) ? o.alias : null, t);
    const innerSql = inner.sql.replace(/SELECT .* FROM/, `SELECT ${inner.alias}.${col} FROM`);
    return { sql: `${o.sql} AND ${o.alias}.${col} IN (${innerSql})`, ok: o.ok && inner.ok };
  }

  exists(): Gen {
    const o = this.single();
    const col = TABLES[o.table][0];
    const t = this.pick(TABLE_NAMES.filter((n) => (TABLES[n] as readonly string[]).includes(col)));
    const r = this.alias();
    const sr = this.scope(r.alias, o.alias);
    const neg = this.chance(0.3) ? "NOT " : "";
    return {
      sql: `${o.sql} AND ${neg}EXISTS (SELECT 1 FROM ${t} ${r.alias} WHERE ${sr.text} AND ${r.alias}.${col} = ${o.alias}.${col})`,
      ok: o.ok && sr.ok && !r.keyword,
    };
  }

  derived(): Gen {
    const inner = this.single(null);
    const { a, col } = this.pair();
    const x = this.alias();
    const sx = this.scope(x.alias, null);
    const d = `d${this.n}`;
    const innerSql = inner.sql.replace(
      /SELECT .* FROM/,
      `SELECT ${inner.alias}.org_id AS o0, ${inner.alias}.${TABLES[inner.table][0]} AS k FROM`,
    );
    void a;
    void col;
    const join = this.chance(0.5) ? "JOIN" : "LEFT JOIN";
    const kcol = TABLES[inner.table][0];
    const other = this.pick(
      TABLE_NAMES.filter((n) => (TABLES[n] as readonly string[]).includes(kcol)),
    );
    return {
      sql: `SELECT ${d}.o0 AS o0, ${x.alias}.org_id AS o1, ${d}.k AS k FROM (${innerSql}) ${d} ${join} ${other} ${x.alias} ON ${x.alias}.${kcol} = ${d}.k WHERE ${sx.text}`,
      ok: inner.ok && sx.ok && !x.keyword,
    };
  }

  scalarSub(): Gen {
    const o = this.single();
    const col = TABLES[o.table][0];
    const t = this.pick(TABLE_NAMES.filter((n) => (TABLES[n] as readonly string[]).includes(col)));
    const r = this.alias();
    const sr = this.scope(r.alias, this.chance(0.5) ? o.alias : null);
    return {
      sql: o.sql.replace(
        " FROM ",
        `, (SELECT MAX(${r.alias}.org_id) FROM ${t} ${r.alias} WHERE ${sr.text}) AS o2 FROM `,
      ),
      ok: o.ok && sr.ok && !r.keyword,
    };
  }

  /** WITH in any position: the whole family is refused, whatever the CTE is named. */
  withForm(): Gen {
    const name = this.pick(["spans", "runs", "agents", "x", "imports", "log_records"]);
    const body = `SELECT 1 AS org_id, 1 AS project_id, 1 AS k`;
    const real = this.single();
    const where = this.pick(["top", "scalar", "exists", "in", "derived", "arm2"] as const);
    const cte = `WITH ${name} AS (${body})`;
    switch (where) {
      case "top":
        return { sql: `${cte} ${real.sql}`, ok: false };
      case "scalar":
        return {
          sql: real.sql.replace(" FROM ", `, (${cte} SELECT org_id FROM ${name}) AS q FROM `),
          ok: false,
        };
      case "exists":
        return { sql: `${real.sql} AND EXISTS (${cte} SELECT 1 FROM ${name})`, ok: false };
      case "in":
        return {
          sql: `${real.sql} AND ${real.alias}.org_id IN (${cte} SELECT org_id FROM ${name})`,
          ok: false,
        };
      case "derived":
        return {
          sql: `SELECT 1 AS o0 FROM (${cte} SELECT org_id AS o0 FROM ${name}) d JOIN runs r ON r.org_id = ? AND r.project_id = ?`,
          ok: false,
        };
      default:
        return {
          sql: `${real.sql} UNION SELECT 1, 1, 1 FROM spans WHERE EXISTS (${cte} SELECT 1 FROM ${name})`,
          ok: false,
        };
    }
  }

  update(): Gen {
    const table = this.pick(["agents", "runs"] as const);
    const set = table === "agents" ? "display_name" : "end_evidence";
    const ret = this.chance(0.5)
      ? ` RETURNING ${table === "agents" ? "agent_id, org_id" : "run_id, org_id"}`
      : "";
    const kind = this.pick([
      "ok",
      "ok",
      "omitOrg",
      "omitPrj",
      "or",
      "setOrg",
      "orResolution",
      "none",
    ] as const);
    const idc = table === "agents" ? "agent_id" : "run_id";
    switch (kind) {
      case "ok":
        return {
          sql: `UPDATE ${table} SET ${set} = ? WHERE org_id = ? AND project_id = ? AND ${idc} = ?${ret}`,
          ok: true,
          write: true,
          params: ["x", "A", "P1", `${idc === "agent_id" ? "agent" : "run"}_0`],
        };
      case "omitOrg":
        return {
          sql: `UPDATE ${table} SET ${set} = ? WHERE project_id = ? AND ${idc} = ?${ret}`,
          ok: false,
          write: true,
        };
      case "omitPrj":
        return {
          sql: `UPDATE ${table} SET ${set} = ? WHERE org_id = ? AND ${idc} = ?${ret}`,
          ok: false,
          write: true,
        };
      case "or":
        return {
          sql: `UPDATE ${table} SET ${set} = ? WHERE org_id = ? AND project_id = ? OR ${idc} = ?${ret}`,
          ok: false,
          write: true,
        };
      case "setOrg":
        return {
          sql: `UPDATE ${table} SET org_id = ? WHERE org_id = ? AND project_id = ?${ret}`,
          ok: false,
          write: true,
        };
      case "orResolution":
        return {
          sql: `UPDATE OR REPLACE ${table} SET ${set} = ? WHERE org_id = ? AND project_id = ?${ret}`,
          ok: false,
          write: true,
        };
      default:
        return { sql: `UPDATE ${table} SET ${set} = ?${ret}`, ok: false, write: true };
    }
  }

  upsert(): Gen {
    const cols =
      "(org_id, project_id, agent_id, agent_key, key_basis, display_name, first_seen_ms, last_seen_ms)";
    const kind = this.pick([
      "ok",
      "ok",
      "literalOrg",
      "targetNoOrg",
      "targetNoProject",
      "setOrg",
      "multiRow",
      "replace",
      "returning",
    ] as const);
    const vals = "(?, ?, ?, ?, ?, ?, ?, ?)";
    const base = `INSERT INTO agents ${cols} VALUES ${vals}`;
    const tgt = "ON CONFLICT (org_id, project_id, agent_id)";
    const params = ["A", "P1", "agent_0", "key_0", "b", "n", "1", "2"];
    switch (kind) {
      case "ok":
        return {
          sql: `${base} ${tgt} DO UPDATE SET display_name = excluded.display_name`,
          ok: true,
          write: true,
          params,
        };
      case "returning":
        return {
          sql: `${base} ${tgt} DO UPDATE SET last_seen_ms = MAX(agents.last_seen_ms, excluded.last_seen_ms)`,
          ok: true,
          write: true,
          params,
        };
      case "literalOrg":
        return {
          sql: `INSERT INTO agents ${cols} VALUES ('org_x', ?, ?, ?, ?, ?, ?, ?) ${tgt} DO NOTHING`,
          ok: false,
          write: true,
        };
      case "targetNoOrg":
        return {
          sql: `${base} ON CONFLICT (agent_id) DO UPDATE SET display_name = excluded.display_name`,
          ok: false,
          write: true,
        };
      case "targetNoProject":
        return { sql: `${base} ON CONFLICT (org_id, agent_id) DO NOTHING`, ok: false, write: true };
      case "setOrg":
        return {
          sql: `${base} ${tgt} DO UPDATE SET org_id = excluded.org_id`,
          ok: false,
          write: true,
        };
      case "multiRow":
        return { sql: `${base}, ${vals} ${tgt} DO NOTHING`, ok: false, write: true };
      default:
        return {
          sql: `INSERT OR REPLACE INTO agents ${cols} VALUES ${vals}`,
          ok: false,
          write: true,
        };
    }
  }

  any(): Gen {
    return this.pick([
      () => this.single(),
      () => this.join(),
      () => this.join(),
      () => this.compound(),
      () => this.subIn(),
      () => this.exists(),
      () => this.derived(),
      () => this.scalarSub(),
      () => this.withForm(),
      () => this.update(),
      () => this.upsert(),
    ])();
  }
}

// ---- the two-org, three-project database -----------------------------------------------------------
const ORG_A = `org_${"a".repeat(32)}`;
const ORG_B = `org_${"b".repeat(32)}`;
const P1 = `prj_${"1".repeat(32)}`;
const P2 = `prj_${"2".repeat(32)}`;
const P3 = `prj_${"3".repeat(32)}`;
/** The scope every generated statement is bound to. */
const BOUND = { A: ORG_A, P1 } as const;
/** Every (org, project): P1 also exists in org B (an ID collision), and org A has a second project. */
const GROUPS: [string, string][] = [
  [ORG_A, P1],
  [ORG_A, P2],
  [ORG_B, P3],
  [ORG_B, P1],
];

function seed(db: DatabaseSync, only: boolean): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA ignore_check_constraints = ON");
  for (const table of Object.keys(TABLES)) {
    const cols = db.prepare("SELECT name, type FROM pragma_table_info(?)").all(table) as {
      name: string;
      type: string;
    }[];
    const names = cols.map((c) => c.name);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    );
    for (const [org, prj] of GROUPS) {
      if (only && !(org === ORG_A && prj === P1)) continue;
      for (let k = 0; k < 2; k++) {
        const vals = cols.map((c) => {
          if (c.name === "org_id") return org;
          if (c.name === "project_id") return prj;
          if (c.name === "agent_id") return `agent_${k}`;
          if (c.name === "run_id") return `run_${k}`;
          if (c.type === "INTEGER") return k + 1;
          if (c.type === "BLOB") return new Uint8Array([k]);
          return `${c.name}_${k}`;
        });
        stmt.run(...(vals as never[]));
      }
    }
  }
}

function fullDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  seed(db, false);
  return db;
}
function reducedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  seed(db, true);
  return db;
}

/** Parameters from the text before each `?`: scope comparisons are bound to the scope. */
function bind(sql: string): string[] {
  const out: string[] = [];
  for (let i = sql.indexOf("?"); i !== -1; i = sql.indexOf("?", i + 1)) {
    const before = sql.slice(Math.max(0, i - 30), i);
    if (/org_id\s*(=|<>)\s*$/.test(before)) out.push(BOUND.A);
    else if (/project_id\s*(=|<>)\s*$/.test(before)) out.push(BOUND.P1);
    else out.push("run_0");
  }
  return out;
}

const json = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Result set of a read, as sorted JSON rows; null when SQLite refuses the statement. */
function resultSet(db: DatabaseSync, sql: string, params: string[]): string[] | null {
  try {
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => json(Object.values(r))).sort();
  } catch {
    return null;
  }
}

function snapshot(db: DatabaseSync): string {
  const out: string[] = [];
  for (const t of Object.keys(TABLES)) {
    const rows = db
      .prepare(`SELECT * FROM ${t} WHERE NOT (org_id = ? AND project_id = ?)`)
      .all(ORG_A, P1);
    out.push(`${t}:${json(rows.map((r) => Object.values(r)).sort())}`);
  }
  return out.join("|");
}

function paramsOf(g: Gen, sql: string): string[] {
  if (g.params !== undefined) return g.params.map((p) => (p === "A" ? ORG_A : p === "P1" ? P1 : p));
  return bind(sql);
}

/** One differential check of an accepted statement; returns true when it ran on both databases. */
function differential(full: DatabaseSync, reduced: DatabaseSync, g: Gen, sql: string): boolean {
  const params = paramsOf(g, sql);
  if ((sql.match(/\?/g) ?? []).length !== params.length) return false;
  if (g.write === true) {
    const before = snapshot(full);
    try {
      full.prepare(sql).all(...params);
    } catch {
      return false;
    }
    assert.equal(snapshot(full), before, `accepted write touches rows outside its scope: ${sql}`);
    return true;
  }
  const a = resultSet(full, sql, params);
  const b = resultSet(reduced, sql, params);
  if (a === null || b === null) return false;
  assert.deepEqual(a, b, `accepted statement sees rows outside its scope: ${sql}`);
  return true;
}

test("generator: every statement with an unscoped reference is rejected; every scoped one is accepted", () => {
  const b = new Builder(20260101);
  let bad = 0;
  let good = 0;
  let writes = 0;
  let withs = 0;
  for (let i = 0; i < 6000; i++) {
    const g = b.any();
    const v = lintStatement(T(g.sql));
    if (/\bWITH\b/.test(g.sql)) withs++;
    if (g.write === true) writes++;
    if (g.ok) {
      good++;
      assert.deepEqual(v, [], `well-scoped statement rejected: ${g.sql}`);
    } else {
      bad++;
      assert.notDeepEqual(v, [], `unscoped statement accepted: ${g.sql}`);
    }
  }
  console.log(`GEN good=${good} bad=${bad} writes=${writes} with=${withs}`);
  assert.ok(
    good > 500 && bad > 1500 && writes > 300 && withs > 200,
    `generator is lopsided: ${good}/${bad}/${writes}/${withs}`,
  );
});

test("differential: an accepted statement gives the same result on the full DB and on a DB holding only its scope", () => {
  const full = fullDb();
  const reduced = reducedDb();
  try {
    const b = new Builder(7);
    let accepted = 0;
    let ran = 0;
    let rejectedThatDiffer = 0;
    for (let i = 0; i < 6000; i++) {
      const g = b.any();
      const v = lintStatement(T(g.sql));
      if (v.length === 0) {
        accepted++;
        if (differential(full, reduced, g, g.sql)) ran++;
      } else if (g.write !== true && !/\bWITH\b/.test(g.sql)) {
        const params = bind(g.sql);
        const x = resultSet(full, g.sql, params);
        const y = resultSet(reduced, g.sql, params);
        if (x !== null && y !== null && json(x) !== json(y)) rejectedThatDiffer++;
      }
    }
    console.log(`DIFF accepted=${accepted} ran=${ran} rejectedThatDiffer=${rejectedThatDiffer}`);
    assert.ok(accepted > 500 && ran > 400, `too few accepted statements ran: ${accepted}/${ran}`);
    // the oracle can fail: many rejected statements really do see other orgs or projects
    assert.ok(rejectedThatDiffer > 300, `the rejected set never differed: ${rejectedThatDiffer}`);
  } finally {
    full.close();
    reduced.close();
  }
});

test("differential: random mutations (parameters re-bound) of generated statements never see outside their scope once accepted", () => {
  const full = fullDb();
  const reduced = reducedDb();
  try {
    const b = new Builder(99);
    const r = rng(1234);
    const SWAPS: [RegExp, string][] = [
      [/ AND /, " OR "],
      [/ = /, " <> "],
      [/ JOIN /, ", "],
      [/ WHERE /, " WHERE NOT "],
      [/\bAND\b/, "OR 1 = 1 AND"],
      [/\(/, "(1 = 1 OR "],
      [/\bFROM\b/, "FROM (SELECT 1 AS k) z, "],
      [/\borg_id = \?/, "org_id IS NOT NULL"],
      [/\bproject_id = \?/, "project_id <> 'x'"],
      [/ UNION /, " UNION SELECT 1, 1, 1 FROM agents x WHERE 1 = 1 UNION "],
      [/\bEXISTS\b/, "NOT EXISTS"],
      [/\bAS o0\b/, "AS end"],
      [/\bWHERE\b/, "WHERE CASE WHEN 1 THEN 1 END AND"],
      [/\bSELECT\b/, "WITH q AS (SELECT 1) SELECT"],
      [/\bFROM (\w+) (\w+)/, "FROM $1 $2 INDEXED BY x"],
      [/\bFROM (\w+) (\w+)/, "FROM $1 $2 JOIN $1 $2 ON 1 = 1"],
      [/\bproject_id = \?/, "project_id = ? OR 1 = 1"],
    ];
    let accepted = 0;
    let ran = 0;
    let removedParam = 0;
    for (let i = 0; i < 10000; i++) {
      const g = b.any();
      if (g.write === true) continue;
      let sql = g.sql;
      const rounds = 1 + Math.floor(r() * 2);
      for (let k = 0; k < rounds; k++) {
        const [re, to] = SWAPS[Math.floor(r() * SWAPS.length)] as [RegExp, string];
        sql = sql.replace(re, to);
      }
      if ((sql.match(/\?/g) ?? []).length < (g.sql.match(/\?/g) ?? []).length) removedParam++;
      if (lintStatement(T(sql)).length > 0) continue;
      accepted++;
      // parameters are re-bound from the mutated text, so a removed `?` is still tested
      if (differential(full, reduced, { sql: sql, ok: true }, sql)) ran++;
    }
    console.log(`MUT accepted=${accepted} ran=${ran} removedParam=${removedParam}`);
    assert.ok(
      accepted > 100 && ran > 100 && removedParam > 500,
      `too few: ${accepted}/${ran}/${removedParam}`,
    );
  } finally {
    full.close();
    reduced.close();
  }
});
