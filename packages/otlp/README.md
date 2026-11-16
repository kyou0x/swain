# @swain/otlp

Bounded decoders for OTLP/HTTP trace and log requests (SPEC-003 N1.2 JSON, N1.3 protobuf;
ADR-0006 section 3 and 6). Both decoders produce the same frozen model (`src/model.ts`,
`swain.otlp-decoded/1`) and the same `recordSha256` / `resourceSha256` / `scopeSha256` values
(`src/canonical.ts`), whatever the wire format. No runtime dependency, no protobuf library.

```ts
decodeTracesJson(body, opts?)      decodeLogsJson(body, opts?)
decodeTracesProtobuf(body, opts?)  decodeLogsProtobuf(body, opts?)
decodeOtlp("traces" | "logs", contentType, body, opts?)
```

`decodeOtlp` picks the decoder from an exact media type (`application/json` or
`application/x-protobuf`, ASCII case-insensitive). Well-formed parameters are tolerated; a JSON
`charset` must be `utf-8`. Anything else throws `UnsupportedContentTypeError` (code
`unsupported-content-type`, for the server to answer 415). The model's `DecodeErrorCode` is frozen,
so this is a separate typed error. Every other failure of any decoder is an `OtlpDecodeError`.

## Layout

| File                    | Role                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `src/json/*`            | N1.2 JSON decoder (unchanged behaviour)                        |
| `src/proto/wire.ts`     | wire-format scanner: one message level, no recursion           |
| `src/proto/decode.ts`   | schema-driven protobuf decoder, mirrors `json/decode.ts`       |
| `PIN.md`                | field numbers and the verification checklist (UNVERIFIED)      |
| `src/assemble.ts`       | wire-independent assembly shared by both decoders (see below)  |
| `src/dispatch.ts`       | `decodeOtlp`, `wireFormatOf`, `UnsupportedContentTypeError`    |
| `test/proto-encoder.ts` | TEST-ONLY protobuf encoder (not exported, not used at runtime) |

## Protobuf decoder: design decisions (for the G3-proto review)

### Shared assembly (the one refactor of N1.2 code)

Hash-before-truncation, truncation with dropped counts and `over-bounds` warnings, the
`time-inverted` warning, the `any-value-too-deep` rejection when the canonical form is deeper than
the core serializer allows, the final model shape and `guard` (only `OtlpDecodeError` escapes;
anything else becomes `internal`) were moved verbatim from `json/decode.ts` into `src/assemble.ts`
and are used by both decoders. Output equivalence therefore does not rest on two copies staying in
sync. The JSON decoder's behaviour and tests are unchanged.

### The scanner (`wire.ts`)

- Reads ONE message level into a flat `Field[]` (number, wire type, payload range or scalar value).
  A nested message is a LEN field whose range is recorded and scanned later by the caller; the
  scanner never recurses, and neither does any loop in the decoder except the bounded
  `readAnyValue` (below).
- Wire types: varint (0), 64-bit (1), LEN (2), 32-bit (5). Groups (3, 4) and 6, 7 are rejected,
  even as a well-formed start/end pair, and even inside an unknown field.
- Varint: at most 10 bytes, at most 64 bits. The 10th byte must be 0 or 1; that single rule
  rejects both an 11-byte varint (continuation bit on the 10th byte) and an overflowing value.
  Non-minimal encodings (`85 80 00` = 5) are accepted: they are legal protobuf and carry nothing.
- Tags: the tag varint must fit 32 bits; field number 0 and numbers above 2^29-1 are rejected.
- Numbers without BigInt in the common case (review F6): a varint below 2^53 (the first 7 bytes
  are accumulated as a plain number, which is exact) is returned as a number; only a value of
  2^53 or more takes the BigInt path, and the field then carries `n = -1` plus the exact `big`.
  A length or a tag at or above 2^53 is therefore rejected without ever being converted. This
  replaces the first version's "BigInt for every varint": the same checks, fewer allocations.
