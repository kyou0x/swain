#!/usr/bin/env node
import { runMain } from "./main.js";

process.exitCode = runMain(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME },
  nowMs: Date.now,
});
