import { sha256Hex } from "../ids/index.js";
import {
  ACTOR_ROLES,
  CHANGE_KINDS,
  COMPLETENESS_REASONS,
  COMPLETENESS_STATES,
  CONTENT_ENCODINGS,
  CONTENT_RETENTIONS,
  EVENT_KINDS,
  FACETS,
  FILE_CHANGE_BASES,
  GAP_REASONS,
  KIND_ALLOWED_STATUS,
  LIMITS,
  LINK_RELS,
  MESSAGE_CHANNELS,
  MESSAGE_ROLES,
  PERMISSION_DECIDERS,
  PERMISSION_DECISIONS,
  PROVIDERS,
  REQUIRED_FACETS_BY_KIND,
  SESSION_END_REASONS,
  SESSION_TRIGGERS,
  STRING_BOUNDS,
  TIME_ORIGINS,
  TIME_STATUSES,
  TOOL_ERROR_CLASSES,
  TOOL_NAMESPACES,
  USAGE_SCOPES,
} from "../schema/constants.js";
import type { EventKind } from "../schema/types.js";
import { utf8ByteLength } from "../text/index.js";
import { normalizeTimestamp } from "../time/index.js";
import {
  arr,
  type Check,
  type Ctx,
  type Field,
  f,
  fail,
  int,
  isSnapObject,
  nonNegativeNumber,
  nullable,
  obj,
  oneOf,
  opt,
  setOwn,
  str,
} from "./checks.js";
import type { IssueCode } from "./issues.js";

const encoder = new TextEncoder();
const sha256 = str("sha256");
const bounded256 = str("bounded256");
const tcId = str("tcId");
const actId = str("actId");

const contentRef: Check = obj(
  [
    f("sha256", sha256),
    f("byteLength", int(0)),
    f("encoding", oneOf(CONTENT_ENCODINGS)),
    f("retention", oneOf(CONTENT_RETENTIONS)),
    opt("inline", str("inlineContent")),
    opt("redactionCount", int(0)),
  ],
  (out, ctx, path) => {
    const add = (key: string, code: IssueCode): void => {
      path.push(key);
      ctx.sink.add(path, code);
      path.pop();
    };
    const inline = out["inline"];
    const redactions = out["redactionCount"];
    if (out["retention"] === "hash-only") {
      if (Object.hasOwn(out, "inline")) add("inline", "inline-with-hash-only");
      if (Object.hasOwn(out, "redactionCount")) add("redactionCount", "redaction-with-hash-only");
      return;
    }
    // SPEC-002 section 3.6 (F10).
    if (typeof inline !== "string") {
      add("inline", "content-inline-missing");
      return;
    }
    const length = utf8ByteLength(inline);
    const byteLength = out["byteLength"];
    if (out["retention"] === "inline-truncated") {
      if (typeof byteLength === "number" && length >= byteLength) {
        add("inline", "content-length-mismatch");
      }
      return;
    }
    // `redactionCount >= 1`: the hash covers the original, so the checks are skipped.
    if (redactions === undefined || redactions === 0) {
      if (length !== byteLength) add("inline", "content-length-mismatch");
      else if (sha256Hex(encoder.encode(inline)) !== out["sha256"]) {
        add("inline", "content-hash-mismatch");
      }
    }
  },
);
const contentRefOrNull = nullable(contentRef);

// Same source as STRING_BOUNDS.schemaVersion.pattern (asserted by a test).
const SCHEMA_VERSION_RE = /^0\.1\.[0-9]{1,6}$/;

const schemaVersion: Check = (v, ctx, path) => {
  if (typeof v !== "string") return fail(ctx, path, "wrong-type");
  const sb = STRING_BOUNDS.schemaVersion;
  if (v.length > sb.bytes || utf8ByteLength(v) > sb.bytes) return fail(ctx, path, "too-long");
  if (!SCHEMA_VERSION_RE.test(v)) return fail(ctx, path, "unsupported-schema-version");
  return v;
};

const timeCheck: Check = obj(
  [
    f("value", nullable(str("timeValue"))),
    f("origin", oneOf(TIME_ORIGINS)),
    f("status", oneOf(TIME_STATUSES)),
  ],
  (out, ctx, path) => {
    const { value, origin, status } = out;
    let ok: boolean;
    if (status === "valid") {
      ok = typeof value === "string" && origin === "source";
      if (ok) {
        const n = normalizeTimestamp(value);
        ok = n.status === "valid" && n.value === value;
      }
    } else if (status === "missing") {
      ok = value === null && origin === "none";
    } else {
      ok = value === null && origin === "source";
    }
    if (!ok) ctx.sink.add(path, "bad-time");
  },
);

