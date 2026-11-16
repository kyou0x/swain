// as: packages/cli/src/bin.ts
import { runMain } from "./main.js";

runMain({ stdout: process.stdout, nowMs: Date.now }); // expect: P-PROCESS P-DATE
runMain({ stdout: process.stderr, nowMs: Date.now }); // expect: P-PROCESS P-DATE
