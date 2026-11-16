// as: packages/cli/src/swain-bin.ts
import { runMain } from "./main.js";

runMain({ argv: process.argv.slice(2), stdin: process.stdin }); // expect: P-PROCESS
