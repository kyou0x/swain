import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AdapterWarning,
  CanonicalEvent,
  DraftEvent,
  EventKind,
  FramedRecord,
  JsonValue,
  RecordDisposition,
  SourceAdapter,
} from "@swain/core";
import {
  canonicalJson,
  DEFAULT_BOUNDS,
  deriveId,
  escapeControlChars,
  sha256Hex,
  validateEvents,
} from "@swain/core";

const enc = new TextEncoder();

/** Minimal jsonl framer for unit tests (the real framer is WP-A's). Blank lines are skipped. */
export function frame(text: string): FramedRecord[] {
  const records: FramedRecord[] = [];
  let offset = 0;
  let line = 0;
  let seq = 0;
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i] ?? "";
    line++;
    const bytes = enc.encode(raw);
    const isLast = i === parts.length - 1;
    if (isLast && raw === "") break;
    if (raw.trim() !== "") {
      let parse: FramedRecord["parse"];
      try {
        parse = { ok: true, value: JSON.parse(raw) as JsonValue };
      } catch {
        parse = { ok: false, failure: "malformed" };
      }
      records.push({
        sourceSequence: seq++,
        line,
        byteOffset: offset,
        byteLength: bytes.length,
        sha256: sha256Hex(bytes),
        finalWithoutNewline: isLast,
        parse,
      });
    }
    offset += bytes.length + 1;
  }
  return records;
}

export interface Driven {
  readonly records: FramedRecord[];
  readonly drafts: { order: number; evidence: number; draft: DraftEvent }[];
  readonly warnings: AdapterWarning[];
  readonly dispositions: RecordDisposition[];
  readonly nativeSessionId: string | null;
  readonly providerVersionSeen: string | null;
}

export type Retention = "hash-only" | "inline";

/** detect + push every parse-ok record + end, like the pipeline does (without framing). */
export function drive(
  adapter: SourceAdapter,
  text: string,
  retention: Retention = "hash-only",
): Driven {
  const records = frame(text);
  const det = adapter.detect(records.slice(0, DEFAULT_BOUNDS.detectSampleRecords));
  const parser = adapter.createParser({
    providerVersionSeen: det.providerVersionSeen,
    bounds: DEFAULT_BOUNDS,
    contentPolicy: { retention, maxInlineBytes: 65_536 },
  });
  const drafts: Driven["drafts"] = [];
  const warnings: AdapterWarning[] = [];
  const dispositions: RecordDisposition[] = [];
  const take = (
    out: {
      drafts: readonly DraftEvent[];
      warnings: readonly AdapterWarning[];
      dispositions?: readonly RecordDisposition[];
    },
    cur: number,
  ): void => {
    for (const d of out.drafts) {
      drafts.push({
        order: d.recordRef?.order ?? cur,
        evidence: d.recordRef?.evidence ?? cur,
        draft: d,
      });
    }
    warnings.push(...out.warnings);
    dispositions.push(...(out.dispositions ?? []));
  };
  for (const r of records) {
    if (r.parse.ok) take(parser.push(r), r.sourceSequence);
  }
  take(parser.end(), records.length);
  return {
    records,
    drafts,
    warnings,
    dispositions,
    nativeSessionId: det.nativeSessionId,
    providerVersionSeen: det.providerVersionSeen,
  };
}

/** SPEC-002 section 3.4 step 10 for parse-ok records. Returns the unaccounted sequences. */
export function unaccounted(d: Driven): number[] {
  const ok = new Set<number>();
  for (const x of d.drafts) {
    ok.add(x.order);
    ok.add(x.evidence);
  }
  for (const x of d.dispositions) ok.add(x.sourceSequence);
  return d.records
    .filter((r) => r.parse.ok && !ok.has(r.sourceSequence))
    .map((r) => r.sourceSequence);
}

const TARGET: Record<string, EventKind> = {
  "result-of": "tool.requested",
  "spawned-by": "tool.requested",
  decides: "permission.requested",
};

export interface Assembled {
  readonly events: CanonicalEvent[];
  readonly unresolvedRefs: { seq: number; kind: EventKind; rel: string }[];
}

/**
 * Test-only stand-in for the WP-A pipeline: assigns ids, provenance and links so the real
 * validator can check every draft against ADR-0002. Not a substitute for runImport.
 */
