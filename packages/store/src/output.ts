/**
 * Confined output writers for reports and the UI (SPEC-002 section 4, S7 rules).
 *
 * Known limit (documented, accepted): the output directory is checked with `lstat` and then used.
 * A local attacker who can replace path components between the check and the use inside a
 * directory they can write to can still redirect the write. Do not write into directories that
 * other users can modify. Only the immediate parent is checked for being a symlink.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { UiFile } from "@swain/report";
import { OutputRefused } from "./errors.js";
import {
  errCode,
  fsyncDir,
  lstatOrNull,
  rename,
  rmdir,
  unlinkRegular,
  utf8Length,
  writeNew,
} from "./fsx.js";

export interface OutputOptions {
  readonly force: boolean;
  readonly maxBytes: number;
}

export const UI_MARKER = ".atm-ui";
const MARKER_TEXT = "atm-ui/1\n";
const SESSION_FILE = /^[A-Za-z0-9_-]{1,64}\.html$/;
const SESSION_NAME = /^sessions\/([A-Za-z0-9_-]{1,64}\.html)$/;

function refuse(e: unknown): OutputRefused {
  if (e instanceof OutputRefused) return e;
  return new OutputRefused(errCode(e) === "ELOOP" ? "symlink" : "io");
}

function absolutePath(path: string): string {
  if (typeof path !== "string" || path === "" || path.includes("\0")) {
    throw new OutputRefused("invalid-path");
  }
  const abs = resolve(path);
  if (basename(abs) === "") throw new OutputRefused("invalid-path");
  return abs;
}

function checkParent(parent: string): void {
  const st = lstatOrNull(parent);
  if (st === null) throw new OutputRefused("parent-invalid");
  if (st.isSymbolicLink()) throw new OutputRefused("symlink");
  if (!st.isDirectory()) throw new OutputRefused("parent-invalid");
}

/**
 * Write one file. The target must not exist unless `force`; with `force` it must be a regular
 * file, never a symlink. Data goes to a sibling temp file (`wx`, 0600, fsync) and is renamed.
 */
export function writeOutputFile(path: string, data: string, opts: OutputOptions): void {
  const abs = absolutePath(path);
  try {
    if (typeof data !== "string" || utf8Length(data) > opts.maxBytes) {
      throw new OutputRefused("too-large");
    }
    const parent = dirname(abs);
    checkParent(parent);
    const target = lstatOrNull(abs);
    if (target !== null) {
      if (target.isSymbolicLink()) throw new OutputRefused("symlink");
      if (!opts.force) throw new OutputRefused("exists");
      if (!target.isFile()) throw new OutputRefused("not-regular");
    }
    const tmp = join(parent, `.${basename(abs)}.atm-tmp`);
    if (lstatOrNull(tmp) !== null) throw new OutputRefused("stale-temp");
    writeNew(tmp, data);
    try {
      rename(tmp, abs);
    } catch (e) {
      try {
        unlinkRegular(tmp);
      } catch {
        // best effort; the original error is reported
      }
      throw e;
    }
    fsyncDir(parent);
  } catch (e) {
    throw refuse(e);
  }
}

/** Remove a directory this module generated: known names only, no recursion, marker required. */
function removeUiTree(dir: string): void {
  const st = lstatOrNull(dir);
  if (st === null) return;
  if (st.isSymbolicLink() || !st.isDirectory()) throw new OutputRefused("stale-temp");
  const entries = readdirSync(dir);
  if (!entries.includes(UI_MARKER)) throw new OutputRefused("not-marked");
  let sessionFiles: string[] = [];
  for (const name of entries) {
    if (name === UI_MARKER || name === "index.html") continue;
    if (name === "sessions") {
      const sdir = join(dir, "sessions");
      const sst = lstatOrNull(sdir);
      if (sst === null || sst.isSymbolicLink() || !sst.isDirectory()) {
        throw new OutputRefused("stale-temp");
      }
      sessionFiles = readdirSync(sdir);
      if (!sessionFiles.every((f) => SESSION_FILE.test(f))) throw new OutputRefused("stale-temp");
      continue;
    }
    throw new OutputRefused("stale-temp");
  }
  for (const f of sessionFiles) unlinkRegular(join(dir, "sessions", f));
  if (entries.includes("sessions")) rmdir(join(dir, "sessions"));
  for (const name of entries) {
    if (name === UI_MARKER || name === "index.html") unlinkRegular(join(dir, name));
  }
  rmdir(dir);
}

function validateUiFiles(files: readonly UiFile[], maxBytes: number): void {
  const seen = new Set<string>();
  let total = utf8Length(MARKER_TEXT);
  let hasIndex = false;
  for (const f of files) {
    if (f.name === "index.html") hasIndex = true;
    else if (!SESSION_NAME.test(f.name)) throw new OutputRefused("invalid-name");
    if (seen.has(f.name)) throw new OutputRefused("invalid-name");
    seen.add(f.name);
    total += utf8Length(f.data);
    if (total > maxBytes) throw new OutputRefused("too-large");
  }
  if (!hasIndex) throw new OutputRefused("invalid-name");
}

/**
 * Write a static site. `dir` must not exist, or must contain the `.atm-ui` marker and `force` must
 * be given. Built in `<dir>.tmp`, then swapped in; the old tree is removed by unlinking known file
 * names (never a recursive delete). Returns the absolute directory.
 */
export function writeOutputDir(dir: string, files: readonly UiFile[], opts: OutputOptions): string {
  const abs = absolutePath(dir);
  const tmp = `${abs}.tmp`;
  const old = `${abs}.old`;
  let building = false;
  try {
    validateUiFiles(files, opts.maxBytes);
    const parent = dirname(abs);
    checkParent(parent);
    const existing = lstatOrNull(abs);
    if (existing !== null) {
      if (existing.isSymbolicLink()) throw new OutputRefused("symlink");
      if (!existing.isDirectory()) throw new OutputRefused("not-regular");
      if (!opts.force) throw new OutputRefused("exists");
      const marker = lstatOrNull(join(abs, UI_MARKER));
      if (marker === null || !marker.isFile()) throw new OutputRefused("not-marked");
    }
    removeUiTree(tmp);
    removeUiTree(old);
    mkdirSync(tmp, { mode: 0o700 });
    building = true;
    writeNew(join(tmp, UI_MARKER), MARKER_TEXT);
    if (files.some((f) => f.name !== "index.html"))
      mkdirSync(join(tmp, "sessions"), { mode: 0o700 });
    for (const f of files) writeNew(join(tmp, f.name), f.data);
    if (files.some((f) => f.name !== "index.html")) fsyncDir(join(tmp, "sessions"));
    fsyncDir(tmp);
    building = false;
    if (existing !== null) {
      rename(abs, old);
      rename(tmp, abs);
      try {
        removeUiTree(old);
      } catch {
        // The new tree is live; a leftover `.old` is cleaned on the next run.
      }
    } else {
      rename(tmp, abs);
    }
    fsyncDir(parent);
    return abs;
  } catch (e) {
    if (building) {
      try {
        removeUiTree(tmp);
      } catch {
        // best effort
      }
    }
    throw refuse(e);
  }
}
