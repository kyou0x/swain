// as: packages/sdk-ts/src/other.ts
import { clearTimeout } from "node:timers"; // expect: P-IMPORT
import { setTimeout } from "node:timers"; // expect: P-IMPORT P-IDENT
setTimeout(() => 1, 5); // expect: P-IDENT
export { clearTimeout };
