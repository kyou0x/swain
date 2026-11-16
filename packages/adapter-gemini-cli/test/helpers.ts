/**
 * Test harness. WP-A's framer, pipeline and conformance kit are not on this branch, so this file
 * has a minimal stand-in for each: a JSONL / json-document framer, a draft-to-event builder that
 * feeds `validateEvents`, and the SPEC-002 section 3.4 step 10 record-accounting check.
 *
 * Fidelity limits of the stand-in framer: JSONL spans are exact; json-document element spans
 * are the re-serialized element (offset 0, line 1), not the original bytes. The real framer
 * (WP-A) computes exact spans; adapters never read those fields.
 *
 * An identical copy lives in the other adapter package's test directory.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AdapterOutput,
  AdapterWarning,
  Bounds,
  CanonicalEvent,
  DetectResult,
  DraftEvent,
  FramedRecord,
  JsonValue,
  RecordDisposition,
  SourceAdapter,
} from "@swain/core";
import { canonicalJson, DEFAULT_BOUNDS, deriveId, sha256Hex, validateEvents } from "@swain/core";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function fixturePath(rel: string): string {
  return fileURLToPath(new URL(`../../../../fixtures/${rel}`, import.meta.url));
}

export function readFixture(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(rel)));
}

export function frameJsonl(input: Uint8Array | string): FramedRecord[] {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const text = dec.decode(bytes);
  const out: FramedRecord[] = [];
  let offset = 0;
  let line = 1;
  for (const raw of text.split("\n")) {
    const len = enc.encode(raw).length;
    if (raw.trim() !== "") {
      let parse: FramedRecord["parse"];
      try {
        parse = { ok: true, value: JSON.parse(raw) as JsonValue };
      } catch {
        parse = { ok: false, failure: "malformed" };
      }
      out.push({
        sourceSequence: out.length,
        line,
        byteOffset: offset,
        byteLength: len,
        sha256: sha256Hex(enc.encode(raw)),
        finalWithoutNewline: false,
        parse,
      });
    }
    offset += len + 1;
    line++;
  }
  return out;
}

/** Envelope (record 0, `/messages` removed when it is an array) then one record per element. */
export function frameDocument(input: Uint8Array | string): FramedRecord[] {
  const bytes = typeof input === "string" ? enc.encode(input) : input;
  const text = dec.decode(bytes);
  let doc: JsonValue;
  try {
    doc = JSON.parse(text) as JsonValue;
  } catch {
    return [
      {
        sourceSequence: 0,
        line: 1,
        byteOffset: 0,
        byteLength: bytes.length,
        sha256: sha256Hex(bytes),
        finalWithoutNewline: false,
        parse: { ok: false, failure: "malformed" },
      },
    ];
  }
  const records: FramedRecord[] = [];
  let envelope: JsonValue = doc;
  let elements: readonly JsonValue[] = [];
  if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) {
    const copy: { [key: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k === "messages" && Array.isArray(v)) elements = v;
      else
        Object.defineProperty(copy, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
    envelope = copy;
  }
  records.push({
    sourceSequence: 0,
    line: 1,
    byteOffset: 0,
    byteLength: bytes.length,
    sha256: sha256Hex(bytes),
    finalWithoutNewline: false,
    parse: { ok: true, value: envelope },
  });
  for (const el of elements) {
    const span = enc.encode(JSON.stringify(el));
    records.push({
      sourceSequence: records.length,
      line: 1,
      byteOffset: 0,
      byteLength: span.length,
      sha256: sha256Hex(span),
      finalWithoutNewline: false,
      parse: { ok: true, value: el },
    });
  }
  return records;
}

export interface Run {
  readonly drafts: readonly {
    readonly draft: DraftEvent;
    readonly order: number;
    readonly evidence: number;
  }[];
  readonly warnings: readonly AdapterWarning[];
  readonly dispositions: readonly RecordDisposition[];
  readonly raw: AdapterOutput[];
}

export function bounds(over: Partial<Bounds> = {}): Bounds {
  return { ...DEFAULT_BOUNDS, ...over };
}

export function run(
  adapter: SourceAdapter,
  records: readonly FramedRecord[],
  o: {
    retention?: "hash-only" | "inline";
    bounds?: Partial<Bounds>;
    version?: string | null;
  } = {},
): Run {
  const parser = adapter.createParser({
    providerVersionSeen: o.version ?? null,
    bounds: bounds(o.bounds),
    contentPolicy: { retention: o.retention ?? "hash-only", maxInlineBytes: 65_536 },
  });
  const drafts: { draft: DraftEvent; order: number; evidence: number }[] = [];
  const warnings: AdapterWarning[] = [];
  const dispositions: RecordDisposition[] = [];
  const raw: AdapterOutput[] = [];
  const take = (out: AdapterOutput, current: number | null): void => {
    raw.push(out);
    for (const d of out.drafts) {
      const ref = d.recordRef;
      if (ref === undefined && current === null) throw new Error("end() draft without recordRef");
      drafts.push({
        draft: d,
        order: ref?.order ?? (current as number),
        evidence: ref?.evidence ?? (current as number),
      });
    }
    warnings.push(...out.warnings);
    dispositions.push(...(out.dispositions ?? []));
  };
  for (const r of records) {
    if (r.parse.ok) take(parser.push(r), r.sourceSequence);
  }
  take(parser.end(), null);
  return { drafts, warnings, dispositions, raw };
}

export function detect(adapter: SourceAdapter, records: readonly FramedRecord[]): DetectResult {
  return adapter.detect(records.slice(0, DEFAULT_BOUNDS.detectSampleRecords));
}

/** SPEC-002 section 3.4 step 10 for this adapter's output. Returns violations (empty = ok). */
export function accounting(records: readonly FramedRecord[], r: Run): string[] {
  const problems: string[] = [];
  const used = new Set<number>();
  for (const d of r.drafts) {
    used.add(d.order);
    used.add(d.evidence);
  }
  const seen = new Set<number>();
  for (const d of r.dispositions) {
    if (seen.has(d.sourceSequence)) problems.push(`duplicate disposition ${d.sourceSequence}`);
    seen.add(d.sourceSequence);
    if (used.has(d.sourceSequence)) problems.push(`disposition on used record ${d.sourceSequence}`);
  }
  for (const d of r.dispositions) {
    if (d.into !== null && !used.has(d.into) && !seen.has(d.into)) {
      problems.push(`disposition ${d.sourceSequence} into unaccounted ${d.into}`);
    }
  }
  for (const rec of records) {
    if (rec.parse.ok && !used.has(rec.sourceSequence) && !seen.has(rec.sourceSequence)) {
      problems.push(`record ${rec.sourceSequence} unaccounted`);
    }
  }
  for (const d of r.drafts) {
    if (d.order > records.length || d.evidence > records.length) problems.push("forward recordRef");
  }
  return problems;
}

type Json = { [key: string]: JsonValue };

/** Stand-in for pipeline steps 5-8: ids, provenance, link resolution. */
export function buildEvents(
  adapter: SourceAdapter,
  records: readonly FramedRecord[],
  r: Run,
  nativeSessionId: string | null,
): unknown[] {
  const m = adapter.manifest;
  const provider = m.provider;
  const sourceId = deriveId("src", [provider, m.sourceKind, `sha256:${"00".repeat(32)}`]);
  const sessionId =
    nativeSessionId === null
      ? deriveId("ses", [provider, "source", sourceId])
      : deriveId("ses", [provider, "native", nativeSessionId]);
  const doc = m.framing.kind === "json-document";
  const sorted = r.drafts
    .map((d, i) => ({ ...d, i }))
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const subs = new Map<number, number>();
  const anchors = new Map<string, string>();
  const tc = (k: JsonValue | undefined): JsonValue =>
    typeof k === "string" ? deriveId("tc", [provider, sourceId, k]) : null;
  const act = (k: JsonValue | undefined): JsonValue =>
    typeof k === "string" ? deriveId("act", [provider, sessionId, k]) : null;
  const events: unknown[] = [];
  for (const s of sorted) {
    const d = s.draft;
    const sub = subs.get(s.order) ?? 0;
    subs.set(s.order, sub + 1);
    const eventId = deriveId("evt", [provider, sourceId, "r", s.order, sub]);
    const rec = records.find((x) => x.sourceSequence === s.evidence);
    if (rec === undefined) throw new Error("evidence record missing");
    const base = !doc ? "" : s.evidence === 0 ? "" : `/messages/${s.evidence - 1}`;
    const payload: Json = { ...d.payload };
    for (const k of ["toolCallId", "spawnedByToolCallId", "viaToolCallId"]) {
      if (Object.hasOwn(payload, k)) payload[k] = tc(payload[k]);
    }
    for (const k of ["agentActorId", "parentActorId"]) {
      if (Object.hasOwn(payload, k)) payload[k] = act(payload[k]);
    }
    const links: { rel: string; target: string }[] = [];
    for (const ref of d.correlation?.refs ?? []) {
      const t = anchors.get(`tool.requested:${ref.key}`);
      if (t !== undefined) links.push({ rel: ref.rel, target: t });
    }
    if (d.correlation?.anchor !== undefined) {
      anchors.set(`${d.kind}:${d.correlation.anchor}`, eventId);
    }
    const completeness = { ...d.completeness };
    if (links.length === 0 && d.correlation?.refs !== undefined && d.correlation.refs.length > 0) {
      completeness.causality = { state: "absent", reason: "correlation-missing" };
    }
    events.push({
      schemaVersion: "0.1.0",
      eventId,
      kind: d.kind,
      provider,
      providerVersion: d.providerVersion,
      sourceKind: m.sourceKind,
      sessionId,
      turnId: null,
      sourceSequence: s.order,
      subIndex: sub,
      time: d.time,
      actor: { actorId: deriveId("act", [provider, sessionId, d.actorKey]), role: d.actor.role },
      status: d.status,
      payload,
      links,
      provenance: {
        type: "record",
        sourceId,
        line: rec.line,
        byteOffset: rec.byteOffset,
        byteLength: rec.byteLength,
        sha256: rec.sha256,
        pointer: `${base}${d.pointer ?? ""}`.length > 512 ? null : `${base}${d.pointer}`,
        adapter: { id: m.id, version: m.adapterVersion },
      },
      completeness,
      attributes: d.attributes,
    });
  }
  return events;
}

/** Validates drafts as canonical events; returns the events or throws with escaped issues. */
export function validated(
  adapter: SourceAdapter,
  records: readonly FramedRecord[],
  r: Run,
  nativeSessionId: string | null = null,
): CanonicalEvent[] {
  const events = buildEvents(adapter, records, r, nativeSessionId);
  const res = validateEvents(events);
  if (!res.ok) {
    throw new Error(`validateEvents failed: ${JSON.stringify(res.issues.slice(0, 5))}`);
  }
  return res.events;
}

/** PA-3: attribute keys inside the allowlist, scalar values, no free text longer than 256. */
export function attributeProblems(adapter: SourceAdapter, r: Run): string[] {
  const allowed = new Set(adapter.manifest.attributeKeys);
  const out: string[] = [];
  for (const d of r.drafts) {
    for (const [k, v] of Object.entries(d.draft.attributes)) {
      if (!allowed.has(k)) out.push(`attribute ${k} not allowed`);
      if (typeof v === "string" && v.length > 256) out.push(`attribute ${k} too long`);
    }
  }
  return out;
}

export function snapshotOf(r: Run): string {
  return canonicalJson({
    drafts: r.drafts.map((d) => d.draft),
    warnings: r.warnings,
    dispositions: [...r.dispositions],
  });
}

/** Byte-for-byte golden compare (pretty-printed canonical JSON). `UPDATE_GOLDEN=1` rewrites. */
export function goldenText(r: Run): string {
  return `${JSON.stringify(JSON.parse(snapshotOf(r)), null, 2)}\n`;
}

export function matchesGolden(rel: string, r: Run): { ok: boolean; actual: string } {
  const actual = goldenText(r);
  if (process.env["UPDATE_GOLDEN"] === "1") writeFileSync(fixturePath(rel), actual);
  const expected = readFileSync(fixturePath(rel), "utf8");
  return { ok: expected === actual, actual };
}

export function kinds(r: Run): string[] {
  return r.drafts.map((d) => d.draft.kind);
}

export function ofKind(r: Run, kind: string): DraftEvent[] {
  return r.drafts.filter((d) => d.draft.kind === kind).map((d) => d.draft);
}

export function json(v: unknown): JsonValue {
  return v as JsonValue;
}

export function shaOf(v: JsonValue | undefined): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const sha = (v as { readonly [key: string]: JsonValue })["sha256"];
  return typeof sha === "string" ? sha : undefined;
}
