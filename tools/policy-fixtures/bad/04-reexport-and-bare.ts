// as: packages/core/src/x.ts
export * from "node:child_process"; // expect: P-IMPORT
export { x } from "node:fs"; // expect: P-IMPORT
import cp = require("child_process"); // expect: P-IMPORT
import "child_process"; // expect: P-IMPORT
import { createHash as h } from "node:crypto";
export { h };
export { createHash } from "node:crypto"; // expect: P-IMPORT