export function assemble(adapter: SourceAdapter, text: string, d: Driven): Assembled {
  const m = adapter.manifest;
  const sourceId = deriveId("src", [
    m.provider,
    m.sourceKind,
    `sha256:${sha256Hex(enc.encode(text))}`,
  ]);
  const sessionId =
    d.nativeSessionId === null
      ? deriveId("ses", [m.provider, "source", sourceId])
      : deriveId("ses", [m.provider, "native", d.nativeSessionId]);
  const sorted = d.drafts
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const sub = new Map<number, number>();
  const anchors = new Map<string, string>();
  const events: CanonicalEvent[] = [];
  const unresolvedRefs: Assembled["unresolvedRefs"] = [];
  const tc = (v: JsonValue | undefined): JsonValue =>
    typeof v === "string" && v.length > 0 ? deriveId("tc", [m.provider, sourceId, v]) : null;
  const act = (v: JsonValue | undefined): JsonValue =>
    typeof v === "string" && v.length > 0 ? deriveId("act", [m.provider, sessionId, v]) : null;
  for (const x of sorted) {
    const dr = x.draft;
    const si = sub.get(x.order) ?? 0;
    sub.set(x.order, si + 1);
    const eventId = deriveId("evt", [m.provider, sourceId, "r", x.order, si]);
    const rec = d.records[x.evidence];
    assert.ok(rec, "evidence record exists");
    const payload: { [k: string]: JsonValue } = { ...dr.payload };
    for (const k of ["toolCallId", "spawnedByToolCallId", "viaToolCallId"]) {
      if (Object.hasOwn(payload, k)) payload[k] = tc(payload[k]);
    }
    for (const k of ["agentActorId", "parentActorId"]) {
      if (Object.hasOwn(payload, k)) payload[k] = act(payload[k]);
    }
    const links: { rel: string; target: string }[] = [];
    for (const ref of dr.correlation?.refs ?? []) {
      const kind = ref.rel === "ends" ? "agent.started" : TARGET[ref.rel];
      const target = anchors.get(`${kind}\u0000${ref.key}`);
      if (target === undefined) unresolvedRefs.push({ seq: x.order, kind: dr.kind, rel: ref.rel });
      else links.push({ rel: ref.rel, target });
    }
    if (dr.correlation?.anchor !== undefined) {
      anchors.set(`${dr.kind}\u0000${dr.correlation.anchor}`, eventId);
    }
    const ev = {
      schemaVersion: "0.1.0",
      eventId,
      kind: dr.kind,
      provider: m.provider,
      providerVersion: dr.providerVersion,
      sourceKind: m.sourceKind,
      sessionId,
      turnId: null,
      sourceSequence: x.order,
      subIndex: si,
      time: dr.time,
      actor: {
        actorId: deriveId("act", [m.provider, sessionId, dr.actorKey]),
        role: dr.actor.role,
      },
      status: dr.status,
      payload,
      links,
      provenance: {
        type: "record",
        sourceId,
        line: rec.line,
        byteOffset: rec.byteOffset,
        byteLength: rec.byteLength,
        sha256: rec.sha256,
        pointer: dr.pointer,
        adapter: { id: m.id, version: m.adapterVersion },
      },
      completeness: dr.completeness,
      attributes: dr.attributes,
    };
    events.push(ev as unknown as CanonicalEvent);
  }
  const v = validateEvents(events);
  if (!v.ok) {
    const first = v.issues
      .slice(0, 5)
      .map((i) => `${i.path}:${i.code}`)
      .join(" | ");
    assert.fail(`validateEvents failed: ${escapeControlChars(first)}`);
  }
  return { events, unresolvedRefs };
}

export function repoPath(...parts: string[]): string {
  return fileURLToPath(new URL(`../../../../${parts.join("/")}`, import.meta.url));
}

export function readFixture(provider: string, name: string): string {
  return readFileSync(repoPath("fixtures", provider, "synthetic-mvp", name), "utf8");
}

export function kinds(d: Driven): string[] {
  return d.drafts.map((x) => x.draft.kind);
}

/** Adapter-level golden (the ImportResult golden needs WP-A's runImport). */
export function goldenText(adapter: SourceAdapter, d: Driven): string {
  return `${canonicalJson({
    adapter: { id: adapter.manifest.id, version: adapter.manifest.adapterVersion },
    detect: { nativeSessionId: d.nativeSessionId, providerVersionSeen: d.providerVersionSeen },
    drafts: d.drafts.map((x) => ({ order: x.order, evidence: x.evidence, draft: x.draft })),
    dispositions: d.dispositions,
    warnings: d.warnings,
  })}\n`;
}

export function checkGolden(provider: string, name: string, actual: string): void {
  const path = repoPath("fixtures", "expected", provider, "mvp", name);
  if (process.env["ATM_UPDATE_GOLDEN"] === "1") writeFileSync(path, actual);
  assert.equal(actual, readFileSync(path, "utf8"), `golden mismatch for ${name}`);
}
