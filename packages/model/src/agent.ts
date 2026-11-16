/**
 * Agent identity (ADR-0005 section 3, r2 F5/F6). The first rule with evidence wins, and every key
 * is namespaced by its basis: the basis is its own length-prefixed component of `deriveSwainId`,
 * so equal values under different bases, or values containing `:` or `/`, can never collide.
 *
 * ID components after the project: `[basis, value...]`.
 * - 1 `cred`            `[name]`;            subagent under a pinned key: `cred-sub` `[name, type]`
 * - 2 `attr:gen_ai.agent.id` `[value]`
 * - 3 `attr:name`       `[value]`            (`gen_ai.agent.name` and `agent.name` share it)
 * - 4 `resource`        `[name]` (no namespace) or `resource-ns` `[namespace, name]`
 * - 5 `adr0002`         `[provider]`;        subagent: `adr0002-sub` `[provider, agentType]`
 * - 6 `none`            `["none"]`           the "unattributed" agent
 * Sub-keys are separate components rather than `name/sub:type` strings so that a pinned agent
 * named `A/sub:B` cannot forge the subagent `B` of agent `A` (ADR-0005 s.3 form kept in `key`).
 */
import { AtmError, REDACTION_MARK, redactTextExtended, sha256Hex } from "@swain/core";
import { identityOfAttribute } from "./identity.js";
import { deriveSwainId } from "./ids.js";
import { neutralizeText, truncateBytes } from "./policy/text.js";
import { deepFreeze, type PolicyKeyValue } from "./policy/types.js";

export const AGENT_KEY_BASES = [
  "cred",
  "cred-sub",
  "attr:gen_ai.agent.id",
  "attr:name",
  "resource",
  "resource-ns",
  "adr0002",
  "adr0002-sub",
  "none",
] as const;
export type AgentKeyBasis = (typeof AGENT_KEY_BASES)[number];

const MAX_KEY_VALUE_BYTES = 256;
const MAX_KEY_BYTES = 512;
const PROJECT_ID = /^prj_[0-9a-f]{32}$/;

export interface AgentEvidence {
  /** Rule 1: the ingest key's pinned agent name (`keys.agentName`). */
  readonly pinnedAgentName?: string | null;
  /** Rule 1, subagents seen under a pinned key. */
  readonly pinnedSubagentType?: string | null;
  /** Rules 2 and 3: span (or log record) attributes, post-policy. */
  readonly attributes?: readonly PolicyKeyValue[];
  /** Rule 4: resource attributes, post-policy. */
  readonly resourceAttributes?: readonly PolicyKeyValue[];
  /** Rule 5: ADR-0002 provider and, for subagents, the agent type. */
  readonly adr0002?: { readonly provider: string; readonly agentType?: string | null };
}

/**
 * One component of a `cred`, `cred-sub`, `adr0002` or `adr0002-sub` key: a short token or, for
 * anything else (spaces, `@`, a secret-shaped name, free text), `h:` plus the SHA-256 of the
 * normalized value. These keys therefore never carry free text (SPEC-003 hard condition 1).
 */
const KEY_PART = "(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|h:[0-9a-f]{64})";
/** The exact key format of each basis that the store cannot re-derive from the record itself. */
export const AGENT_KEY_FORMATS: Readonly<
  Record<"cred" | "cred-sub" | "adr0002" | "adr0002-sub", RegExp>
> = Object.freeze({
  cred: new RegExp(`^cred:${KEY_PART}$`),
  "cred-sub": new RegExp(`^cred:${KEY_PART}/sub:${KEY_PART}$`),
  adr0002: new RegExp(`^adr0002:${KEY_PART}$`),
  "adr0002-sub": new RegExp(`^adr0002:${KEY_PART}/${KEY_PART}$`),
});
const SIMPLE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * A full Swain ingest key (or a prefix of one that is long enough to matter). Text that merely
 * contains `swn_` is NOT refused: it is masked in displays and hashed in key parts (N1.5 G3 F2).
 */
const SWN_KEY = /swn_[0-9a-fA-F]{16}_[0-9a-fA-F]{8,}/g;
const SWN_KEY_TEST = /swn_[0-9a-fA-F]{16}_[0-9a-fA-F]{8,}/;

