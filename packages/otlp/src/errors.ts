import type { DecodeErrorCode, PartialSuccess, RejectedRecord } from "./model.js";

/** The only error a decoder throws (ADR-0006 section 3). Carries a static code, never input. */
export class OtlpDecodeError extends Error {
  readonly code: DecodeErrorCode;

  constructor(code: DecodeErrorCode) {
    super(code);
    this.name = "OtlpDecodeError";
    this.code = code;
  }
}

/** `partialSuccess` for a response, or `null` when no record was rejected. */
export function partialSuccessOf(rejected: readonly RejectedRecord[]): PartialSuccess | null {
  const first = rejected[0];
  if (first === undefined) return null;
  return { rejected: rejected.length, errorMessage: first.reason };
}
