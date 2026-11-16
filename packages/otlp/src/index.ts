export const PACKAGE_NAME = "@swain/otlp";

export {
  base64Encode,
  canonicalLogRecordJson,
  canonicalSpanJson,
  logRecordSha256,
  resourceSha256,
  scopeSha256,
  spanRecordSha256,
} from "./canonical.js";
export type { OtlpWire } from "./dispatch.js";
export { decodeOtlp, UnsupportedContentTypeError, wireFormatOf } from "./dispatch.js";
export { OtlpDecodeError, partialSuccessOf } from "./errors.js";
export { decodeLogsJson, decodeTracesJson } from "./json/decode.js";
export type { DecodeLimits } from "./limits.js";
export { DEFAULT_LIMITS } from "./limits.js";
export * from "./model.js";
export { decodeLogsProtobuf, decodeTracesProtobuf } from "./proto/decode.js";
