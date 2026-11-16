export const ATM_ERROR_CODES = [
  "invalid-id-component",
  "invalid-option",
  "unsupported-schema-version",
  "json-depth-exceeded",
  "json-cycle",
  "json-non-finite",
  "json-unsupported-type",
  "json-ill-formed-string",
  "source-unreadable",
  "not-regular-file",
  "file-too-large",
  "source-changed-during-import",
  "zstd-unavailable",
] as const;

export type AtmErrorCode = (typeof ATM_ERROR_CODES)[number];

/** Typed error. Messages are static; they never contain untrusted data. */
export class AtmError extends Error {
  readonly code: AtmErrorCode;

  constructor(code: AtmErrorCode) {
    super(code);
    this.name = "AtmError";
    this.code = code;
  }
}
