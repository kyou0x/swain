/**
 * Browser session mechanics (ADR-0007 sections 2 and 5, SPEC-003 S27): login codes, the session
 * cookie, CSRF tokens and the full-origin check. Pure functions plus `issueLoginCode`, which the
 * `swain open` command calls with direct DB access.
 *
 * - A login code is 32 random bytes (unpadded base64url). Only `sha256("swain:v1:login-code\n" +
 *   code)` is stored, together with the SERVER-SIDE `next_path`, a 60 s expiry and single use.
 * - A session token is 32 random bytes; only its domain-separated SHA-256 is stored.
 * - CSRF: `HMAC-SHA256(serverSecret, lp("swain:v1:csrf") || lp(sessionHash) || lp(formId))`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_LOGIN_CODE_MS, type OrgId, type SwainStore } from "@swain/db";
import { concat, hmacSha256, lp, sha256Hex, toHex } from "./hmac.js";
import { countHeader, type Req } from "./http.js";

export const SESSION_COOKIE = "swain_session";
/** The local absolute lifetime, also the cookie's `Max-Age` (ADR-0007 section 2). */
export const SESSION_MAX_AGE_SEC = 24 * 3600;
export const LOGIN_CODE_TTL_MS = MAX_LOGIN_CODE_MS;

const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = CODE_RE;

/** The page route table a stored `next_path` may name (SPEC-003 section 3.5, server-side only). */
export function isAllowedNextPath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    (p === "/" ||
      p === "/runs" ||
      /^\/a\/agt_[0-9a-f]{32}$/.test(p) ||
      /^\/r\/run_[0-9a-f]{32}$/.test(p))
  );
}

export function isLoginCode(v: unknown): v is string {
  return typeof v === "string" && CODE_RE.test(v);
}

export function hashLoginCode(code: string): string {
  return sha256Hex(`swain:v1:login-code\n${code}`);
}

export function hashSessionToken(token: string): string {
  return sha256Hex(`swain:v1:session\n${token}`);
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create a single-use login code for `nextPath` (validated against the route table) and store its
 * hash. Returns the code, to be printed once. The caller prints no `next` parameter.
 */
export function issueLoginCode(
  store: SwainStore,
  o: { readonly orgId: OrgId; readonly nextPath: string; readonly nowMs: number },
): string {
  if (!isAllowedNextPath(o.nextPath)) throw new RangeError("next path is not a page route");
  const code = randomBytes(32).toString("base64url");
  store.putLoginCode({
    codeSha256: hashLoginCode(code),
    orgId: o.orgId,
    nextPath: o.nextPath,
    expiresAtMs: o.nowMs + LOGIN_CODE_TTL_MS,
  });
  return code;
}

/** The one `swain_session` token of the request, or null (no cookie, a duplicate, or a bad shape). */
export function sessionTokenOf(req: Req): string | null {
  if (countHeader(req, "cookie") !== 1) return null;
  const raw = req.headers.cookie;
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let found: string | null = null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    if (found !== null) return null;
    found = part.slice(eq + 1).trim();
  }
  return found !== null && TOKEN_RE.test(found) ? found : null;
}

/** Host-only (no `Domain`), `HttpOnly`, `SameSite=Strict`, `Path=/`; local mode is plain HTTP. */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function csrfToken(secret: Uint8Array, sessionHash: string, formId: string): string {
  return toHex(hmacSha256(secret, concat(lp("swain:v1:csrf"), lp(sessionHash), lp(formId))));
}

export function csrfValid(
  secret: Uint8Array,
  sessionHash: string,
  formId: string,
  presented: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(presented)) return false;
  const want = new TextEncoder().encode(csrfToken(secret, sessionHash, formId));
  const got = new TextEncoder().encode(presented);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * The full-origin check of ADR-0007 section 5 for state-changing requests. `Sec-Fetch-Site`, when
 * present, must be `same-origin`. `Origin`, when present, must equal `http://<Host>` and be one of
 * the loopback origins of this server (scheme, host and port). With neither header the request is
 * refused. Duplicated headers are refused.
 */
export function sameOriginOk(req: Req, port: number): boolean {
  if (countHeader(req, "origin") > 1 || countHeader(req, "sec-fetch-site") > 1) return false;
  const site = req.headers["sec-fetch-site"];
  const origin = req.headers.origin;
  if (site !== undefined && site !== "same-origin") return false;
  if (origin !== undefined) {
    const o = origin.toLowerCase();
    const allowed = [
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
      `http://localhost:${port}`,
    ];
    return allowed.includes(o) && o === `http://${(req.headers.host ?? "").toLowerCase()}`;
  }
  return site === "same-origin";
}

/** Cookie-authenticated JSON requires `Sec-Fetch-Site: same-origin`; a missing header is refused. */
export function fetchSiteSameOrigin(req: Req): boolean {
  return (
    countHeader(req, "sec-fetch-site") === 1 && req.headers["sec-fetch-site"] === "same-origin"
  );
}

/** The one value of a Sec-Fetch header: `undefined` when absent, `null` when duplicated. */
function fetchHeader(req: Req, name: string): string | undefined | null {
  const n = countHeader(req, name);
  if (n === 0) return undefined;
  if (n > 1) return null;
  const v = req.headers[name];
  return typeof v === "string" ? v.toLowerCase() : null;
}

/**
 * No-login mode (owner decision 2026-11-16), GET pages: a request the browser marks `cross-site`
 * or `same-site` is refused unless it is a top-level navigation (`Sec-Fetch-Mode: navigate` and
 * `Sec-Fetch-Dest: document`, which cannot read the response). Any other or duplicated
 * `Sec-Fetch-Site` value is refused too; absent headers (curl, scripts) and `same-origin` or
 * `none` pass.
 */
export function pageFetchAllowed(req: Req): boolean {
  const site = fetchHeader(req, "sec-fetch-site");
  if (site === undefined || site === "same-origin" || site === "none") return true;
  if (site === null || (site !== "cross-site" && site !== "same-site")) return false;
  return (
    fetchHeader(req, "sec-fetch-mode") === "navigate" &&
    fetchHeader(req, "sec-fetch-dest") === "document"
  );
}

/**
 * No-login mode, `GET /api/v1/status`: `Sec-Fetch-Site` must be absent (non-browser clients such as
 * `swain status`), `same-origin` or `none`. There is no navigation exception for JSON.
 */
export function statusFetchAllowed(req: Req): boolean {
  const site = fetchHeader(req, "sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}
