// as: packages/cli/src/bin.ts
import { SCHEMA_VERSION } from "@swain/core";
import { runMain } from "./main.js";

// SPEC-002 section 2.3: exactly this shape. argv/exitCode, stdout/stderr (bare or .write) and
// Date.now only inside the single runMain(...) call, and only process.env.HOME / XDG_DATA_HOME.
process.exitCode = runMain({
  argv: process.argv.slice(2),
  stdout: (s: string) => process.stdout.write(s),
  stderr: process.stderr,
  env: { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME },
  nowMs: Date.now,
  version: SCHEMA_VERSION,
});
