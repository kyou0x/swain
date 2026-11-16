import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MIGRATIONS } from "../src/index.js";
import { lintStatement } from "../src/sqlite/lint.js";
import { lintRegistry, type Pins } from "../src/sqlite/registry-lint.js";
import {
  EVIDENCE_TABLES,
  NON_TENANT_STATEMENTS,
  ORG_WIDE_STATEMENTS,
  STATEMENTS,
  type StatementDef,
  UNSCOPED_STATEMENTS,
} from "../src/sqlite/statements.js";

const PINS: Pins = {
  unscoped: UNSCOPED_STATEMENTS,
  orgWide: ORG_WIDE_STATEMENTS,
  nonTenant: NON_TENANT_STATEMENTS,
};

const T = (sql: string, extra: Partial<StatementDef> = {}): StatementDef => ({
  tenant: true,
  sql,
  ...extra,
});

test("tenant lint: every statement in the real registry passes", () => {
  assert.deepEqual(lintRegistry(STATEMENTS, PINS), []);
});

test("tenant lint: the pinned lists are exactly the tagged statements", () => {
  const entries = Object.entries(STATEMENTS) as [string, StatementDef][];
  const names = (f: (d: StatementDef) => boolean): string[] =>
    entries
      .filter(([, d]) => f(d))
      .map(([n]) => n)
      .sort();
  assert.deepEqual(
    names((d) => d.unscoped !== undefined),
    [...UNSCOPED_STATEMENTS].sort(),
  );
  assert.deepEqual(
    names((d) => d.orgWide === true),
    [...ORG_WIDE_STATEMENTS].sort(),
  );
  assert.deepEqual(
    names((d) => !d.tenant),
    [...NON_TENANT_STATEMENTS].sort(),
  );
  // the unscoped reads are exactly findKey, login codes, sessions and the local-org bootstrap
  assert.deepEqual([...UNSCOPED_STATEMENTS].sort(), [
    "key.byId",
    "login.consume",
    "org.bySlug",
    "session.revoke",
    "session.touch",
  ]);
});

test("tenant lint: a new tenant:false or unscoped or org-wide statement fails until pinned", () => {
  const extra: Record<string, StatementDef> = {
    ...(STATEMENTS as Record<string, StatementDef>),
    "evil.nontenant": { tenant: false, sql: "SELECT * FROM spans" },
  };
  const v = lintRegistry(extra, PINS);
  assert.ok(v.includes("evil.nontenant:tenant-table-in-untagged-statement:spans"), v.join());
  assert.ok(v.includes("evil.nontenant:unpinned-non-tenant"));
  // even a harmless-looking one needs a reviewed pin
  const harmless = lintRegistry(
    {
      ...(STATEMENTS as Record<string, StatementDef>),
      "x.y": { tenant: false, sql: "SELECT 1 AS n" },
    },
    PINS,
  );
  assert.deepEqual(harmless, ["x.y:unpinned-non-tenant"]);
  const unscoped = lintRegistry(
    {
      ...(STATEMENTS as Record<string, StatementDef>),
      "x.z": T("SELECT org_id FROM orgs WHERE slug = ?", { unscoped: "bootstrap" }),
    },
    PINS,
  );
  assert.deepEqual(unscoped, ["x.z:unpinned-unscoped"]);
  const wide = lintRegistry(
    {
      ...(STATEMENTS as Record<string, StatementDef>),
      "x.w": T("SELECT run_id FROM runs WHERE org_id = ?", { orgWide: true }),
    },
    PINS,
  );
  assert.deepEqual(wide, ["x.w:unpinned-org-wide"]);
  // a pin that points at nothing is also an error
  assert.ok(lintRegistry({}, PINS).some((x) => x.includes("pin-missing")));
});

const GOOD_ORG_PROJECT = "a.org_id = ? AND a.project_id = ?";

