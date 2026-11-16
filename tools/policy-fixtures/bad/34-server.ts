// as: packages/server/src/x.ts
import { a } from "@swain/client"; // expect: P-IMPORT
import { b } from "@swain/cli"; // expect: P-IMPORT
import { c } from "@swain/adapter-codex-cli"; // expect: P-IMPORT
import { buildImportRecord, openStore } from "@swain/store"; // expect: P-IMPORT
import { readSourceFile } from "@swain/core"; // expect: P-IMPORT
import * as store from "@swain/store"; // expect: P-IMPORT
import store2 from "@swain/store"; // expect: P-IMPORT
export { buildImportRecord as b2 } from "@swain/store";
export { openStore as o2 } from "@swain/store"; // expect: P-IMPORT
import type { Store } from "@swain/store";
import { type Store as S2, buildImportRecord as bir } from "@swain/store";
import { writeFileSync } from "node:fs"; // expect: P-IMPORT
import { scryptSync } from "node:crypto"; // expect: P-RANDOM
import { gzipSync } from "node:zlib"; // expect: P-IMPORT
export { a, b, c, buildImportRecord, openStore, readSourceFile, store, store2, writeFileSync };
export { scryptSync, gzipSync, bir };
export type { Store, S2 };
