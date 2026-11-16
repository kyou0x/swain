/**
 * `swain serve [--host 127.0.0.1|::1] [--port 4318] [--db PATH] [--require-login]` (SPEC-003 section 4).
 *
 * The only command that opens a socket. It opens or creates the database, binds the loopback
 * literal(s), writes the 0600 runtime file, prints literal-IP URLs only and runs until SIGINT or
 * SIGTERM, then closes the listeners, removes the runtime file and closes the database.
 *
 * No flag and no environment variable can turn on the server's unverified-protobuf switch: this file never passes
 * it, so the server keeps its default (protobuf answers 415 until G3-proto passes).
 */
import { parseOrigin, removeRuntimeFile, writeRuntimeFile } from "@swain/client";
import { createSwainServer, isLoopbackLiteral, type LoopbackHost } from "@swain/server";
import { openLocalStore } from "./swain-store.js";
import {
  flagOn,
  flagStr,
  homeOf,
  isoOf,
  type Out,
  parseFlags,
  SWAIN_EXIT,
  type SwainIo,
  shown,
  stateBaseOf,
} from "./swain-support.js";
import { CLI_VERSION } from "./version.js";

const SERVE_FLAGS = {
  "--host": "value",
  "--port": "value",
  "--db": "value",
  "--require-login": "bool",
} as const;
const DEFAULT_PORT = 4318;

export async function runServe(io: SwainIo, args: readonly string[], o: Out): Promise<number> {
  const a = parseFlags(args, SERVE_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  if (a.positionals.length > 0) {
    o.err("swain: serve takes no arguments\n");
    return SWAIN_EXIT.usage;
  }
  // Before any file or socket is touched: --host must be exactly one of the two literals.
  const hostFlag = flagStr(a, "--host");
  if (hostFlag !== undefined && !isLoopbackLiteral(hostFlag)) {
    o.err("swain: bind-not-loopback: --host must be the literal 127.0.0.1 or ::1\n");
    return SWAIN_EXIT.usage;
  }
  const host: LoopbackHost | undefined = hostFlag;
  const portFlag = flagStr(a, "--port");
  if (portFlag !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(portFlag)) {
    o.err("swain: --port must be an integer from 0 to 65535\n");
    return SWAIN_EXIT.usage;
  }
  const port = portFlag === undefined ? DEFAULT_PORT : Number(portFlag);
  if (port > 65_535) {
    o.err("swain: --port must be an integer from 0 to 65535\n");
    return SWAIN_EXIT.usage;
  }
  const stateBase = stateBaseOf(io.env);
  if (stateBase === null) {
    o.err("swain: no state location: set HOME or XDG_STATE_HOME\n");
    return SWAIN_EXIT.usage;
  }

  const requireLogin = flagOn(a, "--require-login");
  const opened = openLocalStore(io, flagStr(a, "--db"));
  let server: Awaited<ReturnType<typeof createSwainServer>> | undefined;
  let runtimePort: number | null = null;
  try {
    // Register first, so a signal that arrives while the server is starting is not lost.
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    io.onSignal(() => stop());

    server = await createSwainServer({
      store: opened.store,
      nowMs: io.nowMs,
      port,
      ...(host === undefined ? {} : { host }),
      version: CLI_VERSION,
      homeDir: homeOf(io.env),
      webAuth: requireLogin ? "login" : "none",
    });
    const primary =
      host === "::1" ? `http://[::1]:${server.port}` : `http://127.0.0.1:${server.port}`;
    parseOrigin(primary);
    writeRuntimeFile(stateBase, { origin: primary, instanceId: server.instanceId }, opened.uid);
    runtimePort = server.port;
    const nowIso = isoOf(io.nowMs());
    opened.store.appendAudit(opened.org.orgId, {
      at: nowIso,
      actorType: "cli",
      actorId: "local-owner",
      action: "server.start",
      targetType: "server",
      targetId: "local",
      detail: { port: server.port, webAuth: requireLogin ? "login" : "none" },
    });

    for (const addr of server.addresses) o.out(`swain: listening on http://${addr}\n`);
    o.out(`swain: database ${shown(opened.dbPath, io.env)}\n`);
    for (const w of server.warnings) {
      if (w === "ipv6-unavailable") {
        o.err("swain: warning: [::1] is unavailable on this machine; serving on 127.0.0.1 only\n");
      }
    }
    o.out("swain: protobuf is off; exporters must use OTEL_EXPORTER_OTLP_PROTOCOL=http/json\n");
    o.out(
      requireLogin
        ? "swain: pages need a login: run swain open for a single-use login URL\n"
        : "swain: pages are open to every local user and process on this machine (no login); use --require-login on a shared host\n",
    );
    o.out("swain: press Ctrl-C to stop\n");

    await stopped;
    o.out("swain: stopping\n");
    return SWAIN_EXIT.ok;
  } finally {
    if (runtimePort !== null) {
      try {
        removeRuntimeFile(stateBase, runtimePort);
      } catch {
        // a leftover runtime file is detected as stale by the proof challenge
      }
    }
    if (server !== undefined) await server.close();
    opened.store.close();
  }
}