test("tenant lint: hostile statements are rejected, with the reason", () => {
  const cases: [string, StatementDef, string][] = [
    ["no org_id", T("SELECT * FROM spans WHERE trace_id = ?"), "org-id-unconstrained:spans"],
    [
      "join alias not constrained",
      T(
        "SELECT * FROM runs r JOIN spans s ON s.run_id = r.run_id WHERE r.org_id = ? AND r.project_id = ?",
      ),
      "org-id-unconstrained:s",
    ],
    [
      "subquery not constrained",
      T(
        "SELECT * FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND EXISTS (SELECT 1 FROM spans s WHERE s.run_id = r.run_id)",
      ),
      "org-id-unconstrained:s",
    ],
    [
      "WITH is not in the subset (a CTE is refused, scoped or not)",
      T(
        "WITH x AS (SELECT run_id FROM spans WHERE trace_id = ?) SELECT * FROM runs r WHERE r.org_id = ? AND r.project_id = ?",
      ),
      "unsupported-construct",
    ],
    [
      "same alias reused for an unconstrained second reference",
      T(
        "SELECT * FROM agents a WHERE a.org_id = ? AND a.project_id = ? AND a.agent_id IN (SELECT agent_id FROM agents a WHERE a.project_id = ?)",
      ),
      "org-id-unconstrained:a",
    ],
    [
      "a comment is not in the subset (and its org_id never counts)",
      T("SELECT * FROM spans s WHERE s.trace_id = ? -- s.org_id = ?"),
      "comment",
    ],
    [
      "org_id compared to itself does not count",
      T("SELECT * FROM spans s WHERE s.org_id = s.org_id AND s.project_id = ?"),
      "org-id-unconstrained:s",
    ],
    [
      "org_id compared to a literal does not count",
      T("SELECT * FROM spans s WHERE s.org_id = 'org_x' AND s.project_id = ?"),
      "org-id-unconstrained:s",
    ],
    [
      "top-level OR",
      T("SELECT * FROM agents a WHERE a.org_id = ? AND a.project_id = ? OR a.agent_id = ?"),
      "top-level-or",
    ],
    ["no project_id", T("SELECT * FROM spans s WHERE s.org_id = ?"), "project-id-unconstrained:s"],
    [
      "project only via an unconstrained alias",
      T(
        "SELECT * FROM runs r JOIN spans s ON s.project_id = r.project_id AND s.org_id = ? WHERE r.org_id = ?",
      ),
      "project-id-unconstrained:r",
    ],
    [
      "insert sets org_id from a literal",
      T(
        "INSERT INTO agents (org_id, project_id, agent_id, agent_key, key_basis, display_name, first_seen_ms, last_seen_ms) VALUES ('org_x', ?, ?, ?, ?, ?, ?, ?)",
      ),
      "insert-org_id-not-bound",
    ],
    [
      "insert without org_id",
      T("INSERT INTO resources (project_id, resource_sha256, attributes_json) VALUES (?, ?, ?)"),
      "insert-org_id-not-bound",
    ],
    [
      "insert without project_id",
      T("INSERT INTO resources (org_id, resource_sha256, attributes_json) VALUES (?, ?, ?)"),
      "insert-project_id-not-bound",
    ],
    [
      "update rewrites org_id",
      T("UPDATE runs SET org_id = ? WHERE org_id = ? AND project_id = ? AND run_id = ?"),
      "set-org_id",
    ],
    [
      "upsert rewrites org_id",
      T(
        "INSERT INTO resources (org_id, project_id, resource_sha256, attributes_json) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, project_id, resource_sha256) DO UPDATE SET org_id = excluded.org_id",
      ),
      "set-org_id",
    ],
    ["LIKE", T(`SELECT * FROM runs a WHERE ${GOOD_ORG_PROJECT} AND a.run_id LIKE ?`), "like"],
    [
      "comma join",
      T("SELECT * FROM runs a, spans b WHERE a.org_id = ? AND a.project_id = ? AND b.org_id = ?"),
      "comma-join",
    ],
    [
      "untagged statement on a tenant table",
      { tenant: false, sql: "SELECT COUNT(*) AS n FROM runs" },
      "tenant-table-in-untagged-statement:runs",
    ],
    [
      "tagged tenant without a tenant table",
      T("SELECT 1 AS n"),
      "tagged-tenant-without-tenant-table",
    ],
  ];
  for (const [label, def, expected] of cases) {
    const v = lintStatement(def);
    assert.ok(
      v.includes(expected),
      `${label}: expected ${expected}, got ${v.join(",") || "nothing"}`,
    );
  }
});

