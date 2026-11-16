/**
 * Evidence digests for span and log deduplication (otlp README F4).
 *
 * "Identical" is decided on the whole tuple (record hash, resource hash, scope hash, resource schema
 * URL, scope schema URL), never on the record hash alone: the same record under another resource or
 * scope is different evidence. Each digest has its own domain string and length-prefixed fields,
 * so a span digest, a log digest and a duplicate-log digest can never equal one another, and no
 * concatenation of field values can be confused with another split.
 *
 * The raw `recordSha256`, `resourceSha256` and `scopeSha256` are undecorated SHA-256 values and are
 * not shared between tables as an index key: `resources` is keyed by the resource hash alone,
 * `spans` and `log_records` by IDs derived here, `span_conflicts` by the span digest.
 */
import { sha256Hex } from "@swain/core";

const encoder = new TextEncoder();

function lp(v: string | number): string {
  const s = String(v);
  return `${encoder.encode(s).length}:${s}`;
}

export interface EvidenceParts {
  readonly recordSha256: string;
  readonly resourceSha256: string;
  readonly scopeSha256: string;
  /** `canonicalJson` of the post-policy `resourceSchemaUrl` / `scopeSchemaUrl`. */
  readonly resourceSchemaUrl: string;
  readonly scopeSchemaUrl: string;
}

function digest(domain: string, fields: readonly (string | number)[]): string {
  return sha256Hex(encoder.encode(`${domain}\n${fields.map(lp).join("")}`));
}

const tuple = (p: EvidenceParts): string[] => [
  p.recordSha256,
  p.resourceSha256,
  p.scopeSha256,
  p.resourceSchemaUrl,
  p.scopeSchemaUrl,
];

/** What `spans.record_sha256` and `span_conflicts.record_sha256` hold. */
export function spanEvidenceSha256(p: EvidenceParts): string {
  return digest("swain:v1:span-evidence", tuple(p));
}

/** The canonical `log_id` suffix: the tuple plus the occurrence within the batch. */
export function logEvidenceSha256(p: EvidenceParts, occurrence: number): string {
  return digest("swain:v1:log-evidence", [...tuple(p), occurrence]);
}

/** The `log_id` suffix of another credential's sighting of the same evidence. */
export function logSightingSha256(p: EvidenceParts, occurrence: number, keyId: string): string {
  return digest("swain:v1:log-sighting", [...tuple(p), occurrence, keyId]);
}
