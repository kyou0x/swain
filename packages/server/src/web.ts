/**
 * The browser pages (SPEC-003 section 3.5, N1.6): local login, logout, fleet, agent, runs and run.
 *
 * Every page except `GET /login` needs a session; a missing, expired or revoked session gets the
 * static sign-in hint (401) and never any data. `GET /login` consumes nothing; `POST /login`
 * consumes the code atomically and redirects to the SERVER-STORED `next_path`. Every state change
 * needs the full-origin check, and logout also the CSRF token. IDs in URLs are regex-validated
 * before they reach the store, and every page is produced by `@swain/report`.
 */
import {
  DbError,
  type OrgId,
  type Project,
  type ProjectScope,
  type RunDetail,
  type RunId,
  type Session,
  type SwainStore,
} from "@swain/db";
import type { ExplainOptions, RenderOptions, SessionView, WebNav } from "@swain/report";
import {
  OutputTooLarge,
  renderAgentPage,
  renderFleetPage,
  renderLoginPage,
  renderMessagePage,
  renderRunPage,
  renderRunsListPage,
  renderSpanRunPage,
  SERVER_CSP,
} from "@swain/report";
import type { ErrorCode } from "./errors.js";
import { countHeader, type Req, readBody } from "./http.js";
import type { Rendered } from "./responses.js";
import {
  agentNameOf,
  agentNameViews,
  conflictView,
  credentialViews,
  errorAgents,
  keyLabels,
  mergeCredentials,
  runHeaderView,
  runRowView,
  runStatusOf,
  spanRowViews,
} from "./webdata.js";
import {
  clearedSessionCookie,
  csrfToken,
  csrfValid,
  hashLoginCode,
  hashSessionToken,
  isAllowedNextPath,
  isLoginCode,
  newSessionToken,
  pageFetchAllowed,
  sameOriginOk,
  sessionCookie,
  sessionTokenOf,
} from "./websession.js";

export type WebAuthMode = "none" | "login";

const RE_AGT = /^agt_[0-9a-f]{32}$/;
const RE_RUN = /^run_[0-9a-f]{32}$/;
const RE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FORM_BODY_CAP = 2048;
const MAX_QUERY_CHARS = 512;
const MAX_SPANS = 1000;
const PRINCIPAL = "local-owner";
const HTML = "text/html; charset=utf-8";

export type WebRoute =
  | { readonly kind: "login"; readonly methods: readonly ["GET", "POST"] }
  | { readonly kind: "logout"; readonly methods: readonly ["POST"] }
  | { readonly kind: "fleet"; readonly methods: readonly ["GET"] }
  | { readonly kind: "runs"; readonly methods: readonly ["GET"] }
  | { readonly kind: "agent"; readonly methods: readonly ["GET"]; readonly id: string }
  | { readonly kind: "run"; readonly methods: readonly ["GET"]; readonly id: string };

/** The page route table. `/a/<x>` and `/r/<x>` match any single segment; the ID is validated later. */
export function matchWebRoute(path: string): WebRoute | null {
  if (path === "/") return { kind: "fleet", methods: ["GET"] };
  if (path === "/runs") return { kind: "runs", methods: ["GET"] };
  if (path === "/login") return { kind: "login", methods: ["GET", "POST"] };
  if (path === "/logout") return { kind: "logout", methods: ["POST"] };
  const m = /^\/([ar])\/([^/]{0,200})$/.exec(path);
  if (m !== null) {
    const id = m[2] ?? "";
    return m[1] === "a"
      ? { kind: "agent", methods: ["GET"], id }
      : { kind: "run", methods: ["GET"], id };
  }
  return null;
}

