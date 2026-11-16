/**
 * Statement lint (ADR-0007 r2 section 3, G0 F12, G3 C5/C6, round 4): a closed SQL subset.
 *
 * The lint is a recursive-descent PARSER for the only SQL the registry may use. Anything outside
 * the grammar below is a violation (`unsupported-construct` or a more specific code); nothing is
 * ignored, and an unbalanced `CASE`/`END` or parenthesis cannot parse. There is no heuristic
 * token scanning: the scope checks run on the parsed structure.
 *
 * Accepted grammar (keywords case-insensitive; every identifier must be a table or column of the
 * schema derived from the migrations, a CTE name, an alias declared in the statement, an output
 * alias, or an allowlisted function; reserved words are never identifiers):
 *
 *   stmt    := select | insert | update | BEGIN IMMEDIATE | COMMIT | ROLLBACK | VACUUM INTO ?
 *              (the last four only in `tenant: false` statements)
 *   select  := core {(UNION [ALL] | INTERSECT | EXCEPT) core}
 *              [ORDER BY item {, item}] [LIMIT expr [OFFSET expr]]
 *   cte     := name AS ( select )
 *   core    := SELECT [DISTINCT] result {, result} [FROM source {join}] [WHERE expr]
 *              [GROUP BY expr {, expr}] [HAVING expr]
 *   result  := * | alias.* | expr [AS name]
 *   source  := table [[AS] alias] | ( select ) [[AS] alias]
 *   join    := [INNER | LEFT [OUTER]] JOIN source ON expr        (explicit joins only: no comma
 *              joins, RIGHT/FULL/CROSS/NATURAL, USING, INDEXED BY, table-valued functions)
 *   insert  := INSERT INTO table ( col {, col} ) VALUES ( expr {, expr} )
 *              [ON CONFLICT ( col {, col} ) DO (NOTHING | UPDATE SET col = expr {, ...})]
 *              (one tuple, one ON CONFLICT clause, no OR resolution, no INSERT ... SELECT)
 *   update  := UPDATE table SET col = expr {, ...} [WHERE expr] [RETURNING col {, col}]
 *   expr    := OR / AND / NOT / comparison (= <> != < <= > >= IS [NOT] [NULL] [NOT] BETWEEN
 *              [NOT] IN ( list | select ) [NOT] LIKE) / + - / * / % / || / unary - + / primary
 *   primary := number | 'string' | ? | NULL | col | alias.col | fn( [* | [DISTINCT] expr {, expr}] )
 *              | CASE [expr] WHEN expr THEN expr {...} [ELSE expr] END | EXISTS ( select )
 *              | ( select ) | ( expr )
 *   fn      := COUNT | COALESCE | SUM | MIN | MAX | SUBSTR
 *
 * No comments, no quoted/bracketed/backtick identifiers, only bare `?` parameters, no `;`.
 *
 * Scope rules for a `tenant: true` statement, per query level (a subquery, a compound arm and a
 * CTE body are separate levels, analysed on their own):
 *  - every reference to a tenant table has `alias.org_id = ?` as a top-level AND conjunct of that
 *    level's WHERE, or of an ON that filters it (an ON of a LEFT JOIN counts only for the joined
 *    alias, also for the project equalities);
 *  - every reference to a table with a `project_id` column has `alias.project_id = ?` as such a
 *    conjunct, or equality with an alias already constrained (also one of an enclosing level),
 *    unless the statement is tagged `orgWide` (a pinned list); an unscoped lookup (pinned list)
 *    skips the `org_id` rule only;
 *  - an INSERT binds `org_id` (and `project_id` where the table has it) from `?`, and its
 *    `ON CONFLICT` target starts with the scope columns; no `SET` assigns `org_id`/`project_id`;
 *  - no LIKE/GLOB and no REPLACE anywhere (`INSERT OR REPLACE`, `REPLACE INTO`, `replace()`).
 * A `tenant: false` statement must not reference a tenant table.
 */
import { migratedSchemaColumns } from "./open.js";
import { type StatementDef, TENANT_TABLES } from "./statements.js";

