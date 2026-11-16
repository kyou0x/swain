/**
 * `applyContentPolicy` (ADR-0005 section 6, SPEC-003 N1.4): the receiver-side content policy.
 * Pure and deterministic: no I/O, no clock, no randomness. Input is a decoded OTLP batch plus the
 * project policy; output is the only value the store accepts (`PolicyApplied*`).
 *
 * Classification of a leaf is by the nearest key and the leaf's own type (section 6.2):
 * - `content` key (6.3), secret-name key (6.4), `log body`: the WHOLE value, at any type and
 *   length, becomes one ContentRef (hash-only, or inline-truncated and masked under `inline`);
 * - `bytesValue`: always a hash-only ContentRef;
 * - other strings: kept after the URL rule and the extended masker when at most 256 UTF-8 bytes
 *   (and within the 16 KiB per-record cap), else a ContentRef (hash-only unless `inline`);
 * - numbers and booleans are kept.
 * The hash of a ContentRef covers the received value before masking and equals core
 * `makeContentRef` over the value's projection: a string is hashed as its UTF-8 text; any other
 * type as the RFC 8785 JSON of a shallow projection (`{"int":"1"}`, `{"bytes":"<base64>"}`,
 * arrays as arrays, key-value lists as `{"kv":[[key, value], ...]}`).
 */
import {
  AtmError,
  type ContentRef,
  canonicalJson,
  makeContentRef,
  redactTextExtended,
  sha256Hex,
} from "@swain/core";
import type {
  InputAnyValue,
  InputKeyValue,
  InputLogRecord,
  InputResource,
  InputScope,
  InputSpan,
  PolicyInputLogs,
  PolicyInputTraces,
} from "../input.js";
import {
  CLAUDE_BARE_EVENT_NAMES,
  CLAUDE_CORRELATION_KEYS,
  CLAUDE_EVENT_PREFIX,
  CONTENT_KEYS_VERSION,
  contentKeyFamily,
  isAllowlistedKey,
  isIdentityKey,
  isNormalizerKey,
  isUsageKey,
  matchesSecretName,
} from "./content-keys.js";
import {
  applyUrlRule,
  base64,
  isUrlKey,
  looksLikeAbsoluteUrl,
  neutralizeText,
  truncateBytes,
  utf8Len,
} from "./text.js";
import {
  type EffectivePolicy,
  type PolicyAppliedLog,
  type PolicyAppliedLogs,
  type PolicyAppliedSpan,
  type PolicyAppliedTraces,
  type PolicyContent,
  type PolicyKeyValue,
  type PolicyLogFields,
  type PolicyLogsFields,
  type PolicyOverDepth,
  type PolicyResource,
  type PolicyScope,
  type PolicySpanEvent,
  type PolicySpanFields,
  type PolicySpanLink,
  type PolicyText,
  type PolicyTracesFields,
  type PolicyValue,
  type PolicyWarning,
  stamp,
} from "./types.js";

/** Kept metadata strings: at most this many UTF-8 bytes each (ADR-0005 section 6.2). */
export const MAX_KEPT_STRING_BYTES = 256;
/** Retained metadata bytes per record (ADR-0005 section 6.2). */
export const METADATA_CAP_BYTES = 16 * 1024;
/** AnyValue nesting bound (OTLP decoders reject deeper). */
const MAX_ANYVALUE_DEPTH = 16;
const MAX_INLINE_LIMIT = 1_048_576;
const encoder = new TextEncoder();

/** The project policy (ADR-0005 section 6; `maxInlineBytes` is `maxInlineContentBytes`). */
export interface ContentPolicyInput {
  readonly contentPolicy: "hash-only" | "inline";
  readonly maxInlineBytes: number;
  /** `"masked"` (default): keep short strings after masking. `"allowlist"`: only allowlisted keys. */
  readonly metadataPolicy?: "masked" | "allowlist";
}

function invalid(): never {
  throw new AtmError("invalid-option");
}

