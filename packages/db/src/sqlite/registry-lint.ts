import { lintStatement } from "./lint.js";
import type { StatementDef } from "./statements.js";

export interface Pins {
  readonly unscoped: readonly string[];
  readonly orgWide: readonly string[];
  readonly nonTenant: readonly string[];
}

/**
 * Lint a whole registry: every statement, plus the pinned name lists (G0 F12). Adding an
 * unscoped, org-wide or `tenant: false` statement without a reviewed change to the pins fails.
 * A bound `ORDER BY ?` is refused too: sort variants are separate registered statements.
 */
export function lintRegistry(
  registry: Readonly<Record<string, StatementDef>>,
  pins: Pins,
): string[] {
  const out: string[] = [];
  for (const [name, def] of Object.entries(registry)) {
    for (const v of lintStatement(def, { orgWide: def.orgWide === true })) out.push(`${name}:${v}`);
    if (/\bORDER\s+BY\s+\?/i.test(def.sql)) out.push(`${name}:bound-order-by`);
    if (def.unscoped !== undefined && !def.tenant) out.push(`${name}:unscoped-needs-tenant`);
    if (def.unscoped !== undefined && !pins.unscoped.includes(name)) {
      out.push(`${name}:unpinned-unscoped`);
    }
    if (def.orgWide === true && !pins.orgWide.includes(name)) out.push(`${name}:unpinned-org-wide`);
    if (!def.tenant && !pins.nonTenant.includes(name)) out.push(`${name}:unpinned-non-tenant`);
  }
  for (const [list, names] of Object.entries(pins)) {
    for (const n of names) if (!Object.hasOwn(registry, n)) out.push(`${n}:pin-missing:${list}`);
  }
  return out;
}
