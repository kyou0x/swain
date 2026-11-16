// as: packages/core/src/x.ts
new Date(); // expect: P-DATE
Date(); // expect: P-DATE
Date.now(); // expect: P-DATE
new Date(1, 2); // expect: P-DATE
Date.parse("x"); // expect: P-DATE
process.hrtime(); // expect: P-PROCESS
import { randomUUID } from "node:crypto"; // expect: P-RANDOM
import * as nc from "node:crypto"; // expect: P-IMPORT
crypto.getRandomValues(a); // expect: P-IDENT
Intl.DateTimeFormat(); // expect: P-IDENT
x.toLocaleString(); // expect: P-LOCALE
a.localeCompare(b); // expect: P-LOCALE
x["toLocaleDateString"](); // expect: P-LOCALE
process.cwd(); // expect: P-PROCESS
process.env.X; // expect: P-PROCESS
import os from "node:os"; // expect: P-IMPORT
Math.random(); // expect: P-RANDOM