test("tenant lint: well-formed statements pass (joins, subqueries, parenthesized OR)", () => {
  const good: StatementDef[] = [
    T("SELECT * FROM spans s WHERE s.org_id = ? AND s.project_id = ? AND s.run_id = ?"),
    T("SELECT * FROM spans WHERE org_id = ? AND project_id = ? AND (? IS NULL OR kind = ?)"),
    T(
      "SELECT * FROM runs r JOIN spans s ON s.org_id = ? AND s.project_id = r.project_id WHERE r.org_id = ? AND r.project_id = ?",
    ),
    T(
      "SELECT * FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND EXISTS (SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = r.project_id AND s.run_id = r.run_id)",
    ),
    T(
      "INSERT INTO resources (org_id, project_id, resource_sha256, attributes_json) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, project_id, resource_sha256) DO NOTHING",
    ),
    T(
      "UPDATE ingest_keys SET revoked_at_ms = ? WHERE org_id = ? AND project_id = ? AND key_id = ?",
    ),
  ];
  for (const d of good) assert.deepEqual(lintStatement(d), [], d.sql);
});

test("registry: no bound or interpolated ORDER BY; sort variants are separate statements", () => {
  for (const [n, d] of Object.entries(STATEMENTS) as [string, StatementDef][]) {
    assert.ok(!/ORDER\s+BY\s+\?/i.test(d.sql), n);
    assert.ok(!d.sql.includes("${") && !d.sql.includes("undefined"), n);
  }
  assert.notEqual(STATEMENTS["fleet.listRecent"].sql, STATEMENTS["fleet.listName"].sql);
});

test("registry: every statement prepares against migration 0001", () => {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  for (const [name, def] of Object.entries(STATEMENTS) as [string, StatementDef][]) {
    if (name === "mig.backup") continue; // VACUUM INTO has no in-memory target; exercised in migrations.test
    assert.doesNotThrow(() => db.prepare(def.sql), name);
  }
  db.close();
});

