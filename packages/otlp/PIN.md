# Protobuf field-number pin (SPEC-003 N1.3, ADR-0006 section 3)

**STATUS: UNVERIFIED. These numbers were written from the author's memory of
`opentelemetry-proto`. The implementation environment had no network access, so no upstream
`.proto` file was read and no file SHA-256 could be computed. They MUST be checked against the
upstream `.proto` files before gate G3-proto.** A wrong number is not caught by this repository's
tests: the test-only encoder (`test/proto-encoder.ts`) was written by the same author from the same
memory, so the differential test proves internal consistency, not conformance.

Believed proto version: **opentelemetry-proto v1.8.x** (the 2025 series; `LogRecord.event_name`
arrived in the v1.8 line, `Span.flags` / `Span.Link.flags` in v1.2-v1.3). The exact tag to pin
is to be chosen when verifying; record the tag and the SHA-256 of each file here:

| File                                                         | SHA-256 at the pinned tag         |
| ------------------------------------------------------------ | --------------------------------- |
| `opentelemetry/proto/collector/trace/v1/trace_service.proto` | _to be filled in at verification_ |
| `opentelemetry/proto/collector/logs/v1/logs_service.proto`   | _to be filled in at verification_ |
| `opentelemetry/proto/trace/v1/trace.proto`                   | _to be filled in at verification_ |
| `opentelemetry/proto/logs/v1/logs.proto`                     | _to be filled in at verification_ |
| `opentelemetry/proto/common/v1/common.proto`                 | _to be filled in at verification_ |
| `opentelemetry/proto/resource/v1/resource.proto`             | _to be filled in at verification_ |

## Field numbers used by the decoder

Wire types: V = varint, I64 = fixed64, L = length-delimited, I32 = fixed32.
"Unsure" marks entries whose number or wire type the author is less than certain of.

### Collector

| Message                     | Field                                       | #   | Wire | Notes |
| --------------------------- | ------------------------------------------- | --- | ---- | ----- |
| `ExportTraceServiceRequest` | `resource_spans` (repeated `ResourceSpans`) | 1   | L    |       |
| `ExportLogsServiceRequest`  | `resource_logs` (repeated `ResourceLogs`)   | 1   | L    |       |

### Trace

| Message         | Field                                                           | #      | Wire    | Notes                                                                                                            |
| --------------- | --------------------------------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `ResourceSpans` | `resource`                                                      | 1      | L       |                                                                                                                  |
|                 | `scope_spans` (repeated)                                        | 2      | L       |                                                                                                                  |
|                 | `schema_url`                                                    | 3      | L       |                                                                                                                  |
|                 | (`instrumentation_library_spans`, field 1000, removed upstream) | n/a    | n/a     | not read; skipped as unknown                                                                                     |
| `ScopeSpans`    | `scope`                                                         | 1      | L       |                                                                                                                  |
|                 | `spans` (repeated)                                              | 2      | L       |                                                                                                                  |
|                 | `schema_url`                                                    | 3      | L       |                                                                                                                  |
| `Span`          | `trace_id`                                                      | 1      | L       | 16 bytes                                                                                                         |
|                 | `span_id`                                                       | 2      | L       | 8 bytes                                                                                                          |
|                 | `trace_state`                                                   | 3      | L       |                                                                                                                  |
|                 | `parent_span_id`                                                | 4      | L       | 8 bytes, empty = root                                                                                            |
|                 | `flags`                                                         | **16** | **I32** | fixed32. **UNSURE** (number 16 and fixed32; added after the original field set, which is why it is out of order) |
|                 | `name`                                                          | 5      | L       |                                                                                                                  |
|                 | `kind`                                                          | 6      | V       | enum, 0..5                                                                                                       |
|                 | `start_time_unix_nano`                                          | 7      | I64     | fixed64                                                                                                          |
|                 | `end_time_unix_nano`                                            | 8      | I64     | fixed64                                                                                                          |
|                 | `attributes` (repeated `KeyValue`)                              | 9      | L       |                                                                                                                  |
|                 | `dropped_attributes_count`                                      | 10     | V       | uint32                                                                                                           |
|                 | `events` (repeated `Span.Event`)                                | 11     | L       |                                                                                                                  |
|                 | `dropped_events_count`                                          | 12     | V       | uint32                                                                                                           |
|                 | `links` (repeated `Span.Link`)                                  | 13     | L       |                                                                                                                  |
|                 | `dropped_links_count`                                           | 14     | V       | uint32                                                                                                           |
|                 | `status`                                                        | 15     | L       |                                                                                                                  |
| `Span.Event`    | `time_unix_nano`                                                | 1      | I64     | fixed64                                                                                                          |
|                 | `name`                                                          | 2      | L       |                                                                                                                  |
|                 | `attributes` (repeated)                                         | 3      | L       |                                                                                                                  |
|                 | `dropped_attributes_count`                                      | 4      | V       | uint32                                                                                                           |
| `Span.Link`     | `trace_id`                                                      | 1      | L       | 16 bytes                                                                                                         |
|                 | `span_id`                                                       | 2      | L       | 8 bytes                                                                                                          |
|                 | `trace_state`                                                   | 3      | L       |                                                                                                                  |
|                 | `attributes` (repeated)                                         | 4      | L       |                                                                                                                  |
|                 | `dropped_attributes_count`                                      | 5      | V       | uint32                                                                                                           |
|                 | `flags`                                                         | **6**  | **I32** | fixed32. **UNSURE** (number 6 and fixed32)                                                                       |
| `Status`        | `message`                                                       | 2      | L       | field 1 (`deprecated_code`) is reserved upstream and is skipped as unknown                                       |
|                 | `code`                                                          | 3      | V       | enum, 0..2                                                                                                       |

