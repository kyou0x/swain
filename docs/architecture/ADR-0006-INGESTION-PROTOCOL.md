# ADR-0006: Ingestion protocol (OTLP/HTTP, native batches, auth, idempotency, ordering, bounds, buffering)

Status: Proposed r2 (2026-11-16; r2 folds the G0 security design review conditions F1, F3, F4, F6, F8, F13, F14, F16, F17, F22 and F23; see §10). Requires human approval and G0 security review. The protobuf decoder is a **security-critical parser** with its own G3 review.
Research: `docs/research/SWAIN-OTEL-FRAMEWORKS.md` §2 (OTF), `docs/research/SWAIN-CLAUDE-CODE-TELEMETRY.md` (CC-T).

## Context
Real OTLP exporters default to HTTP/protobuf, and OpenClaw sends protobuf only (OTF §2/§3). Claude Code supports `http/json` and sends log events by default. Its traces are beta (CC-T §1). OTLP/HTTP requires gzip support and defines status semantics: 200 with partial success, 400 not retried, 429/502/503/504 retryable with `Retry-After` (OTF §2). Swain must have zero runtime dependencies, so there is no protobuf library.

## Decision

### 1. Endpoints (all `POST`, HTTP/1.1, same listener as the UI)
| Path | Body | Purpose |
|---|---|---|
| `/v1/traces` | `ExportTraceServiceRequest` as `application/x-protobuf` or `application/json` | OTLP traces |
| `/v1/logs` | `ExportLogsServiceRequest`, same encodings | OTLP logs (Claude Code events) |
| `/v1/metrics` | any | **404** in N1 to N3, so that misconfigured exporters fail loudly. Metrics are out of scope (the design spec non-goals) |
| `/api/v1/ingest/sources` | raw provider source bytes (`application/octet-stream`) | Remote equivalent of `swain import`: the server runs `selectAdapter` + `runImport` |
| `/api/v1/ingest/events` | `application/json` `{ format: "swain.import-result/1", record, result }` | Canonical ADR-0002 results produced by a client (`swain db push-store`). Labeled `derivation: client`; see §2 |
| `/api/v1/ingest/hooks` (N2) | `application/json` `{ integration: "claude-code", payloads: [...] }` (≤ 256 payloads) | Hook payload batches forwarded by `swain hook` |

- **Content types.** Anything other than the listed content types gets **415**. The response uses the request's content type for OTLP: a protobuf response for a protobuf request, JSON for JSON.
- **Responses.**
  - Success with no rejected records: 200 with an empty `Export*ServiceResponse`.
  - Some records rejected: 200 with `partialSuccess { rejectedSpans | rejectedLogRecords, errorMessage }`. `errorMessage` is a static code string, never echoed input.
- **gRPC is not supported.** The docs tell users to set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` (or `http/json`) and point the endpoint at `http://127.0.0.1:4318`. Claude Code accepts `http/json` and `http/protobuf` (CC-T §1).
- **Error-body shape.** For 4xx/5xx on `/v1/*`, the error body is a `google.rpc.Status`-shaped message (`code`, `message`) in the request's encoding. OTF §2 marks the JSON error-body shape UNVERIFIED, so clients must not depend on it. Exporters act on the status code only.
- **No echo (r2, F17).** No error body, `partialSuccess.errorMessage` or log line ever contains input bytes, header values, attribute values or IDs taken from the request. Messages come from a closed table of static codes.
- **`Content-Encoding` (r2, F17)** must be absent, exactly `identity`, or exactly `gzip`, compared case-sensitively with no list and no parameters. Anything else gets 415 `unsupported-encoding`.

