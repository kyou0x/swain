/**
 * OTLP ingest pipeline (ADR-0006 section 5a step 9 and 10; SPEC-003 section 3.2), synchronous from
 * the received bytes to the committed transaction:
 *
 *   gunzip (capped) -> hash both forms -> batch dedup -> decode (bounded) -> content policy ->
 *   agent and run (`@swain/model`) -> one transaction (`store.ingestTraces` / `ingestLogs`).
 *
 * The result is either a response summary or a static error code. Nothing in it is taken from the
 * request: the rejection reason is one of the decoders' closed codes.
 */
import { gunzipSync } from "node:zlib";
import { canonicalJson, sha256Hex } from "@swain/core";
import {
  type BatchInput,
  DbError,
  type KeyAuthRecord,
  type LogPut,
  type ProjectScope,
  type ReceivedSchemaUrls,
  type SpanPut,
  type SwainStore,
} from "@swain/db";
import {
  applyContentPolicy,
  deriveAgentIdentity,
  identityOfAttribute,
  runForLogRecord,
  traceRun,
} from "@swain/model";
import {
  decodeOtlp,
  OtlpDecodeError,
  type OtlpWire,
  UnsupportedContentTypeError,
} from "@swain/otlp";
import type { ErrorCode } from "./errors.js";
import type { ServerLimits } from "./limits.js";

export type Signal = "traces" | "logs";

export interface IngestInput {
  readonly signal: Signal;
  readonly key: KeyAuthRecord;
  readonly contentType: string;
  readonly wire: OtlpWire;
  readonly gzip: boolean;
  /** The body as received (already capped by the reader). */
  readonly body: Uint8Array;
  readonly receivedMs: number;
  /** A fresh random batch ID (`bat_` + 32 hex). */
  readonly batchId: string;
}

export interface IngestDeps {
  readonly store: SwainStore;
  readonly limits: ServerLimits;
  /** Spend decoded bytes from the key's budget; false when the key has none left (429). */
  readonly chargeBytes: (keyId: string, n: number) => boolean;
  /** A decoder bug (`OtlpDecodeError("internal")`) was seen. */
  readonly onDecoderInternal: () => void;
  /** Test-only seam (not reachable from the package exports): replaces `decodeOtlp`. */
  readonly decode?: typeof decodeOtlp;
}

/** Static text for a record the store refused: nothing from the request. */
const STORE_REJECT_MESSAGE = "A record was refused by the store.";

export type IngestResult =
  | {
      readonly kind: "ok";
      readonly rejected: number;
      readonly errorMessage: string | null;
    }
  | { readonly kind: "error"; readonly code: ErrorCode; readonly retryAfterSec?: number };

const fail = (code: ErrorCode): IngestResult => ({ kind: "error", code });

/** The stored form of a batch's result: what a resend replays. Never the response text itself. */
function resultJson(rejected: number, errorMessage: string | null): string {
  return canonicalJson({ errorMessage, rejected });
}

function replay(stored: string): IngestResult {
  try {
    const v: unknown = JSON.parse(stored);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const rejected = (v as Record<string, unknown>)["rejected"];
      const msg = (v as Record<string, unknown>)["errorMessage"];
      if (typeof rejected === "number" && Number.isSafeInteger(rejected) && rejected >= 0) {
        return { kind: "ok", rejected, errorMessage: typeof msg === "string" ? msg : null };
      }
    }
  } catch {
    // fall through: a stored result that does not parse is replayed as a plain success
  }
  return { kind: "ok", rejected: 0, errorMessage: null };
}

function decodeFailure(e: unknown, deps: IngestDeps): IngestResult {
  if (e instanceof UnsupportedContentTypeError) return fail("unsupported-media-type");
  if (e instanceof OtlpDecodeError) {
    switch (e.code) {
      case "body-too-large":
        return fail("payload-too-large");
      case "too-many-values":
        return fail("too-many-values");
      case "too-many-records":
      case "too-many-resource-groups":
      case "too-many-scope-groups":
        return fail("too-many-records");
      case "invalid-utf8":
      case "malformed-json":
      case "json-too-deep":
      case "invalid-structure":
        return fail("invalid-otlp");
      case "invalid-option":
      case "internal":
        // A decoder bug or a server misconfiguration, never the sender's fault. 500 is not
        // retried by OTLP exporters (only 429/502/503/504 are): the batch is dropped, which is
        // right for a deterministic failure and avoids a retry storm. Counted, never echoed.
        deps.onDecoderInternal();
        return fail("internal");
    }
  }
  return fail("internal");
}