export function resolvePolicy(p: ContentPolicyInput): EffectivePolicy {
  if (typeof p !== "object" || p === null) return invalid();
  const { contentPolicy, maxInlineBytes, metadataPolicy } = p;
  if (contentPolicy !== "hash-only" && contentPolicy !== "inline") return invalid();
  if (
    typeof maxInlineBytes !== "number" ||
    !Number.isInteger(maxInlineBytes) ||
    maxInlineBytes < 1 ||
    maxInlineBytes > MAX_INLINE_LIMIT
  ) {
    return invalid();
  }
  if (
    metadataPolicy !== undefined &&
    metadataPolicy !== "masked" &&
    metadataPolicy !== "allowlist"
  ) {
    return invalid();
  }
  return {
    contentPolicy,
    maxInlineBytes,
    metadataPolicy: metadataPolicy ?? "masked",
    contentKeysVersion: CONTENT_KEYS_VERSION,
  };
}

interface Ctx {
  readonly inline: boolean;
  readonly maxInline: number;
  readonly allowlist: boolean;
  readonly claudeEvent: boolean;
  /** Per-record metadata budget (mutable). */
  readonly budget: { remaining: number; used: number; hit: boolean };
}

/**
 * One budget per emitted record: `usedBefore` is what the record's shared parts (resource and
 * scope) already hold, so resource + scope + record never exceed METADATA_CAP_BYTES together.
 */
function newCtx(policy: EffectivePolicy, claudeEvent: boolean, usedBefore: number): Ctx {
  return {
    inline: policy.contentPolicy === "inline",
    maxInline: policy.maxInlineBytes,
    allowlist: policy.metadataPolicy === "allowlist",
    claudeEvent,
    budget: { remaining: Math.max(0, METADATA_CAP_BYTES - usedBefore), used: 0, hit: false },
  };
}

// ---- projection and ContentRefs -----------------------------------------------------------

function exceedsDepth(v: InputAnyValue, depth: number): boolean {
  if (depth > MAX_ANYVALUE_DEPTH) return true;
  if (v.kind === "array") return v.values.some((x) => exceedsDepth(x, depth + 1));
  if (v.kind === "kvlist") return v.values.some((kv) => exceedsDepth(kv.value, depth + 1));
  return false;
}

function containsBytes(v: InputAnyValue): boolean {
  if (v.kind === "bytes") return true;
  if (v.kind === "array") return v.values.some(containsBytes);
  if (v.kind === "kvlist") return v.values.some((kv) => containsBytes(kv.value));
  return false;
}

function project(v: InputAnyValue): unknown {
  switch (v.kind) {
    case "string":
      return v.value.toWellFormed();
    case "bool":
      return v.value;
    case "int":
      return { int: v.value.toString() };
    case "double":
      return Number.isFinite(v.value) ? v.value : { double: String(v.value) };
    case "bytes":
      return { bytes: base64(v.value) };
    case "array":
      return v.values.map(project);
    case "kvlist":
      return { kv: v.values.map((kv) => [kv.key.toWellFormed(), project(kv.value)]) };
  }
}

/**
 * Inline text source: like `project`, but the values of nested secret-name and content keys are
 * replaced by `[REDACTED]` (counted in `cnt`), because the masker cannot see `{"kv":[["password",
 * "x"]]}` as an assignment. The hash is always over the plain `project`.
 */
function projectInline(v: InputAnyValue, cnt: { n: number }): unknown {
  switch (v.kind) {
    case "array":
      return v.values.map((x) => projectInline(x, cnt));
    case "kvlist":
      return {
        kv: v.values.map((kv) => {
          if (isContentValue(kv.key, kv.value)) {
            cnt.n++;
            return [kv.key.toWellFormed(), "[REDACTED]"];
          }
          return [kv.key.toWellFormed(), projectInline(kv.value, cnt)];
        }),
      };
    default:
      return project(v);
  }
}

/** Inline ContentRef: hash over `value`, text built from `source`, masked before truncation. */
function inlineRef(
  value: unknown,
  maxInline: number,
  source: unknown,
  replaced: number,
): ContentRef {
  const plain = makeContentRef(value, { retention: "inline", maxInlineBytes: maxInline });
  const text = typeof source === "string" ? source : canonicalJson(source);
  const r = redactTextExtended(text);
  const count = r.count + replaced;
  if (count === 0) return plain;
  let out = r.text;
  let retention: "inline" | "inline-truncated" = "inline";
  if (utf8Len(out) > maxInline) {
    out = truncateBytes(out, maxInline);
    retention = "inline-truncated";
  }
  if (retention === "inline-truncated" && utf8Len(out) >= plain.byteLength) {
    out = truncateBytes(out, Math.max(0, plain.byteLength - 1));
  }
  return {
    sha256: plain.sha256,
    byteLength: plain.byteLength,
    encoding: plain.encoding,
    retention,
    inline: out,
    redactionCount: count,
  };
}

