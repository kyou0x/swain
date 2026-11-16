// as: packages/cli/src/swain-bin.ts
import { runSwain } from "./swain.js";

runSwain({ a: process.stdout }); // expect: P-PROCESS
runSwain({ b: process.stdin }); // expect: P-PROCESS