### 2. Native batch endpoint semantics
- **`/api/v1/ingest/sources`** reuses the pipeline exactly. The body goes through `sourceFromBuffer`, then `selectAdapter` (optional `Swain-Provider` and `Swain-Source-Kind` headers narrow it, M-1), then `runImport`, then validation, then store.
  - **Server bounds (r2, F14).** The server passes a stricter `Bounds` to `sourceFromBuffer` and `runImport` than the CLI uses:
    - decoded total (after zstd) ≤ 64 MiB;
    - `maxEvents` 200,000;
    - `maxJsonValues` 1,000,000;
    - `maxDocumentBytes` 32 MiB.
  - **One compression layer only (r2, F14).** A body sent with `Content-Encoding: gzip` whose decoded bytes start with the zstd magic gets 415 `nested-compression`. Either gzip at the HTTP layer or zstd in the payload is accepted, not both.
  - **Headers:**
    - `Swain-Source-Name`: the display name, sanitized by `sanitizeDisplayName`;
    - `Swain-Source-Path-Display`: already home-masked by the client, then control-escaped and bounded to 1024 bytes;
    - `Swain-Include-Content: 0|1`: effective only if the project policy is `inline`.
  - **Dedupe and the `importId` check (r2, F4).** The dedupe key is (project, adapter id, decompressed sha256), mirroring M-14. The server **recomputes** `importId` from those values and never trusts a client-supplied one. Replies are `added | unchanged | superseded | skipped-version`.
- **No destructive replace (r2, F4).**
  - **Supersede, never overwrite.** A reimport (`Swain-Reimport: 1`) never overwrites anything. It appends a new **version** of the import (`imports.version` + 1) and keeps the old version's rows and events. Nothing is updated in place; the current version is derived at read time (the design spec §2.2). Views show the newest version and link "N earlier versions".
  - **Scope.** Reimport requires the scope `ingest:replace`. It is **not granted by default**, and `swain keys create` adds it only with an explicit `--scope ingest:replace`.
- **`/api/v1/ingest/events`** accepts a result the server cannot re-derive, because it has no source bytes.
  - **Checks.** The server validates it with `validateEvents` and the `ImportRecord` with `parseImportRecord`.
    - It **recomputes `importId`** from `record.adapter.id` and `result.source.sha256`, and rejects a mismatch with 400 `import-id-mismatch`.
    - It checks that `record.sessionId` equals the events' `sessionId`, and that the counts match.
  - **Content policy (r2, F3).** It applies the project content policy to every `ContentRef` before storing (ADR-0005 §6.5).
  - **Separate namespace for client-derived imports (r2, F4).** They are stored with `derivation: "client"`. A client-derived import can **never** replace or shadow a server-derived one:
    - if any import with that `importId` exists in the project, the request gets 409 `exists`, and `ingest:replace` does not change this;
    - a later server-derived upload of the same `importId` supersedes the client-derived version (server-derived wins), and the client version is retained as superseded.
  - The run view states: "Events were produced by a client; the server did not see the source bytes."
  - It exists for migrating remote file stores. Local migration (`swain db import-store`) reads the store directly, applies the same content policy (F3), and records `derivation: "migrated"`.

### 3. Decoding (security-critical, `@swain/otlp`)
- **JSON.**
  - The body is decoded as strict UTF-8 (`fatal: true`) and pre-scanned with the existing core `scanJson` limits, so depth and value counts are checked before `JSON.parse`.
  - Fields are read with `Object.hasOwn`. Unknown fields are ignored, as OTLP requires.
  - `traceId` and `spanId` must be lowercase or uppercase hex of exactly 32 or 16 characters, normalized to lowercase. An all-zero ID is invalid.
  - int64 and fixed64 values are accepted as decimal strings or safe-integer numbers. A number above 2^53 is rejected per record (OTF §2). Times ≥ 2^63 are rejected per record (r2, F13).
  - **Value budget (r2, F13).** The server calls `scanJson` with `maxJsonValues` 1,000,000, a request-wide budget shared with the protobuf decoder's.
  - Enums are integers.
