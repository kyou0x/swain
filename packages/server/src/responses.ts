/**
 * Response bodies. JSON is the default; the protobuf forms exist only for the
 * `allowUnverifiedProtobuf` option and use field numbers that are UNVERIFIED
 * (`packages/otlp/PIN.md`): `Status.code = 1`, `Status.message = 2`,
 * `Export*ServiceResponse.partial_success = 1`, `*PartialSuccess.rejected_* = 1`,
 * `*PartialSuccess.error_message = 2`.
 */
import { ERRORS, type ErrorCode } from "./errors.js";
import type { Signal } from "./ingest.js";

const encoder = new TextEncoder();

function varint(n: number, out: number[]): void {
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

function field(num: number, wire: 0 | 2, payload: Uint8Array | number, out: number[]): void {
  varint(num * 8 + wire, out);
  if (typeof payload === "number") {
    varint(payload, out);
    return;
  }
  varint(payload.length, out);
  for (const b of payload) out.push(b);
}

export interface Rendered {
  readonly contentType: string;
  readonly body: Uint8Array;
}

const JSON_TYPE = "application/json";
const PROTO_TYPE = "application/x-protobuf";

/** `{"code": <google.rpc.Code>, "message": "<static>"}` or its protobuf form, for `/v1/*` errors. */
export function renderOtlpError(code: ErrorCode, protobuf: boolean): Rendered {
  const spec = ERRORS[code];
  if (protobuf) {
    const out: number[] = [];
    field(1, 0, spec.grpc, out);
    field(2, 2, encoder.encode(spec.message), out);
    return { contentType: PROTO_TYPE, body: Uint8Array.from(out) };
  }
  return {
    contentType: JSON_TYPE,
    body: encoder.encode(JSON.stringify({ code: spec.grpc, message: spec.message })),
  };
}

/** `{"error":{"code","message"}}` for `/api/*`, `/healthz` and the rest. */
export function renderApiError(code: ErrorCode): Rendered {
  const spec = ERRORS[code];
  return {
    contentType: JSON_TYPE,
    body: encoder.encode(JSON.stringify({ error: { code, message: spec.message } })),
  };
}

export function renderJson(v: unknown): Rendered {
  return { contentType: JSON_TYPE, body: encoder.encode(JSON.stringify(v)) };
}

/** An `Export*ServiceResponse`: empty on full success, `partialSuccess` when records were rejected. */
export function renderExportResponse(
  signal: Signal,
  rejected: number,
  errorMessage: string | null,
  protobuf: boolean,
): Rendered {
  if (protobuf) {
    if (rejected === 0) return { contentType: PROTO_TYPE, body: new Uint8Array(0) };
    const inner: number[] = [];
    field(1, 0, rejected, inner);
    field(2, 2, encoder.encode(errorMessage ?? ""), inner);
    const out: number[] = [];
    field(1, 2, Uint8Array.from(inner), out);
    return { contentType: PROTO_TYPE, body: Uint8Array.from(out) };
  }
  if (rejected === 0) return renderJson({});
  const key = signal === "traces" ? "rejectedSpans" : "rejectedLogRecords";
  // int64 is a decimal string in the OTLP JSON mapping
  return renderJson({
    partialSuccess: { [key]: String(rejected), errorMessage: errorMessage ?? "" },
  });
}
