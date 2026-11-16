/**
 * Boundary validation of adapter drafts (SPEC-002 section 3.4 steps 5 to 7). A draft that does
 * not pass becomes an `adapter-output-invalid` gap in the caller; nothing from it is kept.
 */
import { deriveId } from "../ids/index.js";
import { EVENT_KINDS, SCHEMA_VERSION } from "../schema/constants.js";
import type { EventKind, LinkRel } from "../schema/types.js";
import { truncateCodePoints, truncateUtf8, utf8ByteLength } from "../text/index.js";
import { validateEvent } from "../validate/index.js";
import type { Env, InvalidReason, Pending } from "./types.js";
import { isPlainObject } from "./warnings.js";

export const PLACEHOLDER_EVENT_ID = `evt_${"0".repeat(32)}`;

const DRAFT_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "providerVersion",
  "time",
  "actor",
  "status",
  "payload",
  "completeness",
  "attributes",
  "pointer",
  "nativeSessionId",
  "nativeTurnKey",
  "actorKey",
  "recordRef",
  "correlation",
]);

const TC_FIELDS: Partial<Record<EventKind, readonly string[]>> = {
  "tool.requested": ["toolCallId"],
  "tool.completed": ["toolCallId"],
  "tool.failed": ["toolCallId"],
  "permission.requested": ["toolCallId"],
  "agent.started": ["spawnedByToolCallId"],
  "file.changed": ["viaToolCallId"],
};
const ACT_FIELDS: Partial<Record<EventKind, readonly { f: string; nullable: boolean }[]>> = {
  "agent.started": [
    { f: "agentActorId", nullable: false },
    { f: "parentActorId", nullable: true },
  ],
  "agent.ended": [{ f: "agentActorId", nullable: false }],
};

const ADAPTER_REL_KINDS: Readonly<Record<string, readonly EventKind[]>> = {
  "result-of": ["tool.completed", "tool.failed"],
  decides: ["permission.decided"],
  "spawned-by": ["agent.started"],
  ends: ["turn.ended", "agent.ended", "session.ended"],
};
const MAX_ANCHOR_BYTES = 1024;
const MAX_POINTER_BYTES = 512;

export type DraftOutcome =
  | { readonly ok: true; readonly pending: Pending }
  | {
      readonly ok: false;
      readonly reason: InvalidReason;
      /** Validator issue code (closed set) for `invalid-event`. */
      readonly issue?: string;
      /** The draft used an attribute key outside the manifest allowlist. */
      readonly attribute?: boolean;
    };

const bad = (reason: InvalidReason): DraftOutcome => ({ ok: false, reason });

