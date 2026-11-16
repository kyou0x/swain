import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertEqualEscaped } from "./helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.js", import.meta.url));

// Every CLI integration test runs under the Node permission model (SPEC-001 section 5).
function atm(args: string[]) {
  const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`, bin, ...args], {
    encoding: "buffer",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("--version", () => {
  const r = atm(["--version"]);
  assert.equal(r.status, 0);
  assertEqualEscaped(r.stdout.toString("utf8"), "swain 0.0.0\ncanonical-schema 0.1.0\n");
  assert.equal(r.stderr.length, 0);
});

test("--help", () => {
  const r = atm(["--help"]);
  assert.equal(r.status, 0);
  const text = r.stdout.toString("utf8");
  assert.ok(text.startsWith("Usage: swain"));
  assert.ok(text.includes("import <path...>"));
  assert.equal(r.stderr.length, 0);
});

test("no arguments exits 2 with usage on stderr", () => {
  const r = atm([]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.toString("utf8").startsWith("Usage: swain"));
  assert.equal(r.stdout.length, 0);
});

test("--version --help exits 2 with too many arguments", () => {
  const r = atm(["--version", "--help"]);
  assert.equal(r.status, 2);
  assertEqualEscaped(r.stderr.toString("utf8"), "swain: too many arguments\n");
});

test("hostile arguments are escaped and never emit ESC or BEL", () => {
  const cases = [
    "\u001b]8;;http://x\u0007\u001b[2J",
    "--\u001b[2J",
    "-\u001b",
    "--x=\u001b]8;;u\u0007",
    "y".repeat(10_000),
  ];
  for (const arg of cases) {
    const r = atm([arg]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr.includes(0x1b), false);
    assert.equal(r.stderr.includes(0x07), false);
    const text = r.stderr.toString("utf8");
    assert.equal(text.includes("ERR_PARSE_ARGS"), false);
    assert.ok(text.startsWith("swain: unknown argument: "));
    assert.equal(r.stdout.length, 0);
  }
  const long = atm(["y".repeat(10_000)]);
  assertEqualEscaped(
    long.stderr.toString("utf8"),
    `swain: unknown argument: ${"y".repeat(200)}...\nRun 'swain --help' for usage.\n`,
  );
});
