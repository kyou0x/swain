import { OtlpDecodeError } from "./errors.js";

/** Decoder bounds (ADR-0006 section 6). Options may lower a default; they may not pass the hard max. */
export interface DecodeLimits {
  /** Decoded request body in bytes (after gzip). Default 32 MiB, hard max 64 MiB. */
  readonly maxBodyBytes: number;
  /** Structural JSON nesting. Default 96: 16 AnyValue levels cost up to 4 JSON levels each. */
  readonly maxJsonDepth: number;
  /** Total JSON values (containers, scalars and object keys) in the request. */
  readonly maxValues: number;
  readonly maxResourceGroups: number;
  /** Scope groups per resource group (not in ADR-0006; same default as resource groups). */
  readonly maxScopeGroups: number;
  /** Spans or log records per request. Default 10,000, hard max 50,000. */
  readonly maxRecords: number;
  /** Attributes per resource/scope/span/log/event/link. Truncated, not rejected. */
  readonly maxAttributes: number;
  readonly maxEvents: number;
  readonly maxLinks: number;
  /** Attribute key, in UTF-8 bytes. Over: the record is rejected. */
  readonly maxKeyBytes: number;
  /** Any other string, in UTF-8 bytes. Over: the record is rejected. */
  readonly maxStringBytes: number;
  /** AnyValue nesting; 16 is accepted, 17 is rejected. Fixed. */
  readonly maxAnyValueDepth: number;
  /** Entries of one array or kvlist value. Over: the record is rejected. */
  readonly maxAnyValueEntries: number;
}

export const DEFAULT_LIMITS: DecodeLimits = Object.freeze({
  maxBodyBytes: 32 * 1024 * 1024,
  maxJsonDepth: 96,
  maxValues: 1_000_000,
  maxResourceGroups: 1_000,
  maxScopeGroups: 1_000,
  maxRecords: 10_000,
  maxAttributes: 128,
  maxEvents: 128,
  maxLinks: 128,
  maxKeyBytes: 256,
  maxStringBytes: 1_048_576,
  maxAnyValueDepth: 16,
  maxAnyValueEntries: 1_024,
});

const HARD_MAX: DecodeLimits = Object.freeze({
  maxBodyBytes: 64 * 1024 * 1024,
  maxJsonDepth: 128,
  maxValues: 16_000_000,
  maxResourceGroups: 10_000,
  maxScopeGroups: 10_000,
  maxRecords: 50_000,
  maxAttributes: 1_024,
  maxEvents: 1_024,
  maxLinks: 1_024,
  maxKeyBytes: 1_024,
  maxStringBytes: 16 * 1024 * 1024,
  maxAnyValueDepth: 16,
  maxAnyValueEntries: 1_024,
});

const LIMIT_KEYS: readonly (keyof DecodeLimits)[] = [
  "maxBodyBytes",
  "maxJsonDepth",
  "maxValues",
  "maxResourceGroups",
  "maxScopeGroups",
  "maxRecords",
  "maxAttributes",
  "maxEvents",
  "maxLinks",
  "maxKeyBytes",
  "maxStringBytes",
  "maxAnyValueDepth",
  "maxAnyValueEntries",
];

/** Validate caller options; a bad option is a programmer error and throws `invalid-option`. */
export function resolveLimits(options: Partial<DecodeLimits> | undefined): DecodeLimits {
  if (options === undefined) return DEFAULT_LIMITS;
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const k of LIMIT_KEYS) {
    if (!Object.hasOwn(options, k)) continue;
    const v = options[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > HARD_MAX[k]) {
      throw new OtlpDecodeError("invalid-option");
    }
    out[k] = v;
  }
  return out as unknown as DecodeLimits;
}
