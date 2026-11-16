/**
 * Bounded source reader (SPEC-002 section 3.1, M-5, M-9). The only place provider bytes are
 * read. One fd, `fstat` before and after, an EOF probe, and a zstd output cap.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Bounds } from "../../adapter/contract.js";
import { AtmError } from "../../errors.js";
import { assertFileLimit, finishSource, type SourceBytes } from "./buffer.js";

export type { SourceBytes } from "./buffer.js";
export { sanitizeDisplayName } from "./buffer.js";

/** Read options plus a test seam for the read loop. */
export interface ReadHooks {
  /**
   * Whether the final path component may be a symlink. Default `true` (explicit user arguments).
   * Callers reading files discovered by the directory walker pass `false` (opens with O_NOFOLLOW;
   * a symlink then fails with `source-unreadable`).
   */
  readonly followSymlinks?: boolean;
  /** Runs after the data was read and before the EOF probe and the post-read `fstat`. */
  readonly afterRead?: () => void;
}

/** Read one regular file into memory under `bounds`. Throws a typed `AtmError`. */
export function readSourceFile(path: string, bounds: Bounds, hooks?: ReadHooks): SourceBytes {
  const limit = assertFileLimit(bounds);
  let fd: number;
  try {
    const nofollow = hooks?.followSymlinks === false ? constants.O_NOFOLLOW : 0;
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | nofollow);
  } catch {
    throw new AtmError("source-unreadable");
  }
  let raw: Uint8Array;
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new AtmError("not-regular-file");
    if (before.size > limit) throw new AtmError("file-too-large");
    const buf = new Uint8Array(before.size);
    let got = 0;
    while (got < buf.length) {
      let n: number;
      try {
        n = readSync(fd, buf, got, buf.length - got, null);
      } catch {
        throw new AtmError("source-unreadable");
      }
      if (n === 0) break;
      got += n;
    }
    hooks?.afterRead?.();
    let probe: number;
    try {
      probe = readSync(fd, new Uint8Array(1), 0, 1, null);
    } catch {
      throw new AtmError("source-unreadable");
    }
    const after = fstatSync(fd);
    if (
      got !== before.size ||
      probe !== 0 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    ) {
      throw new AtmError("source-changed-during-import");
    }
    raw = buf;
  } finally {
    closeSync(fd);
  }
  return finishSource(raw, path, bounds, true);
}
