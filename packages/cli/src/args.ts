/**
 * Hand-matched argv parsing (no util.parseArgs, C4). Produces typed results; never throws and
 * never echoes a token except through `echoToken`.
 */
import { echoToken } from "./text.js";

export const COMMANDS = [
  "import",
  "sessions",
  "list",
  "show",
  "explain",
  "report",
  "commands",
  "ui",
  "sources",
] as const;
export type CommandName = (typeof COMMANDS)[number];

type FlagKind = "bool" | "value";

const COMMAND_FLAGS: Readonly<Record<CommandName, Readonly<Record<string, FlagKind>>>> = {
  import: {
    "--provider": "value",
    "--source-kind": "value",
    "--include-content": "bool",
    "--max-inline-bytes": "value",
    "--max-file-bytes": "value",
    "--reimport": "bool",
  },
  sessions: { "--provider": "value", "--outcome": "value", "--json": "bool" },
  list: { "--provider": "value", "--outcome": "value", "--json": "bool" },
  show: { "--limit": "value", "--json": "bool" },
  explain: { "--json": "bool" },
  report: { "--format": "value", "--out": "value", "--force": "bool" },
  commands: { "--all": "bool", "--json": "bool" },
  ui: { "--out": "value", "--force": "bool" },
  sources: {},
};

/** [min, max] positional counts per command. */
const ARITY: Readonly<Record<CommandName, readonly [number, number]>> = {
  import: [1, Number.MAX_SAFE_INTEGER],
  sessions: [0, 0],
  list: [0, 0],
  show: [1, 1],
  explain: [1, 1],
  report: [1, 1],
  commands: [1, Number.MAX_SAFE_INTEGER],
  ui: [0, 0],
  sources: [0, 0],
};

export interface CommandInvocation {
  readonly command: CommandName;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
  readonly store: string | undefined;
}

export type Parsed =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "usage" }
  | { readonly kind: "command"; readonly invocation: CommandInvocation }
  /** A usage error: `message` is final, already escaped, ends with a newline. */
  | { readonly kind: "error"; readonly message: string };

const HELP = ["--help", "-h"];
const VERSION = ["--version", "-V"];

function unknownArg(t: string): Parsed {
  return {
    kind: "error",
    message: `swain: unknown argument: ${echoToken(t)}\nRun 'swain --help' for usage.\n`,
  };
}

function isCommand(t: string): t is CommandName {
  return (COMMANDS as readonly string[]).includes(t);
}

export function parseArgs(argv: readonly string[]): Parsed {
  if (argv.length === 0) return { kind: "usage" };
  let helpCount = 0;
  let versionCount = 0;
  let store: string | undefined;
  let command: CommandName | undefined;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let rest = false;

  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] ?? "";
    if (rest) {
      positionals.push(t);
      continue;
    }
    if (t === "--") {
      if (command === undefined) return unknownArg(t);
      rest = true;
      continue;
    }
    if (HELP.includes(t)) {
      helpCount++;
      continue;
    }
    if (VERSION.includes(t)) {
      versionCount++;
      continue;
    }
    if (t === "--store" || t.startsWith("--store=")) {
      let value: string | undefined;
      if (t === "--store") {
        value = argv[i + 1];
        i++;
      } else value = t.slice("--store=".length);
      if (value === undefined || value === "") {
        return { kind: "error", message: "swain: option requires a value: --store\n" };
      }
      store = value;
      continue;
    }
    if (t.startsWith("-") && t !== "-") {
      if (command === undefined) return unknownArg(t);
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const spec = Object.hasOwn(COMMAND_FLAGS[command], name)
        ? COMMAND_FLAGS[command][name]
        : undefined;
      if (spec === undefined) return unknownArg(t);
      if (spec === "bool") {
        if (eq !== -1) return unknownArg(t);
        flags.set(name, true);
        continue;
      }
      let value: string | undefined;
      if (eq !== -1) value = t.slice(eq + 1);
      else {
        value = argv[i + 1];
        i++;
      }
      if (value === undefined) {
        return { kind: "error", message: `swain: option requires a value: ${name}\n` };
      }
      flags.set(name, value);
      continue;
    }
    if (command === undefined) {
      if (!isCommand(t)) return unknownArg(t);
      command = t;
      continue;
    }
    positionals.push(t);
  }

  const tooMany: Parsed = { kind: "error", message: "swain: too many arguments\n" };
  if (command === undefined) {
    if (helpCount + versionCount > 1) return tooMany;
    if (helpCount === 1) return { kind: "help" };
    if (versionCount === 1) return { kind: "version" };
    return { kind: "usage" };
  }
  if (versionCount > 0) return tooMany;
  if (helpCount > 0) return { kind: "help" };
  const [min, max] = ARITY[command];
  if (positionals.length < min) {
    return {
      kind: "error",
      message: `swain: ${command}: ${command === "import" ? "at least one path is required" : "an import ID is required"}\n`,
    };
  }
  if (positionals.length > max) {
    return {
      kind: "error",
      message: `swain: ${command}: unexpected argument: ${echoToken(positionals[max] ?? "")}\n`,
    };
  }
  return { kind: "command", invocation: { command, positionals, flags, store } };
}

/** Non-negative decimal integer within [min, max], or null. */
export function parseCount(v: string, min: number, max: number): number | null {
  if (!/^[0-9]{1,15}$/.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? n : null;
}
