/**
 * Run history store (SPEC-002 section 4). Layout:
 *   <root>/STORE.json, store.lock, index.json, imports/<hex32>/{import.json,events.jsonl,result.json}
 * Every mutation holds `store.lock` (created `wx`). Files are created `wx` 0600 + fsync and
 * published by rename. Paths are built from fixed names and validated hex only; symlinks anywhere
 * under the root are errors; nothing is deleted recursively.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AdapterWarning,
  AtmError,
  canonicalJson,
  escapeControlChars,
  IMPORT_OUTCOMES,
  type ImportResult,
  type ImportStats,
  maskHome,
  type SourceStability,
  validateEvents,
} from "@swain/core";
import type { ImportRecord } from "@swain/report";
import { StoreError } from "./errors.js";
import {
  decodeUtf8,
  errCode,
  fsyncDir,
  lstatOrNull,
  readBounded,
  realpathOrNull,
  rename,
  rmdir,
  unlinkRegular,
  writeNew,
} from "./fsx.js";
import { isObj, parseImportRecord } from "./record.js";
import { buildImportRecord } from "./record-build.js";

export const STORE_FORMAT = "atm.store/1";
export const INDEX_FORMAT = "atm.index/1";
export const IMPORT_FORMAT = "atm.import/1";
export const MAX_STORE_FILE_BYTES = 536_870_912;
const MAX_INDEX_BYTES = 67_108_864;
const MAX_SMALL_BYTES = 8_388_608;
const MAX_IMPORTS = 1_000_000;
const DISPLAY_PATH_MAX_BYTES = 1024;
const KNOWN_FILES = ["import.json", "events.jsonl", "result.json"] as const;
const TEMP_DIR = /^\.(?:tmp|old)-[0-9a-f]{32}$/;
const encoder = new TextEncoder();

export interface PutMeta {
  readonly adapter: {
    readonly id: string;
    readonly version: string;
    readonly sourceStability: SourceStability;
    readonly experimental: boolean;
  };
  /** The path as given by the user; stored only home-masked and control-escaped. */
  readonly sourcePath: string;
  readonly container: {
    readonly encoding: "none" | "zstd";
    readonly sha256: string;
    readonly byteLength: number;
  };
  readonly contentRetention: "hash-only" | "inline";
  /** Replace an existing import even if the adapter version is the same. */
  readonly reimport: boolean;
}

export type PutStatus = "added" | "unchanged" | "replaced" | "skipped-version";

export type ResolveResult =
  | { readonly ok: true; readonly record: ImportRecord }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "ambiguous";
      readonly candidates: readonly string[];
    };

export interface StoreDeps {
  readonly nowMs: () => number;
  readonly homeDir: string | null;
}

export interface Store {
  /** Absolute store directory. */
  readonly root: string;
  /** Create the store directory (0700, non-recursive) and its files if missing. */
  init(): void;
  put(result: ImportResult, meta: PutMeta): { status: PutStatus; record: ImportRecord };
  list(): readonly ImportRecord[];
  resolve(id: string): ResolveResult;
  /** Re-validated with `validateEvents`; bounded by `MAX_STORE_FILE_BYTES`. */
  load(importId: string): ImportResult;
}

/** Map any low-level failure to a typed store error. */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoreError) throw e;
    const code = errCode(e);
    if (code === "ELOOP") throw new StoreError("symlink");
    throw new StoreError("io");
  }
}

function corrupt(): StoreError {
  return new StoreError("corrupt");
}

function tooLarge(): StoreError {
  return new StoreError("too-large");
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch {
    throw corrupt();
  }
}

function readFileJson(path: string, max: number): unknown {
  let bytes: Uint8Array;
  try {
    bytes = readBounded(path, max, tooLarge);
  } catch (e) {
    if (e instanceof StoreError) throw e;
    const code = errCode(e);
    if (code === "ELOOP") throw new StoreError("symlink");
    if (code === "ENOENT") throw corrupt();
    throw e;
  }
  return parseJson(bytes);
}

function displayPathFor(sourcePath: string, homeDir: string | null): string {
  const abs = resolve(sourcePath);
  const masked = maskHome(abs, homeDir);
  // Walked files are realpath-based: also mask against the real location of HOME.
  const real = masked === abs ? realHomeOf(homeDir) : null;
  let shown = escapeControlChars(real === null ? masked : maskHome(abs, real));
  // Truncate by code points until the UTF-8 length fits.
  while (encoder.encode(shown).length > DISPLAY_PATH_MAX_BYTES) {
    shown = `${Array.from(shown)
      .slice(0, Math.max(0, Array.from(shown).length - 64))
      .join("")}...`;
  }
  return shown;
}

