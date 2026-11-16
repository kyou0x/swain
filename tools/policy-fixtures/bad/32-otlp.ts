// as: packages/otlp/src/x.ts
import { a } from "@swain/db"; // expect: P-IMPORT
import { b } from "@swain/report"; // expect: P-IMPORT
import { createHash } from "node:crypto"; // expect: P-IMPORT
import { gunzipSync } from "node:zlib"; // expect: P-IMPORT
import { readFileSync } from "node:fs"; // expect: P-IMPORT
export { a, b, createHash, gunzipSync, readFileSync };
