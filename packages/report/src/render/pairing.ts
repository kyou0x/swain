import type { CanonicalEvent, EvtId } from "@swain/core";

type Ev<K extends CanonicalEvent["kind"]> = Extract<CanonicalEvent, { kind: K }>;
export type ToolRequest = Ev<"tool.requested">;
export type ToolResult = Ev<"tool.completed"> | Ev<"tool.failed">;

export type ToolStatus = "ok" | "unknown" | "failed" | "denied" | "interrupted" | "none";

/** Milliseconds since the epoch for a valid event time, else null. Uses `new Date(iso)` only. */
export function timeMs(e: CanonicalEvent): number | null {
  if (e.time.status !== "valid" || e.time.value === null) return null;
  const ms = new Date(e.time.value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function toolStatus(r: ToolResult | null): ToolStatus {
  if (r === null) return "none";
  if (r.kind === "tool.completed") return r.status === "success" ? "ok" : "unknown";
  return r.status === "denied" ? "denied" : r.status === "interrupted" ? "interrupted" : "failed";
}

/** The reported duration, else the time between request and result; null when neither is known. */
export function toolDurationMs(
  startMs: number | null,
  resultMs: number | null,
  result: ToolResult | null,
): number | null {
  const rd = result?.payload.durationMs;
  if (rd !== undefined && Number.isFinite(rd) && rd >= 0) return rd;
  if (startMs !== null && resultMs !== null && resultMs >= startMs) return resultMs - startMs;
  return null;
}

export interface ToolPairing {
  readonly requests: ReadonlyMap<EvtId, ToolRequest>;
  readonly reqByCall: ReadonlyMap<string, EvtId>;
  readonly resultFor: ReadonlyMap<EvtId, ToolResult>;
  /** Results that were paired with a request. */
  readonly claimed: ReadonlySet<EvtId>;
}

/**
 * Pairing: the `result-of` link first, then an equal non-null toolCallId. A result is claimed by at
 * most one request. O(n).
 */
export function pairTools(events: readonly CanonicalEvent[]): ToolPairing {
  const requests = new Map<EvtId, ToolRequest>();
  const reqByCall = new Map<string, EvtId>();
  for (const e of events) {
    if (e.kind !== "tool.requested") continue;
    requests.set(e.eventId, e);
    const c = e.payload.toolCallId;
    if (c !== null && !reqByCall.has(c)) reqByCall.set(c, e.eventId);
  }
  const resultFor = new Map<EvtId, ToolResult>();
  const claimed = new Set<EvtId>();
  const results = events.filter(
    (e): e is ToolResult => e.kind === "tool.completed" || e.kind === "tool.failed",
  );
  for (const r of results) {
    for (const l of r.links) {
      if (l.rel === "result-of" && requests.has(l.target) && !resultFor.has(l.target)) {
        resultFor.set(l.target, r);
        claimed.add(r.eventId);
        break;
      }
    }
  }
  for (const r of results) {
    if (claimed.has(r.eventId)) continue;
    const c = r.payload.toolCallId;
    const req = c === null ? undefined : reqByCall.get(c);
    if (req !== undefined && !resultFor.has(req)) {
      resultFor.set(req, r);
      claimed.add(r.eventId);
    }
  }
  return { requests, reqByCall, resultFor, claimed };
}

/**
 * Actors that an `agent.started` may never claim as a subagent: the actor of the session's first
 * event and every user-role actor. Stops a crafted start from relabelling the main actor.
 */
export function protectedActors(events: readonly CanonicalEvent[]): ReadonlySet<string> {
  const out = new Set<string>();
  const first = events[0];
  if (first !== undefined) out.add(first.actor.actorId);
  for (const e of events) if (e.actor.role === "user") out.add(e.actor.actorId);
  return out;
}