function checkDir(path: string): void {
  const st = lstatOrNull(path);
  if (st === null) throw corrupt();
  if (st.isSymbolicLink()) throw new StoreError("symlink");
  if (!st.isDirectory()) throw corrupt();
}

function validateResultForPut(result: ImportResult): string {
  const first = result.events[0];
  if (first === undefined) throw new StoreError("invalid-result");
  if (!IMPORT_OUTCOMES.includes(result.outcome)) throw new StoreError("invalid-result");
  const checked = validateEvents(JSON.parse(JSON.stringify(result.events)));
  if (!checked.ok) throw new StoreError("invalid-result");
  const ses = first.sessionId;
  if (!result.events.every((e) => e.sessionId === ses)) throw new StoreError("invalid-result");
  return ses;
}

export function openStore(root: string, deps: StoreDeps): Store {
  if (typeof root !== "string" || root === "" || root.includes("\0")) {
    throw new StoreError("invalid-root");
  }
  const abs = resolve(root);
  const importsDir = join(abs, "imports");
  const lockPath = join(abs, "store.lock");
  const indexPath = join(abs, "index.json");
  const markerPath = join(abs, "STORE.json");

  const assertRoot = (): boolean => {
    const st = lstatOrNull(abs);
    if (st === null) return false;
    if (st.isSymbolicLink()) throw new StoreError("symlink");
    if (!st.isDirectory()) throw new StoreError("invalid-root");
    return true;
  };

  /** True when STORE.json is valid; false when the directory is empty (apart from the lock). */
  const checkMarker = (): boolean => {
    if (lstatOrNull(markerPath) === null) {
      if (readdirSync(abs).some((n) => n !== "store.lock")) throw corrupt();
      return false;
    }
    const m = readFileJson(markerPath, 1024);
    if (!isObj(m) || Object.keys(m).length !== 1 || m["format"] !== STORE_FORMAT) throw corrupt();
    return true;
  };

  const readIndex = (): ImportRecord[] => {
    if (!assertRoot()) return [];
    if (!checkMarker()) return [];
    if (lstatOrNull(indexPath) === null) return [];
    const doc = readFileJson(indexPath, MAX_INDEX_BYTES);
    if (!isObj(doc) || Object.keys(doc).length !== 2 || doc["format"] !== INDEX_FORMAT) {
      throw corrupt();
    }
    const imports = doc["imports"];
    if (!Array.isArray(imports) || imports.length > MAX_IMPORTS) throw corrupt();
    const out: ImportRecord[] = [];
    for (const raw of imports) {
      const rec = parseImportRecord(raw);
      if (rec === null) throw corrupt();
      const prev = out[out.length - 1];
      if (prev !== undefined && !(prev.importId < rec.importId)) throw corrupt();
      out.push(rec);
    }
    return out;
  };

  const writeIndex = (records: readonly ImportRecord[]): void => {
    const tmp = join(abs, "index.json.tmp");
    const body = `${canonicalJson({ format: INDEX_FORMAT, imports: records })}\n`;
    writeNew(tmp, body);
    rename(tmp, indexPath);
    fsyncDir(abs);
  };

  const removeImportDir = (dir: string): void => {
    checkDir(dir);
    const names = readdirSync(dir);
    if (!names.every((n) => (KNOWN_FILES as readonly string[]).includes(n))) return;
    for (const n of names) unlinkRegular(join(dir, n));
    rmdir(dir);
  };

  /** True when every entry of the directory is one of the known import files. */
  const onlyKnown = (dir: string): boolean => {
    try {
      checkDir(dir);
      return readdirSync(dir).every((n) => (KNOWN_FILES as readonly string[]).includes(n));
    } catch {
      return false;
    }
  };

  /** True when a `.tmp-<hex>` directory holds all three files and a parseable result.json. */
  const isCompleteTemp = (dir: string): boolean => {
    try {
      checkDir(dir);
      const names = readdirSync(dir);
      if (!KNOWN_FILES.every((f) => names.includes(f)) || names.length !== KNOWN_FILES.length) {
        return false;
      }
      // result.json is written last, so a parseable one implies the other files are whole.
      JSON.parse(decodeUtf8(readBounded(join(dir, "result.json"), MAX_SMALL_BYTES, corrupt)));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Startup cleanup of crash leftovers; runs only while holding the lock. A missing `<hex>` is
   * restored from `.old-<hex>` (a replace that crashed between its two renames; the index still
   * describes the old import) or, failing that, rolled forward from a complete `.tmp-<hex>`.
   * Leftovers are deleted only when `<hex>` exists.
   */
  const cleanup = (): void => {
    const leftovers = (): string[] => readdirSync(importsDir).filter((n) => TEMP_DIR.test(n));
    for (const prefix of [".old-", ".tmp-"] as const) {
      for (const n of leftovers()) {
        if (!n.startsWith(prefix)) continue;
        const from = join(importsDir, n);
        const target = join(importsDir, n.slice(prefix.length));
        try {
          if (
            lstatOrNull(target) === null &&
            (prefix === ".old-" ? onlyKnown(from) : isCompleteTemp(from))
          ) {
            checkDir(from);
            rename(from, target);
            fsyncDir(importsDir);
          } else {
            removeImportDir(from);
          }
        } catch {
          // Leave anything unexpected in place.
        }
      }
    }
    try {
      unlinkRegular(join(abs, "index.json.tmp"));
    } catch {
      // Leave anything unexpected in place.
    }
  };

  const withLock = <T>(fn: () => T): T => {
    const existed = assertRoot();
    if (!existed) {
      try {
        mkdirSync(abs, { mode: 0o700 });
      } catch (e) {
        if (errCode(e) === "ENOENT") throw new StoreError("invalid-root");
        throw e;
      }
    }
    try {
      writeNew(lockPath, "");
    } catch (e) {
      if (errCode(e) === "EEXIST") throw new StoreError("locked");
      throw e;
    }
    try {
      if (!checkMarker()) {
        writeNew(markerPath, `${canonicalJson({ format: STORE_FORMAT })}\n`);
      }
      if (lstatOrNull(importsDir) === null) mkdirSync(importsDir, { mode: 0o700 });
      checkDir(importsDir);
      cleanup();
      return fn();
    } finally {
      try {
        unlinkRegular(lockPath);
      } catch {
        // A failed lock removal surfaces as `locked` on the next run.
      }
    }
  };

  const importDirFor = (importId: string): { hex: string; dir: string } => {
    const m = /^imp_([0-9a-f]{32})$/.exec(importId);
    if (m === null || m[1] === undefined) throw corrupt();
    return { hex: m[1], dir: join(importsDir, m[1]) };
  };

  const writeImportDir = (
    dir: string,
    hex: string,
    record: ImportRecord,
    result: ImportResult,
    meta: PutMeta,
  ): string | null => {
    const tmp = join(importsDir, `.tmp-${hex}`);
    let eventsBody: string;
    let resultBody: string;
    let importBody: string;
    try {
      eventsBody = result.events.map((e) => `${canonicalJson(e)}\n`).join("");
      resultBody = `${canonicalJson({
        source: result.source,
        warnings: result.warnings,
        stats: result.stats,
        outcome: result.outcome,
      })}\n`;
      importBody = `${canonicalJson({
        format: IMPORT_FORMAT,
        record,
        container: meta.container,
      })}\n`;
    } catch (e) {
      if (e instanceof AtmError) throw new StoreError("invalid-result");
      throw e;
    }
    mkdirSync(tmp, { mode: 0o700 });
    writeNew(join(tmp, "import.json"), importBody);
    writeNew(join(tmp, "events.jsonl"), eventsBody);
    writeNew(join(tmp, "result.json"), resultBody);
    fsyncDir(tmp);
    let oldDir: string | null = null;
    // An existing directory (with or without an index entry) is replaced; a missing one is a plain add.
    if (lstatOrNull(dir) !== null) {
      checkDir(dir);
      oldDir = join(importsDir, `.old-${hex}`);
      rename(dir, oldDir);
    }
    rename(tmp, dir);
    fsyncDir(importsDir);
    return oldDir;
  };

  const store: Store = {
    root: abs,
    init(): void {
      guard(() => withLock(() => undefined));
    },
    put(result, meta) {
      return guard(() => {
        const sessionId = validateResultForPut(result);
        const record = buildImportRecord(
          result,
          meta,
          sessionId,
          deps.nowMs(),
          displayPathFor(meta.sourcePath, deps.homeDir),
        );
        return withLock(() => {
          const index = readIndex();
          const existing = index.find((r) => r.importId === record.importId);
          if (existing !== undefined && !meta.reimport) {
            const same = existing.adapter.version === meta.adapter.version;
            return { status: same ? "unchanged" : "skipped-version", record: existing } as const;
          }
          const { hex, dir } = importDirFor(record.importId);
          const oldDir = writeImportDir(dir, hex, record, result, meta);
          const next = [...index.filter((r) => r.importId !== record.importId), record].sort(
            (a, b) => (a.importId < b.importId ? -1 : a.importId > b.importId ? 1 : 0),
          );
          writeIndex(next);
          if (oldDir !== null) {
            try {
              removeImportDir(oldDir);
            } catch {
              // Cleaned on the next locked run.
            }
          }
          return { status: existing !== undefined ? "replaced" : "added", record } as const;
        });
      });
    },
    list() {
      return guard(readIndex);
    },
    resolve(id) {
      const records = guard(readIndex);
      let matches: ImportRecord[] = [];
      if (/^imp_[0-9a-f]{6,32}$/.test(id)) {
        matches = records.filter((r) => r.importId.startsWith(id));
      } else if (/^ses_[0-9a-f]{32}$/.test(id)) {
        matches = records.filter((r) => r.sessionId === id);
      }
      const [first, ...rest] = matches;
      if (first === undefined) return { ok: false, reason: "not-found", candidates: [] };
      if (rest.length > 0) {
        return { ok: false, reason: "ambiguous", candidates: matches.map((r) => r.importId) };
      }
      return { ok: true, record: first };
    },
    load(importId) {
      return guard(() => {
        const { dir } = importDirFor(importId);
        if (!assertRoot()) throw corrupt();
        checkDir(importsDir);
        checkDir(dir);
        const imp = readFileJson(join(dir, "import.json"), MAX_SMALL_BYTES);
        if (!isObj(imp) || imp["format"] !== IMPORT_FORMAT) throw corrupt();
        const record = parseImportRecord(imp["record"]);
        if (record === null || record.importId !== importId) throw corrupt();
        const res = readFileJson(join(dir, "result.json"), MAX_STORE_FILE_BYTES);
        if (
          !isObj(res) ||
          !isObj(res["source"]) ||
          !Array.isArray(res["warnings"]) ||
          !isObj(res["stats"]) ||
          !IMPORT_OUTCOMES.includes(res["outcome"] as ImportResult["outcome"])
        ) {
          throw corrupt();
        }
        const eventsText = decodeUtf8(
          readBounded(join(dir, "events.jsonl"), MAX_STORE_FILE_BYTES, tooLarge),
        );
        const lines = eventsText === "" ? [] : eventsText.split("\n");
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        const parsed: unknown[] = [];
        for (const line of lines) {
          try {
            parsed.push(JSON.parse(line));
          } catch {
            throw corrupt();
          }
        }
        const checked = validateEvents(parsed);
        if (!checked.ok) throw corrupt();
        const source = res["source"] as unknown as ImportResult["source"];
        if (
          source.sha256 !== record.source.sha256 ||
          checked.events.length !== record.counts.events ||
          record.outcome !== res["outcome"]
        ) {
          throw corrupt();
        }
        return {
          source,
          events: checked.events,
          warnings: res["warnings"] as AdapterWarning[],
          stats: res["stats"] as unknown as ImportStats,
          outcome: res["outcome"] as ImportResult["outcome"],
        };
      });
    },
  };
  return store;
}

/** Read-only probe: does `path` exist at all (a link counts; nothing is followed or created)? */
export function pathExists(path: string): boolean {
  try {
    return lstatOrNull(path) !== null;
  } catch {
    return true; // unreadable counts as existing: never guess a different location
  }
}

/** Read-only probe: is `path` a real directory (not a link)? */
export function isRealDir(path: string): boolean {
  try {
    return lstatOrNull(path)?.isDirectory() === true;
  } catch {
    return false;
  }
}

/** The realpath of `homeDir`, or null when it is unset, unresolvable or equal to `homeDir`. */
export function realHomeOf(homeDir: string | null): string | null {
  if (homeDir === null) return null;
  const real = realpathOrNull(homeDir);
  return real === null || real === homeDir ? null : real;
}