/** Tenant tables without a `project_id` column. A unit test checks this against the DDL. */
export const TABLES_WITHOUT_PROJECT: readonly string[] = [
  "orgs",
  "workspaces",
  "login_codes",
  "web_sessions",
  "audit_log",
];

/** Tables a `tenant: false` statement may read (server-wide data). */
export const NON_TENANT_TABLES: readonly string[] = [
  "schema_migrations",
  "server_secrets",
  "sqlite_master",
  "sqlite_schema",
];

/** Words that are never identifiers (tables, columns, aliases, CTE names). */
export const RESERVED: ReadonlySet<string> = new Set(
  (
    "ALL AND AS ASC BETWEEN BY CASE CAST COLLATE CONFLICT CROSS DESC DISTINCT DO ELSE END ESCAPE " +
    "EXCEPT EXISTS FILTER FROM FULL GLOB GROUP HAVING IN INDEXED INNER INSERT INTERSECT INTO IS " +
    "JOIN LEFT LIKE LIMIT NATURAL NO NOT NOTHING NULL OF OFFSET ON OR ORDER OUTER OVER RECURSIVE " +
    "REPLACE RETURNING RIGHT SELECT SET THEN UNION UPDATE USING VALUES WHEN WHERE WINDOW WITH " +
    "DELETE BEGIN COMMIT ROLLBACK VACUUM"
  ).split(" "),
);

/** The only functions a statement may call. */
export const FUNCTIONS: ReadonlySet<string> = new Set([
  "count",
  "coalesce",
  "sum",
  "min",
  "max",
  "substr",
]);

// ---- schema ------------------------------------------------------------------------------------
const PINNED_VIRTUAL: Readonly<Record<string, readonly string[]>> = {
  sqlite_master: ["type", "name", "tbl_name", "rootpage", "sql"],
  sqlite_schema: ["type", "name", "tbl_name", "rootpage", "sql"],
};

let schemaMemo: ReadonlyMap<string, ReadonlySet<string>> | null = null;

/** Table to column names, derived from the migrations (memoized). */
export function schemaColumns(): ReadonlyMap<string, ReadonlySet<string>> {
  if (schemaMemo !== null) return schemaMemo;
  const out = new Map(migratedSchemaColumns());
  for (const [tb, cols] of Object.entries(PINNED_VIRTUAL)) out.set(tb, new Set(cols));
  schemaMemo = out;
  return out;
}

// ---- tokens ------------------------------------------------------------------------------------
class Unsupported extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code = "unsupported-construct"): never {
  throw new Unsupported(code);
}

interface Tok {
  readonly k: "id" | "num" | "str" | "param" | "op";
  readonly v: string;
  /** Upper-cased identifier text (empty for other kinds). */
  readonly u: string;
}

const TWO = new Set(["<>", "<=", ">=", "!=", "||"]);
const ONE = new Set(["=", "<", ">", "+", "-", "*", "/", "%", "(", ")", ",", "."]);

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    const n = sql.charAt(i + 1);
    if (c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r") {
      i++;
    } else if ((c === "-" && n === "-") || (c === "/" && n === "*")) {
      return fail("comment");
    } else if (c === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return fail();
        if (sql.charAt(j) === "'") {
          if (sql.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      toks.push({ k: "str", v: sql.slice(i, j + 1), u: "" });
      i = j + 1;
    } else if (c === '"' || c === "`" || c === "[" || c === "]") {
      return fail("quoted-identifier");
    } else if (c === "?") {
      if (/\d/.test(n))
        return fail(`non-positional-parameter:${/^\?\d+/.exec(sql.slice(i))?.[0] ?? "?"}`);
      toks.push({ k: "param", v: "?", u: "" });
      i++;
    } else if (c === ":" || c === "@" || c === "$") {
      return fail(`non-positional-parameter:${/^[:@$]\w*/.exec(sql.slice(i))?.[0] ?? c}`);
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql.charAt(j))) j++;
      const v = sql.slice(i, j);
      toks.push({ k: "id", v, u: v.toUpperCase() });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /\d/.test(sql.charAt(j))) j++;
      if (sql.charAt(j) === "." && /\d/.test(sql.charAt(j + 1))) {
        j++;
        while (j < sql.length && /\d/.test(sql.charAt(j))) j++;
      }
      if (j < sql.length && /[A-Za-z_]/.test(sql.charAt(j))) return fail();
      toks.push({ k: "num", v: sql.slice(i, j), u: "" });
      i = j;
    } else if (TWO.has(c + n)) {
      toks.push({ k: "op", v: c + n, u: "" });
      i += 2;
    } else if (ONE.has(c)) {
      toks.push({ k: "op", v: c, u: "" });
      i++;
    } else {
      return fail();
    }
  }
  return toks;
}