export interface WebDeps {
  readonly store: SwainStore;
  readonly nowMs: () => number;
  /** The bound port (known only after listen). */
  readonly port: () => number;
  readonly homeDir: string | null;
  /** `none`: pages are open (default, owner decision 2026-11-16); `login`: the N1.6 session flow. */
  readonly webAuth: WebAuthMode;
  /** Span rows the fleet page may read in one render for per-agent error flags (default 5000). */
  readonly fleetSpanBudget: number;
  /** Largest rendered page in bytes. */
  readonly maxPageBytes: number;
  /** 32 random bytes per process: the CSRF HMAC key. */
  readonly csrfSecret: Uint8Array;
  /** No-login mode: spend one token of the page-render bucket; `null` when it is empty. */
  readonly takePage: (nowMs: number) => { readonly retryAfterSec: number } | null;
  /** Spend one token of the global authentication-failure bucket; `null` when it is empty. */
  readonly takeFailure: (nowMs: number) => { readonly retryAfterSec: number } | null;
  /** Count a failed login for the per-minute aggregated `login.failure` audit entry. */
  readonly loginFailed: (nowMs: number) => void;
  /** Write the pending aggregate, if any (before a success and at close). */
  readonly flushLoginFailures: () => void;
}

export interface WebReply {
  readonly status: number;
  readonly rendered: Rendered;
  readonly extra: Readonly<Record<string, string>>;
  /** The handler consumed the request body (the server then keeps the connection alive). */
  readonly bodyRead: boolean;
  readonly code: ErrorCode | "ok";
}

const encoder = new TextEncoder();
const EXPLAIN_BASE = { excerptChars: 160 } as const;

const PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy": SERVER_CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
});

function page(
  status: number,
  html: string,
  code: ErrorCode | "ok",
  bodyRead: boolean,
  extra: Readonly<Record<string, string>> = {},
): WebReply {
  return {
    status,
    rendered: { contentType: HTML, body: encoder.encode(html) },
    extra: { ...PAGE_HEADERS, ...extra },
    bodyRead,
    code,
  };
}

