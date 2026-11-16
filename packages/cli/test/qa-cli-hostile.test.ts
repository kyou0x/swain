// Independent G2 (QA) hostile-argument tests for the CLI. Every spawned run uses the Node
// permission model flags from SPEC-001 section 5. Expectations come from SPEC-001 section 4 (C4).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CliIo, main, runMain } from "../src/main.js";
import { ENV, NOW } from "./helpers.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const bin = fileURLToPath(new URL("../src/bin.js", import.meta.url));

function atm(args: string[]) {
  const r = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${root}`, bin, ...args], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

function run(argv: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
    env: ENV,
    nowMs: NOW,
  };
  return { code: main(argv, io), out, err };
}

/** True when any character that could drive a terminal or hide text is present raw. */
function hasRawControl(s: string): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp <= 0x1f && cp !== 0x0a) ||
      (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x61c ||
      cp === 0x200e ||
      cp === 0x200f ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      (cp >= 0xd800 && cp <= 0xdfff)
    ) {
      return true;
    }
  }
  return false;
}

const PREFIX = "swain: unknown argument: ";
const SUFFIX = "\nRun 'swain --help' for usage.\n";

function echoed(err: string): string {
  assert.ok(err.startsWith(PREFIX), "prefix");
  assert.ok(err.endsWith(SUFFIX), "suffix");
  return err.slice(PREFIX.length, err.length - SUFFIX.length);
}

test("spawned: bidi and format controls are escaped, stderr has no raw control bytes", () => {
  const nasty = [
    "‮txt.exe‬",
    "⁦x⁩⁧y⁨‪‫‭",
    "؜‎‏",
    "a\u0085b\u009bc",
    "\u001b[31mred\u001b[0m",
    "\u001b]0;title\u0007",
    "\u0008\u0008\u0008",
    "x\ry",
    "\u007f",
    "--‮",
    "-⁦",
    "--x=\u001b]8;;u\u0007",
  ];
  for (const a of nasty) {
    const r = atm([a]);
    assert.equal(r.status, 2, JSON.stringify(a));
    assert.equal(r.stdout.length, 0);
    const err = r.stderr.toString("utf8");
    assert.equal(hasRawControl(err), false, `raw control in stderr for ${JSON.stringify(a)}`);
    assert.ok(!r.stderr.includes(0x1b));
    assert.ok(!r.stderr.includes(0x07));
    assert.ok(!r.stderr.includes(0x0d));
    // C1 controls would be encoded as C2 80..C2 9F
    for (let i = 0; i + 1 < r.stderr.length; i++) {
      assert.ok(
        !(r.stderr[i] === 0xc2 && (r.stderr[i + 1] ?? 0) >= 0x80 && (r.stderr[i + 1] ?? 0) <= 0x9f),
      );
    }
    assert.ok(!/ERR_PARSE_ARGS|at .*\(.*:\d+:\d+\)|node:internal/.test(err));
  }
});

test("spawned: a 100,000 character argument echoes at most 200 code points then '...'", () => {
  const r = atm(["a".repeat(100_000)]);
  assert.equal(r.status, 2);
  const e = echoed(r.stderr.toString("utf8"));
  assert.equal(e, `${"a".repeat(200)}...`);
  assert.ok(r.stderr.length < 400);
});

test("spawned: very long astral argument is cut on a code point boundary (never splits a pair)", () => {
  const r = atm(["\u{1F600}".repeat(30_000)]);
  assert.equal(r.status, 2);
  const err = r.stderr.toString("utf8");
  assert.ok(!err.includes("�"));
  assert.equal(echoed(err), `${"\u{1F600}".repeat(200)}...`);
});

test("spawned: argument that is mostly escapes is bounded by 200 input code points (output may be up to 6x)", () => {
  const r = atm(["\u001b".repeat(5_000)]);
  assert.equal(r.status, 2);
  const e = echoed(r.stderr.toString("utf8"));
  assert.equal(e, `${"\\u001B".repeat(200)}...`);
  assert.ok(r.stderr.length < 1500);
});

test("spawned: empty string, whitespace, '--', '-', and look-alikes of recognised flags are unknown arguments", () => {
  for (const a of [
    "",
    " ",
    "--",
    "-",
    "--version ",
    " --version",
    "--VERSION",
    "-v",
    "--Help",
    "-H",
    "--version=1",
    "-Vh",
  ]) {
    const r = atm([a]);
    assert.equal(r.status, 2, JSON.stringify(a));
    assert.equal(r.stdout.length, 0);
    assert.ok(r.stderr.toString("utf8").startsWith(PREFIX));
  }
  // Unicode look-alike of --version (fullwidth hyphen-minus) is NOT recognised.
  const r = atm(["－－version"]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout.length, 0);
});

test("spawned: the FIRST unrecognised token is echoed, recognised ones around it are not", () => {
  const r = atm(["--version", "bad\u001b", "--help", "worse"]);
  assert.equal(r.status, 2);
  assert.equal(echoed(r.stderr.toString("utf8")), "bad\\u001B");
  const two = atm(["-V", "-h"]);
  assert.equal(two.status, 2);
  assert.equal(two.stderr.toString("utf8"), "swain: too many arguments\n");
  const rep = atm(["--help", "--help"]);
  assert.equal(rep.status, 2);
  assert.equal(rep.stderr.toString("utf8"), "swain: too many arguments\n");
});

test("spawned: many arguments (10,000) do not crash and report once", () => {
  const r = atm(Array.from({ length: 10_000 }, () => "-V"));
  assert.equal(r.status, 2);
  assert.equal(r.stderr.toString("utf8"), "swain: too many arguments\n");
  const mixed = atm([...Array.from({ length: 5_000 }, () => "-V"), "zzz"]);
  assert.equal(mixed.status, 2);
  assert.equal(echoed(mixed.stderr.toString("utf8")), "zzz");
});

test("spawned: valid flags still succeed under the permission model", () => {
  const v = atm(["-V"]);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.toString("utf8"), "swain 0.0.0\ncanonical-schema 0.1.0\n");
  assert.equal(v.stderr.length, 0);
  const h = atm(["-h"]);
  assert.equal(h.status, 0);
  assert.ok(
    h.stdout.toString("utf8").startsWith("Usage: swain [--store DIR] <command> [options]\n"),
  );
  assert.equal(h.stderr.length, 0);
});

test("main(): lone surrogates are escaped, not written raw", () => {
  for (const a of [
    "\ud800",
    "\udc00",
    "a\ud83d",
    "\ude00\ud83d",
    "\ud800\ud800",
    `${"x".repeat(199)}\ud800`,
  ]) {
    const r = run([a]);
    assert.equal(r.code, 2);
    assert.equal(hasRawControl(r.err), false, JSON.stringify(a));
    assert.ok(r.err.isWellFormed(), "stderr text must be well-formed");
  }
  assert.equal(echoed(run(["\ud800"]).err), "\\uD800");
  assert.equal(echoed(run(["a\udc00b"]).err), "a\\uDC00b");
});

test("main(): NUL is escaped", () => {
  assert.equal(echoed(run(["a\u0000b"]).err), "a\\u0000b");
  assert.equal(echoed(run(["\u0000"]).err), "\\u0000");
  assert.equal(run(["--version\u0000"]).code, 2);
  assert.equal(run(["--version\u0000"]).out, "");
});

test("main(): truncation boundary is exactly 200 code points; 'then escape' order", () => {
  assert.equal(echoed(run(["b".repeat(200)]).err), "b".repeat(200));
  assert.equal(echoed(run(["b".repeat(201)]).err), `${"b".repeat(200)}...`);
  // astral: 200 code points = 400 UTF-16 units
  assert.equal(echoed(run(["\u{1F600}".repeat(200)]).err), "\u{1F600}".repeat(200));
  assert.equal(echoed(run(["\u{1F600}".repeat(201)]).err), `${"\u{1F600}".repeat(200)}...`);
  // an escape sequence is never cut in half: the cut happens before escaping
  const e = echoed(run([`${"a".repeat(199)}\u001bZZZ`]).err);
  assert.equal(e, `${"a".repeat(199)}\\u001B...`);
  // a backslash in input is doubled, so output cannot forge an escape
  assert.equal(echoed(run(["\\u001B"]).err), "\\\\u001B");
});

test("main(): mixed bidi inputs keep logical order visible as escapes", () => {
  assert.equal(echoed(run(["abc‮def‬ghi"]).err), "abc\\u202Edef\\u202Cghi");
  assert.equal(echoed(run(["⁧⁨⁩"]).err), "\\u2067\\u2068\\u2069");
  assert.equal(echoed(run(["‎‏؜"]).err), "\\u200E\\u200F\\u061C");
});

test("main(): output never contains err.message-like text or stack frames for any hostile input", () => {
  const inputs = ["\ud800", "\u0000", "x".repeat(1_000_000), "‮".repeat(1000), "\u{10FFFF}", "￾￿"];
  for (const a of inputs) {
    const r = run([a]);
    assert.equal(r.code, 2);
    assert.ok(
      !/Error|stack| at /.test(r.err.replace(/unknown argument/, "")) || a.includes("Error"),
    );
    assert.ok(r.err.length < 2000);
  }
});

test("runMain(): throw from stdout.write, then from stderr.write, then non-Error throws", () => {
  let err = "";
  const bad: CliIo = {
    stdout: {
      write: () => {
        throw new Error("secret stack \u001b[2J");
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
    env: ENV,
    nowMs: NOW,
  };
  assert.equal(runMain(["--version"], bad), 1);
  assert.equal(err, "swain: internal error\n");
  for (const thrown of [
    undefined,
    null,
    1,
    "str",
    Symbol("s"),
    { toString: () => "x" },
    Object.create(null),
  ]) {
    err = "";
    const io: CliIo = {
      stdout: {
        write: () => {
          throw thrown;
        },
      },
      stderr: {
        write: (s) => {
          err += s;
        },
      },
      env: ENV,
      nowMs: NOW,
    };
    assert.equal(runMain(["-V"], io), 1);
    assert.equal(err, "swain: internal error\n");
  }
  const both: CliIo = {
    stdout: {
      write: () => {
        throw new Error("a");
      },
    },
    stderr: {
      write: () => {
        throw new Error("b");
      },
    },
    env: ENV,
    nowMs: NOW,
  };
  assert.equal(runMain(["--version"], both), 1);
  // main() itself writes only to stderr for unknown args; a throwing stderr also yields 1
  assert.equal(runMain(["zzz"], both), 1);
  assert.equal(runMain([], both), 1);
});

test("runMain(): returns the same codes as main() when nothing throws", () => {
  const sink: CliIo = {
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    env: ENV,
    nowMs: NOW,
  };
  assert.equal(runMain([], sink), 2);
  assert.equal(runMain(["-h"], sink), 0);
  assert.equal(runMain(["-V"], sink), 0);
  assert.equal(runMain(["x"], sink), 2);
  assert.equal(runMain(["-V", "-V"], sink), 2);
});
