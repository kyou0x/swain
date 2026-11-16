/**
 * `runSwain`: the async entry of the `swain` bin (ADR-0004 section 5, SPEC-003 section 4).
 *
 * `swain` is a superset of `atm`: every offline command (`import`, `sessions`, `show`, `explain`,
 * `report`, `commands`, `ui`, `sources`, `--version`) is handed to the same `runMain` with the same
 * file store, byte for byte. Only the commands below touch the network or the database; `serve` is
 * the only one that opens a socket. The `atm` bin (`bin.ts`, `main.ts`) imports none of this.
 */
import { runMain } from "./main.js";
import { runKeys } from "./swain-keys.js";
import { runConnect, runOpen, runStatus } from "./swain-net.js";
import { runServe } from "./swain-serve.js";
import {
  KEY_MESSAGE,
  KEY_SHAPE,
  mapError,
  type Out,
  SWAIN_EXIT,
  type SwainIo,
} from "./swain-support.js";

export type { SwainEnv, SwainIo } from "./swain-support.js";

const NETWORK_COMMANDS = ["serve", "keys", "status", "open", "connect"] as const;
type NetworkCommand = (typeof NETWORK_COMMANDS)[number];

function isNetworkCommand(t: string | undefined): t is NetworkCommand {
  return t !== undefined && (NETWORK_COMMANDS as readonly string[]).includes(t);
}

const SWAIN_USAGE = [
  "",
  "Swain server (self-hosted, loopback only; `swain serve` is the only command that opens a socket):",
  "  serve [--host 127.0.0.1|::1] [--port 4318] [--db PATH] [--require-login]",
  "                     Run the server (SIGINT/SIGTERM stops it). Both loopback families by default.",
  "  keys create [--project SLUG] [--label L] [--agent NAME | --no-pin] [--integration I]",
  "              [--scope S]... (--save | --show-secret)",
  "                     Create an ingest key, agent-pinned by default. --save writes a 0600 credential",
  "                     file bound to the server origin and prints only its path.",
  "  keys list [--project SLUG]       List keys (never the secret)",
  "  keys revoke KEY_ID               Revoke a key",
  "  status [--json] [--project SLUG] [--server URL]",
  "                     Check the server, authenticate it (server proof), then report. Exit 8 if it fails.",
  "  open [fleet | agent ID | run ID | ID]",
  "                     Print a single-use login URL (60 s). It never launches a browser.",
  "  connect otlp|claude-code [--project SLUG] [--show-secret] [--server URL]",
  "                     Print exporter settings (http/json). Writes nothing.",
  "",
  "No command accepts a key on the command line; keys live in credential files.",
  "Environment: SWAIN_DB, SWAIN_SERVER_URL, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME, HOME.",
  "Exit codes (in addition to the offline ones): 8 server unreachable or unauthenticated, 9 server rejected.",
  "",
].join("\n");

function offlineIo(io: SwainIo, stdout: (s: string) => void) {
  return {
    stdout: { write: stdout },
    stderr: io.stderr,
    env: { HOME: io.env.HOME, XDG_DATA_HOME: io.env.XDG_DATA_HOME },
    nowMs: io.nowMs,
  };
}

/** Offline commands: identical to `atm`. `--help` additionally lists the network commands. */
function runOffline(io: SwainIo): number {
  const a = io.argv;
  if (a.length === 1 && (a[0] === "--help" || a[0] === "-h")) {
    const chunks: string[] = [];
    const code = runMain(
      a,
      offlineIo(io, (s) => void chunks.push(s)),
    );
    const text = chunks.join("");
    // The offline text (same as atm) first, then the Swain section.
    io.stdout(`${text.replace(/\n$/, "")}\n${SWAIN_USAGE}`);
    return code;
  }
  return runMain(
    a,
    offlineIo(io, (s) => void io.stdout(s)),
  );
}

export async function runSwain(io: SwainIo): Promise<number> {
  // A key shape anywhere in argv is refused for every command, offline ones included (G3-auth F9):
  // argv is visible to other local users and lands in shell history.
  if (io.argv.some((t) => KEY_SHAPE.test(t))) {
    try {
      io.stderr.write(KEY_MESSAGE);
    } catch {
      // a closed stderr is not worth a second failure
    }
    return SWAIN_EXIT.usage;
  }
  const [first, ...rest] = io.argv;
  if (!isNetworkCommand(first)) return runOffline(io);
  const out: Out = {
    out: (s) => void io.stdout(s),
    err: (s) => {
      try {
        io.stderr.write(s);
      } catch {
        // a closed stderr is not worth a second failure
      }
    },
  };
  try {
    switch (first) {
      case "serve":
        return await runServe(io, rest, out);
      case "keys":
        return runKeys(io, rest, out);
      case "status":
        return await runStatus(io, rest, out);
      case "open":
        return await runOpen(io, rest, out);
      case "connect":
        return runConnect(io, rest, out);
    }
  } catch (e) {
    // Static messages only: never err.message, a stack, a path, a URL or a header.
    const m = mapError(e);
    if (m !== null) {
      out.err(`swain: ${m.message}\n`);
      return m.code;
    }
    out.err("swain: internal error\n");
    return SWAIN_EXIT.internal;
  }
}
