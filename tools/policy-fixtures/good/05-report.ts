// as: packages/report/src/render/x.ts
import { createHash } from "node:crypto";
import { escapeControlChars } from "@swain/core";

// Only getUTC* and toISOString remain usable on Date values.
export function render(d: Date, s: string): string {
  const y = d.getUTCFullYear() + d.getUTCMonth() + d.getUTCDate() + d.getUTCDay() + d.getTime();
  return createHash("sha256").update(escapeControlChars(s)).digest("hex") + d.toISOString() + y;
}
