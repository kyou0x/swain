// as: packages/report/src/x.ts
import { readFileSync } from "node:fs"; // expect: P-IMPORT
import { join } from "node:path"; // expect: P-IMPORT
import { s } from "@swain/store"; // expect: P-IMPORT
import type { S } from "@swain/store"; // expect: P-IMPORT
import { a } from "@swain/adapter-codex-cli"; // expect: P-IMPORT
import { createHash, randomUUID } from "node:crypto"; // expect: P-RANDOM
import { ok } from "@swain/core";
export { readFileSync, join, s, a, createHash, randomUUID, ok };
export type { S };