function refOf(
  projected: unknown,
  ctx: Ctx,
  hashOnly: boolean,
  source: unknown = projected,
  replaced = 0,
): ContentRef {
  if (hashOnly || !ctx.inline) return makeContentRef(projected);
  return inlineRef(projected, ctx.maxInline, source, replaced);
}

const OVER_DEPTH: PolicyOverDepth = { kind: "over-depth" };

function contentOf(v: InputAnyValue, ctx: Ctx): PolicyContent | PolicyOverDepth {
  if (exceedsDepth(v, 1)) {
    ctx.budget.hit = true;
    return OVER_DEPTH;
  }
  const hashOnly = containsBytes(v);
  if (hashOnly || !ctx.inline) return { kind: "content", ref: makeContentRef(project(v)) };
  const cnt = { n: 0 };
  const source = projectInline(v, cnt);
  return { kind: "content", ref: refOf(project(v), ctx, false, source, cnt.n) };
}

// ---- strings -------------------------------------------------------------------------------

interface TextOpts {
  /** Attribute key for the URL rule and the allowlist; `null` for fixed fields. */
  readonly key: string | null;
  /** Fixed structural fields (names, versions, trace state) are allowed under `allowlist`. */
  readonly structural: boolean;
}

function textOf(raw: string, ctx: Ctx, opts: TextOpts): PolicyText {
  const s = raw.toWellFormed();
  if (utf8Len(s) > MAX_KEPT_STRING_BYTES) {
    const urlish = (opts.key !== null && isUrlKey(opts.key)) || looksLikeAbsoluteUrl(s);
    const source = urlish ? applyUrlRule(s, opts.key) : s;
    return { kind: "content", ref: refOf(s, ctx, false, source, source !== s ? 1 : 0) };
  }
  if (ctx.allowlist && !opts.structural && !(opts.key !== null && isAllowlistedKey(opts.key))) {
    return { kind: "content", ref: makeContentRef(s) };
  }
  let t = s;
  if ((opts.key !== null && isUrlKey(opts.key)) || looksLikeAbsoluteUrl(t)) {
    t = applyUrlRule(t, opts.key);
  }
  const r = redactTextExtended(t);
  const size = utf8Len(r.text);
  if (size > MAX_KEPT_STRING_BYTES) return { kind: "content", ref: makeContentRef(s) };
  if (size > ctx.budget.remaining) {
    ctx.budget.hit = true;
    return { kind: "content", ref: makeContentRef(s) };
  }
  ctx.budget.remaining -= size;
  ctx.budget.used += size;
  const text: PolicyText = {
    kind: "text",
    value: r.text,
    bestEffortMasked: true,
    redactionCount: r.count,
  };
  if (opts.key !== null && isIdentityKey(opts.key)) {
    const identity = r.text === s ? s : `h:${sha256Hex(encoder.encode(s))}`;
    return { ...text, identity };
  }
  return text;
}

const structural = (ctx: Ctx, s: string): PolicyText =>
  textOf(s, ctx, { key: null, structural: true });

// ---- keys and values -----------------------------------------------------------------------

const KEY_NOISE = /[\p{Cc}\p{Cf}\s\u2028\u2029]/gu;

/** The key as used for classification: control, format and white-space characters removed. */
function classKey(key: string): string {
  return key.replace(KEY_NOISE, "");
}

/**
 * Keys are metadata and are budgeted like kept strings (B1): a key is kept only when it is at
 * most 256 bytes, fits the record's remaining budget and, under `allowlist`, is allowlisted or a
 * normalizer key. Otherwise it becomes `[key:<first 16 hex of sha256(original key)>]` (flagged
 * `keyAltered`; over-bounds only when a bound caused it). Placeholders are 22 bytes and are not
 * charged. The original key is never kept in part.
 */