function copyOwn(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    Object.defineProperty(out, k, {
      value: o[k],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function nativeKey(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && v.isWellFormed() && utf8ByteLength(v) <= 4096
    ? v
    : undefined;
}

function composePointer(base: string | null, pointer: string | null): string | null {
  const joined = pointer === null ? base : base === null ? pointer : base + pointer;
  if (joined === null) return null;
  return utf8ByteLength(joined) > MAX_POINTER_BYTES ? null : joined;
}

/** Sorted, bounded top-level keys of a parsed record (PA-3). */
export function topLevelKeys(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const keys = Object.keys(value).map((k) => truncateCodePoints(k.toWellFormed(), 64).text);
  keys.sort();
  return keys.slice(0, 32);
}

function mapIds(kind: EventKind, payload: Record<string, unknown>, env: Env): boolean {
  try {
    for (const f of TC_FIELDS[kind] ?? []) {
      const v = payload[f];
      if (v === undefined || v === null) continue;
      const key = nativeKey(v);
      if (key === undefined) return false;
      payload[f] = deriveId("tc", [env.provider, env.sourceId, key]);
    }
    for (const { f, nullable } of ACT_FIELDS[kind] ?? []) {
      const v = payload[f];
      if (v === undefined) continue;
      if (v === null) {
        if (nullable) continue;
        return false;
      }
      const key = nativeKey(v);
      if (key === undefined) return false;
      payload[f] = deriveId("act", [env.provider, env.sessionId, key]);
    }
  } catch {
    return false;
  }
  return true;
}

function contentPolicyViolation(payload: Record<string, unknown>, env: Env): InvalidReason | null {
  for (const k of Object.keys(payload)) {
    const v = payload[k];
    if (!isPlainObject(v) || !Object.hasOwn(v, "retention")) continue;
    const retention = v["retention"];
    if (retention === "hash-only") continue;
    if (env.policy.retention === "hash-only") return "inline-under-hash-only";
    const inline = v["inline"];
    if (typeof inline === "string" && utf8ByteLength(inline) > env.policy.maxInlineBytes) {
      return "inline-too-large";
    }
  }
  return null;
}

/**
 * Validate one raw draft. `cur` is the highest `sourceSequence` the draft may refer to;
 * `defaultRef` is the record a draft without `recordRef` belongs to (`null` in `end()`).
 */
export function normalizeDraft(
  raw: unknown,
  env: Env,
  cur: number,
  defaultRef: number | null,
  emit: number,
): DraftOutcome {
  if (!isPlainObject(raw)) return bad("not-object");
  const d = raw;
  for (const k of Object.keys(d)) if (!DRAFT_KEYS.has(k)) return bad("unknown-field");

  const kind = d["kind"];
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    return bad("bad-kind");
  }
  const k = kind as EventKind;

  // recordRef: required in end(), default to the current record in push.
  let order: number;
  let evidence: number;
  const ref = d["recordRef"];
  if (ref === undefined) {
    if (defaultRef === null) return bad("bad-record-ref");
    order = defaultRef;
    evidence = defaultRef;
  } else {
    if (!isPlainObject(ref) || Object.keys(ref).length !== 2) return bad("bad-record-ref");
    const o = ref["order"];
    const e = ref["evidence"];
    if (typeof o !== "number" || typeof e !== "number") return bad("bad-record-ref");
    order = o;
    evidence = e;
  }
  for (const x of [order, evidence]) {
    if (!Number.isSafeInteger(x) || x < 0 || x > cur) return bad("bad-record-ref");
    if (env.recs[x]?.parse.ok !== true) return bad("bad-record-ref");
  }

  const actorKey = nativeKey(d["actorKey"]);
  if (actorKey === undefined) return bad("bad-id-key");
  let actorId: string;
  try {
    actorId = deriveId("act", [env.provider, env.sessionId, actorKey]);
  } catch {
    return bad("bad-id-key");
  }
  const actor = d["actor"];
  if (!isPlainObject(actor) || Object.keys(actor).length !== 1 || !Object.hasOwn(actor, "role")) {
    return bad("unknown-field");
  }

  const nativeTurnKey = d["nativeTurnKey"];
  let turnKey: string | undefined;
  if (nativeTurnKey !== undefined) {
    turnKey = nativeKey(nativeTurnKey);
    if (turnKey === undefined) return bad("bad-id-key");
  }

  const pointer = d["pointer"];
  if (pointer !== null && typeof pointer !== "string") return bad("bad-pointer");
  if (typeof pointer === "string" && pointer !== "" && !pointer.startsWith("/")) {
    return bad("bad-pointer");
  }

  let anchor: string | undefined;
  const refs: { rel: LinkRel; key: string }[] = [];
  const corr = d["correlation"];
  if (corr !== undefined) {
    if (!isPlainObject(corr)) return bad("bad-correlation");
    for (const ck of Object.keys(corr))
      if (ck !== "anchor" && ck !== "refs") return bad("bad-correlation");
    const a = corr["anchor"];
    if (a !== undefined) {
      if (typeof a !== "string" || a.length === 0 || !a.isWellFormed())
        return bad("bad-correlation");
      if (utf8ByteLength(a) > MAX_ANCHOR_BYTES) return bad("bad-correlation");
      anchor = a;
    }
    const rs = corr["refs"];
    if (rs !== undefined) {
      if (!Array.isArray(rs) || rs.length > 4) return bad("bad-correlation");
      for (const r of rs as unknown[]) {
        if (!isPlainObject(r) || Object.keys(r).length !== 2) return bad("bad-correlation");
        const rel = r["rel"];
        const key = r["key"];
        const allowed = typeof rel === "string" ? ADAPTER_REL_KINDS[rel] : undefined;
        if (allowed === undefined || !allowed.includes(k)) return bad("bad-correlation");
        if (typeof key !== "string" || key.length === 0 || !key.isWellFormed()) {
          return bad("bad-correlation");
        }
        if (utf8ByteLength(key) > MAX_ANCHOR_BYTES) return bad("bad-correlation");
        refs.push({ rel: rel as LinkRel, key });
      }
    }
  }

  const attributes = d["attributes"];
  if (!isPlainObject(attributes)) return bad("bad-attributes");
  for (const ak of Object.keys(attributes)) {
    if (!env.attributeKeys.has(ak)) return { ok: false, reason: "bad-attributes", attribute: true };
  }

  const rawPayload = d["payload"];
  if (!isPlainObject(rawPayload)) return bad("bad-output");
  let payload = copyOwn(rawPayload);
  if (!mapIds(k, payload, env)) return bad("bad-id-key");
  const policy = contentPolicyViolation(payload, env);
  if (policy !== null) return bad(policy);

  const evRec = env.recs[evidence];
  if (evRec === undefined) return bad("bad-record-ref");
  if (k === "source.unknown") {
    const nativeType = payload["nativeType"];
    payload = {
      nativeType:
        typeof nativeType === "string" && nativeType.isWellFormed()
          ? truncateUtf8(nativeType, 256).text
          : null,
      topLevelKeys: topLevelKeys(evRec.parse.ok ? evRec.parse.value : null),
      recordSha256: evRec.sha256,
    };
  }

  const finalPointer = composePointer(env.recordBase[evidence] ?? null, pointer);
  const probe = {
    schemaVersion: SCHEMA_VERSION,
    eventId: PLACEHOLDER_EVENT_ID,
    kind: k,
    provider: env.provider,
    providerVersion: d["providerVersion"],
    sourceKind: env.sourceKind,
    sessionId: env.sessionId,
    turnId: null,
    sourceSequence: order,
    subIndex: 0,
    time: d["time"],
    actor: { actorId, role: actor["role"] },
    status: d["status"],
    payload,
    links: [],
    provenance: {
      type: "record",
      sourceId: env.sourceId,
      line: evRec.line,
      byteOffset: evRec.byteOffset,
      byteLength: evRec.byteLength,
      sha256: evRec.sha256,
      pointer: finalPointer,
      adapter: { id: env.manifest.id, version: env.manifest.adapterVersion },
    },
    completeness: d["completeness"],
    attributes,
  };
  const v = validateEvent(probe);
  if (!v.ok) return { ok: false, reason: "invalid-event", issue: v.issues[0]?.code ?? "internal" };
  const e = v.event;
  return {
    ok: true,
    pending: {
      order,
      evidence,
      emit,
      kind: k,
      providerVersion: e.providerVersion,
      time: e.time,
      role: e.actor.role,
      actorId,
      status: e.status,
      payload: e.payload as unknown as Record<string, unknown>,
      completeness: e.completeness,
      attributes: e.attributes,
      pointer: finalPointer,
      nativeTurnKey: turnKey,
      anchor,
      refs,
    },
  };
}

/** Build the (unvalidated) event object for a pending draft with its final identity. */
export function buildEventObject(
  p: Pending,
  env: Env,
  eventId: string,
  subIndex: number,
  turnId: string | null,
): Record<string, unknown> {
  const rec = env.recs[p.evidence];
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId,
    kind: p.kind,
    provider: env.provider,
    providerVersion: p.providerVersion,
    sourceKind: env.sourceKind,
    sessionId: env.sessionId,
    turnId,
    sourceSequence: p.order,
    subIndex,
    time: p.time,
    actor: { actorId: p.actorId, role: p.role },
    status: p.status,
    payload: p.payload,
    links: [],
    provenance: {
      type: "record",
      sourceId: env.sourceId,
      line: rec?.line ?? 1,
      byteOffset: rec?.byteOffset ?? 0,
      byteLength: rec?.byteLength ?? 0,
      sha256: rec?.sha256 ?? "",
      pointer: p.pointer,
      adapter: { id: env.manifest.id, version: env.manifest.adapterVersion },
    },
    completeness: p.completeness,
    attributes: p.attributes,
  };
}
