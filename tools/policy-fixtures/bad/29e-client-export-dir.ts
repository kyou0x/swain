// as: packages/client/src/export/x.ts
import { setTimeout } from "node:timers"; // expect: P-IMPORT P-IDENT
setTimeout(() => 1, 5); // expect: P-IDENT
