/**
 * HMAC-SHA256 (RFC 2104) built on `createHash` (the client's policy allows no `createHmac`), the
 * length-prefixed encoding of ADR-0006 section 8, and a comparison whose time does not depend on
 * where the inputs differ (`timingSafeEqual` is not on the client's allowlist).
 */
import { createHash } from "node:crypto";

const BLOCK = 64;
const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** `ASCII(decimal byte length) ":" UTF-8 bytes`. */
export function lp(s: string): Uint8Array {
  const body = encoder.encode(s);
  return concat(encoder.encode(`${body.length}:`), body);
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = new Uint8Array(BLOCK);
  k.set(key.length > BLOCK ? sha256(key) : key);
  const ipad = k.map((b) => b ^ 0x36);
  const opad = k.map((b) => b ^ 0x5c);
  return sha256(concat(opad, sha256(concat(ipad, message))));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Lowercase hex of even length to bytes; `null` for anything else. */
export function fromHex(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Equal length and equal bytes, visiting every byte regardless of the first difference. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The proof of ADR-0006 section 8, step 4, as lowercase hex. */
export function serverProofHex(
  proofKeyHex: string,
  origin: string,
  instanceId: string,
  challenge: string,
): string | null {
  const key = fromHex(proofKeyHex);
  if (key === null || key.length !== 32) return null;
  return toHex(
    hmacSha256(key, concat(lp("swain:v1:server-proof"), lp(origin), lp(instanceId), lp(challenge))),
  );
}

/** The owner proof of G3-auth B2 (label `swain:v1:owner-proof`), as lowercase hex. */
export function ownerProofHex(
  ownerKeyHex: string,
  origin: string,
  instanceId: string,
  challenge: string,
): string | null {
  const key = fromHex(ownerKeyHex);
  if (key === null || key.length !== 32) return null;
  return toHex(
    hmacSha256(key, concat(lp("swain:v1:owner-proof"), lp(origin), lp(instanceId), lp(challenge))),
  );
}
