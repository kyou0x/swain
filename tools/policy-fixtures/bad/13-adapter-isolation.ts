// as: packages/adapter-gemini-cli/src/x.ts
import { createHash } from "node:crypto"; // expect: P-IMPORT
import { readFileSync } from "node:fs"; // expect: P-IMPORT
import "@swain/adapter-claude-code"; // expect: P-IMPORT
import { x } from "@swain/adapter-gemini-cli"; // expect: P-IMPORT
import { r } from "@swain/report"; // expect: P-IMPORT
import { s } from "@swain/store"; // expect: P-IMPORT
import type { T } from "@swain/store"; // expect: P-IMPORT
import { c } from "@swain/cli"; // expect: P-IMPORT
import { k } from "@swain/corex"; // expect: P-IMPORT
import { ok } from "@swain/core";
export type U = import("@swain/adapter-opencode").Y; // expect: P-IMPORT
export { ok, c, k, r, s, x, createHash, readFileSync };
