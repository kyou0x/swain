// as: packages/cli/src/bin.ts
import { runMain } from "./main.js";

process.exitCode = runMain({ argv: process.argv.slice(2), nowMs: Date.now });
const n = Date.now; // expect: P-DATE
const t = Date.now(); // expect: P-DATE
const u = new Date(); // expect: P-DATE
process.env.PATH; // expect: P-PROCESS
process.env["HOME"]; // expect: P-PROCESS
process.env.HOME = "x"; // expect: P-PROCESS
delete process.env.XDG_DATA_HOME; // expect: P-PROCESS
process.env.HOME += "x"; // expect: P-PROCESS
const e = process.env; // expect: P-PROCESS
const { HOME } = process.env; // expect: P-PROCESS
process.stdout.write("x"); // expect: P-PROCESS
process.stderr.write("x"); // expect: P-PROCESS
foo(process.stderr); // expect: P-PROCESS
foo(process.stdout.write); // expect: P-PROCESS
process.cwd(); // expect: P-PROCESS
process.exit(1); // expect: P-PROCESS
process.hrtime(); // expect: P-PROCESS
process.stdout.write.bind(process.stdout); // expect: P-PROCESS P-PROCESS
