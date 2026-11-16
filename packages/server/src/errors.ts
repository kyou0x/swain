/**
 * The closed table of error codes (SPEC-003 section 3.1, ADR-0006 section 1 and section 5a).
 *
 * Every message is static text. No error ever echoes input: not a header value, a path, an ID, an
 * attribute or a decoder message. `grpc` is the `google.rpc.Code` used in the `Status`-shaped body
 * of `/v1/*` errors (the JSON shape of that body is UNVERIFIED in OTF section 2, so exporters must,
 * and do, act on the HTTP status only).
 */
export interface ErrorSpec {
  readonly status: number;
  readonly grpc: number;
  readonly message: string;
}

export const ERRORS = {
  "bad-request": { status: 400, grpc: 3, message: "The request is malformed." },
  "invalid-otlp": {
    status: 400,
    grpc: 3,
    message: "The request body is not a valid OTLP export request.",
  },
  "too-many-records": {
    status: 400,
    grpc: 3,
    message: "The request carries more records or groups than the server accepts.",
  },
  "too-many-values": {
    status: 400,
    grpc: 3,
    message: "The request carries more values than the server accepts.",
  },
  "key-in-query": {
    status: 400,
    grpc: 3,
    message: "Keys are accepted only in the Authorization header.",
  },
  "cookie-on-ingest": {
    status: 400,
    grpc: 3,
    message: "Ingest requests must not carry cookies.",
  },
  "absolute-form": {
    status: 400,
    grpc: 3,
    message: "Absolute-form request targets are not accepted.",
  },
  unauthenticated: { status: 401, grpc: 16, message: "Authentication is required." },
  forbidden: { status: 403, grpc: 7, message: "The credential does not allow this request." },
  csrf: {
    status: 403,
    grpc: 7,
    message: "The request failed the cross-origin or CSRF check.",
  },
  "not-found": { status: 404, grpc: 5, message: "Not found." },
  "method-not-allowed": { status: 405, grpc: 3, message: "Method not allowed." },
  "payload-too-large": { status: 413, grpc: 8, message: "The request body is too large." },
  "unsupported-media-type": {
    status: 415,
    grpc: 3,
    message:
      "This route accepts application/json only. Configure the exporter with OTEL_EXPORTER_OTLP_PROTOCOL=http/json.",
  },
  "unsupported-encoding": {
    status: 415,
    grpc: 3,
    message: "Content-Encoding must be absent, identity or gzip.",
  },
  misdirected: { status: 421, grpc: 3, message: "Misdirected request." },
  "rate-limited": { status: 429, grpc: 8, message: "Too many requests." },
  internal: { status: 500, grpc: 13, message: "Internal error." },
  busy: { status: 503, grpc: 14, message: "The server is busy. Retry later." },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERRORS;

/** Startup failures of `createSwainServer`, with static messages (the CLI maps them to exit codes). */
export const SERVER_ERROR_CODES = [
  /** `host` is not the literal `127.0.0.1` or `::1`; raised before any socket is opened (exit 2). */
  "bind-not-loopback",
  /** `EADDRINUSE` on either family (exit 7). */
  "port-held",
  /** `server.address()` is not what was requested (exit 1). */
  "bind-address-mismatch",
  /** `EADDRNOTAVAIL`: the family is not available (IPv6 disabled). Not fatal for `::1`. */
  "address-unavailable",
  /** Any other failure to listen. */
  "bind-failed",
  "invalid-option",
] as const;
export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];

export class SwainServerError extends Error {
  readonly code: ServerErrorCode;
  /** Which family failed, for `port-held` ("127.0.0.1" or "::1"). */
  readonly family: "127.0.0.1" | "::1" | null;

  constructor(code: ServerErrorCode, family: "127.0.0.1" | "::1" | null = null) {
    super(code);
    this.name = "SwainServerError";
    this.code = code;
    this.family = family;
  }
}
