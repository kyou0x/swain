/**
 * Shared pieces of the `swain` network commands: the injected IO, exit codes, path rules, the
 * argument parser and error mapping. Nothing here touches a socket or the filesystem: that stays in
 * `@swain/client`, `@swain/db` and `@swain/server` (the `cli` profile has an empty builtin table).
 */

import { CLIENT_ERROR_MESSAGES, ClientError, type ClientErrorCode } from "@swain/client";
import { maskHome } from "@swain/core";
import { DbError } from "@swain/db";
import { SwainServerError } from "@swain/server";
import type { CliWriter } from "./context.js";
import { echoToken, esc } from "./text.js";

export interface SwainEnv {
  readonly HOME: string | undefined;
  readonly XDG_DATA_HOME: string | undefined;
  readonly XDG_CONFIG_HOME: string | undefined;
  readonly XDG_STATE_HOME: string | undefined;
  readonly SWAIN_SERVER_URL: string | undefined;
  readonly SWAIN_DB: string | undefined;
}

/** Everything `runSwain` needs from the outside world, injected by `swain-bin.ts`. */
export interface SwainIo {
  readonly argv: readonly string[];
  readonly stdout: (s: string) => unknown;
  readonly stderr: CliWriter;
  /** Reserved: no command reads a key from stdin in N1 (keys come from credential files). */
  readonly stdin: unknown;
  readonly env: SwainEnv;
  readonly nowMs: () => number;
  /** Registers a callback for SIGINT/SIGTERM. */
  readonly onSignal: (cb: () => void) => void;
  readonly version: string;
}

/** SPEC-003 section 4: 8 = server unreachable or unauthenticated, 9 = server rejected. */
export const SWAIN_EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  outputRefused: 5,
  notFound: 6,
  store: 7,
  unreachable: 8,
  rejected: 9,
} as const;

export interface Out {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

function absolute(v: string | undefined): string | null {
  if (v === undefined || !v.startsWith("/") || v.includes("\0")) return null;
  return v.length > 1 && v.endsWith("/") ? v.replace(/\/+$/, "") || "/" : v;
}

export function homeOf(env: SwainEnv): string | null {
  return absolute(env.HOME);
}

function base(xdg: string | undefined, env: SwainEnv, rel: string): string | null {
  const x = absolute(xdg);
  if (x !== null) return x === "/" ? "" : x;
  const home = homeOf(env);
  return home === null ? null : `${home === "/" ? "" : home}/${rel}`;
}

export const dataBaseOf = (env: SwainEnv): string | null =>
  base(env.XDG_DATA_HOME, env, ".local/share");
export const configBaseOf = (env: SwainEnv): string | null =>
  base(env.XDG_CONFIG_HOME, env, ".config");
export const stateBaseOf = (env: SwainEnv): string | null =>
  base(env.XDG_STATE_HOME, env, ".local/state");

/** `--db`, else `SWAIN_DB`, else `<data>/swain/swain.sqlite`. Absolute paths only. */
export function dbPathOf(flag: string | undefined, env: SwainEnv): string | null {
  const given = flag ?? env.SWAIN_DB;
  if (given !== undefined) return absolute(given);
  const b = dataBaseOf(env);
  return b === null ? null : `${b}/swain/swain.sqlite`;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** A path for display: the home directory becomes `~`, control characters become visible. */
export function shown(path: string, env: SwainEnv): string {
  return esc(maskHome(path, homeOf(env)));
}

// ---- arguments ----------------------------------------------------------------------------------

export type FlagKind = "bool" | "value" | "multi";
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface ParsedArgs {
  readonly flags: ReadonlyMap<string, string | true | readonly string[]>;
  readonly positionals: readonly string[];
}

export const KEY_SHAPE = /swn_/;
export const KEY_MESSAGE =
  "swain: keys are never accepted on the command line (argv is visible to other local users); they live in credential files\n";

/**
 * Hand-matched flag parsing. Unknown flags, a missing value, a repeated single flag and anything
 * shaped like a key (`swn_`) are errors; no token is echoed except through `echoToken`.
 * `{ error }` is a final, escaped message that ends with a newline.
 */
export function parseFlags(
  args: readonly string[],
  spec: FlagSpec,
): ParsedArgs | { readonly error: string } {
  const flags = new Map<string, string | true | string[]>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i] ?? "";
    if (KEY_SHAPE.test(t)) return { error: KEY_MESSAGE };
    if (!t.startsWith("--")) {
      if (t.startsWith("-") && t !== "-") {
        return { error: `swain: unknown option: ${echoToken(t)}\n` };
      }
      positionals.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    const name = eq < 0 ? t : t.slice(0, eq);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) return { error: `swain: unknown option: ${echoToken(name)}\n` };
    if (kind === "bool") {
      if (eq >= 0 || flags.has(name)) return { error: `swain: bad use of ${name}\n` };
      flags.set(name, true);
      continue;
    }
    let value: string;
    if (eq >= 0) value = t.slice(eq + 1);
    else {
      const next = args[i + 1];
      if (next === undefined) return { error: `swain: ${name} needs a value\n` };
      value = next;
      i++;
    }
    if (KEY_SHAPE.test(value)) return { error: KEY_MESSAGE };
    if (kind === "multi") {
      const prev = flags.get(name);
      flags.set(name, [...(Array.isArray(prev) ? prev : []), value]);
    } else {
      if (flags.has(name)) return { error: `swain: ${name} given twice\n` };
      flags.set(name, value);
    }
  }
  return { flags, positionals };
}