### Logs

| Message        | Field                      | #      | Wire    | Notes                                                                                              |
| -------------- | -------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------- |
| `ResourceLogs` | `resource`                 | 1      | L       |                                                                                                    |
|                | `scope_logs` (repeated)    | 2      | L       |                                                                                                    |
|                | `schema_url`               | 3      | L       |                                                                                                    |
| `ScopeLogs`    | `scope`                    | 1      | L       |                                                                                                    |
|                | `log_records` (repeated)   | 2      | L       |                                                                                                    |
|                | `schema_url`               | 3      | L       |                                                                                                    |
| `LogRecord`    | `time_unix_nano`           | 1      | I64     | fixed64                                                                                            |
|                | `severity_number`          | 2      | V       | enum, 0..24                                                                                        |
|                | `severity_text`            | 3      | L       |                                                                                                    |
|                | `body` (`AnyValue`)        | 5      | L       | field 4 is skipped (reserved upstream, formerly `name`). **UNSURE** that 4 is unused and body is 5 |
|                | `attributes` (repeated)    | 6      | L       |                                                                                                    |
|                | `dropped_attributes_count` | 7      | V       | uint32                                                                                             |
|                | `flags`                    | **8**  | **I32** | fixed32. **UNSURE** (number 8 and fixed32)                                                         |
|                | `trace_id`                 | 9      | L       | 16 bytes, empty = absent                                                                           |
|                | `span_id`                  | 10     | L       | 8 bytes, empty = absent                                                                            |
|                | `observed_time_unix_nano`  | 11     | I64     | fixed64                                                                                            |
|                | `event_name`               | **12** | **L**   | string. **UNSURE** (number 12; the version that introduced it)                                     |

### Common and resource

| Message                    | Field                          | #   | Wire | Notes                                                                |
| -------------------------- | ------------------------------ | --- | ---- | -------------------------------------------------------------------- |
| `Resource`                 | `attributes` (repeated)        | 1   | L    |                                                                      |
|                            | `dropped_attributes_count`     | 2   | V    | uint32. (`entity_refs`, 3 in recent versions, is skipped as unknown) |
| `InstrumentationScope`     | `name`                         | 1   | L    |                                                                      |
|                            | `version`                      | 2   | L    |                                                                      |
|                            | `attributes` (repeated)        | 3   | L    |                                                                      |
|                            | `dropped_attributes_count`     | 4   | V    | uint32                                                               |
| `KeyValue`                 | `key`                          | 1   | L    |                                                                      |
|                            | `value` (`AnyValue`)           | 2   | L    |                                                                      |
| `AnyValue` (oneof `value`) | `string_value`                 | 1   | L    |                                                                      |
|                            | `bool_value`                   | 2   | V    |                                                                      |
|                            | `int_value`                    | 3   | V    | int64 (two's complement in 10 bytes when negative)                   |
|                            | `double_value`                 | 4   | I64  | IEEE 754 binary64, little endian                                     |
|                            | `array_value`                  | 5   | L    |                                                                      |
|                            | `kvlist_value`                 | 6   | L    |                                                                      |
|                            | `bytes_value`                  | 7   | L    |                                                                      |
| `ArrayValue`               | `values` (repeated `AnyValue`) | 1   | L    |                                                                      |
| `KeyValueList`             | `values` (repeated `KeyValue`) | 1   | L    |                                                                      |

## Items to verify before G3-proto

1. Every number and wire type above against the upstream `.proto` files at the chosen tag, and the
   tag itself (record tag plus the six SHA-256 values in the table at the top).
2. Specifically the unsure items: `Span.flags` = 16 (fixed32), `Span.Link.flags` = 6 (fixed32),
   `LogRecord.flags` = 8 (fixed32), `LogRecord.event_name` = 12 (string), `LogRecord.body` = 5 with
   field 4 unused, `Status.code` = 3 and `Status.message` = 2.
3. `AnyValue` member numbers (`bytes_value` = 7 sits after the two composite members, which is easy
   to get wrong from memory).
4. A reference encoding produced by an independent OpenTelemetry SDK (for example the Python or
   Go OTLP/HTTP exporter, writing one trace and one log record to a file with no network) added as a
   fixture whose decoded model is checked by hand. ADR-0006 asks for this "fixture test built from
   a reference encoding"; it could not be produced here.
5. Fields added after the pinned tag are skipped as unknown fields, which is the intended
   forward-compatible behaviour.