// ---- structure ---------------------------------------------------------------------------------
type E =
  | { readonly t: "col"; readonly q: string | null; readonly name: string }
  | { readonly t: "param" }
  | { readonly t: "bin"; readonly op: "=" | "and" | "or" | "other"; readonly l: E; readonly r: E }
  | { readonly t: "not"; readonly e: E }
  | { readonly t: "x" };

interface ColRef {
  readonly q: string | null;
  readonly name: string;
}

interface FromItem {
  readonly alias: string;
  /** Lower-case table name; null for a derived table. */
  readonly table: string | null;
  readonly cte: boolean;
  /** "from": a source to scope; "target": an INSERT target; "excluded": the upsert row. */
  readonly role: "from" | "target" | "excluded";
}

interface Level {
  readonly parent: Level | null;
  readonly from: FromItem[];
  readonly where: E | null;
  readonly ons: { readonly e: E; readonly only: string | null }[];
  readonly cols: ColRef[];
  readonly children: Level[];
  setWhere(e: E | null): void;
}

function newLevel(parent: Level | null): Level {
  let where: E | null = null;
  const lvl: Level = {
    parent,
    from: [],
    get where() {
      return where;
    },
    ons: [],
    cols: [],
    children: [],
    setWhere(e) {
      where = e;
    },
  };
  return lvl;
}

const JOIN_BAD = new Set(["CROSS", "NATURAL"]);

