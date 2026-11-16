import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OutputRefused, writeOutputDir, writeOutputFile } from "../src/index.js";
import { tempRoot } from "./helpers.js";

const OPTS = { force: false, maxBytes: 1_000_000 };

function refused(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof OutputRefused && e.code === code);
}

test("writeOutputFile: new file 0600, no temp left, exists refused, force replaces", () => {
  const t = tempRoot();
  try {
    const out = join(t.dir, "r.md");
    writeOutputFile(out, "one", OPTS);
    assert.equal(readFileSync(out, "utf8"), "one");
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(t.dir), ["r.md"]);
    refused(() => writeOutputFile(out, "two", OPTS), "exists");
    assert.equal(readFileSync(out, "utf8"), "one");
    writeOutputFile(out, "two", { ...OPTS, force: true });
    assert.equal(readFileSync(out, "utf8"), "two");
    assert.deepEqual(readdirSync(t.dir), ["r.md"]);
  } finally {
    t.done();
  }
});

test("writeOutputFile: symlink targets and parents, missing parent, directories, size", () => {
  const t = tempRoot();
  try {
    const victim = join(t.dir, "victim.txt");
    writeFileSync(victim, "untouched");
    const link = join(t.dir, "link.md");
    symlinkSync(victim, link);
    refused(() => writeOutputFile(link, "evil", OPTS), "symlink");
    refused(() => writeOutputFile(link, "evil", { ...OPTS, force: true }), "symlink");
    assert.equal(readFileSync(victim, "utf8"), "untouched");

    const realDir = join(t.dir, "real");
    mkdirSync(realDir);
    symlinkSync(realDir, join(t.dir, "ldir"));
    refused(() => writeOutputFile(join(t.dir, "ldir", "x.md"), "evil", OPTS), "symlink");
    assert.deepEqual(readdirSync(realDir), []);

    refused(() => writeOutputFile(join(t.dir, "missing", "x.md"), "x", OPTS), "parent-invalid");
    mkdirSync(join(t.dir, "adir"));
    refused(
      () => writeOutputFile(join(t.dir, "adir"), "x", { ...OPTS, force: true }),
      "not-regular",
    );
    refused(
      () => writeOutputFile(join(t.dir, "big.md"), "xxxx", { ...OPTS, maxBytes: 3 }),
      "too-large",
    );
    refused(() => writeOutputFile("", "x", OPTS), "invalid-path");
    refused(() => writeOutputFile(join(t.dir, "nul\0.md"), "x", OPTS), "invalid-path");
    writeFileSync(join(t.dir, ".s.md.atm-tmp"), "stale");
    refused(() => writeOutputFile(join(t.dir, "s.md"), "x", OPTS), "stale-temp");
  } finally {
    t.done();
  }
});

const FILES = [
  { name: "index.html", data: "<p>index</p>" },
  { name: "sessions/imp_abc.html", data: "<p>one</p>" },
] as const;

test("writeOutputDir: create, refuse existing, force needs the marker, swap removes old files", () => {
  const t = tempRoot();
  try {
    const dir = join(t.dir, "ui");
    const abs = writeOutputDir(dir, FILES, OPTS);
    assert.equal(abs, dir);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<p>index</p>");
    assert.equal(readFileSync(join(dir, "sessions", "imp_abc.html"), "utf8"), "<p>one</p>");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "index.html")).mode & 0o777, 0o600);
    assert.ok(readdirSync(dir).includes(".atm-ui"));
    assert.deepEqual(readdirSync(t.dir), ["ui"]);

    refused(() => writeOutputDir(dir, FILES, OPTS), "exists");
    writeOutputDir(dir, [{ name: "index.html", data: "<p>new</p>" }], { ...OPTS, force: true });
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<p>new</p>");
    assert.deepEqual(readdirSync(dir).sort(), [".atm-ui", "index.html"]);
    assert.deepEqual(readdirSync(t.dir), ["ui"]);
  } finally {
    t.done();
  }
});

test("writeOutputDir: unmarked directories, symlinks, bad names and sizes are refused", () => {
  const t = tempRoot();
  try {
    const other = join(t.dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "precious.txt"), "keep");
    refused(() => writeOutputDir(other, FILES, { ...OPTS, force: true }), "not-marked");
    assert.deepEqual(readdirSync(other), ["precious.txt"]);

    const link = join(t.dir, "link");
    symlinkSync(other, link);
    refused(() => writeOutputDir(link, FILES, { ...OPTS, force: true }), "symlink");
    const file = join(t.dir, "file");
    writeFileSync(file, "x");
    refused(() => writeOutputDir(file, FILES, { ...OPTS, force: true }), "not-regular");

    refused(
      () =>
        writeOutputDir(
          join(t.dir, "a"),
          [
            { name: "index.html", data: "x" },
            { name: "index.html", data: "y" },
          ],
          OPTS,
        ),
      "invalid-name",
    );
    refused(
      () =>
        writeOutputDir(
          join(t.dir, "b"),
          [
            { name: "index.html", data: "x" },
            { name: "sessions/../../x.html" as "index.html", data: "y" },
          ],
          OPTS,
        ),
      "invalid-name",
    );
    refused(
      () => writeOutputDir(join(t.dir, "c"), [{ name: "sessions/a.html", data: "x" }], OPTS),
      "invalid-name",
    );
    refused(() => writeOutputDir(join(t.dir, "d"), FILES, { ...OPTS, maxBytes: 10 }), "too-large");
    refused(() => writeOutputDir(join(t.dir, "nope", "e"), FILES, OPTS), "parent-invalid");
    assert.deepEqual(readdirSync(t.dir).sort(), ["file", "link", "other"]);
  } finally {
    t.done();
  }
});

test("writeOutputDir: unexpected content in an old tree is never deleted", () => {
  const t = tempRoot();
  try {
    const dir = join(t.dir, "ui");
    writeOutputDir(dir, FILES, OPTS);
    // A stale temp tree that contains something we did not generate blocks the write.
    mkdirSync(`${dir}.tmp`);
    writeFileSync(join(`${dir}.tmp`, "user.txt"), "keep");
    refused(() => writeOutputDir(dir, FILES, { ...OPTS, force: true }), "not-marked");
    assert.equal(readFileSync(join(`${dir}.tmp`, "user.txt"), "utf8"), "keep");
  } finally {
    t.done();
  }
});