test("registry: SQL appears only in the registry, the migrations and the open/migrate plumbing", () => {
  const dir = new URL("../../src/sqlite/", import.meta.url);
  for (const f of readdirSync(dir)) {
    if (f === "lint.ts" || f === "registry-lint.ts") continue; // text analysis (RegExp.exec), no database
    const text = readFileSync(new URL(f, dir), "utf8");
    const prepares = (text.match(/\.prepare\(/g) ?? []).length;
    const execs = (text.match(/\bdb\.exec\(/g) ?? []).length;
    if (f !== "db.ts" && f !== "open.ts") assert.equal(prepares, 0, `${f} prepares SQL`);
    if (f !== "open.ts" && f !== "migrate.ts") assert.equal(execs, 0, `${f} execs SQL`);
    if (f === "store.ts") {
      assert.ok(
        !/["'`]\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\s/.test(text),
        "store.ts holds raw SQL",
      );
    }
  }
});

// ---- append-only evidence (r2 F4) -----------------------------------------------------------------
/** Tables an `UPDATE`, `DELETE` or `ON CONFLICT ... DO UPDATE` in `sql` writes to. */
function mutatedTables(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(
    /\bUPDATE\s+(?:OR\s+(?:IGNORE|ABORT|FAIL|ROLLBACK|REPLACE)\s+)?(\w+)\s+SET\b/gi,
  ))
    out.push((m[1] ?? "").toLowerCase());
  for (const m of sql.matchAll(/\bDELETE\s+FROM\s+(\w+)/gi)) out.push((m[1] ?? "").toLowerCase());
  const ins = /\bINSERT\s+(?:OR\s+(?:IGNORE|ABORT|FAIL|ROLLBACK|REPLACE)\s+)?INTO\s+(\w+)/i.exec(
    sql,
  );
  if (ins !== null && /\bDO\s+UPDATE\b/i.test(sql)) out.push((ins[1] ?? "").toLowerCase());
  return out;
}

test("registry: no statement updates or deletes an evidence (L0/L1) table", () => {
  const evidence = new Set(EVIDENCE_TABLES);
  const mutating: string[] = [];
  for (const [name, def] of Object.entries(STATEMENTS) as [string, StatementDef][]) {
    assert.ok(!/\bDELETE\b/i.test(def.sql), `${name} deletes`);
    assert.ok(!/\bREPLACE\b/i.test(def.sql), `${name} uses REPLACE`);
    const tables = mutatedTables(def.sql);
    if (tables.length > 0) mutating.push(name);
    for (const t of tables) assert.ok(!evidence.has(t), `${name} mutates evidence table ${t}`);
  }
  // the complete list of statements that change rows at all: a new one needs a reviewer
  assert.deepEqual(mutating.sort(), [
    "agent.upsert",
    "key.revoke",
    "login.consume",
    "prj.setPolicy",
    "run.refresh",
    "run.upsert",
    "session.revoke",
    "session.touch",
  ]);
  // the detector itself catches the forbidden shapes
  assert.deepEqual(mutatedTables("UPDATE spans SET late = 1 WHERE x = ?"), ["spans"]);
  assert.deepEqual(mutatedTables("DELETE FROM imports WHERE x = ?"), ["imports"]);
  assert.deepEqual(mutatedTables("UPDATE OR IGNORE spans SET late = 1 WHERE x = ?"), ["spans"]);
  assert.deepEqual(
    mutatedTables(
      "INSERT OR IGNORE INTO events (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = 1",
    ),
    ["events"],
  );
  assert.deepEqual(
    mutatedTables("INSERT INTO events (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET a = 1"),
    ["events"],
  );
  assert.deepEqual(
    mutatedTables("INSERT INTO events (a) VALUES (?) ON CONFLICT (a) DO NOTHING"),
    [],
  );
});

test("registry: evidence table names exist in the DDL; L2 tables are not evidence", () => {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as {
    name: string;
  }[];
  db.close();
  const tables = new Set(rows.map((r) => r.name));
  for (const t of EVIDENCE_TABLES) assert.ok(tables.has(t), t);
  assert.ok(!EVIDENCE_TABLES.includes("runs") && !EVIDENCE_TABLES.includes("agents"));
});

// ---- tenant lint bypasses (G3 C5/C6): one negative test per bypass -------------------------------
const SPAN_INSERT = "INSERT INTO spans (org_id, project_id, trace_id, span_id) VALUES (?, ?, ?, ?)";
const BYPASSES: [string, string, string][] = [
  [
    "NOT before the org comparison",
    "SELECT * FROM spans s WHERE NOT s.org_id = ? AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "NOT around the org comparison",
    "SELECT * FROM spans s WHERE NOT (s.org_id = ?) AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "!= instead of =",
    "SELECT * FROM spans s WHERE s.org_id != ? AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "<> instead of =",
    "SELECT * FROM spans s WHERE s.org_id <> ? AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "NOT before the project comparison",
    "SELECT * FROM spans s WHERE s.org_id = ? AND NOT s.project_id = ?",
    "project-id-unconstrained:s",
  ],
  [
    "(org_id = ? OR 1=1)",
    "SELECT * FROM spans s WHERE (s.org_id = ? OR 1 = 1) AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "(project_id = ? OR 1=1)",
    "SELECT * FROM spans s WHERE s.org_id = ? AND (s.project_id = ? OR 1 = 1)",
    "project-id-unconstrained:s",
  ],
  [
    "scope in the SELECT list",
    "SELECT s.org_id = ? AS ok FROM spans s WHERE s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "scope in a CASE",
    "SELECT * FROM spans s WHERE CASE WHEN s.org_id = ? THEN 1 ELSE 0 END = 1 AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "scope in ORDER BY",
    "SELECT * FROM spans s WHERE s.project_id = ? ORDER BY s.org_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "scope only in HAVING/GROUP BY",
    "SELECT COUNT(*) FROM spans s WHERE s.project_id = ? GROUP BY s.org_id HAVING s.org_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "scope of the left table only in a LEFT JOIN ON",
    "SELECT * FROM runs r LEFT JOIN spans s ON r.org_id = ? AND r.project_id = ? AND s.org_id = ? AND s.project_id = r.project_id",
    "org-id-unconstrained:r",
  ],
  [
    "outer-join ON equality does not constrain the left table",
    "SELECT * FROM runs r LEFT JOIN spans s ON s.org_id = ? AND s.project_id = ? AND r.project_id = s.project_id WHERE r.org_id = ?",
    "project-id-unconstrained:r",
  ],
  [
    "constraint only in an enclosing level",
    "SELECT * FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND r.run_id IN (SELECT s.run_id FROM spans s WHERE s.project_id = r.project_id)",
    "org-id-unconstrained:s",
  ],
  [
    "schema-qualified table",
    "SELECT * FROM main.spans s WHERE s.org_id = ? AND s.project_id = ?",
    "schema-qualified:main",
  ],
  [
    "schema-qualified in a join",
    "SELECT * FROM runs r JOIN temp.spans s ON s.org_id = ? WHERE r.org_id = ? AND r.project_id = ?",
    "schema-qualified:temp",
  ],
  [
    "double-quoted identifier",
    'SELECT * FROM "spans" s WHERE s.org_id = ? AND s.project_id = ?',
    "quoted-identifier",
  ],
  [
    "bracketed identifier",
    "SELECT * FROM [spans] s WHERE s.org_id = ? AND s.project_id = ?",
    "quoted-identifier",
  ],
  [
    "backtick identifier",
    "SELECT * FROM `spans` s WHERE s.org_id = ? AND s.project_id = ?",
    "quoted-identifier",
  ],
  [
    "numbered parameter",
    "SELECT * FROM spans s WHERE s.org_id = ?2 AND s.project_id = ?",
    "non-positional-parameter:?2",
  ],
  [
    "named parameter :x",
    "SELECT * FROM spans s WHERE s.org_id = :x AND s.project_id = ?",
    "non-positional-parameter::x",
  ],
  [
    "named parameter @x",
    "SELECT * FROM spans s WHERE s.org_id = @x AND s.project_id = ?",
    "non-positional-parameter:@x",
  ],
  [
    "named parameter $x",
    "SELECT * FROM spans s WHERE s.org_id = $x AND s.project_id = ?",
    "non-positional-parameter:$x",
  ],
  [
    "INSERT OR REPLACE",
    `INSERT OR REPLACE INTO spans (org_id, project_id, trace_id, span_id) VALUES (?, ?, ?, ?)`,
    "replace",
  ],
  [
    "REPLACE INTO",
    `REPLACE INTO spans (org_id, project_id, trace_id, span_id) VALUES (?, ?, ?, ?)`,
    "replace",
  ],
  [
    "replace() function",
    "SELECT replace(s.name_json, 'a', 'b') FROM spans s WHERE s.org_id = ? AND s.project_id = ?",
    "replace",
  ],
  [
    "upsert target without the scope",
    `${SPAN_INSERT} ON CONFLICT (trace_id, span_id) DO NOTHING`,
    "upsert-target-unscoped",
  ],
  ["upsert without a target", `${SPAN_INSERT} ON CONFLICT DO NOTHING`, "unsupported-construct"],
  [
    "upsert target with org_id only (project table)",
    `${SPAN_INSERT} ON CONFLICT (org_id, trace_id) DO NOTHING`,
    "upsert-target-unscoped",
  ],
  [
    "upsert target in the wrong order",
    `${SPAN_INSERT} ON CONFLICT (project_id, org_id, trace_id) DO NOTHING`,
    "upsert-target-unscoped",
  ],
  [
    "org table upsert without org_id",
    "INSERT INTO audit_log (org_id, seq) VALUES (?, ?) ON CONFLICT (seq) DO NOTHING",
    "upsert-target-unscoped",
  ],
  [
    "RIGHT JOIN",
    "SELECT * FROM runs r RIGHT JOIN spans s ON s.org_id = ? WHERE r.org_id = ? AND r.project_id = ? AND s.project_id = ?",
    "right-full-join",
  ],
  [
    "GLOB",
    "SELECT * FROM spans s WHERE s.org_id = ? AND s.project_id = ? AND s.run_id GLOB ?",
    "like",
  ],
  [
    "UPDATE without a scope",
    "UPDATE runs SET counts_json = ? WHERE run_id = ?",
    "org-id-unconstrained:runs",
  ],
  [
    "UPDATE with NOT scope",
    "UPDATE runs SET counts_json = ? WHERE NOT org_id = ? AND project_id = ? AND run_id = ?",
    "org-id-unconstrained:runs",
  ],
  [
    "compound select: a constrained alias in one arm covers an unconstrained one in another",
    "SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = ? UNION SELECT 1 FROM spans s WHERE 1 = 1",
    "org-id-unconstrained:s",
  ],
  [
    "INTERSECT arm",
    "SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = ? INTERSECT SELECT 1 FROM spans s",
    "org-id-unconstrained:s",
  ],
  [
    "EXCEPT arm",
    "SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = ? EXCEPT SELECT 1 FROM spans s",
    "org-id-unconstrained:s",
  ],
  [
    "recursive CTE is refused",
    "WITH RECURSIVE c AS (SELECT 1 AS n FROM spans s WHERE s.org_id = ? AND s.project_id = ? UNION ALL SELECT 1 FROM spans s) SELECT n FROM c",
    "unsupported-construct",
  ],
  [
    "scope inside a CASE in WHERE",
    "SELECT * FROM spans s WHERE CASE WHEN 0 THEN 1 AND s.org_id = ? AND s.project_id = ? ELSE 1 END",
    "org-id-unconstrained:s",
  ],
  [
    "LEFT JOIN onto a subquery: its ON is not a WHERE",
    "SELECT * FROM runs r LEFT JOIN (SELECT 1 AS k) x ON s.org_id = ? AND s.project_id = ? JOIN spans s ON 1 = 1 WHERE r.org_id = ? AND r.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "scope in the ON of a LEFT JOIN onto a subquery, for the table before it",
    "SELECT * FROM spans s LEFT JOIN (SELECT 1 AS k) x ON s.org_id = ? AND s.project_id = ?",
    "org-id-unconstrained:s",
  ],
  [
    "table-valued function in FROM",
    "SELECT * FROM json_each(?) j JOIN spans s ON 1 = 1 WHERE s.org_id = ? AND s.project_id = ?",
    "unparsed-table-reference",
  ],
  [
    "VALUES subquery is analysed as its own level (a table inside it needs its own scope)",
    "SELECT * FROM spans s WHERE s.org_id = ? AND s.project_id = ? AND EXISTS (VALUES (1) FROM spans t)",
    "unsupported-construct",
  ],
  [
    "LEFT JOIN onto a VALUES subquery: its ON is not a WHERE",
    "SELECT * FROM runs r LEFT JOIN (VALUES (1)) v ON s.org_id = ? AND s.project_id = ? JOIN spans s ON 1 = 1 WHERE r.org_id = ? AND r.project_id = ?",
    "unsupported-construct",
  ],
  [
    "a table reference inside parentheses that is not a split-off query",
    "SELECT * FROM spans s WHERE s.org_id = ? AND s.project_id = ? AND (1 + (2 FROM spans t))",
    "unsupported-construct",
  ],
  [
    "multi-row VALUES",
    "INSERT INTO spans (org_id, project_id, trace_id, span_id) VALUES (?, ?, ?, ?), ('x', 'y', ?, ?)",
    "insert-multi-row",
  ],
  [
    "a second ON CONFLICT clause with an unscoped target",
    `${SPAN_INSERT} ON CONFLICT (org_id, project_id, trace_id, span_id) DO NOTHING ON CONFLICT (span_id) DO NOTHING`,
    "unsupported-construct",
  ],
  [
    "UPDATE OR IGNORE hides the table behind the resolution word",
    "UPDATE OR IGNORE spans SET late = 1 WHERE span_id = ?",
    "conflict-resolution",
  ],
  [
    "UPDATE OR ABORT on a tenant table without a scope",
    "UPDATE OR ABORT runs SET late = 1",
    "conflict-resolution",
  ],
];

for (const [label, sql, expected] of BYPASSES) {
  test(`tenant lint bypass: ${label}`, () => {
    const v = lintStatement(T(sql));
    assert.ok(v.includes(expected), `expected ${expected}, got ${v.join(",") || "nothing"}`);
  });
}

test("tenant lint bypass: the same forms are caught through the registry lint too", () => {
  for (const [label, sql] of BYPASSES) {
    const v = lintRegistry(
      { ...(STATEMENTS as Record<string, StatementDef>), "evil.q": T(sql) },
      PINS,
    );
    assert.ok(
      v.some((x) => x.startsWith("evil.q:")),
      label,
    );
  }
});

test("tenant lint: legitimate forms still pass (outer join ON for the joined table, correlated subquery)", () => {
  const good = [
    "SELECT * FROM runs r LEFT JOIN spans s ON s.org_id = ? AND s.project_id = r.project_id WHERE r.org_id = ? AND r.project_id = ?",
    "SELECT * FROM runs r WHERE r.org_id = ? AND r.project_id = ? AND EXISTS (SELECT 1 FROM spans s WHERE s.org_id = ? AND s.project_id = r.project_id AND s.run_id = r.run_id)",
    "SELECT * FROM spans s WHERE s.org_id = ? AND s.project_id = ? AND s.start_ns BETWEEN ? AND ?",
    `${SPAN_INSERT} ON CONFLICT (org_id, project_id, trace_id, span_id) DO NOTHING`,
    "INSERT INTO audit_log (org_id, seq) VALUES (?, ?) ON CONFLICT (org_id, seq) DO NOTHING",
  ];
  for (const sql of good) assert.deepEqual(lintStatement(T(sql)), [], sql);
});
