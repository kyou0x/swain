// as: packages/db/src/x.ts
import { a } from "@swain/otlp"; // expect: P-IMPORT
import { b } from "@swain/server"; // expect: P-IMPORT
import { c } from "@swain/store"; // expect: P-IMPORT
import { r } from "@swain/report"; // expect: P-IMPORT
import { writeFileSync } from "node:fs"; // expect: P-IMPORT
import { rmSync } from "node:fs"; // expect: P-IMPORT
import { randomUUID } from "node:crypto"; // expect: P-RANDOM
import { request } from "node:http"; // expect: P-IMPORT P-NET
export { a, b, c, r, writeFileSync, rmSync, randomUUID, request };
