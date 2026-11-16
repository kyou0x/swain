/**
 * From `@swain/model` post-policy records to store rows (SPEC-003 section 2.3, brand switch).
 *
 * The store accepts only `PolicyAppliedSpan` / `PolicyAppliedLog` objects that the applier
 * produced: every record is checked with `isPolicyApplied` at runtime (a forged object cast to the
 * type is refused with `db-constraint`). The columns are derived from the post-policy fields, never
 * from caller-supplied JSON: the model serializer (`policyAppliedSpanJson`) is the single source
 * of the text, so `bigint` times become decimal strings exactly as the model defines.
 *
 * Unset times (`0n`) are stored as NULL. `trace_state_json`, `severity_text_json` and
 * `event_name_json` hold the `PolicyText` JSON (a kept text or a content reference).
 */
import { canonicalJson } from "@swain/core";
import {
  CONTENT_KEYS_VERSION,
  type EffectivePolicy,
  isPolicyApplied,
  policyAppliedLogJson,
  policyAppliedSpanJson,
} from "@swain/model";
import { DbError } from "../errors.js";
import type { LogPut, NormalizedLog, NormalizedSpan, SpanPut } from "../types.js";
import { spanEvidenceSha256 } from "./evidence.js";
import { agentUpsertOf, deriveOp, requireLogKind, requireSpanKind, runUpsertOf } from "./facts.js";

type Rec = Record<string, unknown>;

function bad(): never {
  throw new DbError("db-constraint");
}

function rec(v: unknown): Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad();
  return v as Rec;
}

function parse(json: string): Rec {
  return rec(JSON.parse(json));
}

function nsOrNull(v: unknown): bigint | null {
  if (typeof v !== "bigint") return bad();
  return v === 0n ? null : v;
}

function strOrNull(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") return bad();
  return v;
}

function policyOf(v: unknown): EffectivePolicy {
  const p = rec(v);
  const { contentPolicy, maxInlineBytes, metadataPolicy, contentKeysVersion } = p;
  if (
    (contentPolicy !== "hash-only" && contentPolicy !== "inline") ||
    (metadataPolicy !== "masked" && metadataPolicy !== "allowlist") ||
    typeof maxInlineBytes !== "number" ||
    contentKeysVersion !== CONTENT_KEYS_VERSION
  ) {
    return bad();
  }
  return { contentPolicy, maxInlineBytes, metadataPolicy, contentKeysVersion };
}

export interface SpanRow {
  readonly row: NormalizedSpan;
  /** The full post-policy record (`swain.policy-applied/1`), kept for conflicting sightings. */
  readonly recordJson: string;
  readonly policy: EffectivePolicy;
}

function receivedOk(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["resourceSchemaUrl"] === "string" &&
    typeof r["scopeSchemaUrl"] === "string" &&
    r["resourceSchemaUrl"].length <= 65_536 &&
    r["scopeSchemaUrl"].length <= 65_536
  );
}

export function spanRowOf(put: SpanPut): SpanRow {
  try {
    const sp = put.span;
    if (!isPolicyApplied(sp) || !receivedOk(put.received)) return bad();
    requireSpanKind(sp);
    const agent = agentUpsertOf(put.agent);
    const run = runUpsertOf(put.run, agent.agentId);
    const op = deriveOp(sp);
    const recordJson = policyAppliedSpanJson(sp);
    const r = parse(recordJson);
    const status = rec(r["status"]);
    const resource = rec(r["resource"]);
    const row: NormalizedSpan = {
      traceId: sp.traceId,
      spanId: sp.spanId,
      parentSpanId: sp.parentSpanId,
      run,
      agent,
      resource: {
        sha256: sp.resourceSha256,
        attributesJson: canonicalJson({
          attributes: resource["attributes"],
          droppedAttributesCount: resource["droppedAttributesCount"],
        }),
        schemaUrl: canonicalJson(r["resourceSchemaUrl"]),
      },
      nameJson: canonicalJson(r["name"]),
      kind: sp.kind,
      startNs: nsOrNull(sp.startTimeUnixNano),
      endNs: nsOrNull(sp.endTimeUnixNano),
      statusCode: sp.status.code,
      statusMessageJson: canonicalJson(status["message"]),
      traceStateJson: canonicalJson(r["traceState"]),
      flags: sp.flags,
      attributesJson: canonicalJson(r["attributes"]),
      droppedAttributes: sp.droppedAttributesCount,
      eventsJson: canonicalJson(r["events"]),
      linksJson: canonicalJson(r["links"]),
      scopeJson: canonicalJson({ ...rec(r["scope"]), schemaUrl: r["scopeSchemaUrl"] }),
      opClass: op.opClass,
      opJson: op.opJson,
      recordPath: sp.path,
      recordSha256: sp.recordSha256,
      evidenceSha256: spanEvidenceSha256({
        recordSha256: sp.recordSha256,
        resourceSha256: sp.resourceSha256,
        scopeSha256: sp.scopeSha256,
        resourceSchemaUrl: put.received.resourceSchemaUrl,
        scopeSchemaUrl: put.received.scopeSchemaUrl,
      }),
      receivedMs: put.receivedMs,
      late: put.late,
    };
    return { row, recordJson, policy: policyOf(sp.policy) };
  } catch (e) {
    throw e instanceof DbError ? e : new DbError("db-constraint");
  }
}

export interface LogRow {
  readonly row: NormalizedLog;
  readonly policy: EffectivePolicy;
}

export function logRowOf(put: LogPut): LogRow {
  try {
    const lg = put.log;
    if (!isPolicyApplied(lg) || !receivedOk(put.received)) return bad();
    requireLogKind(lg);
    if ((put.run === null) !== (put.agent === null)) bad();
    const agent = put.agent === null ? null : agentUpsertOf(put.agent);
    const run = put.run === null || agent === null ? null : runUpsertOf(put.run, agent.agentId);
    const r = parse(policyAppliedLogJson(lg));
    const resource = rec(r["resource"]);
    const body = r["body"];
    const row: NormalizedLog = {
      occurrence: put.occurrence,
      run,
      agent,
      resource: {
        sha256: lg.resourceSha256,
        attributesJson: canonicalJson({
          attributes: resource["attributes"],
          droppedAttributesCount: resource["droppedAttributesCount"],
        }),
        schemaUrl: canonicalJson(r["resourceSchemaUrl"]),
      },
      timeNs: nsOrNull(lg.timeUnixNano),
      observedNs: nsOrNull(lg.observedTimeUnixNano),
      severityNumber: lg.severityNumber,
      severityTextJson: canonicalJson(r["severityText"]),
      eventNameJson: canonicalJson(r["eventName"]),
      bodyJson: body === null ? null : canonicalJson(body),
      attributesJson: canonicalJson(r["attributes"]),
      traceId: strOrNull(lg.traceId),
      spanId: strOrNull(lg.spanId),
      scopeJson: canonicalJson({ ...rec(r["scope"]), schemaUrl: r["scopeSchemaUrl"] }),
      recordPath: lg.path,
      recordSha256: lg.recordSha256,
      scopeSha256: lg.scopeSha256,
      receivedResourceSchemaUrl: put.received.resourceSchemaUrl,
      receivedScopeSchemaUrl: put.received.scopeSchemaUrl,
      projectedImportId: put.projectedImportId,
      receivedMs: put.receivedMs,
    };
    return { row, policy: policyOf(lg.policy) };
  } catch (e) {
    throw e instanceof DbError ? e : new DbError("db-constraint");
  }
}
