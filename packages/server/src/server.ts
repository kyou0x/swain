/**
 * `createSwainServer(options)`: the Swain HTTP server (SPEC-003 N1.5).
 *
 * Request processing order (ADR-0006 section 5a, normative). A step that fails ends the request
 * and no later step runs. Steps are marked `// step N` below. The body is never read before the
 * request is authenticated; an unauthenticated request never holds a slot.
 *
 *   1 Host (exact, case-insensitive) and request-target form        -> 421 / 400
 *   2 method and route (closed table)                                -> 404 / 405
 *   3 Cookie on an ingest route                                      -> 400
 *   4 Content-Type and Content-Encoding                              -> 415
 *   5 authentication from headers only; the global bucket is
 *     consulted on FAILURE only (N1.5 G3 F1)                         -> 400 / 401 / 429
 *   6 per-key bucket, then the scope check                           -> 429 / 403
 *   7 in-flight slot (server-wide), then the decode slot             -> 503
 *   8 body with a running cap                                        -> 413
 *   9 gunzip with a cap                                              -> 413
 *  10 hash, dedup, decode, policy, agent and run, one transaction    -> 400 / 413 / 500 / 503
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DbError, type KeyAuthRecord, type OrgId, type PrjId, type SwainStore } from "@swain/db";
import { type decodeOtlp, wireFormatOf } from "@swain/otlp";
import { authenticate } from "./auth.js";
import { assertBoundAddress, isLoopbackLiteral, type LoopbackHost, listenOn } from "./bind.js";
import { TokenBucket } from "./bucket.js";
import { ERRORS, type ErrorCode, SwainServerError } from "./errors.js";
import {
  countHeader,
  declaredLength,
  type HttpServer,
  hostAllowed,
  queryHasKey,
  type Req,
  type Res,
  readBody,
  socketOrigin,
  splitTarget,
} from "./http.js";
import { runIngest, type Signal } from "./ingest.js";
import { resolveServerLimits, type ServerLimits } from "./limits.js";
import {
  type Rendered,
  renderApiError,
  renderExportResponse,
  renderJson,
  renderOtlpError,
} from "./responses.js";
import { handleWeb, matchWebRoute, sessionOf, type WebAuthMode, type WebDeps } from "./web.js";
import { fetchSiteSameOrigin, statusFetchAllowed } from "./websession.js";

export const CANONICAL_SCHEMA_VERSION = "0.1.0";

/** The closed route IDs: the only route names that ever appear in a log line. */
export type RouteId =
  | "healthz"
  | "traces"
  | "logs"
  | "metrics"
  | "server-proof"
  | "status"
  | "login"
  | "logout"
  | "page"
  | "unknown";

/**
 * One operational log record. Static code, route ID, status, byte counts, duration and the
 * authenticated key ID: never a URL, a query, a header, a body or an attribute value (S25).
 */
export interface LogEvent {
  readonly code: ErrorCode | "ok";
  readonly route: RouteId;
  readonly status: number;
  /** Request body bytes read at step 8 (0 when the body was never read). */
  readonly bodyBytes: number;
  /** Bytes the connection had delivered when the response finished (headers included). */
  readonly connBytesRead: number;
  readonly durationMs: number;
  readonly keyId: string | null;
}

export interface Counters {
  readonly requests: number;
  /** Handler throws answered with the static 500. */
  readonly internalErrors: number;
  /** `OtlpDecodeError("internal")` / `invalid-option`: a decoder bug, never the sender's fault. */
  readonly decoderInternalErrors: number;
  /** Total request body bytes read at step 8, across all requests. */
  readonly bodyBytesRead: number;
  readonly unauthenticated: number;
  readonly rateLimitedGlobal: number;
  readonly rateLimitedKey: number;
  readonly busy: number;
  /** Runtime `error` events on a listening server (counted; the server keeps running). */
  readonly serverErrors: number;
}

