// as: packages/core/src/x.ts
import { createRequire } from "node:module"; // expect: P-IMPORT
createRequire(import.meta.url)("child_process"); // expect: P-IMPORTMETA