- **Protobuf** is a hand-written decoder for the fixed message set:
  - `ExportTraceServiceRequest`, `ResourceSpans`, `ScopeSpans`, `Span`, `Span.Event`, `Span.Link`, `Status`;
  - `ExportLogsServiceRequest`, `ResourceLogs`, `ScopeLogs`, `LogRecord`;
  - `Resource`, `InstrumentationScope`, `KeyValue`, `AnyValue`, `ArrayValue`, `KeyValueList`.
  - Field numbers are taken from `opentelemetry-proto` at a pinned tag. PIN-AT-IMPLEMENTATION: the slice records the tag and the `.proto` file SHA-256 values in `@swain/otlp/src/proto/PIN.md`, plus a fixture test built from a reference encoding.
  - **Wire types.** Varint (≤ 10 bytes; overflow rejected), 64-bit, length-delimited and 32-bit are supported. Groups (wire types 3 and 4) are rejected. Unknown fields are skipped by wire type, and a length that exceeds the remaining buffer is an error.
  - **Strictness (r2, F13)** goes beyond protobuf's lenient defaults, so that protobuf and JSON are equivalent:
    - field number 0 and field numbers > 2^29 − 1 are rejected;
    - a **singular field that appears twice** is rejected. Protobuf normally keeps the last value, which would let the two encodings disagree;
    - more than one member of a `oneof` (`AnyValue.value`) is rejected;
    - length-delimited lengths are decoded as BigInt and rejected above 2^31 − 1 before conversion;
    - fixed64 times ≥ 2^63 are rejected per record.
  - **UTF-8.** Strings are decoded with `TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`, so a leading BOM is kept as data and never silently stripped.
  - **Value budget (r2, F13).** A global per-request budget of 1,000,000 decoded values counts messages, fields and `AnyValue` nodes. It is shared by the JSON and protobuf paths. Exhausting it rejects the request with 400 `too-many-values`.
  - **Bounds.** Every length is checked against the remaining bytes *before* slicing. Nesting depth is ≤ 32 messages, and `AnyValue` nesting is ≤ 16. Repeated-field counts are capped by §6. Strings are strict UTF-8; invalid strings reject the record, not the batch. `bytes` IDs must be exactly 16 bytes (trace) or 8 bytes (span), else the record is rejected.
  - **No recursion on untrusted depth without a counter**, no allocation proportional to a declared length before the bounds check, and no `Buffer` (`Uint8Array` and `DataView` only).
  - Both decoders produce **the same decoded model**. A differential test encodes every JSON fixture as protobuf (a test-only encoder lives in `contract-tests`) and asserts identical decoded output and an identical `recordSha256`.
  - **Fuzzing.** A deterministic, seeded mutation fuzzer runs in `node:test` (seeds committed, 10,000 iterations per CI run): no throw escapes the typed `OtlpDecodeError`, there is no hang (an iteration budget is enforced), and the memory high-water mark stays bounded.
  - **Structure-aware fuzz (r2, F13).** A grammar-based fuzzer generates valid-then-mutated OTLP messages. It runs for **≥ 1,000,000 iterations** once, with results recorded in the slice's review file, and **must complete together with the dedicated G3-proto review before N1.5 wires the decoder into the server**. A further check asserts that every mutated message accepted by the protobuf decoder, once re-encoded as JSON, decodes to the same model with the same `recordSha256`.
  - **Hash order.** `recordSha256` is computed before any truncation, bounds handling or content policy (ADR-0005 §5).
- **gzip.** `Content-Encoding: gzip` is decoded with `gunzipSync(body, { maxOutputLength: maxDecodedBytes })`. Exceeding the limit gives **413**. Any other content encoding gives 415.

### 4. Idempotency and deduplication
| Level | Key | Effect |
|---|---|---|
| Batch | `(projectId, keyId, signal, decodedSha256)` | Same bytes received again **from the same key**: 200 with the stored result, and nothing new is written. This covers exporter retries, which resend the same body. Including `keyId` (r2, F6) means one key cannot learn, through dedup, that another key already sent a body. The wider dedup-oracle analysis is an N4 precondition (ADR-0007 §10) |
| Batch (native) | `Idempotency-Key` header (≤ 128 printable ASCII) + `(projectId, keyId, route)` | The same key with a different body hash gives **409** `idempotency-conflict`. **Window (r2, F22).** The conflict check considers only entries created within the last 24 h. Rows are not deleted by the server; they are removed only by explicit retention (ADR-0007 §7) |
| Span | `(projectId, traceId, spanId)` | The first arrival is canonical **only if later arrivals come from the same key**. An identical later record (same evidence digest: record, resource, scope and the schema URLs as received, SPEC §3.4) from the same key is recorded as a sighting (`span_conflicts.relation = identical-same-key`); there are no counter updates. Every other case is stored in `span_conflicts` with its `keyId`, its provenance tuple and `relation`: an identical record from another key is `identical-other-key`, and a different record is `conflicting`. Records are never merged. If a `conflicting` row came from a **different key**, neither record is canonical: the run view shows "conflicting records from N credentials", and both are excluded from L2 aggregates (r2, F6; ADR-0005 §9) |
| Log record | `(projectId, recordSha256, occurrence)` where `occurrence` is the index among identical records within its batch | Within a batch, identical records are distinct evidence (ADR-0002 §6 rule). Across batches, a record with the same hash and occurrence is `duplicate-of` the first and not counted twice. A duplicate from a different key is recorded with that key's `keyId` (`log_records.dup_of` + `key_id`), so credential attribution stays complete |
| ADR-0002 source | `(projectId, adapterId, sourceSha256)` | M-14 semantics, except that replace becomes **supersede** (§2, r2 F4) |

