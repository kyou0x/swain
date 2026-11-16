/**
 * Pure `ImportRecord` construction (SPEC-003 N0, ADR-0004 section 4). No clock, no filesystem:
 * the caller injects `nowMs` and the already masked `displayPath`.
 */
import { type CanonicalEvent, type ImportResult, sha256Hex } from "@swain/core";
import type { ImportRecord } from "@swain/report";
import { StoreError } from "./errors.js";
import type { PutMeta } from "./store.js";

const encoder = new TextEncoder();

export function importIdFor(adapterId: string, sourceSha256: string): ImportRecord["importId"] {
  const h = sha256Hex(encoder.encode(`atm:v0:import\n${adapterId}\n${sourceSha256}`));
  return `imp_${h.slice(0, 32)}`;
}

function eventTimeRange(events: readonly CanonicalEvent[]): [string | null, string | null] {
  let first: string | null = null;
  let last: string | null = null;
  for (const e of events) {
    const v = e.time.status === "valid" ? e.time.value : null;
    if (v === null) continue;
    if (first === null || v < first) first = v;
    if (last === null || v > last) last = v;
  }
  return [first, last];
}

function sortedUnique<T extends string>(xs: readonly T[]): T[] {
  return [...new Set(xs)].sort();
}

/**
 * The record the store persists for `result`. `displayPath` must already be home-masked and
 * control-escaped (the store derives it from `meta.sourcePath`). Throws `StoreError`
 * `invalid-result` when `nowMs` is not finite.
 */
export function buildImportRecord(
  result: ImportResult,
  meta: PutMeta,
  sessionId: string,
  nowMs: number,
  displayPath: string,
): ImportRecord {
  const [firstEventTime, lastEventTime] = eventTimeRange(result.events);
  if (!Number.isFinite(nowMs)) throw new StoreError("invalid-result");
  const s = result.stats;
  return {
    importId: importIdFor(meta.adapter.id, result.source.sha256),
    sessionId: sessionId as ImportRecord["sessionId"],
    provider: result.source.provider,
    sourceKind: result.source.sourceKind,
    adapter: {
      id: meta.adapter.id,
      version: meta.adapter.version,
      sourceStability: meta.adapter.sourceStability,
      experimental: meta.adapter.experimental,
    },
    source: {
      sha256: result.source.sha256,
      byteLength: result.source.byteLength,
      container: meta.container.encoding,
      displayName: result.source.displayName,
      displayPath,
    },
    contentRetention: meta.contentRetention,
    outcome: result.outcome,
    counts: {
      events: result.events.length,
      records: s.records,
      gaps: s.gaps,
      unknowns: s.unknowns,
      folded: s.folded,
      warnings: result.warnings.length,
      byKind: { ...s.eventsByKind },
    },
    warningCodes: sortedUnique(result.warnings.map((w) => w.code)),
    firstEventTime,
    lastEventTime,
    importedAt: new Date(nowMs).toISOString(),
  };
}
