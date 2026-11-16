import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { main, runMain } from "../src/main.js";
import { CLI_VERSION } from "../src/version.js";
import { assertEqualEscaped, ENV, NOW } from "./helpers.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: { write: (s: string) => void out.push(s) },
      stderr: { write: (s: string) => void err.push(s) },
      env: ENV,
      nowMs: NOW,
    },
  };
}

test("CLI_VERSION equals package.json version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(CLI_VERSION, pkg.version);
});

test("--version / -V", () => {
  for (const flag of ["--version", "-V"]) {
    const c = capture();
    assert.equal(main([flag], c.io), 0);
    assert.equal(c.out.join(""), "swain 0.0.0\ncanonical-schema 0.1.0\n");
    assert.equal(c.err.join(""), "");
  }
});

test("--help / -h", () => {
  for (const flag of ["--help", "-h"]) {
    const c = capture();
    assert.equal(main([flag], c.io), 0);
    const text = c.out.join("");
    assert.ok(text.startsWith("Usage: swain [--store DIR] <command> [options]"));
    for (const cmd of ["import", "sessions", "show", "explain", "report", "ui", "sources"]) {
      assert.ok(
        text.split("\n").some((l) => l.trimStart().startsWith(cmd)),
        cmd,
      );
    }
    assert.ok(!text.includes("No import commands are implemented"));
  }
});

test("no arguments: usage on stderr, exit 2", () => {
  const c = capture();
  assert.equal(main([], c.io), 2);
  assert.ok(c.err.join("").startsWith("Usage: swain"));
  assert.equal(c.out.join(""), "");
});

test("too many recognized arguments", () => {
  const c = capture();
  assert.equal(main(["--version", "--help"], c.io), 2);
  assert.equal(c.err.join(""), "swain: too many arguments\n");
});

test("unknown argument is escaped and truncated before escaping", () => {
  const c = capture();
  assert.equal(main(["\u001b]8;;http://x\u0007\u001b[2J"], c.io), 2);
  const text = c.err.join("");
  assertEqualEscaped(
    text,
    "swain: unknown argument: \\u001B]8;;http://x\\u0007\\u001B[2J\nRun 'swain --help' for usage.\n",
  );
  const d = capture();
  assert.equal(main(["--version", "x\u001b", "--help"], d.io), 2);
  assert.ok(d.err.join("").startsWith("swain: unknown argument: x\\u001B\n"));
  const long = capture();
  main(["\u001b".repeat(10_000)], long.io);
  assertEqualEscaped(
    long.err.join(""),
    `swain: unknown argument: ${"\\u001B".repeat(200)}...\nRun 'swain --help' for usage.\n`,
  );
  const e = capture();
  main(["\u{1f600}".repeat(201)], e.io);
  assertEqualEscaped(
    e.err.join(""),
    `swain: unknown argument: ${"\u{1f600}".repeat(200)}...\nRun 'swain --help' for usage.\n`,
  );
});

test("runMain: a throwing writer yields a static internal error, exit 1", () => {
  const err: string[] = [];
  const io = {
    stdout: {
      write: () => {
        throw new Error("secret stack detail");
      },
    },
    stderr: { write: (s: string) => void err.push(s) },
    env: ENV,
    nowMs: NOW,
  };
  assert.equal(runMain(["--version"], io), 1);
  assert.equal(err.join(""), "swain: internal error\n");
  const bothThrow = {
    stdout: io.stdout,
    stderr: {
      write: () => {
        throw new Error("again");
      },
    },
    env: ENV,
    nowMs: NOW,
  };
  assert.doesNotThrow(() => runMain(["--version"], bothThrow));
  assert.equal(runMain(["--version"], bothThrow), 1);
});