function redirect(
  location: string,
  extra: Readonly<Record<string, string>>,
  bodyRead: boolean,
): WebReply {
  return {
    status: 303,
    rendered: { contentType: HTML, body: new Uint8Array(0) },
    extra: { ...PAGE_HEADERS, Location: location, ...extra },
    bodyRead,
    code: "ok",
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function renderOptions(d: WebDeps): RenderOptions {
  return { homeDir: d.homeDir, maxOutputBytes: d.maxPageBytes, maxRenderedEvents: 10_000 };
}

function message(
  d: WebDeps,
  status: number,
  code: ErrorCode,
  m: Parameters<typeof renderMessagePage>[0],
  bodyRead: boolean,
  extra: Readonly<Record<string, string>> = {},
): WebReply {
  return page(status, renderMessagePage(m, renderOptions(d)), code, bodyRead, extra);
}

function parseQuery(query: string): URLSearchParams | null {
  if (query.length > MAX_QUERY_CHARS) return null;
  try {
    return new URLSearchParams(query);
  } catch {
    return null;
  }
}

function one(q: URLSearchParams, name: string): string | null {
  const all = q.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

interface Authed {
  readonly session: Session;
  readonly sessionHash: string;
}

/** The valid session of a request (idle and absolute expiry and revocation enforced by the store). */
export function sessionOf(store: SwainStore, req: Req, nowMs: number): Authed | null {
  const token = sessionTokenOf(req);
  if (token === null) return null;
  const sessionHash = hashSessionToken(token);
  const session = store.findSession(sessionHash, nowMs);
  return session === null ? null : { session, sessionHash };
}

function failureReply(d: WebDeps, now: number, bodyRead: boolean): WebReply {
  const wait = d.takeFailure(now);
  if (wait !== null) {
    return message(d, 429, "rate-limited", "rate-limited", bodyRead, {
      "Retry-After": String(wait.retryAfterSec),
    });
  }
  return message(d, 401, "unauthenticated", "signin-required", bodyRead);
}

export async function handleWeb(
  req: Req,
  route: WebRoute,
  query: string,
  d: WebDeps,
): Promise<WebReply> {
  const method = req.method ?? "";
  if (d.webAuth === "none" && (route.kind === "login" || route.kind === "logout")) {
    return message(d, 404, "not-found", "not-found", false);
  }
  if (!(route.methods as readonly string[]).includes(method)) {
    return message(d, 405, "method-not-allowed", "method-not-allowed", false, {
      Allow: route.methods.join(", "),
    });
  }
  const now = d.nowMs();
  try {
    let orgId: OrgId;
    let nav: WebNav;
    if (d.webAuth === "none") {
      // owner decision 2026-11-16: no login. The Host allowlist (server.ts) and this fetch-metadata
      // rule are what stand between a browser tab on another site and these pages.
      if (!pageFetchAllowed(req)) return message(d, 403, "csrf", "csrf", false);
      const wait = d.takePage(now);
      if (wait !== null) {
        return message(d, 429, "rate-limited", "rate-limited", false, {
          "Retry-After": String(wait.retryAfterSec),
        });
      }
      // local mode has exactly one org, looked up read-only
      const org = d.store.findLocalOrg()?.orgId;
      if (org === undefined) return message(d, 404, "not-found", "not-found", false);
      orgId = org;
      nav = { csrf: null, nowMs: now };
    } else {
      switch (route.kind) {
        case "login":
          return method === "GET" ? loginGet(d, query) : await loginPost(req, d, now);
        case "logout":
          return await logoutPost(req, d, now);
        default:
          break;
      }
      // every other page needs a session (a GET carries no body worth reading)
      const auth = sessionOf(d.store, req, now);
      if (auth === null) return failureReply(d, now, false);
      nav = { csrf: csrfToken(d.csrfSecret, auth.sessionHash, "logout"), nowMs: now };
      orgId = auth.session.orgId;
    }
    const q = parseQuery(query);
    if (q === null) return message(d, 400, "bad-request", "bad-request", false);
    switch (route.kind) {
      case "fleet":
        return fleetPage(d, orgId, q, nav, now);
      case "runs":
        return runsPage(d, orgId, q, nav, now);
      case "agent":
        return agentPage(d, orgId, route.id, nav, now);
      case "run":
        return runPage(d, orgId, route.id, q, nav, now);
      default:
        return message(d, 404, "not-found", "not-found", false);
    }
  } catch (e) {
    if (e instanceof DbError && e.code === "db-locked") {
      return message(d, 503, "busy", "busy", false, { "Retry-After": "2" });
    }
    throw e;
  }
}

// ---- login and logout --------------------------------------------------------------------------

/** `GET /login?code=`: consumes nothing, looks nothing up, ignores `next`. */
function loginGet(d: WebDeps, query: string): WebReply {
  const q = parseQuery(query);
  const code = q === null ? null : one(q, "code");
  if (code === null || !isLoginCode(code)) {
    return message(d, 401, "unauthenticated", "signin-required", false);
  }
  return page(200, renderLoginPage(code, renderOptions(d)), "ok", false);
}

function formContentType(req: Req): boolean {
  if (countHeader(req, "content-type") !== 1) return false;
  const ct = (req.headers["content-type"] ?? "").toLowerCase().replace(/\s/g, "");
  return (
    ct === "application/x-www-form-urlencoded" ||
    ct === "application/x-www-form-urlencoded;charset=utf-8"
  );
}

async function readForm(
  req: Req,
  d: WebDeps,
): Promise<{ form: URLSearchParams } | { reply: WebReply }> {
  if (!formContentType(req)) return { reply: message(d, 400, "bad-request", "bad-request", false) };
  const body = await readBody(req, FORM_BODY_CAP, () => undefined);
  if (body.kind === "too-large") {
    return { reply: message(d, 413, "payload-too-large", "bad-request", false) };
  }
  if (body.kind === "aborted")
    return { reply: message(d, 400, "bad-request", "bad-request", false) };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.body);
    return { form: new URLSearchParams(text) };
  } catch {
    return { reply: message(d, 400, "bad-request", "bad-request", true) };
  }
}

/** `POST /login`: origin check, atomic consume, host-only cookie, 303 to the stored `next_path`. */
async function loginPost(req: Req, d: WebDeps, now: number): Promise<WebReply> {
  if (!sameOriginOk(req, d.port())) {
    d.loginFailed(now);
    const wait = d.takeFailure(now);
    if (wait !== null) {
      return message(d, 429, "rate-limited", "rate-limited", false, {
        "Retry-After": String(wait.retryAfterSec),
      });
    }
    return message(d, 403, "csrf", "csrf", false);
  }
  const read = await readForm(req, d);
  if ("reply" in read) return read.reply;
  // Consume first: the shared failure bucket is charged only by a failed consume. A pre-consume
  // throttle would let a flood of bad Bearer requests or session-less GETs lock the owner out;
  // a 256-bit code cannot be guessed at any rate (G3-auth R1).
  const code = one(read.form, "code");
  const consumed =
    code !== null && isLoginCode(code) ? d.store.consumeLoginCode(hashLoginCode(code), now) : null;
  if (consumed === null) {
    d.loginFailed(now);
    return failureReply(d, now, true);
  }
  d.flushLoginFailures();
  const token = newSessionToken();
  d.store.putSession(consumed.orgId, {
    tokenSha256: hashSessionToken(token),
    principal: PRINCIPAL,
    createdMs: now,
  });
  d.store.appendAudit(consumed.orgId, {
    at: iso(now),
    actorType: "user",
    actorId: PRINCIPAL,
    action: "login.success",
    targetType: "session",
    targetId: PRINCIPAL,
    detail: {},
  });
  // The redirect target is the one stored with the code; a request value is never consulted.
  const next = isAllowedNextPath(consumed.nextPath) ? consumed.nextPath : "/";
  return redirect(next, { "Set-Cookie": sessionCookie(token) }, true);
}

/** `POST /logout`: session, full-origin check and CSRF token; revokes the session server-side. */
async function logoutPost(req: Req, d: WebDeps, now: number): Promise<WebReply> {
  const auth = sessionOf(d.store, req, now);
  if (auth === null) return failureReply(d, now, false);
  if (!sameOriginOk(req, d.port())) return message(d, 403, "csrf", "csrf", false);
  const read = await readForm(req, d);
  if ("reply" in read) return read.reply;
  const presented = one(read.form, "csrf");
  if (presented === null || !csrfValid(d.csrfSecret, auth.sessionHash, "logout", presented)) {
    return message(d, 403, "csrf", "csrf", true);
  }
  d.store.revokeSession(auth.sessionHash, now);
  d.store.appendAudit(auth.session.orgId, {
    at: iso(now),
    actorType: "user",
    actorId: auth.session.principal,
    action: "session.revoke",
    targetType: "session",
    targetId: auth.session.principal,
    detail: {},
  });
  return redirect("/", { "Set-Cookie": clearedSessionCookie() }, true);
}

// ---- data pages --------------------------------------------------------------------------------

interface Chosen {
  readonly scope: ProjectScope;
  readonly project: Project;
  readonly slugs: readonly string[];
}

function projectsOf(d: WebDeps, orgId: OrgId): readonly Project[] {
  return d.store.listProjects({ orgId }).projects;
}

function chooseProject(d: WebDeps, orgId: OrgId, q: URLSearchParams): Chosen | null {
  const projects = projectsOf(d, orgId);
  const want = one(q, "p");
  let project: Project | undefined;
  if (want !== null) {
    if (!RE_SLUG.test(want)) return null;
    project = projects.find((p) => p.slug === want);
  } else {
    project = projects.find((p) => p.slug === "default") ?? projects[0];
  }
  if (project === undefined) return null;
  return {
    scope: { orgId, projectId: project.projectId },
    project,
    slugs: projects.map((p) => p.slug),
  };
}

function notFound(d: WebDeps): WebReply {
  return message(d, 404, "not-found", "not-found", false);
}

function fleetPage(
  d: WebDeps,
  orgId: OrgId,
  q: URLSearchParams,
  nav: WebNav,
  now: number,
): WebReply {
  const chosen = chooseProject(d, orgId, q);
  if (chosen === null) return notFound(d);
  const sortParam = one(q, "sort");
  const sort = sortParam === "name" ? "name" : "recent";
  const { scope, project } = chosen;
  const fleet = d.store.fleet(scope, { sort, limit: 100, offset: 0 });
  const labels = keyLabels(d.store, scope);
  const traceOwners = new Map<string, Set<string> | null>();
  let spanBudget = d.fleetSpanBudget;
  const rows = fleet.rows.map((r) => {
    const detail = d.store.agent(scope, r.agentId);
    const runs = detail?.recentRuns ?? [];
    const latest = runs.reduce<(typeof runs)[number] | null>(
      (a, b) => (a === null || b.lastReceivedMs > a.lastReceivedMs ? b : a),
      null,
    );
    const st = latest === null ? null : runStatusOf(d.store, scope, latest, now);
    // The run's error flag is run-wide: in a trace shared by several agents it would mark every
    // agent. For a trace run the fleet charges each ERROR span to its nearest enclosing agent span
    // (see `errorAgents`): the agent's own error plus its same-credential enclosing agent, no
    // propagation across credentials, siblings or sub-agents. Other run kinds, truncated runs and
    // runs past the render budget keep the run flag.
    let error = st?.error ?? false;
    if (latest !== null && latest.kind === "trace" && error) {
      let owners = traceOwners.get(latest.runId);
      if (owners === undefined) {
        // Fall back to the run-wide flag (owners = null) when the spans are not all available:
        // over the per-render budget, or truncated by the read limit.
        owners = null;
        const n = latest.counts["spans"];
        const size = typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : Infinity;
        if (size <= spanBudget) {
          const data = d.store.runSpans(scope, latest.runId, MAX_SPANS);
          spanBudget -= data.spans.length;
          if (!data.truncated) owners = errorAgents(data.spans);
        }
        traceOwners.set(latest.runId, owners);
      }
      if (owners !== null) error = owners.has(r.agentId);
    }
    return {
      agentId: r.agentId,
      displayName: r.displayName,
      keyBasis: r.keyBasis,
      status: st?.status ?? ("idle" as const),
      error,
      lastSeenMs: r.lastSeenMs,
      runCount: r.runCount,
      credentials: credentialViews(mergeCredentials(runs.map((x) => x.credentials)), labels),
    };
  });
  const html = renderFleetPage(
    {
      project: { slug: project.slug, name: project.name, contentPolicy: project.contentPolicy },
      projectSlugs: chosen.slugs,
      sort,
      rows,
      total: fleet.total,
    },
    renderOptions(d),
    nav,
  );
  return page(200, html, "ok", false);
}

function runsPage(
  d: WebDeps,
  orgId: OrgId,
  q: URLSearchParams,
  nav: WebNav,
  now: number,
): WebReply {
  const chosen = chooseProject(d, orgId, q);
  if (chosen === null) return notFound(d);
  const { scope, project } = chosen;
  const labels = keyLabels(d.store, scope);
  const names = new Map(
    d.store
      .fleet(scope, { sort: "name", limit: 200, offset: 0 })
      .rows.map((r) => [r.agentId, r.displayName]),
  );
  const page0 = d.store.runs(scope, { limit: 100, offset: 0 });
  const rows = page0.rows.map((r) =>
    runRowView(d.store, scope, r, names.get(r.primaryAgentId) ?? "unknown agent", labels, now),
  );
  const html = renderRunsListPage(
    {
      project: { slug: project.slug, name: project.name, contentPolicy: project.contentPolicy },
      projectSlugs: chosen.slugs,
      rows,
      total: page0.total,
    },
    renderOptions(d),
    nav,
  );
  return page(200, html, "ok", false);
}

function agentPage(d: WebDeps, orgId: OrgId, id: string, nav: WebNav, now: number): WebReply {
  if (!RE_AGT.test(id)) return notFound(d);
  for (const project of projectsOf(d, orgId)) {
    const scope: ProjectScope = { orgId, projectId: project.projectId };
    const detail = d.store.agent(scope, id as `agt_${string}`);
    if (detail === null) continue;
    const labels = keyLabels(d.store, scope);
    const runs = detail.recentRuns;
    const latest = runs.reduce<(typeof runs)[number] | null>(
      (a, b) => (a === null || b.lastReceivedMs > a.lastReceivedMs ? b : a),
      null,
    );
    const st = latest === null ? null : runStatusOf(d.store, scope, latest, now);
    const html = renderAgentPage(
      {
        project: { slug: project.slug, name: project.name, contentPolicy: project.contentPolicy },
        agent: {
          agentId: detail.agent.agentId,
          displayName: detail.agent.displayName,
          keyBasis: detail.agent.keyBasis,
          status: st?.status ?? "idle",
          error: st?.error ?? false,
          lastSeenMs: detail.agent.lastSeenMs,
          firstSeenMs: detail.agent.firstSeenMs,
          runCount: detail.runCount,
          credentials: credentialViews(mergeCredentials(runs.map((x) => x.credentials)), labels),
        },
        runs: runs.map((r) => runRowView(d.store, scope, r, detail.agent.displayName, labels, now)),
      },
      renderOptions(d),
      nav,
    );
    return page(200, html, "ok", false);
  }
  return notFound(d);
}

function explainOptions(inline: boolean, home: string | null): ExplainOptions {
  return { ...EXPLAIN_BASE, includeContentExcerpts: inline, homeDirs: [home] };
}

function runPage(
  d: WebDeps,
  orgId: OrgId,
  id: string,
  q: URLSearchParams,
  nav: WebNav,
  now: number,
): WebReply {
  if (!RE_RUN.test(id)) return notFound(d);
  const partParam = one(q, "part");
  if (partParam !== null && !/^[1-9][0-9]{0,3}$/.test(partParam)) {
    return message(d, 400, "bad-request", "bad-request", false);
  }
  for (const project of projectsOf(d, orgId)) {
    const scope: ProjectScope = { orgId, projectId: project.projectId };
    const detail: RunDetail | null = d.store.run(scope, id as RunId);
    if (detail === null) continue;
    const labels = keyLabels(d.store, scope);
    const agentName = agentNameOf(d.store, scope, detail.run.primaryAgentId);
    const header = runHeaderView(
      d.store,
      scope,
      detail.run,
      agentName,
      project.contentPolicy,
      labels,
      now,
    );
    const ro = renderOptions(d);
    if (detail.run.kind === "session" || detail.run.kind === "import") {
      const events = d.store.runEvents(scope, id as RunId);
      // Parts keep their own order inside; across parts: first valid event time, then arrival.
      const paired = events.sessions
        .map((s, i) => ({ s, key: detail.imports[i]?.keyId ?? "unknown", i }))
        .sort((a, b) => {
          const ta = a.s.record.firstEventTime ?? "￿";
          const tb = b.s.record.firstEventTime ?? "￿";
          return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
        });
      const parts: SessionView[] = paired.map((p) => p.s);
      if (parts.length === 0) {
        return page(
          200,
          renderSpanRunPage({ run: header, spans: [], conflicts: [], truncated: false }, ro, nav),
          "ok",
          false,
        );
      }
      const part = partParam === null ? 1 : Number(partParam);
      if (part > parts.length) return message(d, 400, "bad-request", "bad-request", false);
      const html = renderRunPage(
        { run: header, parts, partKeys: paired.map((p) => p.key), part },
        explainOptions(project.contentPolicy === "inline", d.homeDir),
        ro,
        nav,
      );
      return page(200, html, "ok", false);
    }
    // trace and logs runs: the span page (a logs run has no spans until the N1.7 projection)
    const data = d.store.runSpans(scope, id as RunId, MAX_SPANS);
    let html: string;
    try {
      html = renderSpanRunPage(
        {
          run: header,
          spans: spanRowViews(data.spans),
          agents: agentNameViews(d.store, scope, data.spans),
          conflicts: data.conflicts.map(conflictView),
          truncated: data.truncated,
        },
        ro,
        nav,
      );
    } catch (e) {
      if (e instanceof OutputTooLarge) {
        return page(200, renderMessagePage("too-large", ro), "ok", false);
      }
      throw e;
    }
    return page(200, html, "ok", false);
  }
  return notFound(d);
}
