/**
 * `swain status`, `swain open` and `swain connect` (SPEC-003 section 4).
 *
 * - `status` talks to the server, authenticating it first (server-proof HMAC); no key is sent to a
 *   server that fails the proof (exit 8).
 * - `open` PRINTS a URL and never launches a browser. Against a default (no-login) server it checks
 *   health and the owner proof, then prints the plain page URL: no code. Against a `--require-login`
 *   server it issues a single-use 60 s login code with the target stored server-side.
 * - `connect` only prints exporter settings. It makes no write and no request.
 */
import {
  authenticateOwner,
  ClientError,
  type Credential,
  checkHealth,
  credentialPath,
  fetchStatus,
  healthWebAuth,
  loadCredential,
  originFor,
  SLUG_RE,
} from "@swain/client";
import type { OrgId, PrjId, ProjectScope, SwainStore } from "@swain/db";
import { issueLoginCode } from "@swain/server";
import { findServer, locateServer, openLocalStore, requestedOrigin, uidIn } from "./swain-store.js";
import {
  configBaseOf,
  flagOn,
  flagStr,
  isoOf,
  type Out,
  parseFlags,
  SWAIN_EXIT,
  type SwainIo,
  shown,
} from "./swain-support.js";
import { clip, esc, table, terminalJson } from "./text.js";

const STATUS_FLAGS = { "--json": "bool", "--server": "value", "--project": "value" } as const;
const OPEN_FLAGS = { "--server": "value", "--db": "value" } as const;
const CONNECT_FLAGS = {
  "--project": "value",
  "--show-secret": "bool",
  "--with-content": "bool",
  "--server": "value",
} as const;
const RE_AGT = /^agt_[0-9a-f]{32}$/;
const RE_RUN = /^run_[0-9a-f]{32}$/;

function loadOptionalCredential(configBase: string, slug: string, uid: number): Credential | null {
  try {
    return loadCredential(configBase, slug, uid);
  } catch (e) {
    if (e instanceof ClientError && e.code === "credential-missing") return null;
    throw e;
  }
}

// ---- status -------------------------------------------------------------------------------------

