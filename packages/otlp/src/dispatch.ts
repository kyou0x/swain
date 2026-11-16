import { OtlpDecodeError } from "./errors.js";
import { decodeLogsJson, decodeTracesJson } from "./json/decode.js";
import type { DecodeLimits } from "./limits.js";
import type { DecodedLogs, DecodedTraces } from "./model.js";
import { decodeLogsProtobuf, decodeTracesProtobuf } from "./proto/decode.js";

/** The request content type is neither `application/json` nor `application/x-protobuf` (HTTP 415). */
export class UnsupportedContentTypeError extends Error {
  readonly code = "unsupported-content-type" as const;

  constructor() {
    super("unsupported-content-type");
    this.name = "UnsupportedContentTypeError";
  }
}

export type OtlpWire = "json" | "protobuf";

const MAX_CONTENT_TYPE_LENGTH = 256;
/** Trim only SP and HTAB (RFC 9110 OWS); `String.trim` also strips NBSP, U+2028 and other Unicode spaces. */
const trimOws = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, "");
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Pick the wire format from a `Content-Type` header value. The media type must be exactly
 * `application/json` or `application/x-protobuf` (ASCII case-insensitive, optional surrounding
 * blanks). Parameters are tolerated when well formed (`name=token` or `name="quoted"`), with one
 * restriction: a `charset` on JSON must be `utf-8`, because the decoder only reads UTF-8.
 * Anything else, including a list (`a, b`), an empty value or a suffix match such as
 * `application/jsonx`, throws `UnsupportedContentTypeError`.
 */
export function wireFormatOf(contentType: string): OtlpWire {
  if (typeof contentType !== "string" || contentType.length > MAX_CONTENT_TYPE_LENGTH) {
    throw new UnsupportedContentTypeError();
  }
  // Control characters (other than a tab) cannot appear in a valid header value.
  for (let i = 0; i < contentType.length; i++) {
    const c = contentType.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) throw new UnsupportedContentTypeError();
  }
  const parts = contentType.split(";");
  const media = asciiLower(trimOws(parts[0] ?? ""));
  let wire: OtlpWire;
  if (media === "application/json") wire = "json";
  else if (media === "application/x-protobuf") wire = "protobuf";
  else throw new UnsupportedContentTypeError();
  for (const raw of parts.slice(1)) {
    const eq = raw.indexOf("=");
    if (eq < 0) throw new UnsupportedContentTypeError();
    const name = asciiLower(trimOws(raw.slice(0, eq)));
    let value = trimOws(raw.slice(eq + 1));
    if (!TOKEN.test(name)) throw new UnsupportedContentTypeError();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
      if (value.includes('"') || value.includes("\\")) throw new UnsupportedContentTypeError();
    } else if (!TOKEN.test(value)) {
      throw new UnsupportedContentTypeError();
    }
    if (name === "charset" && wire === "json" && asciiLower(value) !== "utf-8") {
      throw new UnsupportedContentTypeError();
    }
  }
  return wire;
}

export function decodeOtlp(
  signal: "traces",
  contentType: string,
  body: Uint8Array,
  options?: Partial<DecodeLimits>,
): DecodedTraces;
export function decodeOtlp(
  signal: "logs",
  contentType: string,
  body: Uint8Array,
  options?: Partial<DecodeLimits>,
): DecodedLogs;
/**
 * Decode an OTLP request body by signal and content type. Throws `UnsupportedContentTypeError`
 * for an unsupported type and otherwise only `OtlpDecodeError`.
 */
export function decodeOtlp(
  signal: "traces" | "logs",
  contentType: string,
  body: Uint8Array,
  options?: Partial<DecodeLimits>,
): DecodedTraces | DecodedLogs {
  const wire = wireFormatOf(contentType);
  if (signal === "traces") {
    return wire === "json" ? decodeTracesJson(body, options) : decodeTracesProtobuf(body, options);
  }
  if (signal === "logs") {
    return wire === "json" ? decodeLogsJson(body, options) : decodeLogsProtobuf(body, options);
  }
  throw new OtlpDecodeError("invalid-option");
}