function processKey(key: string, ctx: Ctx): { key: string; altered: boolean } {
  const k0 = key.toWellFormed();
  const placeholder = (bound: boolean): { key: string; altered: boolean } => {
    if (bound) ctx.budget.hit = true;
    return { key: `[key:${sha256Hex(encoder.encode(k0)).slice(0, 16)}]`, altered: true };
  };
  if (utf8Len(k0) > MAX_KEPT_STRING_BYTES) return placeholder(true);
  const pinned = isNormalizerKey(k0);
  if (ctx.allowlist && !pinned && !isAllowlistedKey(k0)) return placeholder(false);
  let k = neutralizeText(k0);
  // Pinned normalizer keys are compared before redaction (ADR-0005 section 6.2).
  if (!pinned) k = redactTextExtended(k).text;
  const size = utf8Len(k);
  if (size > MAX_KEPT_STRING_BYTES) return placeholder(true);
  if (size > ctx.budget.remaining) return placeholder(true);
  ctx.budget.remaining -= size;
  ctx.budget.used += size;
  return { key: k, altered: k !== key };
}

const DIGITS = /^[0-9]{1,20}$/;

function isNumericish(v: InputAnyValue): boolean {
  return v.kind === "int" || v.kind === "double" || (v.kind === "string" && DIGITS.test(v.value));
}

/** Is the whole value under `key` content (ADR-0005 sections 6.2 to 6.4)? */
function isContentValue(key: string, v: InputAnyValue): boolean {
  const k = classKey(key);
  if (contentKeyFamily(k) !== null) return true;
  if (matchesSecretName(k)) return !(isUsageKey(k) && isNumericish(v));
  return false;
}

function walk(key: string, v: InputAnyValue, ctx: Ctx): PolicyValue {
  if (isContentValue(key, v)) return contentOf(v, ctx);
  switch (v.kind) {
    case "bytes":
      return { kind: "content", ref: makeContentRef(project(v)) };
    case "string":
      return textOf(v.value, ctx, { key: classKey(key), structural: false });
    case "bool":
      return { kind: "bool", value: v.value };
    case "int":
      return { kind: "int", value: v.value };
    case "double":
      return { kind: "double", value: v.value };
    case "array":
      return { kind: "array", values: v.values.map((x) => walk(key, x, ctx)) };
    case "kvlist":
      return { kind: "kvlist", values: v.values.map((kv) => walkKv(kv, ctx, false)) };
  }
}

function walkKv(kv: InputKeyValue, ctx: Ctx, top: boolean): PolicyKeyValue {
  const { key, altered } = processKey(kv.key, ctx);
  const k = classKey(kv.key);
  const forced =
    top &&
    ctx.claudeEvent &&
    !CLAUDE_CORRELATION_KEYS.includes(k) &&
    kv.value.kind !== "bool" &&
    kv.value.kind !== "int" &&
    kv.value.kind !== "double";
  let value: PolicyValue;
  if (exceedsDepth(kv.value, 1)) {
    ctx.budget.hit = true;
    value = OVER_DEPTH;
  } else if (forced) value = contentOf(kv.value, ctx);
  else value = walk(kv.key, kv.value, ctx);
  return { key, keyAltered: altered, value };
}

function attrs(list: readonly InputKeyValue[], ctx: Ctx): PolicyKeyValue[] {
  return list.map((kv) => walkKv(kv, ctx, true));
}

// ---- resource, scope, records --------------------------------------------------------------

interface Shared {
  readonly resource: PolicyResource;
  readonly resourceSchemaUrl: PolicyText;
  readonly scope: PolicyScope;
  readonly scopeSchemaUrl: PolicyText;
  readonly warnings: readonly PolicyWarning[];
  /** Metadata bytes held by resource + scope; every record's budget starts after it. */
  readonly used: number;
}

function buildResource(
  r: InputResource,
  schemaUrl: string,
  policy: EffectivePolicy,
  path: string,
): { resource: PolicyResource; schemaUrl: PolicyText; warnings: PolicyWarning[]; used: number } {
  const ctx = newCtx(policy, false, 0);
  const resource = {
    attributes: attrs(r.attributes, ctx),
    droppedAttributesCount: r.droppedAttributesCount,
  };
  const url = structural(ctx, schemaUrl);
  return {
    resource,
    schemaUrl: url,
    warnings: ctx.budget.hit ? [{ path: `${path}/resource`, code: "over-bounds" }] : [],
    used: ctx.budget.used,
  };
}

