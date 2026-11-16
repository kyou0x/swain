/**
 * Non-destructive migration lint (SPEC-003 section 2.1). Comments and quoted text are removed
 * first, so only SQL keywords are checked. The reviewed exception list is empty.
 */
export const MIGRATION_LINT_EXCEPTIONS: readonly string[] = [];

const RULES: readonly (readonly [string, RegExp])[] = [
  ["DROP", /\bDROP\b/i],
  ["DELETE", /\bDELETE\b/i],
  ["ALTER TABLE RENAME", /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i],
  ["ALTER TABLE DROP", /\bALTER\s+TABLE\b[^;]*\bDROP\b/i],
  ["REPLACE INTO", /\bREPLACE\s+INTO\b/i],
  ["INSERT OR REPLACE", /\bOR\s+REPLACE\b/i],
  // `replace()`, `ON CONFLICT REPLACE` and every other spelling: evidence is append-only
  ["REPLACE", /\bREPLACE\b/i],
  // conflict clauses in DDL (`PRIMARY KEY ON CONFLICT REPLACE`, `UNIQUE ON CONFLICT ...`) change
  // what an INSERT does to existing rows; conflict handling lives in the statement registry only
  ["ON CONFLICT", /\bON\s+CONFLICT\b/i],
  ["UPDATE", /\bUPDATE\b/i],
  ["PRAGMA writable_schema", /\bPRAGMA\s+writable_schema\b/i],
  ["CREATE TRIGGER", /\bTRIGGER\b/i],
  ["CREATE VIEW", /\bVIEW\b/i],
  ["ATTACH", /\b(?:ATTACH|DETACH)\b/i],
];

/** PRAGMAs a migration may use (SPEC-003 section 2.1, F21). */
export const MIGRATION_PRAGMA_ALLOWLIST: readonly string[] = ["foreign_keys", "user_version"];

function disallowedPragmas(clean: string): boolean {
  for (const m of clean.matchAll(/\bPRAGMA\s+([A-Za-z_]+)/gi)) {
    if (!MIGRATION_PRAGMA_ALLOWLIST.includes((m[1] ?? "").toLowerCase())) return true;
  }
  return /\bPRAGMA\b(?!\s+[A-Za-z_])/i.test(clean);
}

/** SQL without `--` and block comments and without the content of quoted strings and identifiers. */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === "-" && next === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length) {
        if (sql.charAt(i) === c) {
          if (sql.charAt(i + 1) === c) {
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      out += `${c}${c}`;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The names of the violated rules; empty when the SQL is non-destructive. */
export function lintMigrationSql(sql: string): readonly string[] {
  const clean = stripSqlNoise(sql);
  const hits = RULES.filter(([, re]) => re.test(clean)).map(([name]) => name);
  if (disallowedPragmas(clean)) hits.push("PRAGMA");
  return hits;
}
