// as: packages/core/src/pipeline/x.ts
import { openSync } from "node:fs"; // expect: P-IMPORT
import { join } from "node:path"; // expect: P-IMPORT
import { zstdDecompressSync } from "node:zlib"; // expect: P-IMPORT
import { createHash } from "node:crypto";
export { openSync, join, zstdDecompressSync, createHash };