- LEN: the length is exact (below 2^53) and is compared with 2^31, then with the bytes remaining
  in the enclosing message, before any slice, copy or allocation. A declared length never drives
  an allocation. (The 2^31 check is redundant with the remaining-bytes check for any body under
  2 GiB; it is kept so a future larger body cap cannot silently remove the guarantee.)
- fixed64 is read as an unsigned value (number below 2^53, else BigInt); fixed32 as a number.
- Every malformation is a whole-request `invalid-structure` (the model has no protobuf-specific
  code and is frozen). Rationale: a bad frame means sender and decoder disagree on where fields
  start, so nothing else in the same request is trusted.
- Work bound: every scanned field (unknown ones included) costs one unit of a per-request budget
  of `maxValues` (default 1,000,000, the JSON decoder's value cap, same error `too-many-values`).
  Each field consumes at least one input byte, so scanning terminates, and a flood of tiny
  unknown fields stops after 1M units regardless of body size. Nothing is scanned twice: pass 1
  scans only the request, resource-group and scope-group levels and keeps the record ranges; pass
  2 scans each record, resource and scope exactly once. Lookups inside a message are single
  passes (`split`), so there is no quadratic step.

### Request walk (mirrors `json/decode.ts` `walk`)

1. Pass 1 (shape and counts only, so bounds errors do not depend on record contents):
   `too-many-resource-groups`, `too-many-scope-groups` (per resource group), `too-many-records`
   (total), all whole-request, in the same order as the JSON decoder. Duplicate singular fields in
   a request-level message (`ResourceSpans.resource` / `schema_url`, `ScopeSpans.scope` /
   `schema_url`) and a wrong wire type for a repeated container field are `invalid-structure`.
2. Pass 2: a bad resource or scope rejects every record below it with that reason (the group is
   omitted); a bad record is rejected alone and its siblings survive. Paths use repeated-field
   indexes (positions among the occurrences of that field, rejected siblings included), e.g.
   `/resourceSpans/0/scopeSpans/1/spans/3`.

### Error levels (same as JSON)

| Condition                                                                                   | Level   | Reason / code                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| truncated, bad varint, bad length, group or reserved wire type, field 0, field above 2^29-1 | request | `invalid-structure`                                                                                                                                                                              |
| field budget exhausted                                                                      | request | `too-many-values`                                                                                                                                                                                |
| body over `maxBodyBytes`; bad options; non-`Uint8Array`                                     | request | `body-too-large`; `invalid-option`; `invalid-structure`                                                                                                                                          |
| duplicate singular field inside a record (at any depth)                                     | record  | `duplicate-key`                                                                                                                                                                                  |
| duplicate singular field inside a resource or scope (at any depth)                          | group   | `duplicate-key`                                                                                                                                                                                  |
| duplicate singular field in a request-level message                                         | request | `invalid-structure`                                                                                                                                                                              |
| more than one `AnyValue` member, or none                                                    | record  | `invalid-any-value`                                                                                                                                                                              |
| ID of the wrong length, all zero (required ID absent too)                                   | record  | `invalid-trace-id`, `invalid-span-id`, `invalid-parent-span-id`                                                                                                                                  |
| invalid UTF-8                                                                               | record  | `invalid-string`                                                                                                                                                                                 |
| string over `maxStringBytes`, key over `maxKeyBytes`, bytes over `maxStringBytes`           | record  | `string-too-long`, `key-too-long`                                                                                                                                                                |
| time >= 2^63                                                                                | record  | `time-out-of-range`                                                                                                                                                                              |
| uint32 above 2^32-1 (dropped counts); enum out of range (negative included)                 | record  | `invalid-uint32`; `invalid-enum`                                                                                                                                                                 |
| NaN or infinite double                                                                      | record  | `invalid-double`                                                                                                                                                                                 |
| array or kvlist over `maxAnyValueEntries`                                                   | record  | `too-many-entries`                                                                                                                                                                               |
| AnyValue deeper than 16                                                                     | record  | `any-value-too-deep`                                                                                                                                                                             |
| known field with the wrong wire type                                                        | record  | `invalid-type`, or the type-specific code JSON would use (`invalid-int64` for a time, `invalid-uint32`, `invalid-enum`, `invalid-any-value` for a KeyValue or AnyValue, the ID reason for an ID) |

Known deviation: when a record has two defects, JSON reports the one it meets first in its fixed
field order after any duplicate key (it detects duplicates during parsing, before decoding). The
protobuf decoder decodes fields in the same fixed order, but discovers a duplicate in a nested
message only when it reaches that message. The set of rejected records is identical; the reason
code can differ for a record that is bad in two ways at once. After a record-level rejection the
rest of that record is not examined, so a wire-level defect after the first record-level defect is
not reported as a whole-request error (the record is rejected either way).

### Nesting

- `AnyValue` nesting: 16 accepted, 17 rejected (`any-value-too-deep`), as in JSON. `readAnyValue`
  is the only recursion; the depth is checked BEFORE descending, so a 100-level chain
  costs 17 frames at most and the rest of the record is never read.
- Message nesting is capped at 32 (`MAX_MESSAGE_DEPTH`; exceeding it is whole-request
  `invalid-structure`). The counter charges the structural messages (request 1, resource group 2,
  scope group 3, record 4, event / link / status / resource / scope 5, KeyValue next) plus ONE level
  per AnyValue level. `ArrayValue`, `KeyValueList` and the `KeyValue` inside a kvlist are charged to
  their AnyValue level, not separately.
  **Design choice to confirm:** charging the three wrapper messages of a kvlist level separately
  would make an AnyValue depth of 16 impossible within a cap of 32 (a depth-16 kvlist chain is
  about 53 messages deep), which contradicts "AnyValue depth 16 as in JSON". With this accounting
  the deepest legal input is 21 levels, so the cap of 32 is a backstop that the shipped schema
  cannot reach; `decodeTracesWith(body, opts, maxMessageDepth)` (internal, not exported from the
  package) lets the tests lower it to prove the check (a depth-16 span attribute needs 21, so cap
  21 accepts and cap 20 rejects). The requirement text "nesting depth 33 is rejected" is covered by
  AnyValue chains of 17, 33, 100 and 5,000 levels (record rejected, siblings kept, no stack growth).

### Duplicates, oneof, unknown fields

- proto3 would take the last value or merge; this decoder rejects a second occurrence of any known
  singular field (including a repeated oneof member). The JSON decoder rejects duplicate keys the
  same way (F13).
- Unknown field numbers are skipped for every wire type (and counted against the budget).
- Wire-order independence: fields may arrive in any order; repeated fields keep their order
  (attribute order is part of the hash).

### IDs, strings, numbers

- `trace_id` 16 bytes, `span_id` and `parent_span_id` 8 bytes, lowercase hex, never all zero.
  Empty or absent is "absent" only where JSON allows absence (span `parent_span_id`, log
  `trace_id` / `span_id`); for a span's own IDs and a link's IDs it is rejected.
- Strings: `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`. A leading U+FEFF is kept;
  overlong forms, encoded surrogates (CESU) and code points above U+10FFFF are rejected. Lone
  surrogates cannot occur in valid UTF-8.
- F10: the byte length is checked against `maxStringBytes` / `maxKeyBytes` BEFORE decoding, so an
  over-long string costs no decoding work. JSON checks validity first; a string that is both
  invalid UTF-8 and over the cap is therefore `string-too-long` here and `invalid-string` in JSON
  (the only reason-precedence difference this adds; the record is rejected either way).
- Times are fixed64 read unsigned; >= 2^63 is `time-out-of-range` for that record.
- `bytes_value` is a fresh copy, never a view of the request buffer. F1: a Node `Buffer` is a
  `Uint8Array` subclass whose `slice` returns a shared view, so the decoder first wraps the body in
  a plain `Uint8Array` over the same memory (`new Uint8Array(body.buffer, body.byteOffset,
  body.byteLength)`) and copies with `Uint8Array.prototype.slice.call`. The result is a plain
  `Uint8Array` that does not alias the input, for a `Buffer` with a non-zero `byteOffset` too
  (tested). The earlier text of this README claiming the copy was unconditional was wrong for
  `Buffer` input.
- The source never names `Buffer`; only `Uint8Array`, `DataView` and `TextDecoder`.

### Hashing

`finishSpan` / `finishLog` hash the fully decoded record with the existing canonical functions
BEFORE truncation (attributes, events, links), identically to JSON. The hash is wire-independent:
the differential tests assert equality of every hash.

## Tests

- `test/proto-differential.test.ts`: every JSON fixture (3 variants of encoding each), the hostile
  JSON fixtures that are representable in protobuf, and 3,000 + 3,000 seeded random valid
  structures: both decoders must return a deep-equal model (paths, hashes, warnings, rejections).
- `test/proto-malformed.test.ts`, `test/proto-bounds.test.ts`: hand-built hostile bytes for every
  rule above.
- `test/proto-fuzz.test.ts`: 10,000 seeded iterations (differential, field-level corruption,
  byte-level mutation, raw bytes); asserts no untyped throw, no `internal`, a per-iteration time
  budget (750 ms), and that every outcome is reached. `npm run fuzz:otlp [iterations] [seed]` runs
  the same iteration function 1,000,000 times by default.
- `test/dispatch.test.ts`: content-type dispatch.
- The encoder in `test/proto-encoder.ts` is test-only. It lives here, not in `contract-tests`,
  because `contract-tests` does not depend on `@swain/otlp` and the policy gate scans no test code.

## JSON decoder hardening (review items F2, F7, F8, F9)

- **F2.** Duplicate-key marking walks the open-container stack from the top and stops at the first
  already-marked ancestor (marking always covers a whole prefix of the stack), so the total cost
  is O(depth) per request-wide stack, not O(depth) per duplicate. Worst case measured (95 nested
  arrays plus 450k duplicate keys): 577 ms before, 127 ms after; the test bound is 3 s.
- **F7.** Integer fields (`intValue`, times, enums, `droppedXCount`, `flags`) accept INTEGER
  LITERALS only: `-?(0|[1-9][0-9]*)` with no fraction or exponent, judged from the literal text.
  The parser wraps every number whose literal has `.`, `e` or `E` in a `FloatLiteral` (an object, so
  every integer reader and `isObj` reject it), and only `doubleValue` unwraps it. So `1.0`, `1e3`,
  `1.0000000000000001`, `1e-400` and `9007199254740991.0000001` are all rejected as integers
  (`invalid-int64`, `invalid-enum`, `invalid-uint32` by field). Decision on `1e3`: rejected, even
  though it is exactly an integer, because "exactly an integer" is a property of the value and
  hiding the literal-versus-value distinction is what made `1e-400` and 17-digit fractions
  ambiguous; protobuf JSON emitters write integer fields as integer literals or decimal strings.
  Decimal STRINGS are unchanged. This tightens N1.2 behaviour; no existing test or fixture used an
  exponent or fraction form for an integer field.
- **F8.** A literal `-0` is normalised to `0` by the enum and uint32 readers (int64 goes through
  `BigInt`, which has no negative zero). Documented, not changed: `doubleValue` `0.0` and `-0.0`
  keep `0` and `-0` in the model (so the model is deep-unequal) but RFC 8785 serializes both as
  `0`, so their `recordSha256` values are equal: a `-0.0` record and a `0.0` record collide.
- **F9.** Fail closed on proto-name aliases. proto3 JSON parsers accept both `parentSpanId` and
  `parent_span_id`; this decoder reads only lowerCamelCase, so a record with `parent_span_id`
  would silently lose the parent. A record carrying a snake_case spelling of any known field
  (span, event, link, log record, AnyValue member, resource and scope fields) is rejected as
  `invalid-type` (the frozen `RejectReason` union has no dedicated member, so the nearest existing
  reason is reused). A request, resource-group or scope-group object carrying `resource_spans`,
  `scope_spans`, `log_records`, `schema_url` and the like is a whole-request `invalid-structure`
  (otherwise such a request would decode to an empty result).
- **F11.** `dispatch.ts` trims only SP and HTAB around the media type and parameters, folds case
  for ASCII only, and rejects NBSP, U+2028 and other Unicode spaces.

## Memory high-water (review item F6)

`test/heap.test.ts` runs each worst-case-density body at default limits in a fresh child process
(`test/heap-child.ts`, V8 old space capped at 1 GiB) and reads the process's peak RSS, which
includes every transient allocation. "Before" is the commit under review, "after" this change.
Peak RSS includes about 60 to 90 MB of node baseline and the body-construction buffers.

| Case (default limits)                                        | Body    | Peak RSS before | Peak RSS after |
| ------------------------------------------------------------ | ------- | --------------- | -------------- |
| protobuf: 330k minimal attributes on one span (~990k fields) | 1.9 MB  | 418 MB          | 393 to 414 MB  |
| protobuf: 990k empty unknown fields in a span                | 1.9 MB  | 206 MB          | 158 to 161 MB  |
| protobuf: 10,000 spans x 30 attributes                       | 2.0 MB  | 170 MB          | 168 to 230 MB  |
| protobuf: 320 attributes holding 1,024-entry arrays          | 1.3 MB  | 190 MB          | 186 to 189 MB  |
| JSON: 140k attributes (1M values)                            | 5.1 MB  | 321 MB          | 319 MB         |
| JSON: flat array of 990k numbers                             | 1.9 MB  | 120 MB          | 121 MB         |
| JSON: 10,000 spans x 30 attributes (over the value budget)   | 11.7 MB | 180 MB          | 188 MB         |

Reading: the worst case is about 400 MB of peak RSS for a 2 to 5 MB body; no case approaches the
1 GiB cap. Most of it is the decoded model itself (the record is decoded and hashed in FULL before
truncation, by design) and the canonical-JSON value built for the hash, not the scanner. The
scanner change (no BigInt per small varint, array-backed slot lookup instead of two `Map`s per
message) cut the unknown-field flood case by about 23% and left the model-bound cases unchanged
within noise. A larger reduction would need a streaming canonical hash, which is a change to the
frozen canonical form's implementation and is left to N1.5. The test bounds (900, 400, 400, 450,
700, 300, 400 MB) are about twice the measurement.

