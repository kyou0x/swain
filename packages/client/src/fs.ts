/**
 * Confined filesystem helpers for the files the CLI side owns: the credentials directory and
 * files, the runtime file and the data directory (SPEC-003 S24, ADR-0006 section 8.1).
 *
 * Directories are created 0700 and checked with `lstat` (not a symlink, owned by the effective uid,
 * not group- or world-writable). Files are created `O_CREAT | O_EXCL | O_NOFOLLOW` with mode 0600
 * and read only after an `lstat` check. Nothing here follows a symlink or overwrites a file.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ClientError } from "./errors.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GROUP_WORLD_WRITE = 0o022;
const GROUP_WORLD_ANY = 0o077;
const CREATE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

interface Stat {
  readonly mode: number;
  readonly uid: number;
  readonly size: number;
  readonly ino: number;
  readonly dev: number;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}

function errno(e: unknown): string | undefined {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : undefined;
}

function lstatOrNull(path: string): Stat | null {
  try {
    return (lstatSync(path, { throwIfNoEntry: false }) as Stat | undefined) ?? null;
  } catch {
    throw new ClientError("io");
  }
}

/** The closest ancestor of `path` (or `path` itself) that exists; `/` always does. */
function nearestExisting(path: string): string {
  let p = path;
  for (;;) {
    if (lstatOrNull(p) !== null) return p;
    const up = dirname(p);
    if (up === p) return p;
    p = up;
  }
}

/**
 * The effective uid of this process, learned without `process`: a file created by this process is
 * owned by it. The probe is a fresh `0600` file in the nearest existing ancestor of `target`,
 * removed at once.
 */
export function currentUid(target: string, roots: readonly string[]): number {
  const dir = nearestExisting(target);
  // The probe file is only ever created inside a directory the user named (HOME or the validated
  // XDG base), never in a parent such as `/` or `/home` (G3-auth F8).
  if (!roots.some((r) => r.startsWith("/") && (dir === r || dir.startsWith(`${r}/`)))) {
    throw new ClientError("unsafe-directory");
  }
  const path = join(dir, `.swain-uid-${randomBytes(8).toString("hex")}`);
  let fd = -1;
  try {
    fd = openSync(path, CREATE_FLAGS, FILE_MODE);
    return fstatSync(fd).uid;
  } catch {
    throw new ClientError("io");
  } finally {
    if (fd !== -1) closeSync(fd);
    try {
      unlinkSync(path);
    } catch {
      // The probe is ours and empty; a failure to remove it is not worth failing the command.
    }
  }
}

function checkDir(path: string, uid: number, strict: boolean): void {
  const st = lstatOrNull(path);
  if (st === null || st.isSymbolicLink() || !st.isDirectory())
    throw new ClientError("unsafe-directory");
  const bad = strict ? GROUP_WORLD_ANY : GROUP_WORLD_WRITE;
  if (st.uid !== uid || (st.mode & bad) !== 0) throw new ClientError("unsafe-directory");
}

/**
 * Create `path` (and any missing ancestors) with mode 0700 and check it. Existing ancestors are not
 * judged: only the leaf is, because the leaf is where secrets live.
 */
export function ensurePrivateDir(path: string, uid: number, strict = true): void {
  const missing: string[] = [];
  let p = path;
  while (lstatOrNull(p) === null) {
    missing.push(p);
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  for (const d of missing.reverse()) {
    try {
      // mode 0700 is a request that the umask can only narrow: a directory we create is never
      // looser than 0700, whatever the umask
      mkdirSync(d, { mode: DIR_MODE });
    } catch (e) {
      if (errno(e) !== "EEXIST") throw new ClientError("io");
    }
  }
  // A directory that already existed is judged as it is and never loosened or tightened: `strict`
  // refuses any group or other bit (Swain's own data, state and credentials directories).
  checkDir(path, uid, strict);
}

/** `true` when a directory entry (any kind) exists at `path`. */
export function entryExists(path: string): boolean {
  return lstatOrNull(path) !== null;
}

/** Write `bytes` to a new file, `O_EXCL | O_NOFOLLOW`, 0600. `credential-exists` when it exists. */
export function writeNewPrivateFile(path: string, bytes: Uint8Array): void {
  let fd = -1;
  try {
    fd = openSync(path, CREATE_FLAGS, FILE_MODE);
  } catch (e) {
    throw new ClientError(errno(e) === "EEXIST" ? "credential-exists" : "io");
  }
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    fd = -1;
    try {
      unlinkSync(path);
    } catch {
      // nothing more can be done
    }
    throw new ClientError("io");
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

/**
 * Read a private file: `lstat` first (regular file, not a symlink, owned by `uid`, no group or
 * world access), then open `O_NOFOLLOW` and re-check by descriptor. `null` when it does not exist.
 */
export function readPrivateFile(path: string, uid: number, maxBytes: number): Uint8Array | null {
  const st = lstatOrNull(path);
  if (st === null) return null;
  if (st.isSymbolicLink() || !st.isFile()) throw new ClientError("credential-unsafe");
  if (st.uid !== uid || (st.mode & GROUP_WORLD_ANY) !== 0)
    throw new ClientError("credential-unsafe");
  if (st.size > maxBytes) throw new ClientError("credential-invalid");
  let fd = -1;
  try {
    fd = openSync(path, READ_FLAGS);
    const after = fstatSync(fd);
    if (after.ino !== st.ino || after.dev !== st.dev || after.size > maxBytes) {
      throw new ClientError("credential-unsafe");
    }
    const out = new Uint8Array(after.size);
    let off = 0;
    while (off < out.length) {
      const n = readSync(fd, out, off, out.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return out.subarray(0, off);
  } catch (e) {
    if (e instanceof ClientError) throw e;
    throw new ClientError("io");
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

/** Names in a directory (sorted); empty when it does not exist. */
export function listDir(path: string): readonly string[] {
  try {
    return readdirSync(path).sort();
  } catch (e) {
    if (errno(e) === "ENOENT") return [];
    throw new ClientError("io");
  }
}

/** Remove one of our own files; a missing file is fine. */
export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (errno(e) !== "ENOENT") throw new ClientError("io");
  }
}
