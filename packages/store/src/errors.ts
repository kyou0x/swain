/** Typed store errors. Messages are static codes; they never contain paths or source data. */
export const STORE_ERROR_CODES = [
  "locked",
  "corrupt",
  "symlink",
  "io",
  "invalid-root",
  "too-large",
  "invalid-result",
] as const;
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode) {
    super(code);
    this.name = "StoreError";
    this.code = code;
  }
}

export const OUTPUT_REFUSED_CODES = [
  "exists",
  "symlink",
  "parent-invalid",
  "not-regular",
  "not-marked",
  "too-large",
  "invalid-path",
  "invalid-name",
  "stale-temp",
  "io",
] as const;
export type OutputRefusedCode = (typeof OUTPUT_REFUSED_CODES)[number];

/** Output confinement refusal (CLI exit 5). */
export class OutputRefused extends Error {
  readonly code: OutputRefusedCode;
  constructor(code: OutputRefusedCode) {
    super(code);
    this.name = "OutputRefused";
    this.code = code;
  }
}
