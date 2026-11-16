/**
 * Test harness: a real `SqliteSwainStore` in a temp directory, a real server on port 0 and real
 * HTTP over loopback. Time is a mutable test clock (the product code has no `Date.now`).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import {
  type KeyScope,
  type OrgId,
  type PrjId,
  type ProjectScope,
  SqliteSwainStore,
} from "@swain/db";
import {
  createSwainServer,
  type LogEvent,
  type ServerLimits,
  type SwainServer,
  type SwainServerOptions,
} from "../src/index.js";

export const NOW0 = 1_700_000_000_000;
export const NOW_ISO = "2026-01-01T00:00:00.000Z";
const uid: number = (process.getuid as () => number)();

export interface Clock {
  now: number;
}

export interface Credential {
  readonly keyId: `key_${string}`;
  readonly secret: string;
  readonly serverProofKey: string;
}

export interface Env {
  readonly store: SqliteSwainStore;
  readonly dir: string;
  readonly clock: Clock;
  readonly srv: SwainServer;
  readonly scope: ProjectScope;
  readonly orgId: OrgId;
  readonly projectId: PrjId;
  readonly logs: LogEvent[];
  /** The key created at start (scopes `ingest:otlp` by default, pinned to `planner`). */
  readonly key: Credential;
  newKey(o?: {
    scopes?: readonly KeyScope[];
    agentName?: string | null;
    expiresAtMs?: number | null;
  }): Credential;
  done(): Promise<void>;
}

export interface EnvOptions {
  readonly limits?: Partial<ServerLimits>;
  readonly host?: "127.0.0.1" | "::1";
  readonly allowUnverifiedProtobuf?: boolean;
  readonly webAuth?: "none" | "login";
  readonly fleetSpanBudget?: number;
  readonly maxPageBytes?: number;
  readonly scopes?: readonly KeyScope[];
  readonly agentName?: string | null;
  readonly store?: (s: SqliteSwainStore) => SwainServerOptions["store"];
}

