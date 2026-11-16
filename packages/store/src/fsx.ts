/**
 * Low-level, confined filesystem helpers. Only the fs names allowed by the policy are used. Every
 * file is opened with O_NOFOLLOW; creation is always O_EXCL (`wx`), 0600, then fsync.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface Meta {
  readonly size: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function errCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const c = (e as { code?: unknown }).code;
  return typeof c === "string" ? c : undefined;
}

/** `lstat`, or null when the entry does not exist. Never follows a symlink. */
export function lstatOrNull(path: string): Meta | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

/** Read a whole regular file (no symlink) up to `maxBytes`; `tooLarge` is thrown beyond that. */
export function readBounded(path: string, maxBytes: number, tooLarge: () => Error): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new RangeError("not-regular");
    if (st.size > maxBytes) throw tooLarge();
    const buf = new Uint8Array(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, null);
      if (n === 0) break;
      off += n;
    }
    if (off !== buf.length) throw new RangeError("short-read");
    return buf;
  } finally {
    closeSync(fd);
  }
}

export function decodeUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

/**
 * fsync, except where the Node permission model disables the API (ERR_ACCESS_DENIED): the data is
 * then written and renamed without the durability barrier. Every other error still propagates.
 */
function syncFd(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (e) {
    if (errCode(e) !== "ERR_ACCESS_DENIED") throw e;
  }
}

/** Create a new file (`wx`, 0600), write everything, fsync, close. Fails if it exists. */
export function writeNew(path: string, data: string | Uint8Array): void {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    syncFd(fd);
  } finally {
    closeSync(fd);
  }
}

/** Directory fsync so that renames are durable. */
export function fsyncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    syncFd(fd);
  } finally {
    closeSync(fd);
  }
}

export function rename(from: string, to: string): void {
  renameSync(from, to);
}

/** Unlink a regular file only; refuses to remove anything else. */
export function unlinkRegular(path: string): void {
  const st = lstatOrNull(path);
  if (st === null) return;
  if (!st.isFile()) throw new RangeError("not-regular");
  unlinkSync(path);
}

export function rmdir(path: string): void {
  rmdirSync(path);
}

export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

/** `realpath`, or null when the path cannot be resolved. */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
