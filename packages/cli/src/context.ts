import { DEFAULT_BOUNDS, maskHome } from "@swain/core";
import type { ImportRecord, RenderOptions } from "@swain/report";
import { isRealDir, openStore, pathExists, type Store, type StoreErrorCode } from "@swain/store";
import type { CommandInvocation } from "./args.js";
import { echoToken, esc } from "./text.js";

export interface CliWriter {
  write(s: string): void;
  /** Present on real streams; used only to swallow asynchronous stream errors (EPIPE). */
  on?(event: "error", listener: (e: unknown) => void): unknown;
}

export interface CliEnv {
  readonly HOME: string | undefined;
  readonly XDG_DATA_HOME: string | undefined;
}

/** Everything the CLI needs from the outside world, injected by `bin.ts`. */
export interface CliIo {
  readonly stdout: CliWriter;
  readonly stderr: CliWriter;
  readonly env: CliEnv;
  readonly nowMs: () => number;
}

export interface Ctx {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
  readonly env: CliEnv;
  readonly homeDir: string | null;
  /** Realpath of `homeDir` when it differs (HOME contains a symlink), else null. */
  readonly realHomeDir: string | null;
  readonly nowMs: () => number;
  readonly inv: CommandInvocation;
}

/** Exit codes (SPEC-002 section 8). */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  partial: 3,
  rejected: 4,
  outputRefused: 5,
  notFound: 6,
  store: 7,
} as const;

function absolute(v: string | undefined): string | null {
  if (v === undefined || !v.startsWith("/") || v.includes("\0")) return null;
  return v.length > 1 && v.endsWith("/") ? v.replace(/\/+$/, "") || "/" : v;
}

export function homeDirOf(env: CliEnv): string | null {
  return absolute(env.HOME);
}

/** Candidate default store parents, in order: `$XDG_DATA_HOME`, else `$HOME/.local/share`. */
function dataBase(env: CliEnv): string | null {
  const xdg = absolute(env.XDG_DATA_HOME);
  if (xdg !== null) return xdg === "/" ? "" : xdg;
  const home = homeDirOf(env);
  if (home !== null) return `${home === "/" ? "" : home}/.local/share`;
  return null;
}

/**
 * `--store`, else `<base>/swain`, where base is `$XDG_DATA_HOME` or `$HOME/.local/share`.
 * Compatibility: when `<base>/swain` does not exist and the legacy `<base>/agent-time-machine`
 * directory does, the legacy directory is used (nothing is moved, copied or deleted).
 * `onLegacy` is called when the legacy directory is chosen.
 */
export function storeLocation(
  inv: CommandInvocation,
  env: CliEnv,
  onLegacy?: (legacyPath: string) => void,
): string | null {
  if (inv.store !== undefined) return inv.store;
  const base = dataBase(env);
  if (base === null) return null;
  const fresh = `${base}/swain`;
  const legacy = `${base}/agent-time-machine`;
  if (!pathExists(fresh) && isRealDir(legacy)) {
    onLegacy?.(legacy);
    return legacy;
  }
  return fresh;
}

export function openStoreFor(ctx: Ctx): Store | null {
  const root = storeLocation(ctx.inv, ctx.env, (legacy) =>
    ctx.err(
      `swain: using the legacy store directory ${maskPath(ctx, legacy)}; nothing was moved (to switch, move it to the swain/ directory yourself)\n`,
    ),
  );
  if (root === null) {
    ctx.err("swain: no store location: pass --store DIR, or set HOME or XDG_DATA_HOME\n");
    return null;
  }
  return openStore(root, { nowMs: ctx.nowMs, homeDir: ctx.homeDir });
}

export function flagValue(ctx: Ctx, name: string): string | undefined {
  const v = ctx.inv.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagOn(ctx: Ctx, name: string): boolean {
  return ctx.inv.flags.get(name) === true;
}

export function usageError(ctx: Ctx, message: string): number {
  ctx.err(`swain: ${message}\n`);
  return EXIT.usage;
}

/** Labels that must be visible wherever an import is described (M-17, G3 item 12). */
export function labelsOf(record: ImportRecord): string[] {
  const out: string[] = [];
  if (record.adapter.experimental) out.push("experimental");
  if (record.adapter.sourceStability !== "documented-interface") {
    out.push(record.adapter.sourceStability);
  }
  if (record.warningCodes.includes("untested-provider-version")) {
    out.push("untested-provider-version");
  }
  return out;
}

export function labelText(record: ImportRecord): string {
  return labelsOf(record)
    .map((l) => `[${l}]`)
    .join(" ");
}

/** Resolve an import ID argument; prints the error and returns null when it cannot. */
export function resolveRecord(ctx: Ctx, store: Store, id: string): ImportRecord | null {
  const r = store.resolve(id);
  if (r.ok) return r.record;
  if (r.reason === "not-found") {
    ctx.err(`swain: no import matches '${echoToken(id)}'. Run 'swain sessions' to list imports.\n`);
  } else {
    ctx.err(
      `swain: '${echoToken(id)}' matches more than one import; use an import ID:\n${r.candidates
        .map((c) => `  ${esc(c)}\n`)
        .join("")}`,
    );
  }
  return null;
}

/** Home-mask a path against `$HOME` and, when different, its realpath (walked files are realpath-based). */
export function maskPath(ctx: Ctx, p: string): string {
  const once = maskHome(p, ctx.homeDir);
  return once === p ? maskHome(p, ctx.realHomeDir) : once;
}

/** Render options with the given home directory. */
export function renderOptionsFor(
  homeDir: string | null,
  realHomeDir: string | null = null,
): RenderOptions {
  return {
    homeDir,
    realHomeDir,
    maxOutputBytes: DEFAULT_BOUNDS.maxOutputBytes,
    maxRenderedEvents: 10_000,
  };
}

/** Render options for each home spelling the CLI masks against. */
export function homeRenderOptions(ctx: Ctx): readonly RenderOptions[] {
  return [ctx.homeDir, ctx.realHomeDir]
    .filter((h): h is string => h !== null)
    .map((h) => renderOptionsFor(h));
}

/** Static user-facing text per store error code (never includes paths or source data). */
export const STORE_MESSAGES: Readonly<Record<StoreErrorCode, string>> = {
  locked:
    "the store is locked (another swain is running, or a stale store.lock was left behind; remove it only if no swain is running)",
  corrupt: "the store failed validation and was not modified",
  symlink: "refusing to follow a symlink under the store",
  io: "filesystem error while accessing the store",
  "invalid-root": "the store path is invalid, not a directory, or its parent does not exist",
  "too-large": "a store file exceeds the size limit",
  "invalid-result": "the import result was rejected by validation",
};
