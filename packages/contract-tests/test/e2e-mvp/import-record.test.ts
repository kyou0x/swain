/**
 * SPEC-003 N0: `buildImportRecord` (extracted from the store) gives the record the pre-extraction
 * code gave, for every e2e fixture of all four providers. `legacyBuildRecord` is a verbatim copy of
 * the removed private `buildRecord`, kept here as an independent oracle.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  type CanonicalEvent,
  canonicalJson,
  DEFAULT_BOUNDS,
  type ImportResult,
  readSourceFile,
  runImport,
  selectAdapter,
  sha256Hex,
} from "@swain/core";
import type { ImportRecord } from "@swain/report";
import { buildImportRecord, openStore, type PutMeta } from "@swain/store";
import { fixtureFiles, REGISTRATIONS, sandbox } from "./helpers.js";

const encoder = new TextEncoder();

function legacyImportId(adapterId: string, sourceSha256: string): ImportRecord["importId"] {
  const h = sha256Hex(encoder.encode(`atm:v0:import\n${adapterId}\n${sourceSha256}`));
  return `imp_${h.slice(0, 32)}`;
}

function legacyTimeRange(events: readonly CanonicalEvent[]): [string | null, string | null] {
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

function legacyBuildRecord(
  result: ImportResult,
  meta: PutMeta,
  sessionId: string,
  now: number,
  displayPath: string,
): ImportRecord {
  const [firstEventTime, lastEventTime] = legacyTimeRange(result.events);
  const s = result.stats;
  return {
    importId: legacyImportId(meta.adapter.id, result.source.sha256),
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
    warningCodes: [...new Set(result.warnings.map((w) => w.code))].sort(),
    firstEventTime,
    lastEventTime,
    importedAt: new Date(now).toISOString(),
  };
}

const NOW = 1_700_000_000_000;
const FILES = fixtureFiles().filter((f) => f.adapter !== null);

test("there are e2e fixtures for every provider", () => {
  assert.ok(FILES.length >= 20, `fixture count ${FILES.length}`);
  assert.equal(new Set(FILES.map((f) => f.provider)).size, 4);
});

for (const f of FILES) {
  test(`buildImportRecord equals the pre-extraction record: ${f.rel}`, () => {
    const src = readSourceFile(f.path, DEFAULT_BOUNDS);
    const sel = selectAdapter(src, REGISTRATIONS, {}, DEFAULT_BOUNDS);
    assert.ok(sel.ok);
    const result = runImport(src, sel.registration, sel.detect, {
      bounds: DEFAULT_BOUNDS,
      contentPolicy: { retention: "hash-only", maxInlineBytes: 0 },
    });
    const first = result.events[0];
    if (first === undefined) return; // the store refuses empty results; nothing to build
    const manifest = sel.registration.adapter.manifest;
    const meta: PutMeta = {
      adapter: {
        id: manifest.id,
        version: manifest.adapterVersion,
        sourceStability: manifest.sourceStability,
        experimental: manifest.experimental,
      },
      sourcePath: f.path,
      container: src.container,
      contentRetention: "hash-only",
      reimport: false,
    };
    const built = buildImportRecord(result, meta, first.sessionId, NOW, "~/x/a.jsonl");
    const legacy = legacyBuildRecord(result, meta, first.sessionId, NOW, "~/x/a.jsonl");
    assert.equal(canonicalJson(built), canonicalJson(legacy));
    assert.deepEqual(built, legacy);

    // The store persists exactly this record (displayPath is the only store-derived input).
    const sb = sandbox();
    try {
      const store = openStore(join(sb.store), { nowMs: () => NOW, homeDir: sb.home });
      const put = store.put(result, meta);
      const again = buildImportRecord(
        result,
        meta,
        first.sessionId,
        NOW,
        put.record.source.displayPath,
      );
      assert.equal(canonicalJson(put.record), canonicalJson(again));
    } finally {
      sb.done();
    }
  });
}

test("buildImportRecord refuses a non-finite clock value", () => {
  const f = FILES[0];
  assert.ok(f);
  const src = readSourceFile(f.path, DEFAULT_BOUNDS);
  const sel = selectAdapter(src, REGISTRATIONS, {}, DEFAULT_BOUNDS);
  assert.ok(sel.ok);
  const result = runImport(src, sel.registration, sel.detect, {
    bounds: DEFAULT_BOUNDS,
    contentPolicy: { retention: "hash-only", maxInlineBytes: 0 },
  });
  const m = sel.registration.adapter.manifest;
  const meta: PutMeta = {
    adapter: {
      id: m.id,
      version: m.adapterVersion,
      sourceStability: m.sourceStability,
      experimental: m.experimental,
    },
    sourcePath: f.path,
    container: src.container,
    contentRetention: "hash-only",
    reimport: false,
  };
  const sid = result.events[0]?.sessionId ?? "";
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => buildImportRecord(result, meta, sid, bad, "~/a"),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === "invalid-result",
    );
  }
});
