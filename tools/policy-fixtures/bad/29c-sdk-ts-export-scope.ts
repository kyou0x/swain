// as: packages/sdk-ts/src/export/x.ts
import { setInterval } from "node:timers"; // expect: P-IMPORT P-IDENT
import { setImmediate as si } from "node:timers"; // expect: P-IMPORT
import { setTimeout } from "node:timers";
setInterval(() => 1, 5); // expect: P-IDENT
setImmediate(() => 1); // expect: P-IDENT
setTimeout(() => 1, 5);
export { si };