/** True when `s` contains a full-shaped Swain ingest key. `@swain/db` refuses such stored text. */
export function containsSwainKey(s: string): boolean {
  return typeof s === "string" && SWN_KEY_TEST.test(s);
}

function keyPart(value: string): string {
  if (SIMPLE_PART.test(value) && !SWN_KEY_TEST.test(value)) return value;
  return `h:${sha256Hex(new TextEncoder().encode(value))}`;
}

/** True when `key` has the exact format of `basis`. Bases the store re-derives are not covered. */
export function isAgentKeyFormat(basis: string, key: string): boolean {
  if (typeof key !== "string" || SWN_KEY_TEST.test(key)) return false;
  if (!Object.hasOwn(AGENT_KEY_FORMATS, basis)) return false;
  return (AGENT_KEY_FORMATS as Readonly<Record<string, RegExp>>)[basis]?.test(key) === true;
}

/** A display form: masked, neutralized, at most 256 bytes, never empty. Never used for identity. */
function displayOf(raw: string): string {
  const masked = redactTextExtended(raw.replace(SWN_KEY, REDACTION_MARK)).text;
  // Inputs are already `normalizeKeyValue`d (neutralized); neutralizing again would double-escape.
  const v = truncateBytes(masked.toWellFormed(), 256);
  return v === "" ? "unnamed" : v;
}

/** Separate from the policy registry, so an identity can never pass `isPolicyApplied`. */
const IDENTITIES = new WeakSet<object>();

/** Stamped by `deriveAgentIdentity`: frozen and registered, checked by `isAgentIdentity`. */
export interface AgentIdentity {
  readonly agentId: `agt_${string}`;
  readonly projectId: string;
  readonly keyBasis: AgentKeyBasis;
  /** `deriveSwainId` components after the project and basis (what the ID was derived from). */
  readonly components: readonly string[];
  /** Display name, derived with the identity (never taken from a caller). */
  readonly displayName: string;
  /** The ADR-0005 section 3 key form, for display and `agents.keyBasis` context. */
  readonly key: string;
  /**
   * F6: when a pinned key (rule 1) won, the identity the attributes claim, shown as
   * "sender claims agent X". `null` when the attributes name nobody.
   */
  readonly senderClaim: { readonly keyBasis: AgentKeyBasis; readonly key: string } | null;
}

/** Bound to 256 UTF-8 bytes and neutralize control characters; never trim or case-fold. */
export function normalizeKeyValue(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const v = truncateBytes(neutralizeText(raw.toWellFormed()), MAX_KEY_VALUE_BYTES);
  return v === "" ? null : v;
}

interface Candidate {
  readonly basis: AgentKeyBasis;
  /** `deriveSwainId` components after the basis; attribute-derived ones come from unmasked values. */
  readonly components: readonly string[];
  /** ADR-0005 section 3 key form for display (masked text for attribute-derived keys). */
  readonly key: string;
  readonly display: string;
}

function attributeCandidate(attrs: readonly PolicyKeyValue[] | undefined): Candidate | null {
  const id = identityOfAttribute(attrs, "gen_ai.agent.id");
  if (id !== null) {
    return {
      basis: "attr:gen_ai.agent.id",
      components: [id.part],
      key: `attr:gen_ai.agent.id:${id.display}`,
      display: id.display,
    };
  }
  const name =
    identityOfAttribute(attrs, "gen_ai.agent.name") ?? identityOfAttribute(attrs, "agent.name");
  if (name !== null) {
    return {
      basis: "attr:name",
      components: [name.part],
      key: `attr:name:${name.display}`,
      display: name.display,
    };
  }
  return null;
}

function pinnedCandidate(e: AgentEvidence): Candidate | null {
  if (e.pinnedAgentName === undefined || e.pinnedAgentName === null) return null;
  const name = normalizeKeyValue(e.pinnedAgentName);
  // A pinned key is authoritative: a present but empty name is a configuration error, never a
  // reason to fall back to what the sender claims (G3 F8).
  if (name === null) throw new AtmError("invalid-id-component");
  const sub =
    e.pinnedSubagentType === undefined || e.pinnedSubagentType === null
      ? null
      : normalizeKeyValue(e.pinnedSubagentType);
  if (sub !== null) {
    return {
      basis: "cred-sub",
      components: [name, sub],
      key: `cred:${keyPart(name)}/sub:${keyPart(sub)}`,
      display: displayOf(`${name}/${sub}`),
    };
  }
  return {
    basis: "cred",
    components: [name],
    key: `cred:${keyPart(name)}`,
    display: displayOf(name),
  };
}