function buildScope(
  s: InputScope,
  schemaUrl: string,
  policy: EffectivePolicy,
  path: string,
  usedBefore: number,
): { scope: PolicyScope; schemaUrl: PolicyText; warnings: PolicyWarning[]; used: number } {
  const ctx = newCtx(policy, false, usedBefore);
  const scope = {
    name: structural(ctx, s.name),
    version: structural(ctx, s.version),
    attributes: attrs(s.attributes, ctx),
    droppedAttributesCount: s.droppedAttributesCount,
  };
  const url = structural(ctx, schemaUrl);
  return {
    scope,
    schemaUrl: url,
    warnings: ctx.budget.hit ? [{ path: `${path}/scope`, code: "over-bounds" }] : [],
    used: ctx.budget.used,
  };
}

function applySpan(
  sp: InputSpan,
  sh: Shared,
  hashes: { resourceSha256: string; scopeSha256: string },
  policy: EffectivePolicy,
): PolicyAppliedSpan {
  const ctx = newCtx(policy, false, sh.used);
  const name = structural(ctx, sp.name);
  const traceState = structural(ctx, sp.traceState);
  const statusMessage = textOf(sp.status.message, ctx, { key: null, structural: false });
  const attributes = attrs(sp.attributes, ctx);
  const events: PolicySpanEvent[] = sp.events.map((e) => ({
    timeUnixNano: e.timeUnixNano,
    name: structural(ctx, e.name),
    attributes: attrs(e.attributes, ctx),
    droppedAttributesCount: e.droppedAttributesCount,
  }));
  const links: PolicySpanLink[] = sp.links.map((l) => ({
    traceId: l.traceId,
    spanId: l.spanId,
    traceState: structural(ctx, l.traceState),
    attributes: attrs(l.attributes, ctx),
    droppedAttributesCount: l.droppedAttributesCount,
    flags: l.flags,
  }));
  const warnings: PolicyWarning[] = [...sh.warnings];
  if (ctx.budget.hit) warnings.push({ path: sp.path, code: "over-bounds" });
  const fields: PolicySpanFields = {
    policy,
    path: sp.path,
    recordSha256: sp.recordSha256,
    resourceSha256: hashes.resourceSha256,
    scopeSha256: hashes.scopeSha256,
    traceId: sp.traceId,
    spanId: sp.spanId,
    parentSpanId: sp.parentSpanId,
    traceState,
    flags: sp.flags,
    name,
    kind: sp.kind,
    startTimeUnixNano: sp.startTimeUnixNano,
    endTimeUnixNano: sp.endTimeUnixNano,
    attributes,
    droppedAttributesCount: sp.droppedAttributesCount,
    events,
    droppedEventsCount: sp.droppedEventsCount,
    links,
    droppedLinksCount: sp.droppedLinksCount,
    status: { code: sp.status.code, message: statusMessage },
    resource: sh.resource,
    resourceSchemaUrl: sh.resourceSchemaUrl,
    scope: sh.scope,
    scopeSchemaUrl: sh.scopeSchemaUrl,
    metadataBytes: sh.used + ctx.budget.used,
    warnings,
  };
  return stamp(fields) as PolicyAppliedSpan;
}

function isClaudeEvent(rec: InputLogRecord): boolean {
  const is = (n: string): boolean =>
    n.startsWith(CLAUDE_EVENT_PREFIX) || CLAUDE_BARE_EVENT_NAMES.includes(n);
  if (is(rec.eventName)) return true;
  for (const kv of rec.attributes) {
    if (classKey(kv.key) === "event.name" && kv.value.kind === "string" && is(kv.value.value)) {
      return true;
    }
  }
  return false;
}