class Parser {
  pos = 0;
  readonly toks: Tok[];
  readonly post: string[] = [];
  readonly outAliases = new Set<string>();
  readonly levels: Level[] = [];
  readonly tables: string[] = [];
  top: Level | null = null;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(o = 0): Tok | undefined {
    return this.toks[this.pos + o];
  }
  isKw(w: string, o = 0): boolean {
    const t = this.peek(o);
    return t !== undefined && t.k === "id" && t.u === w;
  }
  isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return t !== undefined && t.k === "op" && t.v === v;
  }
  acceptKw(w: string): boolean {
    if (this.isKw(w)) {
      this.pos++;
      return true;
    }
    return false;
  }
  acceptOp(v: string): boolean {
    if (this.isOp(v)) {
      this.pos++;
      return true;
    }
    return false;
  }
  expectKw(w: string): void {
    if (!this.acceptKw(w)) fail();
  }
  expectOp(v: string): void {
    if (!this.acceptOp(v)) fail();
  }
  /** A non-reserved identifier. */
  ident(): string {
    const t = this.peek();
    if (t === undefined || t.k !== "id") return fail();
    if (RESERVED.has(t.u)) return fail(`reserved-identifier:${t.v.toLowerCase()}`);
    this.pos++;
    return t.v.toLowerCase();
  }
  isIdent(o = 0): boolean {
    const t = this.peek(o);
    return t !== undefined && t.k === "id" && !RESERVED.has(t.u);
  }

  mk(parent: Level | null): Level {
    const l = newLevel(parent);
    this.levels.push(l);
    if (parent !== null) parent.children.push(l);
    return l;
  }

  // ---- statements ------------------------------------------------------------------------------
  statement(tenant: boolean): void {
    const t = this.peek();
    if (t === undefined) fail();
    if (t.u === "SELECT") {
      this.top = this.select(null);
    } else if (t.u === "INSERT") {
      this.insert();
    } else if (t.u === "UPDATE") {
      this.update();
    } else if (!tenant && t.u === "BEGIN" && this.isKw("IMMEDIATE", 1)) {
      this.pos += 2;
    } else if (!tenant && (t.u === "COMMIT" || t.u === "ROLLBACK")) {
      this.pos++;
    } else if (!tenant && t.u === "VACUUM" && this.isKw("INTO", 1) && this.peek(2)?.k === "param") {
      this.pos += 3;
    } else {
      fail();
    }
    if (this.pos !== this.toks.length) fail();
  }

  select(parent: Level | null): Level {
    const scopeParent = parent;
    // WITH is not in the subset at any level: a CTE name would shadow a table, and the registry
    // needs none. It can return only with lexical scoping and a review.
    if (this.isKw("WITH")) fail("unsupported-construct");
    const first = this.core(scopeParent);
    let last = first;
    for (;;) {
      if (this.isKw("UNION")) {
        this.pos++;
        this.acceptKw("ALL");
      } else if (this.isKw("INTERSECT") || this.isKw("EXCEPT")) {
        this.pos++;
      } else break;
      last = this.core(scopeParent);
    }
    if (this.acceptKw("ORDER")) {
      this.expectKw("BY");
      do {
        this.expr(last);
        if (!this.acceptKw("ASC")) this.acceptKw("DESC");
      } while (this.acceptOp(","));
    }
    if (this.acceptKw("LIMIT")) {
      this.expr(last);
      if (this.acceptKw("OFFSET")) this.expr(last);
    }
    return first;
  }

  core(parent: Level | null): Level {
    const lvl = this.mk(parent);
    this.expectKw("SELECT");
    this.acceptKw("DISTINCT");
    do {
      if (this.acceptOp("*")) continue;
      if (this.isIdent() && this.isOp(".", 1) && this.isOp("*", 2)) {
        lvl.cols.push({ q: this.ident(), name: "*" });
        this.pos += 2;
        continue;
      }
      this.expr(lvl);
      if (this.acceptKw("AS")) this.outAliases.add(this.ident());
    } while (this.acceptOp(","));
    if (this.acceptKw("FROM")) {
      this.source(lvl);
      for (;;) {
        if (this.isOp(",")) return fail("comma-join");
        let outer = false;
        if (this.isKw("JOIN")) this.pos++;
        else if (this.isKw("INNER") && this.isKw("JOIN", 1)) this.pos += 2;
        else if (this.isKw("LEFT")) {
          this.pos++;
          this.acceptKw("OUTER");
          this.expectKw("JOIN");
          outer = true;
        } else if (this.isKw("RIGHT") || this.isKw("FULL")) {
          return fail("right-full-join");
        } else if (this.peek()?.k === "id" && JOIN_BAD.has(this.peek()?.u ?? "")) {
          return fail();
        } else break;
        const alias = this.source(lvl);
        this.expectKw("ON");
        lvl.ons.push({ e: this.expr(lvl), only: outer ? alias : null });
      }
    }
    if (this.acceptKw("WHERE")) lvl.setWhere(this.expr(lvl));
    if (this.acceptKw("GROUP")) {
      this.expectKw("BY");
      do this.expr(lvl);
      while (this.acceptOp(","));
    }
    if (this.acceptKw("HAVING")) this.expr(lvl);
    return lvl;
  }

  /** One FROM/JOIN source; returns its alias. */
  source(lvl: Level): string {
    if (this.acceptOp("(")) {
      if (!this.isKw("SELECT")) return fail();
      this.select(lvl);
      this.expectOp(")");
      let alias = `<sub${lvl.from.length}>`;
      if (this.acceptKw("AS")) alias = this.ident();
      else if (this.isIdent()) alias = this.ident();
      if (lvl.from.some((f) => f.alias === alias)) fail(`duplicate-alias:${alias}`);
      lvl.from.push({ alias, table: null, cte: false, role: "from" });
      return alias;
    }
    const table = this.ident();
    if (this.isOp(".")) return fail(`schema-qualified:${table}`);
    if (this.isOp("(")) return fail("unparsed-table-reference");
    let alias = table;
    if (this.acceptKw("AS")) alias = this.ident();
    else if (this.isIdent()) alias = this.ident();
    if (lvl.from.some((f) => f.alias === alias)) fail(`duplicate-alias:${alias}`);
    this.tables.push(table);
    lvl.from.push({ alias, table, cte: false, role: "from" });
    return alias;
  }

  insert(): void {
    this.expectKw("INSERT");
    if (this.isKw("OR")) fail("conflict-resolution");
    this.expectKw("INTO");
    const table = this.ident();
    if (this.isOp(".")) fail(`schema-qualified:${table}`);
    this.tables.push(table);
    const lvl = this.mk(null);
    lvl.from.push({ alias: table, table, cte: false, role: "target" });
    lvl.from.push({ alias: "excluded", table, cte: false, role: "excluded" });
    this.top = lvl;
    this.expectOp("(");
    const cols: string[] = [];
    do {
      const c = this.ident();
      cols.push(c);
      lvl.cols.push({ q: table, name: c });
    } while (this.acceptOp(","));
    this.expectOp(")");
    if (this.isKw("SELECT")) fail("insert-shape");
    this.expectKw("VALUES");
    this.expectOp("(");
    const vals: E[] = [];
    const before = lvl.cols.length;
    do vals.push(this.expr(lvl));
    while (this.acceptOp(","));
    this.expectOp(")");
    // VALUES may hold literals and parameters only: there is no row to read a column from
    if (lvl.cols.length !== before) fail("insert-shape");
    if (this.isOp(",")) fail("insert-multi-row");
    if (vals.length !== cols.length) this.post.push("insert-arity");
    const noProject = TABLES_WITHOUT_PROJECT.includes(table);
    const tenantTable = TENANT_TABLES.includes(table);
    for (const c of tenantTable ? (noProject ? ["org_id"] : ["org_id", "project_id"]) : []) {
      const i = cols.indexOf(c);
      if (i === -1 || vals[i]?.t !== "param") this.post.push(`insert-${c}-not-bound`);
    }
    if (this.acceptKw("ON")) {
      this.expectKw("CONFLICT");
      this.expectOp("(");
      const target: string[] = [];
      do {
        const c = this.ident();
        target.push(c);
        lvl.cols.push({ q: table, name: c });
      } while (this.acceptOp(","));
      this.expectOp(")");
      if (tenantTable && !(target[0] === "org_id" && (noProject || target[1] === "project_id"))) {
        this.post.push("upsert-target-unscoped");
      }
      this.expectKw("DO");
      if (this.acceptKw("NOTHING")) {
        // nothing to assign
      } else {
        this.expectKw("UPDATE");
        this.expectKw("SET");
        this.assignments(lvl, table);
      }
    }
  }

  assignments(lvl: Level, table: string): void {
    do {
      const c = this.ident();
      lvl.cols.push({ q: table, name: c });
      if (c === "org_id" || c === "project_id") this.post.push(`set-${c}`);
      this.expectOp("=");
      this.expr(lvl);
    } while (this.acceptOp(","));
  }

  update(): void {
    this.expectKw("UPDATE");
    if (this.isKw("OR")) fail("conflict-resolution");
    const table = this.ident();
    if (this.isOp(".")) fail(`schema-qualified:${table}`);
    this.tables.push(table);
    const lvl = this.mk(null);
    lvl.from.push({ alias: table, table, cte: false, role: "from" });
    this.top = lvl;
    this.expectKw("SET");
    this.assignments(lvl, table);
    if (this.acceptKw("WHERE")) lvl.setWhere(this.expr(lvl));
    if (this.acceptKw("RETURNING")) {
      do lvl.cols.push({ q: table, name: this.ident() });
      while (this.acceptOp(","));
    }
  }

  // ---- expressions -----------------------------------------------------------------------------
  expr(lvl: Level): E {
    let l = this.and(lvl);
    while (this.acceptKw("OR")) l = { t: "bin", op: "or", l, r: this.and(lvl) };
    return l;
  }
  and(lvl: Level): E {
    let l = this.not(lvl);
    while (this.acceptKw("AND")) l = { t: "bin", op: "and", l, r: this.not(lvl) };
    return l;
  }
  not(lvl: Level): E {
    if (this.acceptKw("NOT")) return { t: "not", e: this.not(lvl) };
    return this.cmp(lvl);
  }
  cmp(lvl: Level): E {
    let l = this.add(lvl);
    for (;;) {
      const t = this.peek();
      if (t === undefined) return l;
      if (t.k === "op" && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(t.v)) {
        this.pos++;
        const r = this.add(lvl);
        l = { t: "bin", op: t.v === "=" ? "=" : "other", l, r };
      } else if (this.isKw("IS")) {
        this.pos++;
        this.acceptKw("NOT");
        if (!this.acceptKw("NULL")) this.add(lvl);
        l = { t: "x" };
      } else if (this.isKw("BETWEEN") || (this.isKw("NOT") && this.isKw("BETWEEN", 1))) {
        this.acceptKw("NOT");
        this.expectKw("BETWEEN");
        this.add(lvl);
        this.expectKw("AND");
        this.add(lvl);
        l = { t: "x" };
      } else if (this.isKw("IN") || (this.isKw("NOT") && this.isKw("IN", 1))) {
        this.acceptKw("NOT");
        this.expectKw("IN");
        this.expectOp("(");
        if (this.isKw("SELECT")) this.select(lvl);
        else {
          do this.expr(lvl);
          while (this.acceptOp(","));
        }
        this.expectOp(")");
        l = { t: "x" };
      } else if (this.isKw("LIKE") || (this.isKw("NOT") && this.isKw("LIKE", 1))) {
        this.acceptKw("NOT");
        this.expectKw("LIKE");
        this.add(lvl);
        l = { t: "x" };
      } else return l;
    }
  }
  add(lvl: Level): E {
    let l = this.mul(lvl);
    while (this.isOp("+") || this.isOp("-")) {
      this.pos++;
      l = { t: "bin", op: "other", l, r: this.mul(lvl) };
    }
    return l;
  }
  mul(lvl: Level): E {
    let l = this.concat(lvl);
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      this.pos++;
      l = { t: "bin", op: "other", l, r: this.concat(lvl) };
    }
    return l;
  }
  concat(lvl: Level): E {
    let l = this.unary(lvl);
    while (this.acceptOp("||")) l = { t: "bin", op: "other", l, r: this.unary(lvl) };
    return l;
  }
  unary(lvl: Level): E {
    if (this.acceptOp("-") || this.acceptOp("+")) return { t: "not", e: this.unary(lvl) };
    return this.primary(lvl);
  }
  primary(lvl: Level): E {
    const t = this.peek();
    if (t === undefined) return fail();
    if (t.k === "num" || t.k === "str") {
      this.pos++;
      return { t: "x" };
    }
    if (t.k === "param") {
      this.pos++;
      return { t: "param" };
    }
    if (t.k === "op" && t.v === "(") {
      this.pos++;
      if (this.isKw("SELECT")) {
        this.select(lvl);
        this.expectOp(")");
        return { t: "x" };
      }
      const e = this.expr(lvl);
      this.expectOp(")");
      return e;
    }
    if (t.k !== "id") return fail();
    if (t.u === "NULL") {
      this.pos++;
      return { t: "x" };
    }
    if (t.u === "CASE") {
      this.pos++;
      if (!this.isKw("WHEN")) this.expr(lvl);
      let n = 0;
      while (this.acceptKw("WHEN")) {
        this.expr(lvl);
        this.expectKw("THEN");
        this.expr(lvl);
        n++;
      }
      if (n === 0) return fail();
      if (this.acceptKw("ELSE")) this.expr(lvl);
      this.expectKw("END");
      return { t: "x" };
    }
    if (t.u === "EXISTS") {
      this.pos++;
      this.expectOp("(");
      if (!this.isKw("SELECT")) return fail();
      this.select(lvl);
      this.expectOp(")");
      return { t: "x" };
    }
    if (t.u === "WITH") return fail("unsupported-construct");
    if (RESERVED.has(t.u)) return fail(`reserved-identifier:${t.v.toLowerCase()}`);
    if (this.isOp("(", 1)) {
      const fn = t.v.toLowerCase();
      if (!FUNCTIONS.has(fn)) return fail(`unknown-function:${fn}`);
      this.pos += 2;
      if (this.acceptOp("*")) {
        if (fn !== "count") return fail();
      } else if (!this.isOp(")")) {
        this.acceptKw("DISTINCT");
        do this.expr(lvl);
        while (this.acceptOp(","));
      }
      this.expectOp(")");
      return { t: "x" };
    }
    const first = this.ident();
    if (this.acceptOp(".")) {
      const name = this.ident();
      if (this.isOp(".")) return fail(`schema-qualified:${first}`);
      lvl.cols.push({ q: first, name });
      return { t: "col", q: first, name };
    }
    lvl.cols.push({ q: null, name: first });
    return { t: "col", q: null, name: first };
  }
}

