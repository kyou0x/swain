# @swain/server

`createSwainServer(options)` is the loopback HTTP server of SPEC-003 N1.5: OTLP/HTTP ingest of
traces and logs into `@swain/db`. It is a library; `swain serve` wiring, web pages, login and
cookies, `/api/v1/ingest/events` and `/api/v1/ingest/sources` are NOT implemented here.

## Endpoints

- `POST /v1/traces`, `POST /v1/logs`: Bearer `swn_...` key with scope `ingest:otlp`. Replies `{}`
  or `{"partialSuccess":{"rejectedSpans":"N","errorMessage":"..."}}` (logs: `rejectedLogRecords`).
- `POST /v1/metrics`: always 404.
- `POST /api/v1/server-proof`: unauthenticated by design (ADR-0006 section 8), static 401 for an
  unknown or revoked key, one global-bucket token per call.
- `GET /api/v1/status` (key with `read:status` or an ingest scope), `GET /healthz`.

## Switch exporters to http/json

Protobuf is DISABLED by default because its field numbers are unverified (`packages/otlp/PIN.md`).
A protobuf request gets `415` with a static message. Configure the exporter with
`OTEL_EXPORTER_OTLP_PROTOCOL=http/json` (and `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>`,
header `Authorization=Bearer swn_...`). Option `allowUnverifiedProtobuf: true` enables protobuf
only after PIN.md has been verified. It is an in-code option and a strict `=== true` check: it is not
read from any environment variable, argument or configuration file (a test enforces this).
**No CLI flag may set it until G3-proto passes with a verified `PIN.md`.**

## Processing order (ADR-0006 section 5a)

Documented step by step at the top of `src/server.ts` (steps 1-10). Unauthenticated requests never
hold a slot and their bodies are never read. The global bucket (5/s, burst 20) is consulted only when
authentication fails, so a flood of failed requests cannot lock out a valid key; `server-proof` has
its own bucket. The per-key bucket is taken before the scope check.

## Per-record rejections

A record the decoder or the store refuses (for example an identity or size the store will not keep)
is a per-record rejection: it is counted in `partial_success` and in the batch row, and the other
records of the batch are stored. Only a whole-batch failure is a 500. A key revoked between
authentication and the write is a 401; a locked database is a 503 with `Retry-After`.

## Failure semantics

- `internal` decoder error: static `500` and `counters().decoderInternalErrors`. OTLP exporters
  retry only 429, 502, 503 and 504, so a 500 means the batch is DROPPED by the sender. This is
  deliberate: a decoder bug must not become a retry storm. Fix, then re-send from the source.
- 503 and 429 carry `Retry-After`; exporters retry them.
- Any handler throw is a static 500 (`Internal error.`); nothing from the request is echoed.

## Memory

Request bodies and decoded models are bounded by `decodeConcurrency` (default 2, acquired after
the in-flight slot and before the body is read; a clarification of section 5a), `maxValues`
(250,000), 8 MiB body and 32 MiB decoded. `test/memory.test.ts` measures a server child process.
Residual: an authenticated key can hold both decode slots until the 60 s request timeout.

## Test seams

`createSwainServerWithHooks` (in `src/server.ts`, not exported from the package) lets tests replace the
decoder and reach the listening servers. It is unreachable from the package `exports`.

## Not done

One decode slot per key and a body-read minimum rate (SPEC-003 N1.5 follow-up 4), adr0002 and session
facts beyond their format (follow-up 12), per-key `last_used`, audit entries for rejected batches, raw-body retention, a separate write
queue, claude_code projection (N1.7), sessions and pages.