const actorCheck = obj([f("actorId", actId), f("role", oneOf(ACTOR_ROLES))]);

const linksCheck = arr(
  obj([f("rel", oneOf(LINK_RELS)), f("target", str("evtId"))]),
  LIMITS.maxLinks,
);

const facetCompleteness = obj([
  f("state", oneOf(COMPLETENESS_STATES)),
  opt("reason", oneOf(COMPLETENESS_REASONS)),
]);
const completenessCheck = obj(FACETS.map((facet) => opt(facet, facetCompleteness)));

const attributesCheck: Check = (v, ctx, path) => {
  if (!isSnapObject(v)) return fail(ctx, path, "wrong-type");
  const keys = Object.keys(v);
  if (keys.length > LIMITS.maxAttributes) return fail(ctx, path, "too-many-keys");
  const before = ctx.sink.total;
  const keyCheck = str("attributeKey");
  const valueString = str("attributeString");
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    path.push(k);
    if (keyCheck(k, ctx, path) === undefined) {
      path.pop();
      continue;
    }
    const val = v[k];
    let r: unknown;
    if (typeof val === "string") r = valueString(val, ctx, path);
    else if (typeof val === "number") r = int(Number.MIN_SAFE_INTEGER)(val, ctx, path);
    else if (typeof val === "boolean" || val === null) r = val;
    else r = fail(ctx, path, "wrong-type");
    path.pop();
    if (r !== undefined) setOwn(out, k, r);
  }
  return ctx.sink.total === before ? out : undefined;
};

const adapterRef = obj([f("id", str("adapterId")), f("version", str("adapterVersion"))]);

const recordProvenance = obj([
  f("type", oneOf(["record"])),
  f("sourceId", str("srcId")),
  f("line", int(1)),
  f("byteOffset", int(0)),
  f("byteLength", int(0)),
  f("sha256", sha256),
  f("pointer", nullable(str("pointer"))),
  f("adapter", adapterRef),
]);

const derivedProvenance = obj([
  f("type", oneOf(["derived"])),
  f("sourceId", str("srcId")),
  f("rule", str("rule")),
  f("basisEventIds", arr(str("evtId"), LIMITS.maxBasisEventIds, 1)),
  f("adapter", adapterRef),
]);

const provenanceCheck: Check = (v, ctx, path) => {
  if (!isSnapObject(v)) return fail(ctx, path, "wrong-type");
  const t = Object.hasOwn(v, "type") ? v["type"] : undefined;
  if (t === "record") return recordProvenance(v, ctx, path);
  if (t === "derived") return derivedProvenance(v, ctx, path);
  path.push("type");
  ctx.sink.add(path, t === undefined ? "missing-key" : "bad-enum");
  path.pop();
  return undefined;
};

const optionalInt = (name: string): Field => opt(name, int(0));

