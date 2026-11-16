// as: packages/cli/src/swain-bin.ts
import { runSwain } from "./swain.js";

runSwain({
  argv: process.argv.slice(2),
  stdin: process.stdin,
  env: { a: process.env.HOME },
  b: process.env.SWAIN_TOKEN, // expect: P-PROCESS
  c: process.env.PATH, // expect: P-PROCESS
  d: process.stdin.on, // expect: P-PROCESS
  e: () => process.once("SIGHUP", () => 1), // expect: P-PROCESS
  f: () => process.once("SIGINT"),
  g: () => process.on("SIGINT", () => 1), // expect: P-PROCESS
  h: () => process.exit(1), // expect: P-PROCESS
  i: () => process.once(sig, () => 1), // expect: P-PROCESS
  j: Date.now(), // expect: P-DATE
  k: process.once, // expect: P-PROCESS
  l: process, // expect: P-PROCESS
});
process.once("SIGINT", () => 1); // expect: P-PROCESS
process.stdin; // expect: P-PROCESS
const v = process.env["HOME"]; // expect: P-PROCESS
process.env.SWAIN_DB = "x"; // expect: P-PROCESS
delete process.env.SWAIN_SERVER_URL; // expect: P-PROCESS
process.stdout.write("x"); // expect: P-PROCESS
