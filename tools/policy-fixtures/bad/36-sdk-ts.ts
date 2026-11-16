// as: packages/sdk-ts/src/x.ts
import { a } from "@swain/core"; // expect: P-IMPORT
import { b } from "@swain/model"; // expect: P-IMPORT
import { createHash } from "node:crypto"; // expect: P-RANDOM
import { readFileSync } from "node:fs"; // expect: P-IMPORT
import { createServer } from "node:http"; // expect: P-IMPORT P-NET
import { Buffer } from "node:buffer"; // expect: P-IMPORT P-IDENT
export { a, b, createHash, readFileSync, createServer, Buffer }; // expect: P-IDENT
