// as: packages/store/src/x.ts
import { cpSync, rmSync } from "node:fs"; // expect: P-IMPORT P-IMPORT
import { copyFileSync } from "node:fs"; // expect: P-IMPORT
import { readFileSync } from "node:fs"; // expect: P-IMPORT
import { spawnSync } from "node:child_process"; // expect: P-IMPORT
import { zstdDecompressSync } from "node:zlib"; // expect: P-IMPORT
import { posix } from "node:path"; // expect: P-IMPORT
import { randomBytes } from "node:crypto"; // expect: P-RANDOM
import { r } from "@swain/report"; // expect: P-IMPORT
import { type Y, z } from "@swain/report"; // expect: P-IMPORT
import { type Q } from "@swain/report"; // expect: P-IMPORT
import "@swain/report"; // expect: P-IMPORT
export { w } from "@swain/report"; // expect: P-IMPORT
export * from "@swain/report"; // expect: P-IMPORT
import { cli } from "@swain/cli"; // expect: P-IMPORT
import { a } from "@swain/adapter-opencode"; // expect: P-IMPORT
import type { Ok } from "@swain/report";
export type { Ok2 } from "@swain/report";
export { cpSync, rmSync, copyFileSync, readFileSync, spawnSync, zstdDecompressSync, posix };
export { randomBytes, r, z, cli, a };
export type { Y, Q, Ok };
