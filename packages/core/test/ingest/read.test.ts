import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { ABSOLUTE_MAX_FILE_BYTES, DEFAULT_BOUNDS } from "../../src/adapter/contract.js";
import { AtmError } from "../../src/errors.js";
import { frameSource } from "../../src/ingest/frame/index.js";
import { readSourceFile, sanitizeDisplayName } from "../../src/ingest/fs/read.js";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-read-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const code = (c: string) => (e: unknown) => e instanceof AtmError && e.code === c;

test("regular file: bytes, hashes, container and display name", () => {
  const p = join(dir, "a.jsonl");
  const bytes = Buffer.from('{"type":"turn.started"}\n');
  writeFileSync(p, bytes);
  const r = readSourceFile(p, DEFAULT_BOUNDS);
  assert.deepEqual(Buffer.from(r.bytes), bytes);
  assert.equal(r.sha256, "cf515a4acc6e41e0f111f01c78b13ba4253f611de9374474864f01e69a90c08f");
  assert.equal(r.byteLength, bytes.length);
  assert.deepEqual(r.container, { encoding: "none", sha256: r.sha256, byteLength: bytes.length });
  assert.equal(r.displayName, "a.jsonl");
});

test("empty file reads as zero bytes", () => {
  const p = join(dir, "empty");
  writeFileSync(p, "");
  const r = readSourceFile(p, DEFAULT_BOUNDS);
  assert.equal(r.byteLength, 0);
  assert.equal(frameSource(r.bytes, { kind: "jsonl" }, DEFAULT_BOUNDS).records.length, 0);
});

test("directory, /dev/null and FIFO are NotRegularFile and are never read", () => {
  assert.throws(() => readSourceFile(dir, DEFAULT_BOUNDS), code("not-regular-file"));
  assert.throws(() => readSourceFile("/dev/null", DEFAULT_BOUNDS), code("not-regular-file"));
  const fifo = join(dir, "pipe");
  const r = spawnSync("mkfifo", [fifo]);
  assert.equal(r.status, 0);
  // O_NONBLOCK: no writer exists, so a blocking open or read would hang this test.
  assert.throws(() => readSourceFile(fifo, DEFAULT_BOUNDS), code("not-regular-file"));
});

test("missing path is source-unreadable", () => {
  assert.throws(() => readSourceFile(join(dir, "nope"), DEFAULT_BOUNDS), code("source-unreadable"));
});

test("oversize file is FileTooLarge; the limit is inclusive", () => {
  const p = join(dir, "ten");
  writeFileSync(p, "0123456789");
  assert.throws(
    () => readSourceFile(p, { ...DEFAULT_BOUNDS, maxFileBytes: 9 }),
    code("file-too-large"),
  );
  assert.equal(readSourceFile(p, { ...DEFAULT_BOUNDS, maxFileBytes: 10 }).byteLength, 10);
});

test("maxFileBytes can never exceed the absolute ceiling", () => {
  const p = join(dir, "x");
  writeFileSync(p, "x");
  assert.throws(
    () => readSourceFile(p, { ...DEFAULT_BOUNDS, maxFileBytes: ABSOLUTE_MAX_FILE_BYTES + 1 }),
    code("invalid-option"),
  );
  assert.equal(
    readSourceFile(p, { ...DEFAULT_BOUNDS, maxFileBytes: ABSOLUTE_MAX_FILE_BYTES }).byteLength,
    1,
  );
});

test("file that grows between the read and the probe is SourceChangedDuringImport", () => {
  const p = join(dir, "grow");
  writeFileSync(p, "abc\n");
  assert.throws(
    () => readSourceFile(p, DEFAULT_BOUNDS, { afterRead: () => appendFileSync(p, "more\n") }),
    code("source-changed-during-import"),
  );
});

