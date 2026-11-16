import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeLogsJson,
  decodeLogsProtobuf,
  decodeOtlp,
  decodeTracesJson,
  decodeTracesProtobuf,
  OtlpDecodeError,
  UnsupportedContentTypeError,
  wireFormatOf,
} from "../src/index.js";
import { fixture } from "./helpers.js";
import { encodeLogs, encodeTraces } from "./proto-encoder.js";

const text = new TextDecoder();
const tracesJson = fixture("traces-genai.json");
const logsJson = fixture("logs-claude-code.json");
const tracesProto = encodeTraces(JSON.parse(text.decode(tracesJson)) as unknown);
const logsProto = encodeLogs(JSON.parse(text.decode(logsJson)) as unknown);

test("dispatch picks the decoder from the exact content type", () => {
  assert.deepEqual(
    decodeOtlp("traces", "application/json", tracesJson),
    decodeTracesJson(tracesJson),
  );
  assert.deepEqual(
    decodeOtlp("traces", "application/x-protobuf", tracesProto),
    decodeTracesProtobuf(tracesProto),
  );
  assert.deepEqual(decodeOtlp("logs", "application/json", logsJson), decodeLogsJson(logsJson));
  assert.deepEqual(
    decodeOtlp("logs", "application/x-protobuf", logsProto),
    decodeLogsProtobuf(logsProto),
  );
  // same bytes through the two routes give the same model
  assert.deepEqual(
    decodeOtlp("traces", "application/x-protobuf", tracesProto),
    decodeOtlp("traces", "application/json", tracesJson),
  );
});

test("parameters such as charset are tolerated; the media type is case-insensitive", () => {
  for (const ct of [
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    'application/json; charset="utf-8"',
    "APPLICATION/JSON",
    "  application/json  ",
    "application/json; charset=utf-8; foo=bar",
  ]) {
    assert.equal(wireFormatOf(ct), "json", ct);
  }
  for (const ct of [
    "application/x-protobuf",
    "application/x-protobuf; charset=utf-8",
    "application/x-protobuf;proto=opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
    "Application/X-Protobuf",
  ]) {
    assert.equal(wireFormatOf(ct), "protobuf", ct);
  }
});

test("other content types are rejected with a typed error", () => {
  for (const ct of [
    "",
    "text/plain",
    "application/jsonx",
    "application/json5",
    "application/x-protobufx",
    "application/protobuf",
    "application/octet-stream",
    "application/grpc",
    "application/json, application/x-protobuf",
    "application/json; charset=latin1",
    "application/json; charset",
    "application/json; =x",
    "application/json; a=b c",
    'application/json; a="b',
    "multipart/form-data; boundary=x; application/json",
    "x".repeat(300),
    "application/json\n",
  ]) {
    assert.throws(
      () => decodeOtlp("traces", ct, tracesJson),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedContentTypeError, `${JSON.stringify(ct)}: ${String(e)}`);
        assert.equal(e.code, "unsupported-content-type");
        return true;
      },
      JSON.stringify(ct),
    );
  }
  assert.throws(() => wireFormatOf(undefined as unknown as string), UnsupportedContentTypeError);
});

test("dispatch passes limits through and keeps decode errors typed", () => {
  assert.throws(
    () => decodeOtlp("traces", "application/x-protobuf", tracesProto, { maxBodyBytes: 4 }),
    (e: unknown) => e instanceof OtlpDecodeError && e.code === "body-too-large",
  );
  assert.throws(
    () => decodeOtlp("logs", "application/json", new Uint8Array([0x7b]), undefined),
    (e: unknown) => e instanceof OtlpDecodeError && e.code === "malformed-json",
  );
  assert.throws(
    () => decodeOtlp("metrics" as unknown as "traces", "application/json", tracesJson),
    (e: unknown) => e instanceof OtlpDecodeError && e.code === "invalid-option",
  );
});

test("F11: only SP and HTAB are trimmed around the media type and parameters", () => {
  assert.equal(wireFormatOf("\tapplication/json \t"), "json");
  assert.equal(wireFormatOf("application/json ;\tcharset = utf-8"), "json");
  for (const ct of [
    "\u00a0application/json",
    "application/json\u00a0",
    "\u2028application/json",
    "application/json\u2003",
    "\ufeffapplication/json",
    "application/json; charset=utf-8\u00a0",
    "application/json;\u00a0charset=utf-8",
    "application/x-protobuf\u0085",
  ]) {
    assert.throws(() => wireFormatOf(ct), UnsupportedContentTypeError, JSON.stringify(ct));
  }
  // ASCII-only case folding: the Kelvin sign is not a K
  assert.throws(
    () => wireFormatOf("application/x-protobuf; \u212aey=v"),
    UnsupportedContentTypeError,
  );
});
