/**
 * Ingest-key authentication from headers only (ADR-0006 section 7).
 *
 * Format `swn_<16 lowercase hex key ID>_<64 lowercase hex secret>`. Only `sha256` of the secret
 * (with the domain prefix, `hashKeySecret`) is stored. The stored and the presented digests are
 * compared with `timingSafeEqual`. An unknown key ID is compared against a fixed dummy digest so
 * that "no such key" and "wrong secret" cost the same. Revoked and expired keys are refused on
 * the very next request: there is no cache.
 */
import { timingSafeEqual } from "node:crypto";
import { hashKeySecret, type KeyAuthRecord, type KeyId, type SwainStore } from "@swain/db";

const KEY_RE = /^swn_([0-9a-f]{16})_([0-9a-f]{64})$/;
const BEARER = /^bearer /i;
const DUMMY_DIGEST = "0".repeat(64);

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The secret of a well-formed `Authorization: Bearer swn_...` value, or null. */
export function parseBearerKey(
  header: string | undefined,
): { keyId: KeyId; secret: string } | null {
  if (typeof header !== "string" || !BEARER.test(header)) return null;
  const secret = header.slice("Bearer ".length);
  const m = KEY_RE.exec(secret);
  if (m === null || m[1] === undefined) return null;
  return { keyId: `key_${m[1]}`, secret };
}

export type AuthResult =
  | { readonly ok: true; readonly key: KeyAuthRecord }
  | { readonly ok: false };

/**
 * `ok: false` for every failure: malformed, unknown, wrong secret, revoked, expired. The caller
 * answers all of them with the same static 401.
 */
export function authenticate(
  store: SwainStore,
  header: string | undefined,
  nowMs: number,
): AuthResult {
  const parsed = parseBearerKey(header);
  if (parsed === null) return { ok: false };
  const record = store.findKey(parsed.keyId);
  const stored = record === null ? DUMMY_DIGEST : record.secretSha256;
  const presented = hashKeySecret(parsed.secret);
  const equal = timingSafeEqual(hexBytes(stored), hexBytes(presented));
  if (record === null || !equal) return { ok: false };
  if (record.revokedAtMs !== null) return { ok: false };
  if (record.expiresAtMs !== null && record.expiresAtMs <= nowMs) return { ok: false };
  return { ok: true, key: record };
}