function applyLog(
  rec: InputLogRecord,
  sh: Shared,
  hashes: { resourceSha256: string; scopeSha256: string },
  policy: EffectivePolicy,
): PolicyAppliedLog {
  const ctx = newCtx(policy, isClaudeEvent(rec), sh.used);
  const severityText = structural(ctx, rec.severityText);
  const eventName = structural(ctx, rec.eventName);
  const body = rec.body === null ? null : contentOf(rec.body, ctx);
  const attributes = attrs(rec.attributes, ctx);
  const warnings: PolicyWarning[] = [...sh.warnings];
  if (ctx.budget.hit) warnings.push({ path: rec.path, code: "over-bounds" });
  const fields: PolicyLogFields = {
    policy,
    path: rec.path,
    recordSha256: rec.recordSha256,
    resourceSha256: hashes.resourceSha256,
    scopeSha256: hashes.scopeSha256,
    timeUnixNano: rec.timeUnixNano,
    observedTimeUnixNano: rec.observedTimeUnixNano,
    severityNumber: rec.severityNumber,
    severityText,
    body,
    attributes,
    droppedAttributesCount: rec.droppedAttributesCount,
    flags: rec.flags,
    traceId: rec.traceId,
    spanId: rec.spanId,
    eventName,
    resource: sh.resource,
    resourceSchemaUrl: sh.resourceSchemaUrl,
    scope: sh.scope,
    scopeSchemaUrl: sh.scopeSchemaUrl,
    metadataBytes: sh.used + ctx.budget.used,
    warnings,
  };
  return stamp(fields) as PolicyAppliedLog;
}

/** Apply the project content policy to a decoded traces batch. */
export function applyContentPolicy(
  batch: PolicyInputTraces,
  policy: ContentPolicyInput,
): PolicyAppliedTraces;
/** Apply the project content policy to a decoded logs batch. */
export function applyContentPolicy(
  batch: PolicyInputLogs,
  policy: ContentPolicyInput,
): PolicyAppliedLogs;
export function applyContentPolicy(
  batch: PolicyInputTraces | PolicyInputLogs,
  policyInput: ContentPolicyInput,
): PolicyAppliedTraces | PolicyAppliedLogs {
  const policy = resolvePolicy(policyInput);
  if (typeof batch !== "object" || batch === null) return invalid();
  const rejected = batch.rejected.map((r) => ({ path: r.path, reason: r.reason }));
  const warnings = batch.warnings.map((w) => ({ path: w.path, code: w.code as string }));
  if (batch.signal === "traces") {
    const spans: PolicyAppliedSpan[] = [];
    for (const rs of batch.resourceSpans) {
      const res = buildResource(rs.resource, rs.schemaUrl, policy, rs.path);
      for (const ss of rs.scopeSpans) {
        const sc = buildScope(ss.scope, ss.schemaUrl, policy, ss.path, res.used);
        const shared: Shared = {
          resource: res.resource,
          resourceSchemaUrl: res.schemaUrl,
          scope: sc.scope,
          scopeSchemaUrl: sc.schemaUrl,
          warnings: [...res.warnings, ...sc.warnings],
          used: res.used + sc.used,
        };
        const hashes = { resourceSha256: rs.resourceSha256, scopeSha256: ss.scopeSha256 };
        for (const sp of ss.spans) spans.push(applySpan(sp, shared, hashes, policy));
      }
    }
    const out: PolicyTracesFields = { signal: "traces", policy, spans, rejected, warnings };
    return stamp(out) as PolicyAppliedTraces;
  }
  if (batch.signal === "logs") {
    const logs: PolicyAppliedLog[] = [];
    for (const rl of batch.resourceLogs) {
      const res = buildResource(rl.resource, rl.schemaUrl, policy, rl.path);
      for (const sl of rl.scopeLogs) {
        const sc = buildScope(sl.scope, sl.schemaUrl, policy, sl.path, res.used);
        const shared: Shared = {
          resource: res.resource,
          resourceSchemaUrl: res.schemaUrl,
          scope: sc.scope,
          scopeSchemaUrl: sc.schemaUrl,
          warnings: [...res.warnings, ...sc.warnings],
          used: res.used + sc.used,
        };
        const hashes = { resourceSha256: rl.resourceSha256, scopeSha256: sl.scopeSha256 };
        for (const rec of sl.logRecords) logs.push(applyLog(rec, shared, hashes, policy));
      }
    }
    const out: PolicyLogsFields = { signal: "logs", policy, logs, rejected, warnings };
    return stamp(out) as PolicyAppliedLogs;
  }
  return invalid();
}