## Fuzz coverage (review item F6)

- The protobuf fuzz has six modes: differential on a valid structure, differential with ONE
  injected semantic defect (bad ID length, all-zero ID, enum or time out of range, uint32
  overflow, AnyValue depth 17 to 22, 1,025 entries, over-long key or string, value-less attribute;
  both decoders must still return deep-equal results, reasons included), field-level corruption
  (duplicate, drop, wrong wire type, bad field number, bad length, group wire types, overlong
  varint, truncation), FRAMING-PRESERVING payload mutation (the bytes inside a length-delimited
  field are edited and the enclosing length is re-encoded, so the damage reaches the nested
  decoders instead of a top-level framing error), byte-level edits, and raw bytes.
- Coverage per reject reason is recorded (`recordReasonCoverage`), and the long run lists the
  reasons it never reached. `invalid-base64` is JSON-only and `invalid-double` needs a NaN or
  infinite double, which JSON cannot express; both are covered by unit tests.
- The JSON fuzz (`test/fuzz.test.ts`) now asserts a 750 ms budget per iteration.

## N1.5 status (what the server did with the open items)

- **F3.** Still open. `PIN.md` is unverified, so `@swain/server` keeps protobuf OFF by default
  (415 with a static body that points exporters at `http/json`).
- **F4.** Closed in `@swain/db` (`sqlite/evidence.ts`): the dedup decision uses a domain-separated,
  length-prefixed digest over (recordSha256, resourceSha256, scopeSha256, resource schemaUrl,
  scope schemaUrl). A same-record resend under a different resource or scope is a conflict row.
  The digest is stored in the existing `record_sha256` columns (no DDL change).
- **F5.** Closed in `@swain/server`: `internal` is a static 500 and a counter, never a 400.
- **Sync decode on the event loop.** Accepted behind a decode-concurrency semaphore of 2, a server
  default `maxValues` of 250,000 and the 8 MiB / 32 MiB body caps. See `packages/server/README.md`.
