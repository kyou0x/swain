/**
 * The Swain HTTP client (SPEC-003 section 4, ADR-0006 section 8, S18).
 *
 * The client authenticates the server BEFORE it sends a key:
 *  1. `POST /api/v1/server-proof` with `{ keyId, challenge }` (32 random bytes in hex). No key is sent.
 *  2. The server answers `{ origin, instanceId, proof }`. The client recomputes
 *     `HMAC-SHA256(serverProofKey, lp("swain:v1:server-proof") || lp(origin) || lp(instanceId) ||
 *     lp(challenge))` from the credential file and compares in constant time. The origin must be
 *     the credential's own, and, when a runtime file pins an `instanceId`, that one.
 *  3. Only then is the `Authorization` header sent, and only to the credential's recorded origin.
 *
 * A failed proof is `server-unauthenticated` and the key never leaves the process. Every request is
 * a single attempt with a 2 s timeout and no redirect following.
 */
import { randomBytes } from "node:crypto";
import type { Credential } from "./credentials.js";
import { ClientError } from "./errors.js";
import { constantTimeEqual, fromHex, ownerProofHex, serverProofHex, toHex } from "./hmac.js";
import { Channel, type HttpResult, httpExchange, parseJsonBody } from "./http.js";

const encoder = new TextEncoder();
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** `GET /healthz`: true for a 200 JSON object with `ok: true` (other fields such as `webAuth` are ignored here). Unreachable is an error, not false. */
export async function checkHealth(origin: string): Promise<boolean> {
  const r = await httpExchange(origin, "GET", "/healthz");
  const v = parseJsonBody(r.body);
  return (
    r.status === 200 &&
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>)["ok"] === true
  );
}

/**
 * The web access mode a healthy server advertises in `GET /healthz`: `none` only when the answer
 * says exactly `"webAuth":"none"`. Anything else (an older server, a missing or odd field) is
 * `login`, the conservative reading. Not secret and not authenticated: a wrong answer can at most
 * make the caller print a plain URL (nothing secret) or ask for the owner proof (which then fails).
 */
export async function healthWebAuth(origin: string): Promise<"none" | "login"> {
  const r = await httpExchange(origin, "GET", "/healthz");
  const v = parseJsonBody(r.body);
  const m =
    r.status === 200 && typeof v === "object" && v !== null
      ? (v as Record<string, unknown>)["webAuth"]
      : undefined;
  return m === "none" ? "none" : "login";
}

/** The verified identity of a server instance. */
export interface ServerIdentity {
  readonly origin: string;
  readonly instanceId: string;
}

/**
 * The server-proof handshake. `pinnedInstanceId` comes from the runtime file when one exists for
 * this origin. Resolves only when the proof is valid.
 */
export async function authenticateServer(
  cred: Credential,
  pinnedInstanceId: string | null,
  channel?: Channel,
): Promise<ServerIdentity> {
  const challenge = toHex(randomBytes(32));
  const r = await httpExchange(cred.origin, "POST", "/api/v1/server-proof", {
    headers: JSON_HEADERS,
    body: encoder.encode(JSON.stringify({ keyId: cred.keyId, challenge })),
    ...(channel === undefined ? {} : { channel }),
  });
  if (r.status !== 200) throw new ClientError("server-unauthenticated");
  const v = parseJsonBody(r.body);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ClientError("server-unauthenticated");
  }
  const { origin, instanceId, proof } = v as Record<string, unknown>;
  if (
    origin !== cred.origin ||
    typeof instanceId !== "string" ||
    !HEX32.test(instanceId) ||
    typeof proof !== "string" ||
    !HEX64.test(proof) ||
    (pinnedInstanceId !== null && instanceId !== pinnedInstanceId)
  ) {
    throw new ClientError("server-unauthenticated");
  }
  const expected = serverProofHex(cred.serverProofKey, cred.origin, instanceId, challenge);
  const a = expected === null ? null : fromHex(expected);
  const b = fromHex(proof);
  if (a === null || b === null || !constantTimeEqual(a, b)) {
    throw new ClientError("server-unauthenticated");
  }
  return { origin: cred.origin, instanceId };
}

export interface ProjectStatusReport {
  readonly projectId: string;
  readonly slug: string;
  readonly agents: number;
  readonly runs: number;
  readonly lastIngestMs: number | null;
  readonly batches24h: {
    readonly accepted: number;
    readonly partial: number;
    readonly rejected: number;
  };
  readonly contentPolicy: string;
  readonly rawRetention: string;
}