// ---- analysis ----------------------------------------------------------------------------------
type Match =
  | { kind: "org"; alias: string | null }
  | { kind: "prj"; alias: string | null }
  | { kind: "eq"; a: string; b: string };

function conjuncts(e: E | null): E[] {
  if (e === null) return [];
  if (e.t === "bin" && e.op === "and") return [...conjuncts(e.l), ...conjuncts(e.r)];
  return [e];
}

function matchConjunct(e: E): Match | null {
  if (e.t !== "bin" || e.op !== "=") return null;
  if (e.l.t === "col" && e.r.t === "param") {
    if (e.l.name === "org_id") return { kind: "org", alias: e.l.q };
    if (e.l.name === "project_id") return { kind: "prj", alias: e.l.q };
  }
  if (
    e.l.t === "col" &&
    e.r.t === "col" &&
    e.l.name === "project_id" &&
    e.r.name === "project_id" &&
    e.l.q !== null &&
    e.r.q !== null
  ) {
    return { kind: "eq", a: e.l.q, b: e.r.q };
  }
  return null;
}

interface Ctx {
  readonly out: string[];
  readonly orgWide: boolean;
  readonly skipOrg: boolean;
  readonly tenant: boolean;
  readonly universe: ReadonlySet<string>;
  readonly outAliases: ReadonlySet<string>;
  readonly schema: ReadonlyMap<string, ReadonlySet<string>>;
}