export function flagStr(a: ParsedArgs, name: string): string | undefined {
  const v = a.flags.get(name);
  return typeof v === "string" ? v : undefined;
}
export function flagOn(a: ParsedArgs, name: string): boolean {
  return a.flags.get(name) === true;
}
export function flagList(a: ParsedArgs, name: string): readonly string[] {
  const v = a.flags.get(name);
  return Array.isArray(v) ? v : [];
}

// ---- errors -------------------------------------------------------------------------------------

const CLIENT_EXIT: Readonly<Record<ClientErrorCode, number>> = {
  "server-unreachable": SWAIN_EXIT.unreachable,
  "server-unauthenticated": SWAIN_EXIT.unreachable,
  "server-rejected": SWAIN_EXIT.rejected,
  "credential-origin-mismatch": SWAIN_EXIT.usage,
  "credential-invalid": SWAIN_EXIT.usage,
  "credential-missing": SWAIN_EXIT.notFound,
  "credential-exists": SWAIN_EXIT.outputRefused,
  "credential-unsafe": SWAIN_EXIT.store,
  "invalid-origin": SWAIN_EXIT.usage,
  "unsafe-directory": SWAIN_EXIT.store,
  io: SWAIN_EXIT.store,
};

const SERVER_MESSAGES: Readonly<Record<string, string>> = {
  "bind-not-loopback": "--host must be the literal 127.0.0.1 or ::1",
  "port-held": "the port is already in use on a loopback address (exit 7 port-held)",
  "bind-address-mismatch": "the bound address is not the requested one",
  "address-unavailable": "the address is not available on this machine",
  "bind-failed": "the server could not listen",
  "invalid-option": "an option is invalid",
};

/**
 * Map a thrown value to a static message and an exit code. Messages never include `err.message`,
 * a path, a URL or a header. `null` for anything unexpected (the caller prints the internal error).
 */
export function mapError(e: unknown): { readonly message: string; readonly code: number } | null {
  if (e instanceof ClientError) {
    return { message: CLIENT_ERROR_MESSAGES[e.code], code: CLIENT_EXIT[e.code] };
  }
  if (e instanceof DbError) {
    return { message: `database error (${e.code})`, code: SWAIN_EXIT.store };
  }
  if (e instanceof SwainServerError) {
    const message = SERVER_MESSAGES[e.code] ?? "the server failed to start";
    const family = e.family === null ? "" : ` (${e.family})`;
    const code =
      e.code === "bind-not-loopback"
        ? SWAIN_EXIT.usage
        : e.code === "port-held"
          ? SWAIN_EXIT.store
          : SWAIN_EXIT.internal;
    return { message: `${message}${family}`, code };
  }
  return null;
}