export async function startEnv(o: EnvOptions = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "swain-server-test-"));
  const clock: Clock = { now: NOW0 };
  const store = SqliteSwainStore.open(join(dir, "swain.sqlite"), {
    sessionMode: "local",
    uid,
    nowMs: () => clock.now,
  });
  store.migrate({ nowIso: () => NOW_ISO });
  const { org, project } = store.ensureLocalTenancy(NOW_ISO);
  const scope: ProjectScope = { orgId: org.orgId, projectId: project.projectId };
  const logs: LogEvent[] = [];
  const srv = await createSwainServer({
    store: o.store === undefined ? store : o.store(store),
    nowMs: () => clock.now,
    port: 0,
    ...(o.host === undefined ? {} : { host: o.host }),
    ...(o.allowUnverifiedProtobuf === undefined
      ? {}
      : { allowUnverifiedProtobuf: o.allowUnverifiedProtobuf }),
    ...(o.webAuth === undefined ? {} : { webAuth: o.webAuth }),
    ...(o.fleetSpanBudget === undefined ? {} : { fleetSpanBudget: o.fleetSpanBudget }),
    ...(o.maxPageBytes === undefined ? {} : { maxPageBytes: o.maxPageBytes }),
    ...(o.limits === undefined ? {} : { limits: o.limits }),
    log: (e) => logs.push(e),
  });
  let n = 0;
  const newKey: Env["newKey"] = (k = {}) => {
    n++;
    const made = store.createKey(scope, {
      label: `test-${n}`,
      scopes: k.scopes ?? ["ingest:otlp"],
      agentName: k.agentName === undefined ? null : k.agentName,
      createdBy: "test",
      createdAt: NOW_ISO,
      ...(k.expiresAtMs === undefined ? {} : { expiresAtMs: k.expiresAtMs }),
    });
    return { keyId: made.key.keyId, secret: made.secret, serverProofKey: made.serverProofKey };
  };
  const key = newKey({
    scopes: o.scopes ?? ["ingest:otlp"],
    agentName: o.agentName === undefined ? "planner" : o.agentName,
  });
  return {
    store,
    dir,
    clock,
    srv,
    scope,
    orgId: org.orgId,
    projectId: project.projectId,
    logs,
    key,
    newKey,
    done: async () => {
      await srv.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
}

export interface Req {
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

/** A normal HTTP request (Node's client, Host defaults to `127.0.0.1:<port>`). */
export function http(port: number, r: Req, host = "127.0.0.1"): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    const body = r.body === undefined ? undefined : Buffer.from(r.body);
    const req = httpRequest(
      {
        host,
        port,
        method: r.method ?? "POST",
        path: r.path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(body === undefined ? {} : { "Content-Length": String(body.length) }),
          ...r.headers,
        },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const bearer = (c: Credential): Record<string, string> => ({
  Authorization: `Bearer ${c.secret}`,
});

/** An ingest POST of a JSON string with a valid key. */
export function postJson(
  port: number,
  path: string,
  c: Credential,
  body: string | Uint8Array,
  extra: Record<string, string> = {},
): Promise<Reply> {
  return http(port, {
    path,
    headers: { "Content-Type": "application/json", ...bearer(c), ...extra },
    body,
  });
}

export const gz = (s: string | Uint8Array): Uint8Array => new Uint8Array(gzipSync(Buffer.from(s)));

export interface RawReply {
  /** Everything the server sent before it closed the connection (or the wait ended). */
  readonly text: string;
  readonly closed: boolean;
}

/**
 * A raw TCP exchange, for requests Node's client refuses to build (no Host, absolute-form,
 * duplicate headers, bodies that are announced but not sent). It writes `chunks` in order and
 * collects the reply until the server closes or `waitMs` passes.
 */
export function raw(
  port: number,
  chunks: readonly (string | Uint8Array)[],
  waitMs = 1500,
): Promise<RawReply> {
  return new Promise<RawReply>((resolve) => {
    const sock = connect({ host: "127.0.0.1", port });
    const out: Buffer[] = [];
    let closed = false;
    const finish = (): void => {
      resolve({ text: Buffer.concat(out).toString("latin1"), closed });
      sock.destroy();
    };
    sock.on("data", (d: Buffer) => out.push(d));
    sock.on("close", () => {
      closed = true;
      finish();
    });
    sock.on("error", () => undefined);
    sock.setTimeout(waitMs, finish);
    sock.on("connect", () => {
      for (const c of chunks) sock.write(c);
    });
  });
}

export const statusOf = (r: RawReply): number =>
  Number(/^HTTP\/1\.1 (\d{3})/.exec(r.text)?.[1] ?? 0);

export function fixture(name: string): string {
  return readFileSync(new URL(`../../../../fixtures/otlp/${name}`, import.meta.url), "utf8");
}

/** Every table's content as one string, for "this marker is nowhere in the database" checks. */
export function dbDump(store: SqliteSwainStore, tables: readonly string[]): string {
  // The store has no raw access; read through the file with a second connection.
  const raw = new DatabaseSync(store.path);
  try {
    const parts: string[] = [];
    for (const t of tables) {
      const st = raw.prepare(`SELECT * FROM ${t}`);
      st.setReadBigInts(true);
      parts.push(
        JSON.stringify(st.all(), (_k: string, v: unknown) =>
          typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? "<blob>" : v,
        ),
      );
    }
    return parts.join("\n");
  } finally {
    raw.close();
  }
}

export function rows(store: SqliteSwainStore, sql: string): Record<string, unknown>[] {
  const raw = new DatabaseSync(store.path);
  try {
    const st = raw.prepare(sql);
    st.setReadBigInts(true);
    return st.all() as Record<string, unknown>[];
  } finally {
    raw.close();
  }
}

export const L1_TABLES = [
  "agents",
  "runs",
  "run_agents",
  "spans",
  "span_conflicts",
  "log_records",
  "ingest_batches",
  "resources",
] as const;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