function resourceCandidate(attrs: readonly PolicyKeyValue[] | undefined): Candidate | null {
  const name = identityOfAttribute(attrs, "service.name");
  if (name === null || name.display.startsWith("unknown_service")) return null;
  const ns = identityOfAttribute(attrs, "service.namespace");
  if (ns === null) {
    return {
      basis: "resource",
      components: [name.part],
      key: `resource:/${name.display}`,
      display: name.display,
    };
  }
  // The combined display is capped at 256 bytes. When the readable key would not fit the store's
  // 512-byte limit, the identity component is the hash form instead (never an error: one odd
  // record must not poison its batch, N1.5 G3 F2).
  const readable = `resource:${ns.display}/${name.display}`;
  const key =
    new TextEncoder().encode(readable).length <= MAX_KEY_BYTES
      ? readable
      : `resource:h:${sha256Hex(new TextEncoder().encode(`${ns.part.length}:${ns.part}${name.part}`))}`;
  return {
    basis: "resource-ns",
    components: [ns.part, name.part],
    key,
    display: truncateBytes(`${ns.display}/${name.display}`, 256),
  };
}

function adr0002Candidate(e: AgentEvidence): Candidate | null {
  if (e.adr0002 === undefined) return null;
  const provider = normalizeKeyValue(e.adr0002.provider);
  if (provider === null) return null;
  const type =
    e.adr0002.agentType === undefined || e.adr0002.agentType === null
      ? null
      : normalizeKeyValue(e.adr0002.agentType);
  if (type !== null) {
    return {
      basis: "adr0002-sub",
      components: [provider, type],
      key: `adr0002:${keyPart(provider)}/${keyPart(type)}`,
      display: displayOf(`${provider}/${type}`),
    };
  }
  return {
    basis: "adr0002",
    components: [provider],
    key: `adr0002:${keyPart(provider)}`,
    display: displayOf(provider),
  };
}

/** Derive the agent identity for one record, rules 1 to 6 in order (ADR-0005 section 3). */
export function deriveAgentIdentity(projectId: string, evidence: AgentEvidence): AgentIdentity {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    throw new AtmError("invalid-id-component");
  }
  const claim = attributeCandidate(evidence.attributes);
  const pinned = pinnedCandidate(evidence);
  const chosen: Candidate = pinned ??
    claim ??
    resourceCandidate(evidence.resourceAttributes) ??
    adr0002Candidate(evidence) ?? {
      basis: "none",
      components: ["none"],
      key: "none",
      display: "unattributed",
    };
  const agentId = deriveSwainId("agt", [
    projectId,
    chosen.basis,
    ...chosen.components,
  ]) as `agt_${string}`;
  const out: AgentIdentity = deepFreeze({
    agentId,
    projectId,
    keyBasis: chosen.basis,
    components: [...chosen.components],
    displayName: chosen.display === "" ? "unnamed" : chosen.display,
    key: chosen.key,
    senderClaim:
      pinned !== null && claim !== null
        ? deepFreeze({ keyBasis: claim.basis, key: claim.key })
        : null,
  });
  IDENTITIES.add(out);
  return out;
}

/**
 * True only for an identity `deriveAgentIdentity` produced (stamped, frozen) whose ID still equals
 * the derivation from its own parts and, for the four key-evidence bases, whose key has the exact
 * format of its basis. `@swain/db` calls this on every agent it stores.
 */
export function isAgentIdentity(v: unknown): v is AgentIdentity {
  if (typeof v !== "object" || v === null || !IDENTITIES.has(v)) return false;
  const a = v as AgentIdentity;
  try {
    if (a.agentId !== deriveSwainId("agt", [a.projectId, a.keyBasis, ...a.components]))
      return false;
  } catch {
    return false;
  }
  if (Object.hasOwn(AGENT_KEY_FORMATS, a.keyBasis) && !isAgentKeyFormat(a.keyBasis, a.key))
    return false;
  return SWN_KEY_TEST.test(a.displayName) === false;
}
