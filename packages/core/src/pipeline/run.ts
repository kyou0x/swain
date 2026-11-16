/**
 * Import pipeline (SPEC-002 section 3.4). Turns framed records plus adapter drafts into a
 * validated, byte-reproducible `ImportResult`. Adapters never set IDs, provenance or links.
 */
import type {
  AdapterRegistration,
  AdapterWarning,
  Bounds,
  DetectResult,
  FramedRecord,
  RecordDisposition,
  RecordParser,
} from "../adapter/contract.js";
import { redactText } from "../content/redact.js";
import { deriveId } from "../ids/index.js";
import { frameSource } from "../ingest/frame/index.js";
import type { SourceBytes } from "../ingest/fs/read.js";
import { SCHEMA_VERSION } from "../schema/constants.js";
import type {
  CanonicalEvent,
  Completeness,
  EventKind,
  EventTime,
  GapReason,
  ImportResult,
  LinkRel,
  SrcId,
} from "../schema/types.js";
import { truncateUtf8, utf8ByteLength } from "../text/index.js";
import { validateEvents } from "../validate/index.js";
import { buildEventObject, normalizeDraft, PLACEHOLDER_EVENT_ID, topLevelKeys } from "./draft.js";
import type { Env, InvalidReason, Pending } from "./types.js";
import { isPlainObject, sanitizeWarning, WarningSink } from "./warnings.js";

export interface ImportOptions {
  readonly bounds: Bounds;
  readonly contentPolicy: {
    readonly retention: "hash-only" | "inline";
    readonly maxInlineBytes: number;
  };
}

const MISSING_TIME: EventTime = { value: null, origin: "none", status: "missing" };
const MAX_SUB_INDEX = 1023;
const ABSOLUTE_INLINE = 1_048_576;
const VERSION_RE = /^[!-~]{1,64}$/;
const DISPOSITION_KINDS = ["superseded", "control", "rewound", "metadata"] as const;

const TARGET_KIND: Readonly<Record<string, EventKind>> = {
  "result-of": "tool.requested",
  "spawned-by": "tool.requested",
  decides: "permission.requested",
};

interface DerivedSpec {
  readonly rule: string;
  readonly basis: readonly number[];
  readonly reason: GapReason;
  readonly detail: string;
  readonly gapFor?: number;
  readonly from?: number;
  readonly to?: number;
}

function coreCompleteness(): Completeness {
  return { timestamp: { state: "unavailable" }, actor: { state: "unknown" } };
}

type Mutable = Record<string, unknown> & {
  eventId: string;
  turnId: string | null;
  links: { rel: LinkRel; target: string }[];
  completeness: Completeness;
  payload: Record<string, unknown>;
  time: EventTime;
  sourceSequence: number;
  subIndex: number;
};