test("same-size rewrite with a new mtime is detected", () => {
  const p = join(dir, "same-size");
  writeFileSync(p, "abcd");
  utimesSync(p, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  assert.throws(
    () =>
      readSourceFile(p, DEFAULT_BOUNDS, {
        afterRead: () => utimesSync(p, new Date(1_800_000_000_000), new Date(1_800_000_000_000)),
      }),
    code("source-changed-during-import"),
  );
});

test("file truncated before the read completes is SourceChangedDuringImport", () => {
  const p = join(dir, "shrink");
  writeFileSync(p, "abcdefgh");
  assert.throws(
    () =>
      readSourceFile(p, DEFAULT_BOUNDS, {
        afterRead: () => writeFileSync(p, "ab"),
      }),
    code("source-changed-during-import"),
  );
});

test("a symlink given as an explicit argument is followed", () => {
  const target = join(dir, "real.jsonl");
  writeFileSync(target, '{"a":1}\n');
  const link = join(dir, "link.jsonl");
  symlinkSync(target, link);
  const r = readSourceFile(link, DEFAULT_BOUNDS);
  assert.equal(r.byteLength, 8);
  assert.equal(r.displayName, "link.jsonl");
});

test("zstd round trip: offsets and sha256 refer to the decompressed bytes", () => {
  const plain = Buffer.from('{"t":"a"}\n{"t":"b"}\n');
  const comp = zstdCompressSync(plain);
  const p = join(dir, "x.jsonl.zst");
  writeFileSync(p, comp);
  const r = readSourceFile(p, DEFAULT_BOUNDS);
  assert.deepEqual(Buffer.from(r.bytes), plain);
  assert.equal(r.sha256, sha(plain));
  assert.equal(r.byteLength, plain.length);
  assert.deepEqual(r.container, { encoding: "zstd", sha256: sha(comp), byteLength: comp.length });
  const frame = frameSource(r.bytes, { kind: "jsonl" }, DEFAULT_BOUNDS);
  assert.equal(frame.records[1]?.byteOffset, 10);
  assert.equal(frame.records[1]?.sha256, sha(Buffer.from('{"t":"b"}')));
});

test("zstd bomb: tiny input, output above the bound is FileTooLarge", () => {
  const comp = zstdCompressSync(Buffer.alloc(8 * 1024 * 1024));
  assert.ok(comp.length < 4096);
  const p = join(dir, "bomb.jsonl.zst");
  writeFileSync(p, comp);
  assert.throws(
    () => readSourceFile(p, { ...DEFAULT_BOUNDS, maxFileBytes: 1024 * 1024 }),
    code("file-too-large"),
  );
  // Output exactly at the bound is accepted.
  assert.equal(
    readSourceFile(p, { ...DEFAULT_BOUNDS, maxFileBytes: 8 * 1024 * 1024 }).byteLength,
    8 * 1024 * 1024,
  );
});

test("corrupt zstd stream is rejected as zstd-unavailable", () => {
  const p = join(dir, "corrupt.zst");
  writeFileSync(p, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
  assert.throws(() => readSourceFile(p, DEFAULT_BOUNDS), code("zstd-unavailable"));
});

test("display names are sanitized", () => {
  assert.equal(sanitizeDisplayName("/x/y/ok.jsonl"), "ok.jsonl");
  assert.equal(sanitizeDisplayName("/x/a\\b\u0000c\u001b[2Jd‮.jsonl"), "a_b_c_[2Jd_.jsonl");
  assert.equal(sanitizeDisplayName("/"), "source");
  assert.equal(sanitizeDisplayName(`/x/${"é".repeat(300)}`).length <= 255, true);
  assert.ok(new TextEncoder().encode(sanitizeDisplayName(`/x/${"é".repeat(300)}`)).length <= 255);
  assert.equal(sanitizeDisplayName("/x/\ud800.txt").isWellFormed(), true);
});

test("a nested directory fixture path still reads one regular file", () => {
  mkdirSync(join(dir, "nest"));
  const p = join(dir, "nest", "f.jsonl");
  writeFileSync(p, "{}\n");
  assert.equal(readSourceFile(p, DEFAULT_BOUNDS).byteLength, 3);
});

test("G3-6: followSymlinks=false opens with O_NOFOLLOW; default still follows", () => {
  const target = join(dir, "nf-target.jsonl");
  const link = join(dir, "nf-link.jsonl");
  writeFileSync(target, '{"a":1}\n');
  symlinkSync(target, link);
  assert.equal(readSourceFile(link, DEFAULT_BOUNDS).byteLength, 8);
  assert.equal(readSourceFile(link, DEFAULT_BOUNDS, { followSymlinks: true }).byteLength, 8);
  assert.throws(
    () => readSourceFile(link, DEFAULT_BOUNDS, { followSymlinks: false }),
    code("source-unreadable"),
  );
  assert.equal(readSourceFile(target, DEFAULT_BOUNDS, { followSymlinks: false }).byteLength, 8);
});
