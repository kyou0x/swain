/**
 * Bounded directory walk (SPEC-002 section 3.3). Symlinks and non-regular files inside walked
 * directories are skipped and counted. Explicit arguments are followed once.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { AdapterRegistration } from "../../adapter/contract.js";
import { AtmError } from "../../errors.js";

export interface WalkOptions {
  /** Default 8. */
  readonly maxDepth: number;
  /** Default 10_000. */
  readonly maxFiles: number;
}

export interface WalkResult {
  /** Sorted by UTF-16 code units. */
  readonly files: readonly string[];
  readonly skipped: {
    readonly symlinks: number;
    readonly nonRegular: number;
    readonly unmatched: number;
    /** Lower bound: the walk stops at the first excess. */
    readonly depthOrCount: number;
  };
}

export const DEFAULT_WALK_OPTIONS: WalkOptions = Object.freeze({ maxDepth: 8, maxFiles: 10_000 });

const BACKREFERENCE = /\\(?:[1-9]|k<)/;

function compilePatterns(regs: readonly AdapterRegistration[]): RegExp[] {
  const out: RegExp[] = [];
  for (const r of regs) {
    const src = r.discovery.fileNamePattern;
    if (!src.startsWith("^") || !src.endsWith("$") || BACKREFERENCE.test(src)) continue;
    try {
      out.push(new RegExp(src));
    } catch {
      // A malformed pattern never matches.
    }
  }
  return out;
}

function sortedCodeUnits(names: string[]): string[] {
  // Default sort: UTF-16 code unit order, no locale.
  return names.sort();
}

/**
 * Collect importable files. An explicit path that is not a directory is returned as given (the
 * reader rejects non-regular files with a typed error). Throws `source-unreadable` when an
 * explicit path cannot be resolved; limits never throw.
 */
export function walkImportPaths(
  paths: readonly string[],
  regs: readonly AdapterRegistration[],
  opts: WalkOptions,
): WalkResult {
  const patterns = compilePatterns(regs);
  const files = new Set<string>();
  const seenReal = new Set<string>();
  const skipped = { symlinks: 0, nonRegular: 0, unmatched: 0, depthOrCount: 0 };
  let stopped = false;

  const add = (p: string): void => {
    if (files.size >= opts.maxFiles) {
      skipped.depthOrCount++;
      stopped = true;
      return;
    }
    files.add(p);
  };

  const walkDir = (dir: string, depth: number): void => {
    if (stopped) return;
    let entries: { name: string; kind: "dir" | "file" | "symlink" | "other" }[];
    try {
      const list = readdirSync(dir, { withFileTypes: true });
      entries = list.map((d) => ({
        name: d.name,
        kind: d.isSymbolicLink()
          ? "symlink"
          : d.isDirectory()
            ? "dir"
            : d.isFile()
              ? "file"
              : "other",
      }));
    } catch {
      skipped.nonRegular++;
      return;
    }
    const byName = new Map(entries.map((e) => [e.name, e.kind] as const));
    for (const name of sortedCodeUnits([...byName.keys()])) {
      if (stopped) return;
      const kind = byName.get(name);
      const full = join(dir, name);
      if (kind === "symlink") skipped.symlinks++;
      else if (kind === "dir") {
        if (depth + 1 > opts.maxDepth) skipped.depthOrCount++;
        else walkDir(full, depth + 1);
      } else if (kind === "file") {
        if (patterns.some((re) => re.test(name))) add(full);
        else skipped.unmatched++;
      } else skipped.nonRegular++;
    }
  };

  for (const p of paths) {
    if (stopped) break;
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new AtmError("source-unreadable");
    }
    if (seenReal.has(real)) continue;
    seenReal.add(real);
    let isDir = false;
    try {
      isDir = lstatSync(real).isDirectory();
    } catch {
      throw new AtmError("source-unreadable");
    }
    if (isDir) walkDir(real, 0);
    else add(p);
  }
  return { files: sortedCodeUnits([...files]), skipped };
}
