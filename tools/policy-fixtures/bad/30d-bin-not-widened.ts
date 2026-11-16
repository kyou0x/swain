// as: packages/cli/src/bin.ts
import { runMain } from "./main.js";

runMain({
  argv: process.argv.slice(2),
  stdin: process.stdin, // expect: P-PROCESS
  a: process.env.SWAIN_DB, // expect: P-PROCESS
  b: process.env.SWAIN_SERVER_URL, // expect: P-PROCESS
  c: process.env.XDG_CONFIG_HOME, // expect: P-PROCESS
  d: process.env.XDG_STATE_HOME, // expect: P-PROCESS
  e: () => process.once("SIGINT", () => 1), // expect: P-PROCESS
});
