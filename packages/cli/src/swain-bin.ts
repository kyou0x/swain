#!/usr/bin/env node
import { SCHEMA_VERSION } from "@swain/core";
import { runSwain } from "./swain.js";

// ADR-0004 section 5: exactly this shape (tools/policy-fixtures/good/14-swain-bin.ts). Everything
// process-related sits inside the single runSwain(...) call; process.exitCode may be assigned anywhere.
runSwain({
  argv: process.argv.slice(2),
  stdout: (s: string) => process.stdout.write(s),
  stderr: process.stderr,
  stdin: process.stdin,
  env: {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    SWAIN_SERVER_URL: process.env.SWAIN_SERVER_URL,
    SWAIN_DB: process.env.SWAIN_DB,
  },
  nowMs: Date.now,
  onSignal: (cb: () => void) => {
    process.once("SIGINT", cb);
    process.once("SIGTERM", cb);
  },
  version: SCHEMA_VERSION,
}).then((code: number) => {
  process.exitCode = code;
});