function resolveCols(lvl: Level, ctx: Ctx): void {
  for (const c of lvl.cols) {
    if (c.q !== null) {
      let item: FromItem | undefined;
      for (let l: Level | null = lvl; l !== null && item === undefined; l = l.parent) {
        item = l.from.find((f) => f.alias === c.q);
      }
      if (item === undefined) {
        ctx.out.push(`unknown-identifier:${c.q}.${c.name}`);
      } else if (c.name === "*") {
        // alias.* is fine for any known alias
      } else if (item.table !== null && !item.cte) {
        const cols = ctx.schema.get(item.table);
        if (cols === undefined || !cols.has(c.name)) {
          ctx.out.push(`unknown-identifier:${c.q}.${c.name}`);
        }
      } else if (!ctx.universe.has(c.name) && !ctx.outAliases.has(c.name)) {
        ctx.out.push(`unknown-identifier:${c.q}.${c.name}`);
      }
    } else if (!ctx.universe.has(c.name) && !ctx.outAliases.has(c.name)) {
      ctx.out.push(`unknown-identifier:${c.name}`);
    }
  }
}

function analyse(lvl: Level, inherited: ReadonlySet<string>, ctx: Ctx): void {
  resolveCols(lvl, ctx);
  const real = lvl.from.filter((f) => f.table !== null && !f.cte);
  for (const f of real) {
    const table = f.table ?? "";
    if (!ctx.schema.has(table)) ctx.out.push(`unknown-table:${table}`);
    else if (!ctx.tenant) {
      if (TENANT_TABLES.includes(table)) {
        ctx.out.push(`tenant-table-in-untagged-statement:${table}`);
      } else if (!NON_TENANT_TABLES.includes(table)) ctx.out.push(`unknown-table:${table}`);
    } else if (!TENANT_TABLES.includes(table)) ctx.out.push(`unknown-table:${table}`);
  }
  const sources = lvl.from.filter((f) => f.role === "from");
  if (ctx.tenant && sources.length > 0) {
    const conj: { e: E; only: string | null }[] = [
      ...conjuncts(lvl.where).map((e) => ({ e, only: null })),
      ...lvl.ons.flatMap((o) => conjuncts(o.e).map((e) => ({ e, only: o.only }))),
    ];
    if (lvl.where !== null && lvl.where.t === "bin" && lvl.where.op === "or") {
      ctx.out.push("top-level-or");
    }
    const first = sources[0];
    const single = sources.length === 1 && first?.table != null && !first.cte ? first.alias : null;
    const orgOk = new Set<string>();
    const prjOk = new Set<string>();
    const eqs: [string, string, string | null][] = [];
    for (const c of conj) {
      const m = matchConjunct(c.e);
      if (m === null) continue;
      const applies = (a: string): boolean => c.only === null || c.only === a;
      if (m.kind === "eq") {
        eqs.push([m.a, m.b, c.only]);
        continue;
      }
      const alias = m.alias ?? single;
      if (alias === null || !applies(alias)) continue;
      (m.kind === "org" ? orgOk : prjOk).add(alias);
    }
    const own = new Set(sources.map((f) => f.alias));
    const known = new Set([...inherited].filter((a) => !own.has(a)));
    for (const a of prjOk) known.add(a);
    for (let changed = true; changed; ) {
      changed = false;
      for (const [a, b, only] of eqs) {
        if (known.has(a) && !known.has(b) && (only === null || only === b)) {
          known.add(b);
          changed = true;
        }
        if (known.has(b) && !known.has(a) && (only === null || only === a)) {
          known.add(a);
          changed = true;
        }
      }
    }
    for (const f of sources) {
      if (f.table === null || f.cte || !TENANT_TABLES.includes(f.table)) continue;
      if (!ctx.skipOrg && !orgOk.has(f.alias)) ctx.out.push(`org-id-unconstrained:${f.alias}`);
      if (!ctx.orgWide && !TABLES_WITHOUT_PROJECT.includes(f.table) && !known.has(f.alias)) {
        ctx.out.push(`project-id-unconstrained:${f.alias}`);
      }
    }
    for (const child of lvl.children) analyse(child, known, ctx);
  } else {
    for (const child of lvl.children) analyse(child, new Set(), ctx);
  }
}

