// as: packages/client/src/x.ts
import { a } from "@swain/server"; // expect: P-IMPORT
import { b } from "@swain/db"; // expect: P-IMPORT
import { c } from "@swain/otlp"; // expect: P-IMPORT
import { d } from "@swain/store"; // expect: P-IMPORT
import { randomUUID } from "node:crypto"; // expect: P-RANDOM
import { readFileSync } from "node:fs"; // expect: P-IMPORT
import { gunzipSync } from "node:zlib"; // expect: P-IMPORT
export { a, b, c, d, randomUUID, readFileSync, gunzipSync };