export interface SwainServerOptions {
  readonly store: SwainStore;
  /** Injected clock (the policy bans `Date.now` in product code). */
  readonly nowMs: () => number;
  /** TCP port; `0` picks a free one (both families then share it). */
  readonly port: number;
  /** One literal (`127.0.0.1` or `::1`); omitted binds both families. */
  readonly host?: LoopbackHost;
  readonly version?: string;
  /** The user's home directory: pages mask it at display (ADR-0007 T-N6). `null` masks nothing. */
  readonly homeDir?: string | null;
  /**
   * Browser page access. `none` (default, owner decision 2026-11-16): the pages need no login,
   * `/login` and `/logout` are 404, and cross-site fetches are refused by `Sec-Fetch-*`. `login`:
   * the N1.6 session, cookie and CSRF flow (`swain serve --require-login`, for shared hosts).
   */
  readonly webAuth?: WebAuthMode;
  /** Span rows the fleet page may read per render for per-agent error flags. Default 5000. */
  readonly fleetSpanBudget?: number;
  /** Largest page the server renders, in bytes (default 32 MiB); a larger run page degrades to a notice. */
  readonly maxPageBytes?: number;
  /**
   * Accept `application/x-protobuf` on `/v1/*`. Default false: the protobuf field numbers are
   * UNVERIFIED (`packages/otlp/PIN.md`), so protobuf gets 415 and exporters are told to use
   * `http/json`. Turn it on only after PIN.md is verified.
   */
  readonly allowUnverifiedProtobuf?: boolean;
  readonly limits?: Partial<ServerLimits>;
  readonly log?: (e: LogEvent) => void;
}

export interface SwainServer {
  readonly port: number;
  /** Bound addresses, e.g. `["127.0.0.1:4318", "[::1]:4318"]`. */
  readonly addresses: readonly string[];
  /** 16 random bytes in hex, for the runtime file and the server-proof HMAC. */
  readonly instanceId: string;
  /** Static warning codes, e.g. `ipv6-unavailable`. */
  readonly warnings: readonly string[];
  counters(): Counters;
  close(): Promise<void>;
}

const NODE_OPTIONS = {
  maxHeaderSize: 16_384,
  headersTimeout: 10_000,
  requestTimeout: 60_000,
  keepAliveTimeout: 5_000,
  // Idle and half-open connections are checked every 5 s instead of every 30 s.
  connectionsCheckingInterval: 5_000,
  insecureHTTPParser: false,
  // Our own handler answers a missing Host with 421, so the order of section 5a holds.
  requireHostHeader: false,
} as const;
const PROOF_BODY_BYTES = 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^key_[0-9a-f]{16}$/;

interface Route {
  readonly id: RouteId;
  readonly method: "GET" | "POST";
}
const ROUTES: Readonly<Record<string, Route>> = Object.freeze({
  "/healthz": { id: "healthz", method: "GET" },
  "/v1/traces": { id: "traces", method: "POST" },
  "/v1/logs": { id: "logs", method: "POST" },
  "/v1/metrics": { id: "metrics", method: "POST" },
  "/api/v1/server-proof": { id: "server-proof", method: "POST" },
  "/api/v1/status": { id: "status", method: "GET" },
});

function hex(b: Uint8Array): string {
  let out = "";
  for (const x of b) out += x.toString(16).padStart(2, "0");
  return out;
}

/** Per-request state, shared by the steps and by the `handle` wrapper. */
interface Rq {
  readonly req: Req;
  readonly res: Res;
  readonly startedMs: number;
  route: RouteId;
  code: ErrorCode | "ok";
  keyId: string | null;
  bodyBytes: number;
  /** True when the request body is fully consumed (or there is none). */
  bodyDone: boolean;
  /** `application/x-protobuf` was negotiated, so errors and responses are protobuf. */
  protobuf: boolean;
  expectContinue: boolean;
}

