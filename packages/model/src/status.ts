/**
 * Run status (ADR-0005 section 4): computed at read time from evidence plus an injected clock,
 * never stored as fact. Pure: `nowMs` is a parameter, nothing here reads a clock.
 */
import { AtmError } from "@swain/core";

export type RunStatus = "active" | "idle" | "ended" | "incomplete";

export const DEFAULT_IDLE_WINDOW_MS = 300_000;

export interface RunEvidence {
  /** Server receive time (ms) of the newest record, or `null` when none. */
  readonly lastReceivedMs: number | null;
  /** All root spans have `endTimeUnixNano` (and there is at least one), or an ADR-0002 `session.ended`. */
  readonly endEvidence: boolean;
  /** Spans whose parent has not been received. */
  readonly missingParents: number;
  /** ADR-0002 `capture.gap` events. */
  readonly captureGaps: number;
  readonly unresolvedReferences: number;
  /** A span with `status.code = ERROR`, `tool.failed`, or a normalized operation error. */
  readonly errorEvidence: boolean;
  /** Receive time (ms) of the end evidence, when known; later records are "late". */
  readonly endedReceivedMs?: number | null;
}

export interface RunStatusResult {
  readonly status: RunStatus;
  /** `error` is a flag, not a status (ADR-0005 section 4). */
  readonly error: boolean;
  /** Data was accepted after the run ended. */
  readonly late: boolean;
}

function finite(n: number, min: number): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < min) throw new AtmError("invalid-option");
  return n;
}

export function computeRunStatus(
  ev: RunEvidence,
  nowMs: number,
  idleWindowMs: number = DEFAULT_IDLE_WINDOW_MS,
): RunStatusResult {
  finite(nowMs, 0);
  finite(idleWindowMs, 0);
  if (ev.lastReceivedMs !== null) finite(ev.lastReceivedMs, 0);
  const late =
    ev.endEvidence &&
    ev.lastReceivedMs !== null &&
    ev.endedReceivedMs !== undefined &&
    ev.endedReceivedMs !== null &&
    ev.lastReceivedMs > ev.endedReceivedMs;
  let status: RunStatus;
  if (ev.endEvidence) {
    status =
      ev.missingParents > 0 || ev.captureGaps > 0 || ev.unresolvedReferences > 0
        ? "incomplete"
        : "ended";
  } else if (ev.lastReceivedMs !== null && nowMs - ev.lastReceivedMs <= idleWindowMs) {
    status = "active";
  } else {
    status = "idle";
  }
  return { status, error: ev.errorEvidence, late };
}

/** The part of a stored span the status evidence needs. */
export interface SpanStatusFact {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly endTimeUnixNano: bigint;
  readonly statusCode: 0 | 1 | 2;
  readonly receivedMs: number;
}

/** Derive `RunEvidence` for a trace run from its span records. */
export function traceRunEvidence(spans: readonly SpanStatusFact[]): RunEvidence {
  const ids = new Set(spans.map((s) => s.spanId));
  const roots = spans.filter((s) => s.parentSpanId === null);
  let last: number | null = null;
  for (const s of spans) if (last === null || s.receivedMs > last) last = s.receivedMs;
  return {
    lastReceivedMs: last,
    endEvidence: roots.length > 0 && roots.every((r) => r.endTimeUnixNano > 0n),
    missingParents: spans.filter((s) => s.parentSpanId !== null && !ids.has(s.parentSpanId)).length,
    captureGaps: 0,
    unresolvedReferences: 0,
    errorEvidence: spans.some((s) => s.statusCode === 2),
  };
}