### 5. Out-of-order data, late spans, open runs
- **Arrival order is not order.** Storage keeps arrival order (`batchSeq`, `recordIndex`) and source timestamps separately, with the server receive time in `received_at`. Views order spans by `startTimeUnixNano`, then by arrival, and label the run "ordered by reported start time". Within an ADR-0002 source the order stays `(sourceSequence, subIndex)`.
- **A parent arriving after its child** needs no fix-up writes. The tree is built at read time from `parentSpanId`. Until the parent arrives, the child is shown under "parent not received" (ADR-0005 §9).
- **Spans without an end** (`endTimeUnixNano` = 0 or absent) are stored as `open`. OTLP sends finished spans, so an open span is unusual and labeled. A later identical-ID record with an end time is a conflicting duplicate (§4), not an update.
- **Open runs.** Runs have no explicit "close" API. Status comes from evidence plus the idle window (ADR-0005 §4). A late span is accepted at any time, as long as retention has not tombstoned the run (ADR-0007 §7). Late records are flagged `late` when received more than `lateGrace` (default 600 s) after the run's last end evidence.
- **Clock skew.** Source times are never "corrected". `startTimeUnixNano > endTimeUnixNano` gives a `time-inverted` warning on the span, and the duration is shown as n/a.
- **Session runs from OTLP-log projections.** Each batch produces one source per session (ADR-0005 §7.2). Batches can arrive out of order, so the multi-part run view orders parts by first valid event time, then arrival, and labels them "sources ordered by first timestamp; not causally ordered" (the ADR-0002 §7 cross-source rule).

### 5a. Request processing order (r2, F1; normative)
Every request goes through these steps in order. A step that fails ends the request with the status shown, and **no later step runs**. In particular, the body is never read before the request is authenticated.

| # | Step | Failure |
|---|---|---|
| 1 | `Host` check: exact, case-insensitive match against the allowlist (ADR-0007 §1). A missing Host, a trailing dot, or an absolute-form request target (`POST http://…/v1/traces`) is rejected | 421 / 400 |
| 2 | Method and route lookup (closed route table) | 404 / 405 |
| 3 | Ingest routes only: a request with a `Cookie` header is rejected | 400 `cookie-on-ingest` |
| 4 | `Content-Type` and `Content-Encoding` against the route's allowed set | 415 |
| 5 | Authentication from headers only (Bearer key for ingest; session cookie for pages): one indexed lookup and one SHA-256, bounded by `maxConnections`. `?key=` in the query is rejected. The global bucket is consulted **only when authentication fails** | 401 / 400 / 429 |
| 6 | Per-key token bucket (requests), then the scope check. It exists only for authenticated keys and is keyed by `keyId` | 429 + `Retry-After` / 403 |
| 7 | Acquire an in-flight slot (server-wide, 32) | 503 + `Retry-After: 1` |
| 8 | Read the body with a running cap against the route limit, plus the per-key bytes budget. The socket is destroyed when the cap is passed | 413 |
| 9 | gunzip with `maxOutputLength` | 413 |
| 10 | Hash, batch dedup, decode, validate, content policy, normalize, write queue, one transaction | 400 / 503 |

- **Failures before authentication.** One **global** token bucket (5/s, burst 20) covers every authentication failure (401, `?key=`, `/login`), across all clients. It is consulted on failure only: a failing request takes a token and gets 401, or gets 429 when the bucket is empty. A request with a valid key never touches it, so a flood of failures (for example a browser page looping on `/api/v1/status`) cannot lock out real exporters. Steps 6 and 7 never run for unauthenticated requests, so they cannot hold an in-flight slot or a body buffer, and there is no per-IP or per-unknown-key state.
- **Body discipline.** Before step 8 the request body is neither read nor buffered. On failures in steps 1 to 7 the server answers and closes the connection (`Connection: close`) without draining the body.

