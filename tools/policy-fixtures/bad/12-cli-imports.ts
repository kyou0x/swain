// as: packages/cli/src/x.ts
import { createHash } from "node:crypto"; // expect: P-IMPORT
import "node:fs"; // expect: P-IMPORT
import "@swain/cli-evil"; // expect: P-IMPORT
import "@swain/core";
import "@swain/core/sub";