/** Gunzip with an output cap. `null` is a failure the caller maps through `code`. */
function gunzipCapped(
  body: Uint8Array,
  cap: number,
): { ok: true; bytes: Uint8Array } | { ok: false; code: ErrorCode } {
  try {
    return { ok: true, bytes: gunzipSync(body, { maxOutputLength: cap }) };
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    // `ERR_BUFFER_TOO_LARGE` (or `ERR_OUT_OF_RANGE` on some versions) is the cap being hit.
    if (code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE") {
      return { ok: false, code: "payload-too-large" };
    }
    return { ok: false, code: "bad-request" };
  }
}

export function runIngest(deps: IngestDeps, input: IngestInput): IngestResult {
  const { store, limits } = deps;
  const { key } = input;
  const scope: ProjectScope = { orgId: key.orgId, projectId: key.projectId };

  // step 9: gunzip with maxOutputLength
  let decoded: Uint8Array = input.body;
  if (input.gzip) {
    const g = gunzipCapped(input.body, limits.maxDecodedBytes);
    if (!g.ok) return fail(g.code);
    decoded = g.bytes;
  }
  if (decoded.length > limits.maxDecodedBytes) return fail("payload-too-large");
  if (!deps.chargeBytes(key.keyId, decoded.length)) {
    return { kind: "error", code: "rate-limited", retryAfterSec: 1 };
  }

  // step 10.1/10.2: hash both forms, then batch dedup, both before any decoding
  const bodySha256 = sha256Hex(input.body);
  const decodedSha256 = input.gzip ? sha256Hex(decoded) : bodySha256;
  const stored = store.findBatch(scope, key.keyId, input.signal, decodedSha256);
  if (stored !== null) return replay(stored.resultJson);

  // step 10.3: decode under the value budget
  let result: IngestResult | null = null;
  const policySource = store.getProject(scope);
  if (policySource === null) return fail("internal");
  const options = {
    maxBodyBytes: limits.maxDecodedBytes,
    maxValues: limits.maxValues,
    maxRecords: limits.maxRecords,
  };
  const policy = {
    contentPolicy: policySource.contentPolicy,
    maxInlineBytes: policySource.maxInlineBytes,
  };
  const pinned = key.agentName;
  const base = (
    status: "accepted" | "partial" | "rejected",
    accepted: number,
    rejected: number,
    errorMessage: string | null,
  ): BatchInput => ({
    batchId: input.batchId,
    signal: input.signal,
    encoding: input.wire,
    contentEncoding: input.gzip ? "gzip" : "identity",
    bodySha256,
    bodyBytes: input.body.length,
    decodedSha256,
    decodedBytes: decoded.length,
    receivedMs: input.receivedMs,
    status,
    accepted,
    rejected,
    resultJson: resultJson(rejected, errorMessage),
  });
  const statusOf = (accepted: number, rejected: number): "accepted" | "partial" | "rejected" =>
    rejected === 0 ? "accepted" : accepted > 0 ? "partial" : "rejected";

  const decode = deps.decode ?? decodeOtlp;
  try {
    if (input.signal === "traces") {
      const traces = decode("traces", input.contentType, decoded, options);
      // step 10.4 to 10.6 happened in the decoder (validation, hash before truncation, bounds);
      // the content policy is the next one and the only producer of the branded records.
      const applied = applyContentPolicy(traces, policy);
      // The schema URLs as received (before the policy) are dedup evidence, found by record path.
      const urls = new Map<string, ReceivedSchemaUrls>();
      for (const rs of traces.resourceSpans) {
        for (const ss of rs.scopeSpans) {
          for (const sp of ss.spans) {
            urls.set(sp.path, { resourceSchemaUrl: rs.schemaUrl, scopeSchemaUrl: ss.schemaUrl });
          }
        }
      }
      const candidates: SpanPut[] = [];
      let refused = 0;
      for (const span of applied.spans) {
        const received = urls.get(span.path);
        try {
          if (received === undefined) throw new Error("no received schema URLs");
          candidates.push({
            span,
            received,
            agent: deriveAgentIdentity(key.projectId, {
              pinnedAgentName: pinned,
              attributes: span.attributes,
              resourceAttributes: span.resource.attributes,
            }),
            run: traceRun(key.projectId, span.traceId),
            receivedMs: input.receivedMs,
            late: false,
          });
        } catch {
          refused++;
        }
      }
      // N1.5 G3 F2/F10: a record the store would refuse is a per-record rejection counted in
      // partial_success and in the batch row; it never fails the batch.
      const rejectedByStore = store.precheckSpans(scope, key.keyId, candidates);
      const bad = new Set(rejectedByStore.map((r) => r.index));
      const puts = candidates.filter((_p, i) => !bad.has(i));
      const rejected = traces.rejected.length + refused + rejectedByStore.length;
      const errorMessage =
        traces.rejected[0]?.reason ?? (rejected > 0 ? STORE_REJECT_MESSAGE : null);
      const out = store.ingestTraces(
        scope,
        key.keyId,
        base(statusOf(puts.length, rejected), puts.length, rejected, errorMessage),
        puts,
      );
      result =
        out.batch.outcome === "duplicate"
          ? replay(out.batch.batch.resultJson)
          : { kind: "ok", rejected, errorMessage };
    } else {
      const logs = decode("logs", input.contentType, decoded, options);
      const applied = applyContentPolicy(logs, policy);
      const urls = new Map<string, ReceivedSchemaUrls>();
      for (const rl of logs.resourceLogs) {
        for (const sl of rl.scopeLogs) {
          for (const lr of sl.logRecords) {
            urls.set(lr.path, { resourceSchemaUrl: rl.schemaUrl, scopeSchemaUrl: sl.schemaUrl });
          }
        }
      }
      const seen = new Map<string, number>();
      const candidates: LogPut[] = [];
      let refused = 0;
      for (const log of applied.logs) {
        // Occurrence: the index among identical records (same record, resource and scope) in
        // this batch; identical records in one batch are distinct evidence (ADR-0002 section 6).
        const k = `${log.recordSha256}:${log.resourceSha256}:${log.scopeSha256}`;
        const occurrence = seen.get(k) ?? 0;
        seen.set(k, occurrence + 1);
        const received = urls.get(log.path);
        try {
          if (received === undefined) throw new Error("no received schema URLs");
          const agent = deriveAgentIdentity(key.projectId, {
            pinnedAgentName: pinned,
            attributes: log.attributes,
            resourceAttributes: log.resource.attributes,
          });
          const run = runForLogRecord({
            projectId: key.projectId,
            agentId: agent.agentId,
            traceId: log.traceId,
            session: identityOfAttribute(log.attributes, "session.id"),
            timeUnixNano: log.timeUnixNano,
          });
          candidates.push({
            log,
            received,
            occurrence,
            run,
            agent,
            projectedImportId: null,
            receivedMs: input.receivedMs,
          });
        } catch {
          refused++;
        }
      }
      const rejectedByStore = store.precheckLogs(scope, key.keyId, candidates);
      const bad = new Set(rejectedByStore.map((r) => r.index));
      const puts = candidates.filter((_p, i) => !bad.has(i));
      const rejected = logs.rejected.length + refused + rejectedByStore.length;
      const errorMessage = logs.rejected[0]?.reason ?? (rejected > 0 ? STORE_REJECT_MESSAGE : null);
      const out = store.ingestLogs(
        scope,
        key.keyId,
        base(statusOf(puts.length, rejected), puts.length, rejected, errorMessage),
        puts,
      );
      result =
        out.batch.outcome === "duplicate"
          ? replay(out.batch.batch.resultJson)
          : { kind: "ok", rejected, errorMessage };
    }
  } catch (e) {
    if (e instanceof OtlpDecodeError || e instanceof UnsupportedContentTypeError) {
      return decodeFailure(e, deps);
    }
    // N1.5 G3 F9: a key revoked or expired between authentication and the write is a 401, not a
    // 500 (the store reports it as `db-constraint`, like any refusal, so ask the key record).
    if (e instanceof DbError && e.code === "db-constraint") {
      const k = store.findKey(key.keyId);
      if (
        k === null ||
        k.revokedAtMs !== null ||
        (k.expiresAtMs !== null && k.expiresAtMs <= input.receivedMs)
      ) {
        return fail("unauthenticated");
      }
    }
    throw e;
  }
  return result;
}