### 6. Bounds (defaults, configurable down; raising them needs explicit server config)
| Bound | Default | Hard max |
|---|---|---|
| Request body (as received) | 8 MiB | 64 MiB (OTF §2 default) |
| Decoded body (after gzip) | 32 MiB | 64 MiB |
| Header bytes | 16 KiB (`maxHeaderSize`) | 16 KiB |
| Resource groups per request | 1,000 | n/a |
| Spans or log records per request | 10,000 | 50,000 |
| Attributes per resource/span/log/event/link | 128 | 1,024 |
| Events / links per span | 128 / 128 | n/a |
| Attribute key | 256 bytes | n/a |
| `AnyValue` depth / array or map entries | 16 / 1,024 | n/a |
| Native source upload | `DEFAULT_BOUNDS.maxFileBytes` (256 MiB) but the HTTP cap applies first: 64 MiB | 64 MiB |
| Hook payloads per request | 256, each ≤ 1 MiB | n/a |
| Requests per key (authenticated keys only, r2 F1) | token bucket 20 req/s, burst 100 | n/a |
| Unauthenticated failures, global (401, `/login` failures) | token bucket 5/s, burst 20 | n/a |
| Decoded values per request (JSON and protobuf, r2 F13) | 1,000,000 | 1,000,000 |
| Server connections (`maxConnections`, r2 F17) | 256 | n/a |
| Decoded bytes per key | 64 MiB/min | n/a |
| Concurrent requests per server | 32 in flight, else 503 + `Retry-After: 1` | n/a |
| Write queue depth | 64 batches, else 503 + `Retry-After: 2` | n/a |
| Server timeouts | `headersTimeout` 10 s, `requestTimeout` 60 s, keep-alive 5 s (set as server options, no timers) | n/a |

