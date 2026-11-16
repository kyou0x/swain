/**
 * Credential files (ADR-0006 section 8.1) and the origin rules (ADR-0007 section 1).
 *
 * `$XDG_CONFIG_HOME/swain/credentials/<project>.key`: directory 0700, file `wx | O_NOFOLLOW` 0600,
 * `{ format, origin, keyId, secret, serverProofKey, projectSlug, agentName?, createdAt }`. A
 * credential is bound to the origin it was issued for and is never used for another.
 */
import { join } from "node:path";
import { ClientError } from "./errors.js";
import {
  ensurePrivateDir,
  entryExists,
  readPrivateFile,
  removeFile,
  writeNewPrivateFile,
} from "./fs.js";

export const CREDENTIAL_FORMAT = "swain.credential/1" as const;
const MAX_CREDENTIAL_BYTES = 8192;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_RE = /^swn_([0-9a-f]{16})_[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ORIGIN_RE = /^http:\/\/(127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;

export interface Credential {
  readonly format: typeof CREDENTIAL_FORMAT;
  readonly origin: string;
  readonly keyId: `key_${string}`;
  readonly secret: string;
  readonly serverProofKey: string;
  readonly projectSlug: string;
  readonly agentName?: string;
  readonly createdAt: string;
}

/**
 * A server origin: `http://127.0.0.1:<port>` or `http://[::1]:<port>`, literal IPs only, port 1 to
 * 65535 without leading zeros. Nothing else (no name, path, userinfo or other scheme) is accepted.
 */
export function parseOrigin(s: unknown): {
  origin: string;
  host: "127.0.0.1" | "::1";
  port: number;
} {
  if (typeof s !== "string") throw new ClientError("invalid-origin");
  const m = ORIGIN_RE.exec(s);
  if (m === null) throw new ClientError("invalid-origin");
  const digits = m[2] ?? "";
  const port = Number(digits);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== digits) {
    throw new ClientError("invalid-origin");
  }
  return { origin: s, host: m[1] === "::1" || m[1] === "[::1]" ? "::1" : "127.0.0.1", port };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the purpose
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function plainText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= max && !CONTROL_RE.test(v);
}

/** Strict parse of a credential file; any deviation is `credential-invalid`. */
export function parseCredential(text: string): Credential {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ClientError("credential-invalid");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ClientError("credential-invalid");
  const o = v as Record<string, unknown>;
  const allowed = new Set([
    "format",
    "origin",
    "keyId",
    "secret",
    "serverProofKey",
    "projectSlug",
    "agentName",
    "createdAt",
  ]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new ClientError("credential-invalid");
  const secret = o["secret"];
  const m = typeof secret === "string" ? SECRET_RE.exec(secret) : null;
  const agent = o["agentName"];
  if (
    o["format"] !== CREDENTIAL_FORMAT ||
    m === null ||
    o["keyId"] !== `key_${m[1]}` ||
    typeof o["serverProofKey"] !== "string" ||
    !HEX64.test(o["serverProofKey"]) ||
    typeof o["projectSlug"] !== "string" ||
    !SLUG_RE.test(o["projectSlug"]) ||
    !plainText(o["createdAt"], 40) ||
    (agent !== undefined && !plainText(agent, 128))
  ) {
    throw new ClientError("credential-invalid");
  }
  const origin = parseOrigin(o["origin"]).origin;
  return {
    format: CREDENTIAL_FORMAT,
    origin,
    keyId: o["keyId"] as `key_${string}`,
    secret: secret as string,
    serverProofKey: o["serverProofKey"],
    projectSlug: o["projectSlug"],
    ...(agent === undefined ? {} : { agentName: agent as string }),
    createdAt: o["createdAt"],
  };
}

export function credentialsDir(configBase: string): string {
  return join(configBase, "swain", "credentials");
}

export function credentialPath(configBase: string, projectSlug: string): string {
  if (!SLUG_RE.test(projectSlug)) throw new ClientError("credential-invalid");
  return join(credentialsDir(configBase), `${projectSlug}.key`);
}

/** True when a credential file (or anything else) already occupies the project's path. */
export function credentialExists(configBase: string, projectSlug: string): boolean {
  return entryExists(credentialPath(configBase, projectSlug));
}

/** Write the credential file: 0700 directories, `wx | O_NOFOLLOW` 0600. Never overwrites. */
export function saveCredential(configBase: string, cred: Credential, uid: number): string {
  parseCredential(JSON.stringify(cred));
  ensurePrivateDir(join(configBase, "swain"), uid);
  ensurePrivateDir(credentialsDir(configBase), uid);
  const path = credentialPath(configBase, cred.projectSlug);
  const body = JSON.stringify({
    format: cred.format,
    origin: cred.origin,
    keyId: cred.keyId,
    secret: cred.secret,
    serverProofKey: cred.serverProofKey,
    projectSlug: cred.projectSlug,
    ...(cred.agentName === undefined ? {} : { agentName: cred.agentName }),
    createdAt: cred.createdAt,
  });
  writeNewPrivateFile(path, new TextEncoder().encode(`${body}\n`));
  return path;
}

/** Remove a credential file we just wrote (used to roll back when the key could not be kept). */
export function discardCredential(configBase: string, projectSlug: string): void {
  removeFile(credentialPath(configBase, projectSlug));
}

/** Load and validate the credential of a project; `credential-missing` when there is none. */
export function loadCredential(configBase: string, projectSlug: string, uid: number): Credential {
  const dir = credentialsDir(configBase);
  const bytes = readPrivateFile(credentialPath(configBase, projectSlug), uid, MAX_CREDENTIAL_BYTES);
  if (bytes === null) throw new ClientError("credential-missing");
  void dir;
  const cred = parseCredential(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  if (cred.projectSlug !== projectSlug) throw new ClientError("credential-invalid");
  return cred;
}

/**
 * The origin to use with a credential: a requested origin (flag or `SWAIN_SERVER_URL`) must equal
 * the credential's recorded one, else `credential-origin-mismatch` (exit 2).
 */
export function originFor(cred: Credential, requested: string | null): string {
  if (requested !== null && parseOrigin(requested).origin !== cred.origin) {
    throw new ClientError("credential-origin-mismatch");
  }
  return cred.origin;
}