export function runImport(
  src: SourceBytes,
  reg: AdapterRegistration,
  detect: DetectResult,
  opts: ImportOptions,
): ImportResult {
  const { bounds, contentPolicy } = opts;
  const manifest = reg.adapter.manifest;
  const { provider, sourceKind } = manifest;

  // 1. Frame the whole source.
  const frame = frameSource(src.bytes, manifest.framing, bounds);
  const recs = frame.records;
  const recCount = recs.length;

  // 2. Identity.
  const sourceId = deriveId("src", [provider, sourceKind, `sha256:${src.sha256}`]);
  let sessionId: string;
  try {
    const native = detect.nativeSessionId;
    sessionId =
      typeof native === "string" && native.length > 0
        ? deriveId("ses", [provider, "native", native])
        : deriveId("ses", [provider, "source", sourceId]);
  } catch {
    sessionId = deriveId("ses", [provider, "source", sourceId]);
  }
  const seen = detect.providerVersionSeen;
  const versionSeen = typeof seen === "string" && VERSION_RE.test(seen) ? seen : null;
  const env: Env = {
    manifest,
    provider,
    sourceKind,
    sourceId,
    sessionId,
    recs,
    recordBase: frame.recordBase,
    bounds,
    policy: contentPolicy,
    attributeKeys: new Set(manifest.attributeKeys),
  };
  const unknownActorId = deriveId("act", [provider, sessionId, "unknown"]);

  const sink = new WarningSink();
  if (recCount === 0) sink.add("empty-source", "info", null);
  if (frame.blankLines > 0) sink.add("blank-lines", "info", null, { count: frame.blankLines });
  if (versionSeen === null || !manifest.testedProviderVersions.includes(versionSeen)) {
    sink.add("untested-provider-version", "warn", null, {
      versionObserved: versionSeen === null ? 0 : 1,
    });
  }
  for (const w of frame.warnings) sink.push(w);

  let emit = 0;
  const pend: Pending[] = [];

  const corePending = (
    order: number,
    kind: EventKind,
    payload: Record<string, unknown>,
  ): Pending => ({
    order,
    evidence: order,
    emit: emit++,
    kind,
    providerVersion: null,
    time: { ...MISSING_TIME },
    role: "unknown",
    actorId: unknownActorId,
    status: "none",
    payload,
    completeness: coreCompleteness(),
    attributes: {},
    pointer: env.recordBase[order] ?? null,
    nativeTurnKey: undefined,
    anchor: undefined,
    refs: [],
  });
  const addGap = (order: number, reason: GapReason, detail: string): void => {
    pend.push(corePending(order, "capture.gap", { reason, detail }));
  };
  const invalid = (
    anchorRec: number,
    reason: InvalidReason,
    issue?: string,
    attribute?: boolean,
  ): void => {
    const seq = anchorRec >= 0 ? anchorRec : null;
    if (attribute === true) sink.add("attribute-not-allowed", "warn", seq);
    else
      sink.add(
        "adapter-output-invalid",
        "warn",
        seq,
        issue === undefined ? { reason } : { reason, issue },
      );
    if (anchorRec >= 0)
      addGap(anchorRec, "adapter-output-invalid", "adapter output failed validation");
  };

  // 3. Parse failures and push.
  const dispositionsRaw: RecordDisposition[] = [];
  const adapterWarned = new Set<number>();
  const handleOutput = (
    out: unknown,
    cur: number,
    defaultRef: number | null,
    anchorRec: number,
    isEnd: boolean,
  ): void => {
    if (
      !isPlainObject(out) ||
      !Array.isArray(out["drafts"]) ||
      !Array.isArray(out["warnings"]) ||
      (out["dispositions"] !== undefined && !Array.isArray(out["dispositions"]))
    ) {
      invalid(anchorRec, "bad-output");
      return;
    }
    for (const w of out["warnings"] as unknown[]) {
      const s = sanitizeWarning(w, recCount);
      if (s === undefined)
        sink.add("adapter-output-invalid", "warn", anchorRec >= 0 ? anchorRec : null, {
          reason: "bad-warning",
        });
      else {
        sink.push(s);
        if (s.code === "timestamp-invalid" && s.sourceSequence !== null) {
          adapterWarned.add(s.sourceSequence);
        }
      }
    }
    for (const d of (out["dispositions"] ?? []) as unknown[]) {
      const ok =
        isPlainObject(d) &&
        typeof d["sourceSequence"] === "number" &&
        Number.isSafeInteger(d["sourceSequence"]) &&
        d["sourceSequence"] >= 0 &&
        d["sourceSequence"] <= cur &&
        recs[d["sourceSequence"]]?.parse.ok === true &&
        typeof d["kind"] === "string" &&
        (DISPOSITION_KINDS as readonly string[]).includes(d["kind"]) &&
        (d["into"] === null ||
          (typeof d["into"] === "number" &&
            Number.isSafeInteger(d["into"]) &&
            d["into"] >= 0 &&
            d["into"] < recCount));
      if (ok) dispositionsRaw.push(d as unknown as RecordDisposition);
      else
        sink.add("adapter-output-invalid", "warn", anchorRec >= 0 ? anchorRec : null, {
          reason: "bad-disposition",
        });
    }
    let drafts = out["drafts"] as unknown[];
    const overflowed = !isEnd && drafts.length > bounds.maxDraftsPerRecord;
    if (overflowed) drafts = drafts.slice(0, bounds.maxDraftsPerRecord);
    for (const raw of drafts) {
      const r = normalizeDraft(raw, env, cur, defaultRef, emit++);
      if (r.ok) pend.push(r.pending);
      else invalid(anchorRec, r.reason, r.issue, r.attribute);
    }
    if (overflowed) {
      addGap(cur, "bounds-reached", "draft limit per record reached");
      sink.add("bounds-reached", "warn", cur, { limit: bounds.maxDraftsPerRecord });
    }
  };

  let aborted = false;
  let abortFrom = recCount;
  let parser: RecordParser | undefined;
  try {
    parser = reg.adapter.createParser({
      providerVersionSeen: versionSeen,
      bounds,
      contentPolicy,
    });
  } catch {
    aborted = true;
    sink.add("adapter-error", "error", null, { phase: "create" });
  }
  let adapterErrors = 0;
  for (let i = 0; i < recCount && !aborted; i++) {
    const rec: FramedRecord | undefined = recs[i];
    if (rec === undefined) continue;
    if (!rec.parse.ok) {
      const f = rec.parse.failure;
      if (f === "malformed" && rec.finalWithoutNewline) {
        addGap(i, "truncated-final-record", "final record is incomplete");
        sink.add("truncated-final-record", "warn", i);
      } else if (f === "malformed") {
        addGap(i, "malformed-record", "record is not valid JSON");
        sink.add("malformed-record", "warn", i);
      } else if (f === "too-large") {
        addGap(i, "record-too-large", "record exceeds the size limit");
        sink.add("record-too-large", "warn", i);
      } else if (f === "depth") {
        addGap(i, "depth-exceeded", "record exceeds the nesting limit");
        sink.add("depth-exceeded", "warn", i);
      } else {
        addGap(i, "invalid-utf8", "record is not valid UTF-8");
        sink.add("invalid-utf8", "warn", i);
      }
      continue;
    }
    let out: unknown;
    try {
      out = parser?.push(rec);
    } catch {
      addGap(i, "adapter-error", "adapter failed while mapping the record");
      sink.add("adapter-error", "error", i);
      adapterErrors++;
      if (adapterErrors > bounds.maxAdapterErrors) {
        aborted = true;
        abortFrom = i + 1;
      }
      continue;
    }
    handleOutput(out, i, i, i, false);
  }

  // 4. End.
  let endFailed = false;
  if (!aborted) {
    let out: unknown;
    try {
      out = parser?.end();
    } catch {
      endFailed = true;
      sink.add("adapter-error", "error", null, { phase: "end" });
    }
    if (!endFailed) handleOutput(out, recCount - 1, null, recCount - 1, true);
  }

  // 5. Order, cap per record, and account.
  const byOrder = (a: Pending, b: Pending): number => a.order - b.order || a.emit - b.emit;
  const sorted = [...pend].sort(byOrder);
  const capped: Pending[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    const order = sorted[i]?.order ?? 0;
    while (j < sorted.length && sorted[j]?.order === order) j++;
    if (j - i > MAX_SUB_INDEX + 1) {
      for (let k = i; k < i + MAX_SUB_INDEX; k++) {
        const p = sorted[k];
        if (p !== undefined) capped.push(p);
      }
      sink.add("bounds-reached", "warn", order, { limit: MAX_SUB_INDEX + 1 });
      capped.push(
        corePending(order, "capture.gap", {
          reason: "bounds-reached",
          detail: "event limit per record reached",
        }),
      );
    } else {
      for (let k = i; k < j; k++) {
        const p = sorted[k];
        if (p !== undefined) capped.push(p);
      }
    }
    i = j;
  }

  let folded = 0;
  if (!aborted) {
    const covered = new Set<number>();
    for (const p of capped) {
      covered.add(p.order);
      covered.add(p.evidence);
    }
    const first = new Map<number, RecordDisposition>();
    for (const d of dispositionsRaw)
      if (!first.has(d.sourceSequence)) first.set(d.sourceSequence, d);
    const accounted = new Set<number>(covered);
    for (const d of first.values()) {
      const intoOk = d.into === null || covered.has(d.into) || first.has(d.into);
      if (d.into === d.sourceSequence || !intoOk) {
        sink.add("adapter-output-invalid", "warn", d.sourceSequence, { reason: "bad-disposition" });
        continue;
      }
      accounted.add(d.sourceSequence);
      if (!covered.has(d.sourceSequence)) folded++;
    }
    const counts: Record<string, number> = {};
    for (const d of first.values()) {
      if (!accounted.has(d.sourceSequence) || covered.has(d.sourceSequence)) continue;
      counts[d.kind] = (counts[d.kind] ?? 0) + 1;
    }
    for (let i = 0; i < recCount; i++) {
      if (accounted.has(i)) continue;
      const rec = recs[i];
      if (rec === undefined) continue;
      capped.push(
        corePending(i, "source.unknown", {
          nativeType: null,
          topLevelKeys: topLevelKeys(rec.parse.ok ? rec.parse.value : null),
          recordSha256: rec.sha256,
        }),
      );
      sink.add("adapter-output-invalid", "warn", i, { reason: "unaccounted-record" });
    }
    if (folded > 0) {
      const detail: Record<string, number> = { total: folded };
      for (const k of DISPOSITION_KINDS) if (counts[k] !== undefined) detail[k] = counts[k];
      sink.add("folded-records", "info", null, detail);
    }
  }
  const ordered = capped.sort(byOrder);

  // 6. IDs, sub-indices and record events.
  interface Item {
    readonly p: Pending;
    readonly ev: Mutable;
  }
  const items: Item[] = [];
  let prevOrder = -1;
  let sub = 0;
  for (const p of ordered) {
    sub = p.order === prevOrder ? sub + 1 : 0;
    prevOrder = p.order;
    const eventId = deriveId("evt", [provider, sourceId, "r", p.order, sub]);
    items.push({ p, ev: buildEventObject(p, env, eventId, sub, null) as Mutable });
  }

  // 7. Turns and time.
  let openTurn: string | null = null;
  let lastValid: string | null = null;
  for (const { p, ev } of items) {
    let turnId: string | null;
    if (p.nativeTurnKey !== undefined) {
      turnId = deriveId("trn", [provider, sourceId, `native:${p.nativeTurnKey}`]);
    } else if (p.kind === "turn.started") {
      turnId = deriveId("trn", [provider, sourceId, `seq:${p.order}`]);
    } else turnId = openTurn;
    if (p.kind === "turn.started") openTurn = turnId;
    ev.turnId = turnId;
    if (p.kind === "turn.ended") openTurn = null;
    if (p.time.status === "invalid" && !adapterWarned.has(p.order)) {
      sink.add("timestamp-invalid", "warn", p.order);
    }
    if (p.time.status === "valid" && p.time.value !== null) {
      if (lastValid !== null && p.time.value < lastValid) {
        sink.add("timestamp-regression", "warn", p.order);
      }
      lastValid = p.time.value;
    }
  }

  // 8. Correlation.
  const anchors = new Map<string, { first: number; latest: number }>();
  const referenced = new Set<number>();
  // Events whose anchor is in the table; an untracked request says nothing about its result.
  const tracked = new Set<number>();
  const derived: DerivedSpec[] = [];
  const missingStart: DerivedSpec[] = [];
  let anchorOverflow: number | null = null;
  const idAt = (i: number): string => items[i]?.ev.eventId ?? PLACEHOLDER_EVENT_ID;
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (item === undefined) continue;
    const { p, ev } = item;
    let orphan = false;
    for (const ref of p.refs) {
      const targetKind: EventKind | undefined =
        ref.rel === "ends"
          ? (p.kind.replace(".ended", ".started") as EventKind)
          : TARGET_KIND[ref.rel];
      const found = targetKind === undefined ? undefined : anchors.get(`${targetKind}\n${ref.key}`);
      if (found === undefined) orphan = true;
      else {
        ev.links.push({ rel: ref.rel, target: idAt(found.latest) });
        if (ref.rel === "result-of") referenced.add(found.latest);
      }
    }
    if (p.refs.length > 0) {
      if (orphan) {
        ev.completeness = {
          ...ev.completeness,
          causality: { state: "absent", reason: "correlation-missing" },
        };
        sink.add("orphan-result", "warn", p.order);
        missingStart.push({
          rule: "core.missing-start",
          basis: [idx],
          reason: "missing-start",
          detail: "result without a matching request",
          gapFor: idx,
        });
      } else if (ev.completeness.causality === undefined) {
        ev.completeness = { ...ev.completeness, causality: { state: "captured" } };
      }
    }
    if (p.anchor !== undefined) {
      const key = `${p.kind}\n${p.anchor}`;
      const entry = anchors.get(key);
      if (entry !== undefined) {
        ev.links.push({ rel: "duplicate-of", target: idAt(entry.first) });
        sink.add("duplicate-native-record", "warn", p.order);
        if (p.kind === "tool.requested") referenced.add(entry.latest);
        entry.latest = idx;
        tracked.add(idx);
      } else if (anchors.size >= bounds.maxOpenCorrelations) {
        anchorOverflow ??= idx;
      } else {
        anchors.set(key, { first: idx, latest: idx });
        tracked.add(idx);
      }
    }
  }
  for (let idx = 0; idx < items.length; idx++) {
    const p = items[idx]?.p;
    if (p?.kind === "tool.requested" && tracked.has(idx) && !referenced.has(idx)) {
      sink.add("missing-result", "warn", p.order);
      derived.push({
        rule: "core.missing-result",
        basis: [idx],
        reason: "missing-result",
        detail: "tool outcome not observed",
        gapFor: idx,
      });
    }
  }
  const lastIdx = items.length - 1;
  const pre: DerivedSpec[] = [];
  if (endFailed && lastIdx >= 0) {
    pre.push({
      rule: "core.adapter-error",
      basis: [lastIdx],
      reason: "adapter-error",
      detail: "adapter failed while flushing",
    });
  }
  if (aborted && lastIdx >= 0) {
    pre.push({
      rule: "core.import-aborted",
      basis: [lastIdx],
      reason: "adapter-error",
      detail: "import aborted after too many adapter errors",
      from: abortFrom,
      to: Math.max(abortFrom, recCount - 1),
    });
  }
  if (frame.recordLimitHit && lastIdx >= 0) {
    pre.push({
      rule: "core.record-limit",
      basis: [lastIdx],
      reason: "bounds-reached",
      detail: "record limit reached",
      from: recCount,
    });
  }
  const post: DerivedSpec[] = [];
  if (anchorOverflow !== null) {
    sink.add("bounds-reached", "warn", items[anchorOverflow]?.p.order ?? null, {
      limit: bounds.maxOpenCorrelations,
    });
    post.push({
      rule: "core.correlation-limit",
      basis: [anchorOverflow],
      reason: "bounds-reached",
      detail: "correlation table limit reached",
    });
  }
  derived.unshift(...pre, ...missingStart);
  derived.push(...post);

  // 9. Derived events (sourceSequence = record count).
  const events: Mutable[] = items.map((i) => i.ev);
  const makeDerived = (spec: DerivedSpec, subIndex: number): Mutable => {
    const basisIds = spec.basis.map(idAt);
    const payload: Record<string, unknown> = { reason: spec.reason, detail: spec.detail };
    if (spec.from !== undefined) payload["fromSequence"] = spec.from;
    if (spec.to !== undefined) payload["toSequence"] = spec.to;
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId: deriveId("evt", [provider, sourceId, "d", spec.rule, ...basisIds]),
      kind: "capture.gap",
      provider,
      providerVersion: null,
      sourceKind,
      sessionId,
      turnId: items[spec.basis[0] ?? 0]?.ev.turnId ?? null,
      sourceSequence: recCount,
      subIndex,
      time: { ...MISSING_TIME },
      actor: { actorId: unknownActorId, role: "unknown" },
      status: "none",
      payload,
      links: spec.gapFor === undefined ? [] : [{ rel: "gap-for", target: idAt(spec.gapFor) }],
      provenance: {
        type: "derived",
        sourceId,
        rule: spec.rule,
        basisEventIds: basisIds,
        adapter: { id: manifest.id, version: manifest.adapterVersion },
      },
      completeness: coreCompleteness(),
      attributes: {},
    } as Mutable;
  };
  let derivedList = derived;
  if (derived.length > MAX_SUB_INDEX + 1) {
    const dropped = derived[MAX_SUB_INDEX];
    derivedList = derived.slice(0, MAX_SUB_INDEX);
    if (dropped !== undefined) {
      derivedList.push({
        rule: "core.derived-limit",
        basis: [dropped.basis[0] ?? 0],
        reason: "bounds-reached",
        detail: "derived event limit reached",
      });
      sink.add("bounds-reached", "warn", null, { limit: MAX_SUB_INDEX + 1 });
    }
  }
  derivedList.forEach((spec, k) => {
    events.push(makeDerived(spec, k));
  });

  // 10. maxEvents.
  let truncated = false;
  if (events.length > bounds.maxEvents) {
    truncated = true;
    events.length = Math.max(0, bounds.maxEvents - 1);
    sink.add("bounds-reached", "warn", null, { limit: bounds.maxEvents });
    const last = events[events.length - 1];
    if (last !== undefined) {
      while (
        events.length > 0 &&
        events[events.length - 1]?.sourceSequence === recCount &&
        (events[events.length - 1]?.subIndex ?? 0) >= MAX_SUB_INDEX
      ) {
        events.pop();
      }
      const tail = events[events.length - 1];
      const subIndex =
        tail !== undefined && tail.sourceSequence === recCount ? tail.subIndex + 1 : 0;
      const basis = tail?.eventId ?? last.eventId;
      const spec: DerivedSpec = {
        rule: "core.event-limit",
        basis: [],
        reason: "bounds-reached",
        detail: "event limit reached",
      };
      const gap = makeDerived(spec, subIndex);
      const prov = gap["provenance"] as { basisEventIds: string[] };
      prov.basisEventIds = [basis];
      gap.eventId = deriveId("evt", [provider, sourceId, "d", spec.rule, basis]);
      gap.turnId = tail?.turnId ?? null;
      events.push(gap);
    }
  }

  // 11. Inline content: redact, then enforce the aggregate budget.
  let remaining = bounds.maxTotalInlineBytes;
  let exhausted = false;
  let downgraded = false;
  const inlineLimit = Math.min(contentPolicy.maxInlineBytes, ABSOLUTE_INLINE);
  for (const ev of events) {
    for (const key of Object.keys(ev.payload)) {
      const ref = ev.payload[key];
      if (
        !isPlainObject(ref) ||
        (ref["retention"] !== "inline" && ref["retention"] !== "inline-truncated")
      )
        continue;
      const inline = ref["inline"];
      if (typeof inline !== "string") continue;
      const r = redactText(inline);
      let text = inline;
      if (r.count > 0) {
        text = r.text;
        if (utf8ByteLength(text) > inlineLimit) {
          text = truncateUtf8(text, inlineLimit).text;
          ref["retention"] = "inline-truncated";
        }
        const byteLength = ref["byteLength"];
        if (
          ref["retention"] === "inline-truncated" &&
          typeof byteLength === "number" &&
          utf8ByteLength(text) >= byteLength
        ) {
          text = truncateUtf8(text, Math.max(0, byteLength - 1)).text;
        }
        ref["inline"] = text;
        ref["redactionCount"] = r.count;
      }
      const size = utf8ByteLength(text);
      if (exhausted || size > remaining) {
        exhausted = true;
        downgraded = true;
        ref["retention"] = "hash-only";
        delete ref["inline"];
        delete ref["redactionCount"];
      } else remaining -= size;
    }
  }
  if (downgraded) {
    sink.add("bounds-reached", "warn", null, { limit: bounds.maxTotalInlineBytes });
  }

  // 12. Final validation, stats and outcome.
  const validated = validateEvents(events);
  let finalEvents: CanonicalEvent[] = [];
  let failed = aborted || (manifest.framing.kind === "json-document" && isTooLargeDocument(recs));
  if (validated.ok) finalEvents = validated.events;
  else {
    failed = true;
    sink.add("adapter-error", "error", null, { code: "internal" });
  }
  const eventsByKind: Partial<Record<EventKind, number>> = {};
  let gaps = 0;
  let unknowns = 0;
  let derivedCount = 0;
  for (const e of finalEvents) {
    eventsByKind[e.kind] = (eventsByKind[e.kind] ?? 0) + 1;
    if (e.kind === "capture.gap") gaps++;
    if (e.kind === "source.unknown") unknowns++;
    if (e.provenance.type === "derived") derivedCount++;
  }
  const outcome = failed
    ? "failed"
    : gaps > 0 || unknowns > 0 || truncated
      ? "partial"
      : "complete";
  const warnings: AdapterWarning[] = sink.finalize(bounds.maxWarnings);
  return {
    source: {
      sourceId: sourceId as SrcId,
      provider,
      sourceKind,
      sourceStability: manifest.sourceStability,
      sha256: src.sha256,
      byteLength: src.byteLength,
      recordCount: recCount,
      blankLineCount: frame.blankLines,
      displayName: src.displayName,
    },
    events: finalEvents,
    warnings,
    stats: {
      records: recCount,
      blankLines: frame.blankLines,
      eventsByKind,
      gaps,
      unknowns,
      derived: derivedCount,
      folded,
    },
    outcome,
  };
}

function isTooLargeDocument(recs: readonly FramedRecord[]): boolean {
  const r = recs[0];
  return r !== undefined && !r.parse.ok && r.parse.failure === "too-large";
}