export async function runStatus(io: SwainIo, args: readonly string[], o: Out): Promise<number> {
  const a = parseFlags(args, STATUS_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  if (a.positionals.length > 0) {
    o.err("swain: status takes no arguments\n");
    return SWAIN_EXIT.usage;
  }
  const slug = flagStr(a, "--project") ?? "default";
  const configBase = configBaseOf(io.env);
  if (!SLUG_RE.test(slug) || configBase === null) {
    o.err("swain: --project must be a slug, and HOME or XDG_CONFIG_HOME must be set\n");
    return SWAIN_EXIT.usage;
  }
  const uid = uidIn(io.env, configBase, configBase);
  const requested = requestedOrigin(flagStr(a, "--server"), io.env);
  const cred = loadOptionalCredential(configBase, slug, uid);
  // A credential is used only for its recorded origin; another one is refused (exit 2).
  const origin = cred === null ? null : originFor(cred, requested);
  const located = locateServer(io, origin ?? requested, uid);

  if (!(await checkHealth(located.origin))) throw new ClientError("server-unreachable");
  const json = flagOn(a, "--json");
  if (cred === null) {
    if (json)
      o.out(terminalJson({ origin: located.origin, reachable: true, authenticated: false }));
    else {
      o.out(`server: reachable at ${located.origin}\n`);
      o.out(
        `no credential file for project '${slug}': run swain keys create --project ${slug} --save\n`,
      );
    }
    return SWAIN_EXIT.ok;
  }
  // The server proves itself before the key is sent (exit 8 on failure).
  const r = await fetchStatus(cred, located.pin);
  if (json) {
    o.out(
      terminalJson({
        origin: r.identity.origin,
        reachable: true,
        authenticated: true,
        instanceId: r.identity.instanceId,
        server: r.status.server,
        projects: r.status.projects,
      }),
    );
    return SWAIN_EXIT.ok;
  }
  const s = r.status.server;
  o.out(`server: reachable at ${r.identity.origin}\n`);
  o.out(
    `server: authenticated (instance ${r.identity.instanceId.slice(0, 12)}); the key was sent only after the proof\n`,
  );
  o.out(
    `  version ${clip(s.version, 32)}, canonical schema ${clip(s.canonicalSchema, 16)}, db schema ${s.dbSchema}, mode ${clip(s.mode, 16)}, bind ${clip(s.bind, 64)}\n`,
  );
  o.out("projects:\n");
  const rows = r.status.projects.map((p) => [
    clip(p.slug, 40),
    String(p.agents),
    String(p.runs),
    p.lastIngestMs === null ? "never" : isoOf(p.lastIngestMs),
    `${p.batches24h.accepted}/${p.batches24h.partial}/${p.batches24h.rejected}`,
    clip(p.contentPolicy, 16),
    clip(p.rawRetention, 16),
  ]);
  o.out(
    table(
      ["PROJECT", "AGENTS", "RUNS", "LAST INGEST", "BATCHES 24H A/P/R", "CONTENT", "RAW"],
      rows,
    ),
  );
  return SWAIN_EXIT.ok;
}

// ---- open ---------------------------------------------------------------------------------------

/** The page route (`next_path`) for a target; `null` plus an error message when it is not valid. */
function targetPath(
  args: readonly string[],
  find: {
    agent: (id: string) => boolean;
    run: (id: string) => boolean;
    any: (q: string) => readonly string[];
  },
): { path: string } | { error: string; code: number } {
  const [first, second, ...more] = args;
  if (more.length > 0) return { error: "swain: too many arguments\n", code: SWAIN_EXIT.usage };
  if (first === undefined || first === "fleet") {
    return second === undefined
      ? { path: "/" }
      : { error: "swain: fleet takes no argument\n", code: SWAIN_EXIT.usage };
  }
  if (first === "agent" || first === "run") {
    if (second === undefined)
      return { error: `swain: ${first} needs an ID\n`, code: SWAIN_EXIT.usage };
    const ok = first === "agent" ? RE_AGT.test(second) : RE_RUN.test(second);
    if (!ok) return { error: `swain: not a valid ${first} ID\n`, code: SWAIN_EXIT.usage };
    const exists = first === "agent" ? find.agent(second) : find.run(second);
    return exists
      ? { path: first === "agent" ? `/a/${second}` : `/r/${second}` }
      : { error: `swain: no ${first} with that ID\n`, code: SWAIN_EXIT.notFound };
  }
  if (second !== undefined)
    return {
      error: "swain: usage: swain open [fleet | agent ID | run ID | ID]\n",
      code: SWAIN_EXIT.usage,
    };
  const hits = find.any(first);
  const unique = [...new Set(hits)];
  if (unique.length === 1 && unique[0] !== undefined) return { path: unique[0] };
  return {
    error:
      unique.length === 0
        ? "swain: no run or agent matches that ID\n"
        : "swain: that ID matches more than one run or agent; use a full ID\n",
    code: SWAIN_EXIT.notFound,
  };
}

function resolveTarget(
  positionals: readonly string[],
  orgId: OrgId,
  store: SwainStore,
): { path: string } | { error: string; code: number } {
  const projects = store.listProjects({ orgId }).projects;
  const scopes: ProjectScope[] = projects.map((p) => ({ orgId, projectId: p.projectId }));
  const ids: PrjId[] = projects.map((p) => p.projectId);
  return targetPath(positionals, {
    agent: (id) => scopes.some((s) => store.agent(s, id as `agt_${string}`) !== null),
    run: (id) => scopes.some((s) => store.run(s, id as `run_${string}`) !== null),
    any: (q) =>
      store
        .resolveId({ orgId }, ids, q)
        .flatMap((r) =>
          r.type === "agent" ? [`/a/${r.id}`] : r.runId === null ? [] : [`/r/${r.runId}`],
        ),
  });
}

export async function runOpen(io: SwainIo, args: readonly string[], o: Out): Promise<number> {
  const a = parseFlags(args, OPEN_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  const requested = requestedOrigin(flagStr(a, "--server"), io.env);
  const opened = openLocalStore(io, flagStr(a, "--db"));
  try {
    const { store, org, uid } = opened;
    // G3-auth B2: nothing is written and nothing is printed until the listener has proved that it
    // uses this very database. There is no default-port guess: no runtime file means no server.
    const located = findServer(io, requested, uid);
    if (located === null) {
      o.err(
        "swain: no running server found (no runtime file in the state directory); start one with swain serve, or name it with --server. No login code was created.\n",
      );
      return SWAIN_EXIT.unreachable;
    }
    let alive = false;
    try {
      alive = await checkHealth(located.origin);
    } catch {
      alive = false;
    }
    if (!alive) {
      o.err(
        `swain: nothing healthy is listening at ${located.origin} (a stale runtime file?); start the server with swain serve. No login code was created.\n`,
      );
      return SWAIN_EXIT.unreachable;
    }
    // The owner proof runs in both modes (security review F1): in the default mode no code exists,
    // but a squatter of a stale runtime file's port must not send the user to forged pages.
    try {
      await authenticateOwner(located.origin, store.ownerProofKey(isoOf(io.nowMs())), located.pin);
    } catch (e) {
      if (e instanceof ClientError && e.code === "server-unauthenticated") {
        o.err(
          `swain: the listener at ${located.origin} did not prove that it uses this database (stale runtime file, or another program owns the port). No login code was created.\n`,
        );
        return SWAIN_EXIT.unreachable;
      }
      throw e;
    }
    // The mode is read only from a listener that has proved it uses this database; anything but an
    // explicit "none" keeps the login-code flow.
    let mode: "none" | "login" = "login";
    try {
      mode = await healthWebAuth(located.origin);
    } catch {
      mode = "login";
    }
    const t = resolveTarget(a.positionals, org.orgId, store);
    if ("error" in t) {
      o.err(t.error);
      return t.code;
    }
    if (mode === "none") {
      o.out(`${located.origin}${t.path}\n`);
      return SWAIN_EXIT.ok;
    }
    const code = issueLoginCode(store, { orgId: org.orgId, nextPath: t.path, nowMs: io.nowMs() });
    o.out("Login URL (single use, expires in 60 s):\n");
    o.out(`  ${located.origin}/login?code=${code}\n`);
    o.out("Paste this URL into your browser; it expires in 60 s.\n");
    o.out(
      "Pasting is preferred over launching a browser with xdg-open: a launched browser carries the URL in its argv, which other local users can read in /proc/*/cmdline during those 60 s.\n",
    );
    return SWAIN_EXIT.ok;
  } finally {
    opened.store.close();
  }
}

// ---- connect ------------------------------------------------------------------------------------

export function runConnect(io: SwainIo, args: readonly string[], o: Out): number {
  const [kind, ...rest] = args;
  if (kind !== "otlp" && kind !== "claude-code") {
    o.err("swain: usage: swain connect otlp|claude-code [--project SLUG] [--show-secret]\n");
    return SWAIN_EXIT.usage;
  }
  const a = parseFlags(rest, CONNECT_FLAGS);
  if ("error" in a) {
    o.err(a.error);
    return SWAIN_EXIT.usage;
  }
  if (a.positionals.length > 0) {
    o.err("swain: connect takes no further arguments\n");
    return SWAIN_EXIT.usage;
  }
  if (kind === "otlp" && flagOn(a, "--with-content")) {
    o.err("swain: --with-content applies to connect claude-code only\n");
    return SWAIN_EXIT.usage;
  }
  const slug = flagStr(a, "--project") ?? "default";
  const configBase = configBaseOf(io.env);
  if (!SLUG_RE.test(slug) || configBase === null) {
    o.err("swain: --project must be a slug, and HOME or XDG_CONFIG_HOME must be set\n");
    return SWAIN_EXIT.usage;
  }
  const uid = uidIn(io.env, configBase, configBase);
  const requested = requestedOrigin(flagStr(a, "--server"), io.env);
  const cred = loadOptionalCredential(configBase, slug, uid);
  const origin =
    cred === null ? locateServer(io, requested, uid).origin : originFor(cred, requested);
  const showSecret = flagOn(a, "--show-secret");
  if (showSecret && cred === null) {
    o.err(
      `swain: no credential file for project '${slug}'; run swain keys create --project ${slug} --save\n`,
    );
    return SWAIN_EXIT.notFound;
  }
  const bearer = showSecret && cred !== null ? cred.secret : "<SWAIN_KEY>";
  const lines: string[] = [];
  const env = (k: string, v: string): void => {
    lines.push(`${k}=${v}`);
  };
  if (kind === "otlp") {
    lines.push("# Swain: generic OTLP/HTTP exporter settings");
  } else {
    lines.push('# Swain: Claude Code telemetry, for the "env" block of your USER settings.json');
    lines.push("# (repository settings cannot enable telemetry; this is the user-level file)");
    env("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
    env("OTEL_LOGS_EXPORTER", "otlp");
    env("OTEL_METRICS_EXPORTER", "none");
  }
  env("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
  env("OTEL_EXPORTER_OTLP_ENDPOINT", origin);
  env("OTEL_EXPORTER_OTLP_HEADERS", `Authorization=Bearer ${bearer}`);
  if (kind === "claude-code" && flagOn(a, "--with-content")) {
    lines.push(
      "# WARNING: these flags make the sender include prompts and tool content. The server",
    );
    lines.push("# still stores hash-only by default, but the content crosses the local socket.");
    for (const k of [
      "OTEL_LOG_USER_PROMPTS",
      "OTEL_LOG_ASSISTANT_RESPONSES",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT",
    ]) {
      env(k, "1");
    }
  }
  o.out(`${lines.map((l) => esc(l)).join("\n")}\n`);
  o.out("\n");
  if (showSecret) {
    o.out(
      "WARNING: the secret is printed above. Anyone who can read your terminal history or settings can use it.\n",
    );
  } else if (cred === null) {
    o.out(
      `Replace <SWAIN_KEY> with a key: run swain keys create --project ${slug} --save, then read the secret from the credential file.\n`,
    );
  } else {
    o.out(
      `Replace <SWAIN_KEY> with the secret in ${shown(credentialPath(configBase, slug), io.env)} (key ${cred.keyId}); it is not printed here.\n`,
    );
  }
  o.out(
    "Protobuf is off: the exporter must use http/json (OTEL_EXPORTER_OTLP_PROTOCOL=http/json). gRPC (port 4317) is not supported.\n",
  );
  o.out(
    "For Claude Code, prefer otelHeadersHelper: a helper command that prints the Authorization header from the credential file, so the secret never lands in settings.json. Its output contract is unverified; this integration is a documented route, untested.\n",
  );
  o.out("A key written into settings.json is plaintext and readable by anything running as you.\n");
  o.out("Nothing was written: this command only prints.\n");
  return SWAIN_EXIT.ok;
}