export interface LintOptions {
  readonly orgWide?: boolean;
}

/** Violation codes for one statement; empty when it passes. */
export function lintStatement(def: StatementDef, options: LintOptions = {}): string[] {
  const out: string[] = [];
  const sql = def.sql;
  if (/\bREPLACE\b/i.test(sql)) out.push("replace");
  if (def.tenant && /\b(LIKE|GLOB)\b/i.test(sql)) out.push("like");
  try {
    const parser = new Parser(tokenize(sql));
    parser.statement(def.tenant);
    out.push(...parser.post);
    const schema = schemaColumns();
    const universe = new Set<string>();
    for (const cols of schema.values()) for (const c of cols) universe.add(c);
    const ctx: Ctx = {
      out,
      orgWide: options.orgWide === true || def.unscoped !== undefined,
      skipOrg: def.unscoped !== undefined,
      tenant: def.tenant,
      universe,
      outAliases: parser.outAliases,
      schema,
    };
    // top-level levels: the statement's own, plus CTE bodies (private scope)
    for (const l of parser.levels) if (l.parent === null) analyse(l, new Set(), ctx);
    // a CTE body is created with the enclosing level as its owner but a null scope parent:
    // `levels` already lists it as a root, so each root is analysed exactly once
    for (const name of parser.tables) {
      if (!schema.has(name)) out.push(`unknown-table:${name}`);
    }
    const tenantRefs = parser.tables.some((t) => TENANT_TABLES.includes(t));
    if (def.tenant && !tenantRefs) out.push("tagged-tenant-without-tenant-table");
  } catch (e) {
    if (e instanceof Unsupported) out.push(e.code);
    else throw e;
  }
  return [...new Set(out)];
}
