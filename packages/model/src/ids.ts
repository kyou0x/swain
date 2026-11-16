/**
 * Swain identifiers (ADR-0005 section 2). Same length-prefixed encoding as ADR-0002 section 6
 * `deriveId`, with its own domain string `"swain:v1:" + type`, so `deriveId` and its vectors are
 * untouched and the two ID spaces can never collide.
 */
import { createHash } from "node:crypto";
import { AtmError } from "@swain/core";

/** Derived Swain entities. `org`, `wsp` and `prj` IDs are random (ADR-0005 section 2), never derived. */
export const SWAIN_ID_TYPES = ["agt", "run", "sess", "edg"] as const;
export type SwainIdType = (typeof SWAIN_ID_TYPES)[number];

const MAX_COMPONENTS = 70;
const MAX_COMPONENT_BYTES = 4096;
const encoder = new TextEncoder();

function fail(): never {
  throw new AtmError("invalid-id-component");
}

/**
 * Input bytes = UTF-8(`"swain:v1:" + type`) 0x0A, then for each component
 * ASCII(decimal UTF-8 byte length) ":" UTF-8 bytes. Components are non-empty well-formed strings
 * (at most 4096 UTF-8 bytes) or non-negative safe integers (encoded as decimal strings); one to 70
 * of them. Output = `type_` + the first 32 lowercase hex characters of SHA-256(input).
 * Anything else throws `AtmError("invalid-id-component")`.
 */
export function deriveSwainId(
  type: SwainIdType,
  components: readonly (string | number)[],
): `${SwainIdType}_${string}` {
  if (!SWAIN_ID_TYPES.includes(type)) fail();
  if (!Array.isArray(components)) fail();
  if (components.length < 1 || components.length > MAX_COMPONENTS) fail();
  const hash = createHash("sha256");
  hash.update(encoder.encode(`swain:v1:${type}\n`));
  for (const c of components) {
    let s: string;
    if (typeof c === "number") {
      if (!Number.isSafeInteger(c) || c < 0) fail();
      s = String(c);
    } else if (typeof c === "string") {
      if (c.length === 0 || !c.isWellFormed() || c.length > MAX_COMPONENT_BYTES) fail();
      s = c;
    } else {
      return fail();
    }
    const body = encoder.encode(s);
    if (body.length > MAX_COMPONENT_BYTES) fail();
    hash.update(encoder.encode(`${body.length}:`));
    hash.update(body);
  }
  return `${type}_${hash.digest("hex").slice(0, 32)}`;
}
