/**
 * Identity and grouping values (ADR-0005 section 3 note, G3 B2): an agent key, a session or
 * conversation value is never derived from masked text. The applier records, for identity keys,
 * `identity` = the received value when masking left it unchanged, else `"h:" + sha256(received)`.
 * An `IdentityValue` can only be built from that applier output (or from an unmasked ADR-0002
 * ID), and every identity-consuming function demands one, so a caller cannot pass post-mask text.
 * The original value is never stored; only this component enters `deriveSwainId`.
 */
import { AtmError } from "@swain/core";
import { neutralizeText, truncateBytes } from "./policy/text.js";
import type { PolicyKeyValue } from "./policy/types.js";

export declare const IDENTITY_VALUE: unique symbol;

export interface IdentityValueFields {
  /** The `deriveSwainId` component: unmasked value or `h:<sha256>`, control characters neutralized. */
  readonly part: string;
  /** Display form (masked, bounded to 256 bytes). Never used for identity. */
  readonly display: string;
}
export type IdentityValue = IdentityValueFields & { readonly [IDENTITY_VALUE]: true };

const MADE = new WeakSet<object>();

function make(part: string, display: string): IdentityValue | null {
  if (part === "") return null;
  const v: IdentityValueFields = Object.freeze({
    part: neutralizeText(part.toWellFormed()),
    display: truncateBytes(neutralizeText(display.toWellFormed()), 256),
  });
  MADE.add(v);
  return v as IdentityValue;
}

/** From a post-policy attribute list. `null` when absent, empty, or not a kept string. */
export function identityOfAttribute(
  attrs: readonly PolicyKeyValue[] | undefined,
  key: string,
): IdentityValue | null {
  const kv = attrs?.find((a) => a.key === key);
  if (kv === undefined || kv.value.kind !== "text") return null;
  if (kv.value.identity === undefined) return null;
  return make(kv.value.identity, kv.value.value);
}

/** An ADR-0002 `sessionId` (never masked: it is an ID produced by `deriveId`). */
export function identityOfAdr0002(raw: string): IdentityValue | null {
  if (typeof raw !== "string") return null;
  return make(raw, raw);
}

export function isIdentityValue(v: unknown): v is IdentityValue {
  return typeof v === "object" && v !== null && MADE.has(v);
}

export function requireIdentity(v: unknown): IdentityValue {
  if (!isIdentityValue(v)) throw new AtmError("invalid-option");
  return v;
}