export interface StatusReport {
  readonly server: {
    readonly version: string;
    readonly canonicalSchema: string;
    readonly dbSchema: number;
    readonly mode: string;
    readonly bind: string;
  };
  readonly projects: readonly ProjectStatusReport[];
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function nat(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Re-validate `/api/v1/status` at the boundary; anything else is `server-rejected`. */
export function parseStatus(v: unknown): StatusReport {
  const o = obj(v);
  const s = obj(o?.["server"]);
  const list = o?.["projects"];
  if (
    s === null ||
    typeof s["version"] !== "string" ||
    typeof s["canonicalSchema"] !== "string" ||
    !nat(s["dbSchema"]) ||
    typeof s["mode"] !== "string" ||
    typeof s["bind"] !== "string" ||
    !Array.isArray(list) ||
    list.length > 1000
  ) {
    throw new ClientError("server-rejected");
  }
  const projects = list.map((p): ProjectStatusReport => {
    const q = obj(p);
    const b = obj(q?.["batches24h"]);
    const last = q?.["lastIngestMs"];
    if (
      q === null ||
      b === null ||
      typeof q["projectId"] !== "string" ||
      typeof q["slug"] !== "string" ||
      !nat(q["agents"]) ||
      !nat(q["runs"]) ||
      !(last === null || nat(last)) ||
      !nat(b["accepted"]) ||
      !nat(b["partial"]) ||
      !nat(b["rejected"]) ||
      typeof q["contentPolicy"] !== "string" ||
      typeof q["rawRetention"] !== "string"
    ) {
      throw new ClientError("server-rejected");
    }
    return {
      projectId: q["projectId"],
      slug: q["slug"],
      agents: q["agents"],
      runs: q["runs"],
      lastIngestMs: last,
      batches24h: { accepted: b["accepted"], partial: b["partial"], rejected: b["rejected"] },
      contentPolicy: q["contentPolicy"],
      rawRetention: q["rawRetention"],
    };
  });
  return {
    server: {
      version: s["version"],
      canonicalSchema: s["canonicalSchema"],
      dbSchema: s["dbSchema"],
      mode: s["mode"],
      bind: s["bind"],
    },
    projects,
  };
}

function bearer(cred: Credential): Record<string, string> {
  return { Authorization: `Bearer ${cred.secret}` };
}

function judge(r: HttpResult): HttpResult {
  if (r.status === 401) throw new ClientError("server-unauthenticated");
  if (r.status < 200 || r.status > 299) throw new ClientError("server-rejected");
  return r;
}

/** Authenticate the server, then `GET /api/v1/status` with the key. */
export async function fetchStatus(
  cred: Credential,
  pinnedInstanceId: string | null,
): Promise<{ readonly identity: ServerIdentity; readonly status: StatusReport }> {
  // proof and key share one connection (G3-auth F3)
  const channel = new Channel();
  try {
    const identity = await authenticateServer(cred, pinnedInstanceId, channel);
    const r = judge(
      await httpExchange(cred.origin, "GET", "/api/v1/status", {
        headers: bearer(cred),
        channel,
      }),
    );
    const v = parseJsonBody(r.body);
    if (v === undefined) throw new ClientError("server-rejected");
    return { identity, status: parseStatus(v) };
  } finally {
    channel.close();
  }
}

/** Authenticate the server, then POST an OTLP/HTTP JSON export (`http/json` only). */
export async function sendOtlpJson(
  cred: Credential,
  signal: "traces" | "logs",
  body: Uint8Array,
  pinnedInstanceId: string | null,
): Promise<{ readonly status: number }> {
  const channel = new Channel();
  let r: HttpResult;
  try {
    await authenticateServer(cred, pinnedInstanceId, channel);
    r = judge(
      await httpExchange(cred.origin, "POST", `/v1/${signal}`, {
        headers: { ...bearer(cred), ...JSON_HEADERS },
        body,
        channel,
      }),
    );
  } finally {
    channel.close();
  }
  return { status: r.status };
}

/**
 * The owner proof (G3-auth B2): before `swain open` writes a login code, it checks that the
 * listener at `origin` shares this machine's database. The owner key (derived from the server
 * secret in the database the CLI itself opened) never leaves the process; the server answers a
 * fresh challenge with an HMAC under a label distinct from the key-bound server proof.
 * Resolves only for a valid proof, for exactly `origin`, and for `pinnedInstanceId` when given.
 */
export async function authenticateOwner(
  origin: string,
  ownerKeyHex: string,
  pinnedInstanceId: string | null,
): Promise<ServerIdentity> {
  const challenge = toHex(randomBytes(32));
  const r = await httpExchange(origin, "POST", "/api/v1/server-proof", {
    headers: JSON_HEADERS,
    body: encoder.encode(JSON.stringify({ purpose: "owner", challenge })),
  });
  if (r.status !== 200) throw new ClientError("server-unauthenticated");
  const v = parseJsonBody(r.body);
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ClientError("server-unauthenticated");
  }
  const { origin: said, instanceId, proof } = v as Record<string, unknown>;
  if (
    said !== origin ||
    typeof instanceId !== "string" ||
    !HEX32.test(instanceId) ||
    typeof proof !== "string" ||
    !HEX64.test(proof) ||
    (pinnedInstanceId !== null && instanceId !== pinnedInstanceId)
  ) {
    throw new ClientError("server-unauthenticated");
  }
  const expected = ownerProofHex(ownerKeyHex, origin, instanceId, challenge);
  const a = expected === null ? null : fromHex(expected);
  const b = fromHex(proof);
  if (a === null || b === null || !constantTimeEqual(a, b)) {
    throw new ClientError("server-unauthenticated");
  }
  return { origin, instanceId };
}