When a limit is exceeded:
- body or decoded size → 413;
- record counts → 400 (`too-many-records`);
- attributes/events/links over their limit → they are truncated per record, with `droppedAttributesCount` incremented and an `over-bounds` warning (OTLP's own dropped-count semantics);
- rate limits → 429 + `Retry-After`.

The body is read with a running byte counter, and the connection is destroyed once the cap is passed. Nothing larger than the cap is buffered.

### 7. Authentication with per-project ingest keys
- **Format.** `swn_<keyId: 16 lowercase hex>_<secret: 64 lowercase hex>` (the secret is 32 random bytes from `randomBytes(32)`). The stored key ID is `key_<16 hex>`.
- **At rest.** Only `keyId` and `sha256("swain:v1:ingest-key\n" + key)` are stored, where `key` is the whole `swn_<keyId>_<secret>` string as presented (not the 64-hex secret alone; `hashKeySecret` in `@swain/db`). A plain SHA-256 is adequate for a 256-bit random secret; a slow KDF is unnecessary. Comparison uses `timingSafeEqual` on the digests.
- **Display.** The secret is shown once at creation and never logged, rendered or audited. The audit log records `keyId` only.
- **Transport.** Credentials are accepted only as `Authorization: Bearer <key>`. Any `?key=` query is refused with 400, so keys never reach URLs or logs. Claude Code passes the key with `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer swn_…"` (CC-T §1).
- **Scopes.**
  - closed set (r2, F22): `ingest:otlp`, `ingest:native` (default: both), `ingest:hooks` (N2), `ingest:replace` (never default, r2 F4), and `read:status`. No wildcard scopes exist. The earlier `read:*` wording is withdrawn: JSON read endpoints other than `/api/v1/status` accept a session only, until a later ADR defines read tokens;
  - optional pin `agentName` (ADR-0005 §3 rule 1);
  - optional `integration` label (`claude-code`, `otlp`, …), used only for display and for choosing projections. Projections are also confirmed by evidence (`claude_code.*` event names).
- **Default pinning (r2, F6).** `swain connect <integration> --create-key` and `swain keys create --integration I` create keys pinned to an agent by default (`agentName` = the integration name, or `--agent`). `--no-pin` is explicit.
- **Lifecycle.** Keys are revocable (`revoked_at`, effective on the next request; there is no cache) and may have an expiry (`expires_at`). `last_used_at` is updated at most once per minute per key.
- **Failures.** A wrong, unknown, revoked or expired key gets 401 with `WWW-Authenticate: Bearer` and the same static body in every case. A valid key with the wrong scope gets 403.
- **Cross-origin defense.** Ingest routes reject requests that carry a `Cookie` header and set no CORS headers. A browser can send a cross-origin POST only with "simple" content types, and a simple request cannot carry `Authorization`, so cross-site ingestion is not possible.

### 8. Buffering, retry and spool (client, CLI, SDK)
- **Server authentication before sending a key (r2, F8).** `@swain/client` (`swain push`, `swain hook`, `swain status`, `swain db push-store`) never sends a key to a server it has not authenticated:
  1. On start, `swain serve` writes a runtime file `$XDG_STATE_HOME/swain/server-<port>.json` (directory 0700, file `wx | O_NOFOLLOW` 0600) containing `{ origin, instanceId, pid }`, where `instanceId` is 16 random bytes. The file is removed on clean shutdown. A stale file is detected by the challenge failing.
  2. The client picks the credential file for the project. Each credential file (§8.1) records its issuing `origin` and a `serverProofKey`. The proof key is `HMAC-SHA256(server_secrets.client_proof, lp("swain:v1:proof-key") ‖ lp(keyId))`, written by `swain keys create --save`, which has DB access.
  3. The client sends `POST /api/v1/server-proof` with `{ keyId, challenge }`, where `challenge` is 32 random bytes in hex. **No key is sent.**
  4. The server answers `HMAC-SHA256(proofKey(keyId), lp("swain:v1:server-proof") ‖ lp(origin) ‖ lp(instanceId) ‖ lp(challenge))`, where `lp` is length-prefixed encoding (r2, F22). The client verifies it with `timingSafeEqual` and checks that `origin` and `instanceId` match the runtime file when one exists.
  5. Only then does the client send the key, on the same connection (keep-alive).
  6. A failure gives exit 8 `server-unauthenticated`. The batch is spooled, and the key is not sent.
  - **Why the origin is in the HMAC.** A relay is defeated because the proof covers the exact origin the client connected to. Suppose a squatter on `[::1]:4318` forwards the challenge to the real server on `127.0.0.1:4318`. It receives a proof for the real server's origin, which the client rejects. The same origin cannot be squatted while the real server holds it.
  - **Abuse limits.** `/api/v1/server-proof` is unauthenticated, accepts only known `keyId`s, and counts against its own small bucket (5/s, burst 20), separate from the authentication-failure bucket (§5a). An unknown `keyId` returns the same static 401 as a bad key.
- **Owner proof (G3-auth B2).** `swain open` writes a login code, so it must know the listener shares its own database before it does. The same endpoint answers a second purpose: `POST /api/v1/server-proof` with `{ "purpose": "owner", "challenge" }` (32 random bytes in hex, **no `keyId`**; a `keyId` together with `purpose`, an unknown purpose or a malformed challenge is 400). The owner key is derived from the server secret in the DB the CLI itself opened: `ownerKey = HMAC-SHA256(server_secrets.client_proof, lp("swain:v1:owner-proof-key"))`. The server answers `HMAC-SHA256(ownerKey, lp("swain:v1:owner-proof") ‖ lp(origin) ‖ lp(instanceId) ‖ lp(challenge))`. The labels differ from `swain:v1:server-proof` and `swain:v1:proof-key`, so a key holder's proof key cannot answer an owner challenge. In both purposes the answered `origin` is built from the accepting socket (`localAddress`/`localPort`, literal-IP form), never from the Host header, and Host must name a family the server really listens on (B1).
  - **`swain open` sequence:** (1) find the server from `--server`/`SWAIN_SERVER_URL` or the one runtime file; with none, say the server is not running and exit 8, with **no fallback to port 4318**; (2) `GET /healthz`; (3) owner proof against the runtime file's `instanceId` and exactly that origin; (4) only then create the code and print the URL. A stale runtime file, a dead port or a failed proof exits 8, prints no URL and writes no code.
  - **Residual:** the proof is checked when the command runs, but the URL is pasted into the browser later. A server crash followed by another process taking the port within the 60 s window would receive the code. The code is single-use, expires in 60 s and only yields a session on a server that holds the matching `next_path` row, so a squatter gains nothing it can redeem against the real database; it can only see the code.
- **Origin pinning (r2, F8).** A credential is used only for its recorded `origin`. A `--server` flag or `SWAIN_SERVER_URL` that names another origin is refused (exit 2 `credential-origin-mismatch`). Re-issuing a key for the other origin is the only way to use it there.
- **No keys in argv (r2, F8).** No command accepts a key as an argument or flag value, because argv is visible in `/proc/*/cmdline`. Keys come only from credential files, or from stdin with `swain keys import --stdin`.
- **Residual (r2, F8).** Third-party exporters (Claude Code, OTel SDKs, OpenClaw) cannot authenticate the server. They send the Bearer key to whatever listens on the configured port. On a shared host, loopback is therefore **not a confidentiality boundary** for those keys. This is recorded in the threat model (ADR-0007 §9, T-N3). Mitigations: pinned, revocable, narrowly scoped keys; the dual-family bind (ADR-0007 §1); `swain status` warns when the port is held by another process or family.

#### 8.1 Credential files (r2, F16)
- **Location.** `$XDG_CONFIG_HOME/swain/credentials/` is created 0700, checked with `lstat` (not a symlink, owned by the uid, not group- or world-writable). Files `<project>.key` are written `wx | O_NOFOLLOW`, mode 0600.
- **Content.** `{ format: "swain.credential/1", origin, keyId, secret, serverProofKey, projectSlug, agentName?, createdAt }`.
- **Display.** `swain connect` prints a **placeholder or a reference to the credential file**, not the secret, unless `--show-secret` is given. For Claude Code it recommends `otelHeadersHelper` pointing at a helper that reads the credential file, so the secret never lands in `settings.json`. The helper's output contract is UNVERIFIED (CC-T §1 lists `otelHeadersHelper` only by name), so N2 verifies the contract with a fixture before recommending it as default. When the user chooses to put the key in `settings.json` `env`, `connect` warns if that file is group- or world-readable.

#### 8.2 Spool, retry, daemons
- **Spool.** The spool is at `$XDG_STATE_HOME/swain/spool/<projectId>/` (else `~/.local/state/swain/spool/…`): directory 0700, files 0600, written `wx` then renamed, fsynced.
  - Each spool file is one ready-to-send request: the body plus a JSON sidecar with the route, content type, origin, and an `Idempotency-Key` generated **once** at spool time (16 random bytes, hex), so a retry is idempotent. The key secret is never written into the spool.
  - **Caps (r2, F23).** 256 MiB and 10,000 files per project, plus a global cap of 1 GiB across projects. When full, the **newest** batch is refused and the user is warned (`swain status` shows the drop count). Silent dropping of old evidence is avoided.
  - **Purge (r2, F23).** `swain spool purge [--project P] [--failed-only] --yes` removes spool files explicitly. Spooled payloads may contain content the sender emitted, so `swain status` shows the spool size and the purge command.
- **Retry.**
  - Retries are attempted on 429/502/503/504, connection errors and timeouts.
  - The delay is `min(cap, base · 2^attempt)` with full jitter from `randomInt`: base 1 s, cap 5 min. `Retry-After` is honored when it is larger.
  - No retry on 400/401/403/404/409/413/415. These are moved to `spool/failed/` with the status code, for inspection with `swain status --failed`.
- **No daemon.** Short-lived processes (`swain hook`, `swain push`) try once inline with a 2 s timeout set through the `node:http` request option, spool on failure, and drain at most N files (default 16) on each later invocation. `swain status --flush` drains explicitly.
- **Hook payloads (r2, F23).** `swain hook` forwards stdin as data:
  - it never opens a path named in the payload (`transcript_path`, `agent_transcript_path`, `cwd`);
  - the server never opens those paths either; they are stored as metadata under the content policy;
  - hook payloads go through the same receiver-side content policy as OTLP (ADR-0005 §6), with `tool_input`, `tool_response`, `prompt` and `last_assistant_message` classed as content.
- **SDK.** The TS SDK has an in-memory queue (2,048 spans, else the newest spans are dropped and counted), a periodic flush every 5 s with an unref'd timer, a flush on `shutdown()`, and the same retry policy. The disk spool is opt-in (`spoolDir`). The SDK cannot run the server-proof handshake against non-Swain receivers; with a Swain endpoint it performs it when given a credential file.
- **Integrations that bring their own exporter** (Claude Code, OTel SDKs) use the exporter's retry. Swain answers with the correct retryable codes.

### 9. Replay safety
- Replaying any accepted request is a no-op by the dedup keys in §4. A replay of a batch whose key has been **revoked** is refused (401), even if the bytes were seen before.
- **Bearer keys over plain HTTP.** In local mode the key travels over plain HTTP on loopback. ADR-0007 §1 requires TLS, or a TLS-terminating proxy, before any non-loopback bind.
- Ingested data is never executed, rendered unescaped, or used as instructions (S1, the project hostile-data rule). Commands seen in telemetry are never run.
- The audit log records key use per batch only when the result is `rejected`. Successful ingests are counted, not individually audited, to avoid write amplification.
- **Logging (r2, F17).** The server has **no access log** containing headers, bodies, query strings or attribute values. Operational logs to stderr carry only a static event code, a route ID from the closed table, a status, a byte count, a duration and a `keyId`. URLs are never logged, so login codes and `next` values can never appear in logs.

### 10. r2 changes (G0 security design review, 2026-11-16)
- F1: normative request processing order with auth before body; per-key and global buckets (§5a, §6).
- F3/F4/F14: native endpoint content policy, supersede-only replace, the `ingest:replace` scope, `importId` recomputation, the client-derived namespace, server bounds and a single compression layer (§2).
- F6: `keyId` in dedup and conflicts; pinned keys by default (§4, §7).
- F8/F16: client-side server authentication, origin-pinned credentials, no keys in argv, credential files, the exporter residual (§8).
- F13: protobuf strictness, the value budget, the structure-aware fuzz gate (§3).
- F17: no echo, exact `Content-Encoding`, no access logs (§1, §9).
- F22: idempotency window wording; closed scope set (§4, §7).
- F23: spool caps and purge; hook payload paths never opened (§8.2).

## Alternatives considered
| Alternative | Why not |
|---|---|
| JSON-only OTLP | Most exporters default to protobuf, and OpenClaw is protobuf-only (OTF §2/§3). Users would need a collector |
| A protobuf library | It adds a runtime dependency. The OTLP trace and log schema is small and fixed, so a bounded decoder is about 500 lines and fully testable |
| gRPC (port 4317) | Needs HTTP/2 plus gRPC framing and trailers. All target exporters also support HTTP |
| Storing keys with a KDF (scrypt) | Not needed for 256-bit random secrets, and it slows every request |
| Keys in a query string | Leaks into logs and history |
| Updating spans in place when a "newer" version arrives | OTLP spans are immutable when exported. In-place update would let a sender rewrite evidence |
| Server-assigned order by arrival | Arrival is not causality |

## Consequences
- The protobuf decoder is new attack surface and must pass a dedicated G3 review plus fuzzing before N1 merges.
- Exporters configured for gRPC fail. `swain status` and `swain connect` print the exact env to switch them.
- Hash-only receiver policy means senders' prompt content is never stored by default, even when sent.

## Guarantees changed
| Guarantee | Change |
|---|---|
| Ingest only from user-selected files (S6) | Extended to authenticated network bodies, with the same bounded and strict decoding. Bounds are per request and per key |
| Idempotent import (M-14) | Extended to batches, spans, logs and native uploads |
| `time.origin: "receipt"` reserved (ADR-0002 §7) | Still unused in events. The receive time lives only in L0/L1 columns, never in ADR-0002 events |

## 10. Change log
- N1.5 G3 F1: bucket consulted on failure only; decided by lead (§5a, §7 abuse limits).
- N1.5 G3 F5: the dedup digest lives in `evidence_sha256`; `record_sha256` stays the bare hash (§4; SPEC §3.4).
- N1.5 G3 F11: the §7 at-rest hash covers the whole `swn_...` string.
- r2 amendment (N1.1 G3 C1): the §7 key format is `swn_<16 hex keyId>_<64 hex secret>` (lowercase hex, replacing the earlier 12-char base32 key ID and base32 secret). The at-rest hash is unchanged: `sha256("swain:v1:ingest-key\n" + secret)`, implemented in `@swain/db` with a pinned test vector.