/**
 * Test-only seams. They are not in the package exports (`index.ts` exports `createSwainServer`
 * only), so no configuration, environment or caller of the package can reach them.
 */
export interface ServerHooks {
  /** Replaces `decodeOtlp` (to force a decoder `internal` error). */
  readonly decode?: typeof decodeOtlp;
  /** Receives the listening servers once bound (to emit a runtime `error` event). */
  readonly onServers?: (servers: readonly HttpServer[]) => void;
}

export function createSwainServer(o: SwainServerOptions): Promise<SwainServer> {
  return createSwainServerWithHooks(o, {});
}

export async function createSwainServerWithHooks(
  o: SwainServerOptions,
  hooks: ServerHooks,
): Promise<SwainServer> {
  if (typeof o !== "object" || o === null) throw new SwainServerError("invalid-option");
  if (o.host !== undefined && !isLoopbackLiteral(o.host)) {
    throw new SwainServerError("bind-not-loopback");
  }
  if (typeof o.nowMs !== "function" || typeof o.store !== "object" || o.store === null) {
    throw new SwainServerError("invalid-option");
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65_535) {
    throw new SwainServerError("invalid-option");
  }
  const limits = resolveServerLimits(o.limits);
  const store = o.store;
  const nowMs = o.nowMs;
  const allowProtobuf = o.allowUnverifiedProtobuf === true;
  const version = o.version ?? "0.0.0";
  const instanceId = hex(randomBytes(16));
  /** The CSRF HMAC key: 32 random bytes per process (a restart invalidates open forms only). */
  const csrfSecret = new Uint8Array(randomBytes(32));
  if (o.webAuth !== undefined && o.webAuth !== "none" && o.webAuth !== "login") {
    throw new SwainServerError("invalid-option");
  }
  if (
    o.fleetSpanBudget !== undefined &&
    (!Number.isInteger(o.fleetSpanBudget) || o.fleetSpanBudget < 0 || o.fleetSpanBudget > 1_000_000)
  ) {
    throw new SwainServerError("invalid-option");
  }
  if (
    o.maxPageBytes !== undefined &&
    (!Number.isInteger(o.maxPageBytes) ||
      o.maxPageBytes < 65536 ||
      o.maxPageBytes > 256 * 1024 * 1024)
  ) {
    throw new SwainServerError("invalid-option");
  }
  const webAuth: WebAuthMode = o.webAuth ?? "none";

  let port = 0;
  let primary = "";
  /** The families this server really listens on (filled right after each listen succeeds). */
  const bound = new Set<string>();
  const t0 = nowMs();
  /** One global bucket for authentication failures only (401, key-in-query); see step 5. */
  const globalBucket = new TokenBucket(limits.unauthBurst, limits.unauthPerSec, t0);
  /** `server-proof` has its own small bucket, separate from the authentication-failure one. */
  const proofBucket = new TokenBucket(limits.unauthBurst, limits.unauthPerSec, t0);
  /** No-login page renders: a cheap per-server cap (burst 60, 30 per second). */
  const pageBucket = new TokenBucket(60, 30, t0);
  const keyBuckets = new Map<string, TokenBucket>();
  const byteBuckets = new Map<string, TokenBucket>();
  let inFlight = 0;
  let decoding = 0;
  let connections = 0;
  const c = {
    requests: 0,
    internalErrors: 0,
    decoderInternalErrors: 0,
    bodyBytesRead: 0,
    unauthenticated: 0,
    rateLimitedGlobal: 0,
    rateLimitedKey: 0,
    busy: 0,
    serverErrors: 0,
  };

  /** Failed logins, written as one `login.failure` audit entry per minute (ADR-0007 section 8). */
  const loginFailures = {
    minute: -1,
    count: 0,
    add(now: number): void {
      const m = Math.floor(now / 60_000);
      if (m !== this.minute) this.flush();
      this.minute = m;
      this.count++;
    },
    flush(): void {
      if (this.count === 0) return;
      const { minute, count } = this;
      this.count = 0;
      try {
        const at = new Date(minute * 60_000).toISOString();
        // local mode has exactly one org; looked up read-only, never created here
        const org = store.findLocalOrg()?.orgId;
        if (org === undefined) return;
        store.appendAudit(org, {
          at,
          actorType: "system",
          actorId: "server",
          action: "login.failure",
          targetType: "session",
          targetId: "login",
          detail: { count, minute: at },
        });
      } catch {
        // an audit failure never fails a request
      }
    },
  };

  const webDeps: WebDeps = {
    store,
    nowMs,
    port: () => port,
    homeDir: o.homeDir ?? null,
    webAuth,
    fleetSpanBudget: o.fleetSpanBudget ?? 5000,
    maxPageBytes: o.maxPageBytes ?? 32 * 1024 * 1024,
    csrfSecret,
    loginFailed: (now) => loginFailures.add(now),
    flushLoginFailures: () => loginFailures.flush(),
    takePage: (now) => {
      if (pageBucket.take(now)) return null;
      c.rateLimitedGlobal++;
      return { retryAfterSec: pageBucket.retryAfterSec(now) };
    },
    // one global bucket covers every authentication failure, pages included (SPEC-003 3.1)
    takeFailure: (now) => {
      if (!globalBucket.take(now)) {
        c.rateLimitedGlobal++;
        return { retryAfterSec: globalBucket.retryAfterSec(now) };
      }
      c.unauthenticated++;
      return null;
    },
  };

  const keyBucket = (keyId: string, now: number): TokenBucket => {
    let b = keyBuckets.get(keyId);
    if (b === undefined) {
      b = new TokenBucket(limits.keyBurst, limits.keyPerSec, now);
      keyBuckets.set(keyId, b);
    }
    return b;
  };
  const byteBucket = (keyId: string, now: number): TokenBucket => {
    let b = byteBuckets.get(keyId);
    if (b === undefined) {
      b = new TokenBucket(limits.keyBytesPerMinute, limits.keyBytesPerMinute / 60, now);
      byteBuckets.set(keyId, b);
    }
    return b;
  };

  // ---- responses ------------------------------------------------------------------------------
  const respond = (
    rq: Rq,
    status: number,
    r: Rendered,
    extra: Readonly<Record<string, string>> = {},
  ): void => {
    const { res, req } = rq;
    if (res.headersSent || res.writableEnded) return;
    // A response while the body is unread or half read closes the connection: no draining.
    const close = !rq.bodyDone;
    res.statusCode = status;
    res.setHeader("Content-Type", r.contentType);
    res.setHeader("Content-Length", String(r.body.length));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    if (close) {
      res.setHeader("Connection", "close");
      res.once("finish", () => req.socket.destroy());
    }
    res.end(r.body);
  };

  const fail = (rq: Rq, code: ErrorCode, extra: Readonly<Record<string, string>> = {}): void => {
    rq.code = code;
    const otlp = rq.route === "traces" || rq.route === "logs";
    const rendered = otlp
      ? renderOtlpError(code, rq.protobuf && allowProtobuf)
      : renderApiError(code);
    respond(rq, ERRORS[code].status, rendered, extra);
  };
  const retry = (sec: number): Readonly<Record<string, string>> => ({ "Retry-After": String(sec) });

  const ok = (rq: Rq, r: Rendered): void => {
    rq.code = "ok";
    respond(rq, 200, r);
  };

  // ---- the request ----------------------------------------------------------------------------
  const serve = async (rq: Rq): Promise<void> => {
    const { req } = rq;
    c.requests++;
    const declared = declaredLength(req);
    rq.bodyDone =
      declared === 0 || (declared === null && req.headers["transfer-encoding"] === undefined);

    // step 1: Host, then the request-target form
    if (!hostAllowed(req, port, bound)) return fail(rq, "misdirected");
    const url = req.url ?? "";
    if (!url.startsWith("/")) return fail(rq, "absolute-form");

    // step 2: method and route (closed table; `/v1/metrics` is a loud 404 for any method)
    const { path, query } = splitTarget(url);
    // pages (N1.6): session auth, no key and no ingest body; each handler checks its own method
    const webRoute = matchWebRoute(path);
    if (webRoute !== null) {
      rq.route =
        webRoute.kind === "login" ? "login" : webRoute.kind === "logout" ? "logout" : "page";
      const r = await handleWeb(req, webRoute, query, webDeps);
      if (r.bodyRead) rq.bodyDone = true;
      rq.code = r.code;
      return respond(rq, r.status, r.rendered, r.extra);
    }
    const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
    if (route === undefined) return fail(rq, "not-found");
    rq.route = route.id;
    if (route.id === "metrics") return fail(rq, "not-found");
    if (req.method !== route.method) return fail(rq, "method-not-allowed", { Allow: route.method });

    // `webAuth` is not secret; the CLI reads it to choose between a plain URL and a login code
    if (route.id === "healthz") return ok(rq, renderJson({ ok: true, webAuth }));
    if (route.id === "server-proof") return serverProof(rq);

    const ingest = route.id === "traces" || route.id === "logs";
    let gzip = false;
    let contentType = "";
    let protobuf = false;
    if (ingest) {
      // step 3: a Cookie on an ingest route is rejected before anything else is looked at
      if (countHeader(req, "cookie") > 0) return fail(rq, "cookie-on-ingest");

      // step 4: Content-Type and Content-Encoding against the route's allowed set
      contentType = req.headers["content-type"] ?? "";
      let wire: "json" | "protobuf";
      try {
        if (countHeader(req, "content-type") !== 1) throw new Error("unsupported");
        wire = wireFormatOf(contentType);
      } catch {
        return fail(rq, "unsupported-media-type");
      }
      protobuf = wire === "protobuf";
      rq.protobuf = protobuf;
      if (protobuf && !allowProtobuf) return fail(rq, "unsupported-media-type");
      const ce = req.headers["content-encoding"];
      if (ce !== undefined && ce !== "identity" && ce !== "gzip") {
        return fail(rq, "unsupported-encoding");
      }
      gzip = ce === "gzip";
    }

    // step 5: authentication from headers only (one indexed lookup and one SHA-256, bounded by
    // maxConnections). The global bucket is consulted ONLY when authentication fails: a flood of
    // bad or foreign requests must never lock out a valid key.
    const now = nowMs();
    const authFailure = (code: ErrorCode, extra: Readonly<Record<string, string>>): void => {
      if (!globalBucket.take(now)) {
        c.rateLimitedGlobal++;
        fail(rq, "rate-limited", retry(globalBucket.retryAfterSec(now)));
        return;
      }
      c.unauthenticated++;
      fail(rq, code, extra);
    };
    if (queryHasKey(query)) return authFailure("key-in-query", {});
    // cookie-authenticated JSON (ADR-0007 section 5): `Sec-Fetch-Site: same-origin` is required and
    // a missing header is refused, so non-browser clients cannot use a cookie here
    if (route.id === "status" && webAuth === "none" && !statusFetchAllowed(req)) {
      return fail(rq, "csrf");
    }
    if (
      webAuth === "login" &&
      route.id === "status" &&
      countHeader(req, "authorization") === 0 &&
      countHeader(req, "cookie") > 0
    ) {
      if (!fetchSiteSameOrigin(req)) return fail(rq, "csrf");
      const s = sessionOf(store, req, now);
      if (s === null) return authFailure("unauthenticated", {});
      const orgId = s.session.orgId;
      return statusFor(
        rq,
        orgId,
        store.listProjects({ orgId }).projects.map((p) => p.projectId),
      );
    }
    const auth =
      countHeader(req, "authorization") === 1
        ? authenticate(store, req.headers.authorization, now)
        : ({ ok: false } as const);
    if (!auth.ok) return authFailure("unauthenticated", { "WWW-Authenticate": "Bearer" });
    const key: KeyAuthRecord = auth.key;
    rq.keyId = key.keyId;

    // step 6: per-key bucket (exists only for authenticated keys), before the scope check
    const kb = keyBucket(key.keyId, now);
    if (!kb.take(now)) {
      c.rateLimitedKey++;
      return fail(rq, "rate-limited", retry(kb.retryAfterSec(now)));
    }
    const scopeOk =
      route.id === "status"
        ? key.scopes.some((s) => s === "read:status" || s.startsWith("ingest:"))
        : key.scopes.includes("ingest:otlp");
    if (!scopeOk) return fail(rq, "forbidden");

    // step 7: the server-wide in-flight slot
    if (inFlight >= limits.inFlight) {
      c.busy++;
      return fail(rq, "busy", retry(1));
    }
    inFlight++;
    try {
      if (route.id === "status") return statusFor(rq, key.orgId, [key.projectId]);
      return await ingestRequest(rq, route.id as Signal, key, { gzip, contentType, protobuf });
    } finally {
      inFlight--;
    }
  };

  const statusFor = (rq: Rq, orgId: OrgId, projectIds: readonly PrjId[]): void => {
    const st = store.status({ orgId }, projectIds);
    ok(
      rq,
      renderJson({
        server: {
          version,
          canonicalSchema: CANONICAL_SCHEMA_VERSION,
          dbSchema: st.schemaVersion,
          mode: "local",
          bind: primary,
        },
        projects: st.projects.map((p) => ({
          projectId: p.projectId,
          slug: p.slug,
          agents: p.agents,
          runs: p.runs,
          lastIngestMs: p.lastIngestMs,
          batches24h: p.batches24h,
          contentPolicy: p.contentPolicy,
          rawRetention: p.rawRetention,
        })),
      }),
    );
  };

  const ingestRequest = async (
    rq: Rq,
    signal: Signal,
    key: KeyAuthRecord,
    h: { gzip: boolean; contentType: string; protobuf: boolean },
  ): Promise<void> => {
    const { req, res } = rq;
    // step 7b: the decode slot, separate from the in-flight slot. It is taken before the body is
    // read, so at most `decodeConcurrency` request bodies and decoded models are alive at once.
    if (decoding >= limits.decodeConcurrency) {
      c.busy++;
      return fail(rq, "busy", retry(1));
    }
    decoding++;
    try {
      const now = nowMs();
      if (!byteBucket(key.keyId, now).has(now)) {
        c.rateLimitedKey++;
        return fail(rq, "rate-limited", retry(byteBucket(key.keyId, now).retryAfterSec(now)));
      }
      if (rq.expectContinue) res.writeContinue();

      // step 8: the body, with a running cap (declared length first)
      const body = await readBody(req, limits.maxBodyBytes, (n) => {
        rq.bodyBytes += n;
        c.bodyBytesRead += n;
      });
      if (body.kind === "too-large") return fail(rq, "payload-too-large");
      if (body.kind === "aborted") {
        res.destroy();
        return;
      }
      rq.bodyDone = true;

      // steps 9 and 10
      let result: ReturnType<typeof runIngest>;
      try {
        result = runIngest(
          {
            store,
            limits,
            chargeBytes: (keyId, n) => byteBucket(keyId, nowMs()).take(nowMs(), n),
            onDecoderInternal: () => {
              c.decoderInternalErrors++;
            },
            ...(hooks.decode === undefined ? {} : { decode: hooks.decode }),
          },
          {
            signal,
            key,
            contentType: h.contentType,
            wire: h.protobuf ? "protobuf" : "json",
            gzip: h.gzip,
            body: body.body,
            receivedMs: now,
            batchId: `bat_${hex(randomBytes(16))}`,
          },
        );
      } catch (e) {
        if (e instanceof DbError && e.code === "db-locked") {
          c.busy++;
          return fail(rq, "busy", retry(2));
        }
        throw e;
      }
      if (result.kind === "error") {
        const extra =
          result.code === "unauthenticated"
            ? { "WWW-Authenticate": "Bearer" }
            : result.retryAfterSec === undefined
              ? {}
              : retry(result.retryAfterSec);
        return fail(rq, result.code, extra);
      }
      ok(rq, renderExportResponse(signal, result.rejected, result.errorMessage, h.protobuf));
    } finally {
      decoding--;
    }
  };

  /**
   * `POST /api/v1/server-proof` (ADR-0006 section 8): unauthenticated by design, no key is sent.
   * It counts against the global bucket on every call, holds no slot, and reads at most
   * `PROOF_BODY_BYTES`. An unknown or revoked key ID gets the same static 401 as a bad key.
   */
  const serverProof = async (rq: Rq): Promise<void> => {
    const { req } = rq;
    const ce = req.headers["content-encoding"];
    try {
      if (countHeader(req, "content-type") !== 1) throw new Error("unsupported");
      if (wireFormatOf(req.headers["content-type"] ?? "") !== "json")
        throw new Error("unsupported");
    } catch {
      return fail(rq, "unsupported-media-type");
    }
    if (ce !== undefined && ce !== "identity") return fail(rq, "unsupported-encoding");
    const now = nowMs();
    if (!proofBucket.take(now)) {
      c.rateLimitedGlobal++;
      return fail(rq, "rate-limited", retry(proofBucket.retryAfterSec(now)));
    }
    const body = await readBody(req, PROOF_BODY_BYTES, (n) => {
      rq.bodyBytes += n;
      c.bodyBytesRead += n;
    });
    if (body.kind === "too-large") return fail(rq, "payload-too-large");
    if (body.kind === "aborted") {
      req.socket.destroy();
      return;
    }
    rq.bodyDone = true;
    let keyId: unknown;
    let challenge: unknown;
    let purpose: unknown;
    try {
      const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.body));
      if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("shape");
      purpose = Object.hasOwn(v, "purpose") ? (v as Record<string, unknown>)["purpose"] : undefined;
      keyId = Object.hasOwn(v, "keyId") ? (v as Record<string, unknown>)["keyId"] : undefined;
      challenge = Object.hasOwn(v, "challenge")
        ? (v as Record<string, unknown>)["challenge"]
        : undefined;
    } catch {
      return fail(rq, "bad-request");
    }
    if (typeof challenge !== "string" || !HEX64.test(challenge)) return fail(rq, "bad-request");
    const owner = purpose === "owner";
    if (purpose !== undefined && !owner) return fail(rq, "bad-request");
    if (owner ? keyId !== undefined : typeof keyId !== "string" || !KEY_ID.test(keyId)) {
      return fail(rq, "bad-request");
    }
    // The origin comes from the socket that accepted the connection, never from the Host header
    // (G3-auth B1): a relay on another address family or port cannot obtain a proof for an origin
    // this server does not own.
    const origin = socketOrigin(req);
    if (origin === null || req.socket.localPort !== port) return fail(rq, "misdirected");
    const proof = owner
      ? store.ownerProof(origin, instanceId, challenge)
      : store.serverProof(keyId as string, origin, instanceId, challenge);
    if (proof === null) {
      c.unauthenticated++;
      return fail(rq, "unauthenticated", { "WWW-Authenticate": "Bearer" });
    }
    ok(rq, renderJson({ origin, instanceId, proof }));
  };

  // ---- handle(): nothing a handler throws escapes as anything but a static 500 --------------------
  const logEvent = (rq: Rq): void => {
    if (o.log === undefined) return;
    try {
      o.log({
        code: rq.code,
        route: rq.route,
        status: rq.res.statusCode,
        bodyBytes: rq.bodyBytes,
        connBytesRead: rq.req.socket.bytesRead,
        durationMs: Math.max(0, nowMs() - rq.startedMs),
        keyId: rq.keyId,
      });
    } catch {
      // a failing log sink never fails a request
    }
  };

  const handle = (req: Req, res: Res, expectContinue: boolean): void => {
    const rq: Rq = {
      req,
      res,
      startedMs: nowMs(),
      route: "unknown",
      code: "ok",
      keyId: null,
      bodyBytes: 0,
      bodyDone: false,
      protobuf: false,
      expectContinue,
    };
    req.on("error", () => undefined);
    res.on("error", () => undefined);
    res.once("close", () => logEvent(rq));
    serve(rq).catch(() => {
      c.internalErrors++;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      rq.bodyDone = false;
      fail(rq, "internal");
    });
  };

  // ---- the servers ----------------------------------------------------------------------------
  const make = (): HttpServer => {
    const server = createServer(NODE_OPTIONS, (req, res) => handle(req, res, false));
    server.maxConnections = limits.maxConnections;
    // `Expect: 100-continue` is answered only at step 8, never before authentication.
    server.on("checkContinue", (req, res) => handle(req, res, true));
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("connect", (_req, socket) => socket.destroy());
    server.on("connection", (socket) => {
      connections++;
      socket.on("error", () => undefined);
      socket.once("close", () => {
        connections--;
      });
      if (connections > limits.maxConnections) socket.destroy();
    });
    return server;
  };

  // After listen succeeded, a later `error` event must not crash the process (an unhandled
  // `error` event throws): count it and carry on.
  const persistentError = (srv: HttpServer): void => {
    srv.on("error", () => {
      c.serverErrors++;
    });
  };

  const families: readonly LoopbackHost[] = o.host === undefined ? ["127.0.0.1", "::1"] : [o.host];
  const warnings: string[] = [];
  let servers: HttpServer[] = [];
  const closeAll = async (list: readonly HttpServer[]): Promise<void> => {
    await Promise.all(
      list.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (!s.listening) return resolve();
            s.close(() => resolve());
            s.closeAllConnections();
          }),
      ),
    );
  };

  // With port 0 both families must share the port the first one got; a collision on the second
  // family just retries with another port.
  const attempts = o.port === 0 && families.length === 2 ? 8 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const list: HttpServer[] = [];
    try {
      const first = families[0] as LoopbackHost;
      const s0 = make();
      list.push(s0);
      await listenOn(s0, first, o.port);
      persistentError(s0);
      bound.add(first);
      port = assertBoundAddress(s0.address(), first, o.port);
      if (families.length === 2) {
        const s1 = make();
        try {
          await listenOn(s1, "::1", port);
          persistentError(s1);
          assertBoundAddress(s1.address(), "::1", port);
          list.push(s1);
          bound.add("::1");
        } catch (e) {
          if (e instanceof SwainServerError && e.code === "address-unavailable") {
            warnings.push("ipv6-unavailable");
          } else if (
            e instanceof SwainServerError &&
            e.code === "port-held" &&
            o.port === 0 &&
            attempt < attempts - 1
          ) {
            await closeAll(list);
            continue;
          } else throw e;
        }
      }
      servers = list;
      hooks.onServers?.(list);
      break;
    } catch (e) {
      await closeAll(list);
      throw e;
    }
  }
  if (servers.length === 0) throw new SwainServerError("port-held", "::1");
  const addresses = servers.map((_s, i) => {
    const fam = families[i] as LoopbackHost;
    return fam === "::1" ? `[::1]:${port}` : `${fam}:${port}`;
  });
  primary = addresses[0] ?? "";

  let closed = false;
  return {
    port,
    addresses,
    instanceId,
    warnings,
    counters: () => Object.freeze({ ...c }),
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      loginFailures.flush();
      await closeAll(servers);
    },
  };
}
