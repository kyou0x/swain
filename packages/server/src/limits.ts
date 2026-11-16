import { SwainServerError } from "./errors.js";

const MIB = 1024 * 1024;

/** Server bounds (ADR-0006 section 6). Options may lower a default; none may pass its hard max. */
export interface ServerLimits {
  /** Request body as received. Default 8 MiB, hard max 64 MiB. */
  readonly maxBodyBytes: number;
  /** Decoded body after gunzip. Default 32 MiB, hard max 64 MiB. */
  readonly maxDecodedBytes: number;
  /**
   * Decoded values per request, handed to the decoders as `maxValues`. Default 250,000 (the
   * decoder's own default is 1,000,000): the G3-proto memory precondition. Hard max 1,000,000.
   */
  readonly maxValues: number;
  /** Spans or log records per request. Default 10,000, hard max 50,000. */
  readonly maxRecords: number;
  /** Concurrent authenticated requests holding a slot. Default 32. */
  readonly inFlight: number;
  /**
   * Requests that may be reading a body or decoding at once, separate from `inFlight`. Default 2.
   * It bounds peak memory: bodies and decoded models of at most this many requests are alive.
   */
  readonly decodeConcurrency: number;
  readonly maxConnections: number;
  /** Global bucket for every unauthenticated failure: 5/s, burst 20. */
  readonly unauthBurst: number;
  readonly unauthPerSec: number;
  /** Per-key bucket (requests): 20/s, burst 100. */
  readonly keyBurst: number;
  readonly keyPerSec: number;
  /** Decoded bytes per key per minute. Default 64 MiB. */
  readonly keyBytesPerMinute: number;
}

export const DEFAULT_SERVER_LIMITS: ServerLimits = Object.freeze({
  maxBodyBytes: 8 * MIB,
  maxDecodedBytes: 32 * MIB,
  maxValues: 250_000,
  maxRecords: 10_000,
  inFlight: 32,
  decodeConcurrency: 2,
  maxConnections: 256,
  unauthBurst: 20,
  unauthPerSec: 5,
  keyBurst: 100,
  keyPerSec: 20,
  keyBytesPerMinute: 64 * MIB,
});

const HARD_MAX: Partial<Record<keyof ServerLimits, number>> = {
  maxBodyBytes: 64 * MIB,
  maxDecodedBytes: 64 * MIB,
  maxValues: 1_000_000,
  maxRecords: 50_000,
  maxConnections: 4096,
};

/** Validate caller limits. A bad value is a programming error: `invalid-option`. */
export function resolveServerLimits(over: Partial<ServerLimits> | undefined): ServerLimits {
  if (over === undefined) return DEFAULT_SERVER_LIMITS;
  const out: Record<string, number> = { ...DEFAULT_SERVER_LIMITS };
  for (const k of Object.keys(DEFAULT_SERVER_LIMITS) as (keyof ServerLimits)[]) {
    if (!Object.hasOwn(over, k)) continue;
    const v = over[k];
    if (v === undefined) continue;
    const max = HARD_MAX[k] ?? Number.MAX_SAFE_INTEGER;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) {
      throw new SwainServerError("invalid-option");
    }
    out[k] = v;
  }
  return out as unknown as ServerLimits;
}