const PAYLOADS: Record<EventKind, Check> = {
  "session.started": obj([
    f("nativeSessionId", nullable(bounded256)),
    f("trigger", oneOf(SESSION_TRIGGERS)),
  ]),
  "session.ended": obj([f("reason", oneOf(SESSION_END_REASONS))]),
  "turn.started": obj([f("prompt", contentRefOrNull)]),
  "turn.ended": obj([]),
  "message.observed": obj([
    f("role", oneOf(MESSAGE_ROLES)),
    f("channel", oneOf(MESSAGE_CHANNELS)),
    f("content", contentRef),
  ]),
  "tool.requested": obj([
    f("toolCallId", nullable(tcId)),
    f("toolName", bounded256),
    f("toolNamespace", oneOf(TOOL_NAMESPACES)),
    opt("mcpServer", bounded256),
    f("input", contentRefOrNull),
  ]),
  "tool.completed": obj([
    f("toolCallId", nullable(tcId)),
    f("toolName", nullable(bounded256)),
    f("output", contentRefOrNull),
    opt("exitCode", int(Number.MIN_SAFE_INTEGER)),
    optionalInt("durationMs"),
  ]),
  "tool.failed": obj([
    f("toolCallId", nullable(tcId)),
    f("toolName", nullable(bounded256)),
    f("output", contentRefOrNull),
    opt("exitCode", int(Number.MIN_SAFE_INTEGER)),
    optionalInt("durationMs"),
    f("error", contentRefOrNull),
    f("errorClass", oneOf(TOOL_ERROR_CLASSES)),
  ]),
  "agent.started": obj([
    f("agentActorId", actId),
    f("parentActorId", nullable(actId)),
    f("agentType", nullable(bounded256)),
    f("spawnedByToolCallId", nullable(tcId)),
  ]),
  "agent.ended": obj([f("agentActorId", actId)]),
  "file.changed": obj([
    f("path", str("filePath")),
    f("changeKind", oneOf(CHANGE_KINDS)),
    f("diff", contentRefOrNull),
    f("viaToolCallId", nullable(tcId)),
    f("basis", oneOf(FILE_CHANGE_BASES)),
  ]),
  "permission.requested": obj([
    f("toolName", nullable(bounded256)),
    f("toolCallId", nullable(tcId)),
    f("input", contentRefOrNull),
  ]),
  "permission.decided": obj([
    f("decision", oneOf(PERMISSION_DECISIONS)),
    f("decidedBy", oneOf(PERMISSION_DECIDERS)),
    f("reason", contentRefOrNull),
  ]),
  "model.usage": obj([
    f("scope", oneOf(USAGE_SCOPES)),
    f("model", nullable(bounded256)),
    optionalInt("inputTokens"),
    optionalInt("outputTokens"),
    optionalInt("cachedInputTokens"),
    optionalInt("cacheWriteInputTokens"),
    optionalInt("reasoningOutputTokens"),
    optionalInt("totalTokens"),
    opt("costUsdEstimate", nonNegativeNumber),
  ]),
  "capture.gap": obj([
    f("reason", oneOf(GAP_REASONS)),
    f("detail", str("bounded512")),
    optionalInt("fromSequence"),
    optionalInt("toSequence"),
  ]),
  "source.unknown": obj(
    [
      f("nativeType", nullable(bounded256)),
      f("topLevelKeys", arr(bounded256, LIMITS.maxTopLevelKeys)),
      f("recordSha256", sha256),
    ],
    (out, ctx, path) => {
      const keys = out["topLevelKeys"];
      if (Array.isArray(keys)) {
        for (let i = 1; i < keys.length; i++) {
          if (String(keys[i - 1]) > String(keys[i])) {
            path.push("topLevelKeys");
            ctx.sink.add(path, "not-sorted");
            path.pop();
            break;
          }
        }
      }
    },
  ),
};

function eventFields(kind: EventKind): readonly Field[] {
  return [
    f("schemaVersion", schemaVersion),
    f("eventId", str("evtId")),
    f("kind", oneOf([kind])),
    f("provider", oneOf(PROVIDERS)),
    f("providerVersion", nullable(str("providerVersion"))),
    f("sourceKind", str("sourceKind")),
    f("sessionId", str("sesId")),
    f("turnId", nullable(str("trnId"))),
    f("sourceSequence", int(0)),
    f("subIndex", int(0, LIMITS.maxSubIndex)),
    f("time", timeCheck),
    f("actor", actorCheck),
    f("status", oneOf(KIND_ALLOWED_STATUS[kind], "status-not-allowed")),
    f("payload", PAYLOADS[kind]),
    f("links", linksCheck),
    f("provenance", provenanceCheck),
    f("completeness", completenessCheck),
    f("attributes", attributesCheck),
  ];
}

function eventCheck(kind: EventKind): Check {
  return obj(eventFields(kind), (out, ctx, path) => {
    const completeness = out["completeness"];
    if (completeness === null || typeof completeness !== "object") return;
    const need: string[] = [...REQUIRED_FACETS_BY_KIND[kind]];
    const links = out["links"];
    if (
      Array.isArray(links) &&
      links.some((l: unknown) => {
        const rel = isSnapObjectLike(l) ? l["rel"] : undefined;
        return rel === "result-of" || rel === "decides";
      })
    ) {
      need.push("causality");
    }
    for (const facet of need) {
      if (!Object.hasOwn(completeness, facet)) {
        path.push("completeness");
        path.push(facet);
        ctx.sink.add(path, "missing-facet");
        path.pop();
        path.pop();
      }
    }
  });
}

function isSnapObjectLike(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const EVENT_CHECKS = new Map<string, Check>(EVENT_KINDS.map((k) => [k, eventCheck(k)]));

/** Validate one snapshot value as a CanonicalEvent. Returns the fresh copy or undefined. */
export function checkEvent(v: Parameters<Check>[0], ctx: Ctx, path: Parameters<Check>[2]): unknown {
  if (!isSnapObject(v)) return fail(ctx, path, "wrong-type");
  const kind = Object.hasOwn(v, "kind") ? v["kind"] : undefined;
  const check = typeof kind === "string" ? EVENT_CHECKS.get(kind) : undefined;
  if (check === undefined) {
    path.push("kind");
    ctx.sink.add(path, kind === undefined ? "missing-key" : "bad-enum");
    path.pop();
    return undefined;
  }
  return check(v, ctx, path);
}
