import { LIMITS } from "../schema/constants.js";
import type { CanonicalEvent } from "../schema/types.js";
import type { Ctx } from "./checks.js";
import { type Issue, IssueSink, type PathSeg } from "./issues.js";
import { checkEvent } from "./schema.js";
import { snapshot } from "./snapshot.js";

export type { Issue, IssueCode, PathSeg } from "./issues.js";
export { ISSUE_CODES } from "./issues.js";

export type ValidationResult =
  | { readonly ok: true; readonly event: CanonicalEvent }
  | { readonly ok: false; readonly issues: Issue[] };

export type ValidationsResult =
  | { readonly ok: true; readonly events: CanonicalEvent[] }
  | { readonly ok: false; readonly issues: Issue[] };

const INTERNAL: () => Issue[] = () => [{ path: "", code: "internal" }];

/** Snapshot then schema-validate one value; returns the fresh event or undefined. */
function validateOne(v: unknown, sink: IssueSink, base: PathSeg[]): CanonicalEvent | undefined {
  const before = sink.total;
  const snap = snapshot(v, sink, base, 0);
  if (sink.total !== before) return undefined;
  const ctx: Ctx = { sink };
  const out = checkEvent(snap, ctx, base);
  if (sink.total !== before || out === undefined) return undefined;
  // The checkers have verified every field of the fresh copy; this is the one boundary cast.
  return out as CanonicalEvent;
}

/**
 * Validate an unknown value as a v0.1 CanonicalEvent (C7, C12). Never throws and never
 * mutates its input. On success `event` is a fresh deep copy of plain objects with keys in
 * ADR-0002 field order that shares no reference with the input.
 */
export function validateEvent(v: unknown): ValidationResult {
  try {
    const sink = new IssueSink();
    const event = validateOne(v, sink, []);
    if (event !== undefined && sink.total === 0) return { ok: true, event };
    return { ok: false, issues: sink.issues };
  } catch {
    return { ok: false, issues: INTERNAL() };
  }
}

function checkSet(events: readonly CanonicalEvent[], sink: IssueSink): void {
  const ids = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    if (ids.has(e.eventId)) sink.add([i, "eventId"], "duplicate-event-id");
    ids.add(e.eventId);
  }
  const rank = new Map<string, number>();
  let prev: readonly [number, number, number] | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e === undefined) continue;
    for (let j = 0; j < e.links.length; j++) {
      const link = e.links[j];
      if (link !== undefined && !ids.has(link.target)) {
        sink.add([i, "links", j, "target"], "dangling-link");
      }
    }
    if (e.provenance.type === "derived") {
      const basis = e.provenance.basisEventIds;
      for (let j = 0; j < basis.length; j++) {
        const b = basis[j];
        if (b !== undefined && !ids.has(b)) {
          sink.add([i, "provenance", "basisEventIds", j], "dangling-basis");
        }
      }
    }
    const sourceId = e.provenance.sourceId;
    let r = rank.get(sourceId);
    if (r === undefined) {
      r = rank.size;
      rank.set(sourceId, r);
    }
    const key = [r, e.sourceSequence, e.subIndex] as const;
    if (
      prev !== undefined &&
      (key[0] < prev[0] ||
        (key[0] === prev[0] && (key[1] < prev[1] || (key[1] === prev[1] && key[2] < prev[2]))))
    ) {
      sink.add([i, "sourceSequence"], "out-of-order");
    }
    prev = key;
  }
}

/**
 * Validate an array of events and the set-level rules: unique `eventId`, link targets and
 * `basisEventIds` exist, and order is non-decreasing by (sourceId first appearance,
 * sourceSequence, subIndex).
 */
export function validateEvents(v: unknown): ValidationsResult {
  try {
    const sink = new IssueSink();
    if (!Array.isArray(v)) {
      sink.add([], "wrong-type");
      return { ok: false, issues: sink.issues };
    }
    if (Object.getPrototypeOf(v) !== Array.prototype) {
      sink.add([], "not-plain-data");
      return { ok: false, issues: sink.issues };
    }
    const len = v.length;
    if (len > LIMITS.maxEvents) {
      sink.add([], "too-many-elements");
      return { ok: false, issues: sink.issues };
    }
    if (Object.getOwnPropertyNames(v).length !== len + 1) {
      sink.add([], "not-plain-data");
      return { ok: false, issues: sink.issues };
    }
    const events: CanonicalEvent[] = [];
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(v, String(i));
      if (d === undefined) {
        sink.add([i], "not-plain-data");
      } else if (Object.hasOwn(d, "get") || Object.hasOwn(d, "set")) {
        sink.add([i], "accessor-property");
      } else {
        const e = validateOne(d.value, sink, [i]);
        if (e !== undefined) events.push(e);
      }
      if (sink.full) break;
    }
    if (sink.total === 0) checkSet(events, sink);
    if (sink.total === 0) return { ok: true, events };
    return { ok: false, issues: sink.issues };
  } catch {
    return { ok: false, issues: INTERNAL() };
  }
}
