import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AtmError } from "../../src/errors.js";
import { DEFAULT_WALK_OPTIONS, walkImportPaths } from "../../src/ingest/fs/walk.js";
import { refRegistration } from "../pipeline/ref-adapter.js";

let dir = "";
before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "atm-walk-")));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const regs = [refRegistration()];
const rel = (files: readonly string[], root: string): string[] =>
  files.map((f) => f.slice(root.length + 1));

test("walk collects matching regular files, sorted, and skips symlinks, FIFOs and unmatched", () => {
  const root = join(dir, "t1");
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  mkdirSync(join(root, "realdir"));
  writeFileSync(join(root, "b.ref.jsonl"), "{}\n");
  writeFileSync(join(root, "a.ref.jsonl"), "{}\n");
  writeFileSync(join(root, "sub", "c.ref.jsonl"), "{}\n");
  writeFileSync(join(root, "sub", "deep", "d.ref.jsonl"), "{}\n");
  writeFileSync(join(root, "notes.txt"), "x");
  writeFileSync(join(root, "realdir", "z.ref.jsonl"), "{}\n");
  symlinkSync(join(root, "a.ref.jsonl"), join(root, "link.ref.jsonl"));
  symlinkSync(join(root, "realdir"), join(root, "dirlink"));
  assert.equal(spawnSync("mkfifo", [join(root, "pipe.ref.jsonl")]).status, 0);
  const r = walkImportPaths([root], regs, DEFAULT_WALK_OPTIONS);
  assert.deepEqual(rel(r.files, root), [
    "a.ref.jsonl",
    "b.ref.jsonl",
    "realdir/z.ref.jsonl",
    "sub/c.ref.jsonl",
    "sub/deep/d.ref.jsonl",
  ]);
  assert.deepEqual(r.skipped, { symlinks: 2, nonRegular: 1, unmatched: 1, depthOrCount: 0 });
  assert.deepEqual(r.files, [...r.files].sort());
});

test("an explicit symlink argument is followed; an explicit file is kept as given", () => {
  const root = join(dir, "t2");
  mkdirSync(join(root, "real"), { recursive: true });
  writeFileSync(join(root, "real", "x.ref.jsonl"), "{}\n");
  symlinkSync(join(root, "real"), join(root, "alias"));
  const viaDir = walkImportPaths([join(root, "alias")], regs, DEFAULT_WALK_OPTIONS);
  assert.equal(viaDir.files.length, 1);
  assert.ok(viaDir.files[0]?.endsWith("real/x.ref.jsonl"));
  const file = join(root, "real", "whatever.bin");
  writeFileSync(file, "x");
  assert.deepEqual(walkImportPaths([file], regs, DEFAULT_WALK_OPTIONS).files, [file]);
});

test("the same directory given twice is walked once", () => {
  const root = join(dir, "t3");
  mkdirSync(root);
  writeFileSync(join(root, "a.ref.jsonl"), "{}\n");
  assert.equal(
    walkImportPaths([root, root, join(root, ".")], regs, DEFAULT_WALK_OPTIONS).files.length,
    1,
  );
});

test("maxDepth and maxFiles stop the walk without throwing and count the excess", () => {
  const root = join(dir, "t4");
  mkdirSync(join(root, "d1", "d2", "d3"), { recursive: true });
  writeFileSync(join(root, "d1", "d2", "d3", "deep.ref.jsonl"), "{}\n");
  writeFileSync(join(root, "top.ref.jsonl"), "{}\n");
  const shallow = walkImportPaths([root], regs, { maxDepth: 2, maxFiles: 100 });
  assert.deepEqual(rel(shallow.files, root), ["top.ref.jsonl"]);
  assert.equal(shallow.skipped.depthOrCount, 1);
  for (let i = 0; i < 5; i++) writeFileSync(join(root, `f${i}.ref.jsonl`), "{}\n");
  const capped = walkImportPaths([root], regs, { maxDepth: 8, maxFiles: 3 });
  assert.equal(capped.files.length, 3);
  assert.ok(capped.skipped.depthOrCount >= 1);
});

test("an unresolvable explicit path is source-unreadable", () => {
  assert.throws(
    () => walkImportPaths([join(dir, "missing")], regs, DEFAULT_WALK_OPTIONS),
    (e: unknown) => e instanceof AtmError && e.code === "source-unreadable",
  );
});

test("a malformed or backreference pattern never matches", () => {
  const root = join(dir, "t5");
  mkdirSync(root);
  writeFileSync(join(root, "a.ref.jsonl"), "{}\n");
  const bad = refRegistration();
  for (const pattern of ["(", ".*", "^(a)\\1$", "^.*\\.ref\\.jsonl"]) {
    const r = walkImportPaths(
      [root],
      [{ ...bad, discovery: { ...bad.discovery, fileNamePattern: pattern } }],
      DEFAULT_WALK_OPTIONS,
    );
    assert.equal(r.files.length, 0, pattern);
  }
});
