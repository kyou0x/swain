import { createHash } from "node:crypto";
import { AtmError } from "../errors.js";
import { utf8ByteLength } from "../text/index.js";

export const ID_TYPES = ["src", "ses", "trn", "evt", "act", "tc"] as const;
export type IdType = (typeof ID_TYPES)[number];

const MAX_COMPONENTS = 70;
const MAX_COMPONENT_BYTES = 4096;
const encoder = new TextEncoder();

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(): never {
  throw new AtmError("invalid-id-component");
}

/**
 * ADR-0002 section 6. Input bytes are UTF-8("atm:v0:" + type) 0x0A, then for
 * each component ASCII(decimal UTF-8 byte length) ":" UTF-8 bytes. Output is
 * `type_` + first 32 hex chars of SHA-256.
 */
export function deriveId(type: IdType, components: readonly (string | number)[]): string {
  if (!ID_TYPES.includes(type)) fail();
  if (!Array.isArray(components)) fail();
  if (components.length < 1 || components.length > MAX_COMPONENTS) fail();
  const parts: Uint8Array[] = [encoder.encode(`atm:v0:${type}\n`)];
  for (const c of components) {
    let s: string;
    if (typeof c === "number") {
      if (!Number.isSafeInteger(c) || c < 0) fail();
      s = String(c);
    } else if (typeof c === "string") {
      if (c.length === 0 || !c.isWellFormed()) fail();
      if (c.length > MAX_COMPONENT_BYTES || utf8ByteLength(c) > MAX_COMPONENT_BYTES) fail();
      s = c;
    } else {
      return fail();
    }
    const body = encoder.encode(s);
    parts.push(encoder.encode(`${body.length}:`), body);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return `${type}_${sha256Hex(buf).slice(0, 32)}`;
}
