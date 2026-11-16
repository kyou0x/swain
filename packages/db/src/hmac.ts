/**
 * HMAC-SHA256 and length-prefixed encoding for the server proof (ADR-0006 section 8). `@swain/db`
 * may import only `createHash` from `node:crypto`, so HMAC (RFC 2104) is built on it.
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

/** `ASCII(decimal byte length) ":" UTF-8 bytes` (the ADR-0002 section 6 style). */
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
