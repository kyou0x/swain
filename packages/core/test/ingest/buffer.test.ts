import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  ABSOLUTE_MAX_FILE_BYTES,
  type Bounds,
  DEFAULT_BOUNDS,
} from "../../src/adapter/contract.js";
import { AtmError } from "../../src/errors.js";
import { sourceFromBuffer } from "../../src/ingest/fs/buffer.js";
import { readSourceFile } from "../../src/ingest/fs/read.js";

let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "atm-buffer-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const code = (c: string) => (e: unknown) => e instanceof AtmError && e.code === c;
const small = (maxFileBytes: number): Bounds => ({ ...DEFAULT_BOUNDS, maxFileBytes });

/** Both readers on the same bytes: same result or the same error code. */
function both(name: string, bytes: Uint8Array, bounds: Bounds): void {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  let fromFile: unknown;
  let fileErr: string | undefined;
  try {
    fromFile = readSourceFile(p, bounds);
  } catch (e) {
    fileErr = e instanceof AtmError ? e.code : "other";
  }
  if (fileErr !== undefined) {
    assert.throws(() => sourceFromBuffer(bytes, p, bounds), code(fileErr));
    return;
  }
  assert.deepEqual(sourceFromBuffer(bytes, p, bounds), fromFile);
}

test("sourceFromBuffer equals readSourceFile: plain, empty, hostile display name", () => {
  const plain = new TextEncoder().encode('{"type":"turn.started"}\n');
  both("a.jsonl", plain, DEFAULT_BOUNDS);
  both("empty", new Uint8Array(0), DEFAULT_BOUNDS);
  const r = sourceFromBuffer(plain, "/x/y/a.jsonl", DEFAULT_BOUNDS);
  assert.equal(r.sha256, "cf515a4acc6e41e0f111f01c78b13ba4253f611de9374474864f01e69a90c08f");
  assert.equal(r.displayName, "a.jsonl");
  assert.deepEqual(r.container, { encoding: "none", sha256: r.sha256, byteLength: plain.length });
  assert.equal(sourceFromBuffer(plain, "../..", DEFAULT_BOUNDS).displayName, "source");
  assert.equal(sourceFromBuffer(plain, "a‮b\u0007.txt", DEFAULT_BOUNDS).displayName, "a_b_.txt");
});

test("sourceFromBuffer equals readSourceFile: zstd container", () => {
  const plain = new TextEncoder().encode('{"a":1}\n'.repeat(500));
  const comp = zstdCompressSync(plain);
  both("a.jsonl.zst", comp, DEFAULT_BOUNDS);
  const r = sourceFromBuffer(comp, "a.jsonl.zst", DEFAULT_BOUNDS);
  assert.equal(r.container.encoding, "zstd");
  assert.equal(r.container.byteLength, comp.length);
  assert.equal(r.byteLength, plain.length);
  assert.deepEqual(r.bytes, new Uint8Array(plain));
});

test("sourceFromBuffer equals readSourceFile: file-too-large (plain, zstd bomb) and boundary", () => {
  const plain = new Uint8Array(100).fill(0x61);
  both("exact", plain, small(100));
  both("over", plain, small(99));
  assert.throws(() => sourceFromBuffer(plain, "over", small(99)), code("file-too-large"));
  const bomb = zstdCompressSync(new Uint8Array(8 * 1024 * 1024));
  both("bomb", bomb, DEFAULT_BOUNDS);
  assert.throws(() => sourceFromBuffer(bomb, "bomb", small(1024)), code("file-too-large"));
  // Compressed input over the bound is rejected before decompression, as for files.
  assert.throws(
    () => sourceFromBuffer(bomb, "bomb", small(bomb.length - 1)),
    code("file-too-large"),
  );
});

test("sourceFromBuffer equals readSourceFile: corrupt zstd and invalid bounds", () => {
  const bad = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3, 4, 5]);
  both("corrupt", bad, DEFAULT_BOUNDS);
  assert.throws(() => sourceFromBuffer(bad, "c", DEFAULT_BOUNDS), code("zstd-unavailable"));
  for (const n of [-1, 1.5, Number.NaN, ABSOLUTE_MAX_FILE_BYTES + 1]) {
    assert.throws(() => sourceFromBuffer(new Uint8Array(1), "x", small(n)), code("invalid-option"));
  }
});

test("sourceFromBuffer validates its arguments and never aliases the caller's array", () => {
  assert.throws(
    () => sourceFromBuffer("text" as unknown as Uint8Array, "x", DEFAULT_BOUNDS),
    code("invalid-option"),
  );
  assert.throws(
    () => sourceFromBuffer(new Uint8Array(1), 5 as unknown as string, DEFAULT_BOUNDS),
    code("invalid-option"),
  );
  const mine = new Uint8Array([1, 2, 3]);
  const r = sourceFromBuffer(mine, "x", DEFAULT_BOUNDS);
  mine[0] = 9;
  assert.deepEqual(r.bytes, new Uint8Array([1, 2, 3]));
});
