# ADR-0005: Canonical model v2 (OTel-aligned runs, spans and evidence-backed relationships)

Status: Proposed r2 (2026-11-16; r2 folds the G0 security design review conditions F2, F5, F6, F13, F15 and F18; see §11). Requires human approval and G0 review.
Builds on ADR-0002 r2.2 without changing it. Research inputs:
- `docs/research/SWAIN-CLAUDE-CODE-TELEMETRY.md` (cited as CC-T)
- `docs/research/SWAIN-OTEL-FRAMEWORKS.md` (cited as OTF)

## Context

ADR-0002 events are a strict, closed, provider-enumerated evidence format for four CLIs (audit L1). Swain must also hold OTLP traces and logs from any framework, track tenancy, agents and runs, and show relationships between agents. ADR-0002 forbids adding a provider without a 0.2 bump, and its readers refuse 0.2. Changing it would break every existing store and export. The OTel GenAI conventions are all at **Development** status and live in a separate repository with no release tags (OTF §1). Field names can therefore change, so the model must pin a commit and accept aliases.

## Decision

### 1. Three layers; lower layers are never rewritten

| Layer | Content | Mutability |
|---|---|---|
| **L0 Evidence** | One `ingest_batches` row per request: body hashes, decoded hash, signal, key, receive time. Per record: a provenance tuple (§5). Raw bytes are kept only when the project opts in (§5) | Append-only. Retention may remove raw bytes explicitly (ADR-0007 §7) |
| **L1 Observations** | (a) **ADR-0002 events**, unchanged, schema 0.1, produced only by adapters through `runImport`. (b) **OTel records**: spans and log records exactly as OTLP defines them (IDs, times, kind, status, attributes, events, links, resource, scope), with attribute values subject to the content policy (§6) | Immutable once written. Duplicates and conflicts are recorded, never merged (ADR-0006 §4) |
| **L2 Model** | Tenancy, agents, runs, sessions, normalized operations (LLM call, tool call, agent invocation, handoff), usage roll-ups, relationship edges with evidence | Derived and rebuildable from L1 by `swain db rebuild-model`. Every L2 row cites the L1 rows it came from |

v2 is **additive**. ADR-0002 events are never converted into OTel records, and OTel records are never converted into ADR-0002 events. The single exception is a named, versioned **adapter projection** (§7.2): a deterministic re-encoding of OTLP log records into JSONL that an ADR-0002 adapter consumes like any other source.

### 2. Tenancy and core entities

```
org ─┬─ workspace ─┬─ project ─┬─ agent ── run ─┬─ span / log record / ADR-0002 event (L1)
     │             │           │                ├─ operation (llm | tool | agent | handoff | workflow | generic)
     │             │           │                └─ usage
     │             │           ├─ session (grouping key, optional)
     │             │           ├─ ingest key
     │             │           └─ relationship edge
     └─ membership (user, role)
```

| Entity | Identity | Notes |
|---|---|---|
| `org` | `org_` + 32 hex, random | Local mode creates one org, `local` |
| `workspace` | `wsp_` + 32 hex, random | Local mode: `default` |
| `project` | `prj_` + 32 hex, random | Holds the content policy, raw retention and ingest keys. Local mode: `default` |
| `agent` | `agt_` + `deriveSwainId(projectId, agentKey)` | A stable logical identity derived from evidence (§3) |
| `run` | `run_` + derived (§4) | One trace, one ADR-0002 session, or one legacy import |
| `session` | `sess_` + derived from `(projectId, sessionKeyBasis, value)` | A grouping only, never causal. Basis: `session.id` (CC-T §1, OpenInference), `gen_ai.conversation.id` (OTF §1), or an ADR-0002 `sessionId` |
| `operation` | `(runId, sourceRef)` | Normalized meaning of a span or log record (§8) |
| `edge` | `edg_` + derived from `(projectId, kind, from, to, basis, evidenceRef)` | §9 |

`deriveSwainId(type, components)` reuses the ADR-0002 §6 length-prefixed encoding, with the domain string `"swain:v1:" + type`. It lives in `@swain/model`. It does not touch `deriveId` or its vectors. the design spec adds normative test vectors. They are computed by the implementing slice and checked independently by QA. Hand-computed values are not used in this ADR.

### 3. Agent identity (evidence only)
The agent key is chosen by the first rule that has evidence. **Each key is namespaced by its basis before `deriveSwainId`** (r2, F5), so that different bases with equal values can never collide. Example: a credential pin `billing` and a `service.name` of `billing` are different agents. The basis is also stored as `agents.keyBasis`.

| # | Rule | Agent key (exact form; values are length-prefixed by `deriveSwainId`) |
|---|---|---|
| 1 | Ingest key pinned to an agent (`keys.agentName`) | `cred:<agentName>`. Subagents seen under a pinned key: `cred:<agentName>/sub:<agentType>` |
| 2 | Span attribute `gen_ai.agent.id` (OTF §1) | `attr:gen_ai.agent.id:<value>` |
| 3 | `gen_ai.agent.name`, or OpenInference `agent.name` (OTF §4) | `attr:name:<value>` (one namespace for both, because both are names) |
| 4 | Resource `service.namespace` + `service.name`, when `service.name` does not start with `unknown_service` | `resource:<namespace>/<name>` (empty namespace allowed) |
| 5 | ADR-0002 provider plus root actor | `adr0002:<provider>`. Subagents with `agentType`: `adr0002:<provider>/<agentType>`, with an edge `spawned` (§9) to the root agent |
| 6 | No evidence | `none` (the agent "unattributed", one per project, never merged with another agent) |

- **Key values.** Values are taken as received after the metadata rules in §6: bounded to 256 bytes, control characters neutralized. They are never trimmed or case-folded, so distinct evidence stays distinct.
- **Never derive an identity from masked text (G3 B2, lead decision).** The masker can map two distinct values to the same text (two high-entropy agent IDs both become `[REDACTED]`), which would merge distinct agents or sessions. For the agent bases (`gen_ai.agent.id`, `gen_ai.agent.name`, `agent.name`, `service.name`, `service.namespace`) and for session or conversation values, the key component is computed from the UNMASKED value: the value itself when masking left it unchanged, else `"h:" + sha256(value)`. The applier records it as `identity` on the kept string; the original is never stored, and display uses the masked form only. `@swain/model` identity functions accept only such `IdentityValue`s. N1.4 implements the components as ID components after the basis (`cred-sub`, `resource-ns` and `adr0002-sub` are separate bases with separate components, so `/` and `:` in values cannot forge a sub-key). A pinned `agentName` that is present but empty is a configuration error and throws; it never falls back to sender claims.
- **Collision tests (required, N1.4).**
  - The same value under every basis gives six distinct IDs.
  - A value containing `:` or `/` cannot forge another basis. The basis is a separate length-prefixed component: `deriveSwainId("agt", [projectId, basis, value])`.
  - The same key in two projects gives distinct IDs.
- **Credentials and agent attribution (r2, F6).** A pinned key (rule 1) attributes every record it sends to the pinned agent, even when the attributes name another agent. The attribute value is kept and shown as "sender claims agent X". `swain connect` creates agent-pinned keys by default (the design spec §4).

The agent URL is `/a/<agt_id>`. It is stable because the ID is a pure function of the project, the basis and the value.

### 4. Runs
| Kind | When | ID components |
|---|---|---|
| `trace` | OTLP spans | `["trace", projectId, traceIdHex]` |
| `session` | ADR-0002 events from one or more sources sharing an ADR-0002 `sessionId` (native uploads, Claude Code OTLP-log projection, hooks) | `["session", projectId, sessionId]` |
| `import` | A legacy file-store import migrated by `swain db import-store` | `["import", projectId, importId]` |
| `logs` | OTLP log records with no trace ID that no projection consumes, grouped by `session.id` if present | `["logs", projectId, agentId, sessionValue]`. Without a session value, there is one rolling run per agent per UTC day, labeled "ungrouped logs" |

- **URL.** `/r/<run_id>`. `/r/imp_<hex>` and `/r/ses_<hex>` redirect to the matching run when exactly one exists in scope.
- **Run status** is computed at read time from evidence plus the server receive clock. It is never stored as fact:
  - `active`: a record was received within `idleWindow` (default 300 s) and no end evidence exists;
  - `ended`: end evidence exists, namely all root spans have `endTimeUnixNano`, or an ADR-0002 `session.ended`;
  - `idle`: no end evidence and no activity within the window;
  - `incomplete`: ended, but missing parents, `capture.gap` events, or unresolved references remain;
  - `error`: shown as a separate flag, not a status. It is set by a span `status.code = ERROR`, `tool.failed`, or a normalized operation error.
    - **Presentation note (fleet page):** the run carries one error flag, but the fleet page shows it per agent for trace runs. An ERROR span marks its own agent and its nearest enclosing agent span's agent, but only through spans of the same credential (`key_id`) that are canonical and have a unique span ID. There is no propagation across credentials, siblings or sub-agents. Runs whose spans are truncated or over the render budget, and other run kinds, show the run-wide flag.
- **Late data** after `ended` is accepted and marked `late`. The status is recomputed.

### 5. Raw preservation and provenance for OTLP
Each L1 OTel record carries a provenance tuple:
```
{ batchId, signal: "traces"|"logs", encoding: "json"|"protobuf", contentEncoding: "identity"|"gzip",
  bodySha256 /* bytes as received */, decodedSha256 /* after gzip */,
  path /* e.g. "/resourceSpans/0/scopeSpans/1/spans/3", same shape for protobuf (field-index path) */,
  recordSha256 /* SHA-256 of the RFC 8785 canonical JSON of the decoded record before any content policy */,
  decoder: { id: "swain.otlp-json" | "swain.otlp-proto", version },
  keyId /* r2, F6: the ingest credential that delivered the record; a direct, indexed column on every L1 row */ }
```
- **`rawRetention: "hash-only"` (default).** Only the hashes and the path are stored, plus attributes under the content policy (§6). This is the same trade-off as ADR-0002 §10: verification requires the sender's copy.
- **`rawRetention: "full"` (project opt-in, owner/admin, audited).** The decoded body bytes are stored (zlib-compressed BLOB, 0600 database). Re-derivation, `recordSha256` verification and future re-normalization are then possible. The full body may contain content the sender emitted, so the UI labels the project "raw bodies retained". Retention applies.
- `recordSha256` is computed over the decoded record **before any truncation, bounds handling or content policy** (r2, F13), so JSON and protobuf encodings of the same record give the same hash. The canonical JSON form of a decoded record is defined in the design spec §3.4 (hex IDs, decimal-string int64, lowerCamelCase).

### 6. Content policy at the receiver (hash-only regardless of sender)
The sender's choice never overrides the project policy. ADK sends content by default (OTF §3). The policy is a pure function, `applyContentPolicy(record, policy) → stored record`, in `@swain/model`. It runs on the decoded record **before any write**, on every path: OTLP spans and logs, `span_conflicts`, native events (§6.5) and imports (r2, F2/F3).

#### 6.1 Fields covered (r2, F2)
The policy applies to **every string-bearing or AnyValue-bearing field**, not only span attributes:
- resource attributes and scope attributes;
- scope `name` and `version`;
- span `name`, `status.message` and `traceState`;
- span event `name` and event attributes;
- link attributes;
- log record `body`, `attributes`, `eventName` and `severityText`.

`span_conflicts.record_json` stores the post-policy form, never the received form.

#### 6.2 Leaf rule (applied recursively)
`AnyValue` arrays and key-value lists are walked recursively. Each leaf is classified by the nearest key and its own type:

| Class | Applies to | Stored |
|---|---|---|
| `content` | a key in the content list (§6.3), or any key matching the secret-name rule (§6.4), at any value type and any length. Exception: the pinned numeric usage keys (§7.3: `*.usage.*tokens`, `llm.token_count.*`, `gen_ai.request.max_tokens`), which stay metadata | `ContentRef`: hash-only by default. With project `contentPolicy: "inline"`, inline up to `maxInlineContentBytes` and passed through `redactText` |
| `bytes` | any `bytesValue` | Always a hash-only `ContentRef`, whatever the policy (r2, F2) |
| `metadata` | numbers, booleans, and strings ≤ 256 UTF-8 bytes not classed above | Kept after `redactText` (with the extensions in §6.4) and the URL rule (§6.4). Shown in the UI with the label "best-effort masked" (r2, F15). With `metadataPolicy: "allowlist"` (an optional per-project setting, r2, F15), only keys in the pinned metadata allowlist are kept; other strings become hash-only |
| `oversize` | any non-content string > 256 bytes | `ContentRef`, hash-only unless the policy is inline |

- **Per-record cap.** Retained metadata bytes are capped at **16 KiB per record**: the sum of kept metadata string bytes over all fields. Once the cap is reached, further metadata strings become hash-only `ContentRef`s, and the record gets an `over-bounds` warning.
- **Keys are budgeted too (G3 B1).** Kept key bytes are charged to the same 16 KiB per-record cap as kept strings. One budget covers resource + scope + record for each emitted record (shared parts are built first; each record's budget starts after them). A key over 256 bytes (never kept as a prefix), a key that does not fit the budget, and, under `metadataPolicy: "allowlist"`, a key that is neither allowlisted nor a normalizer key, is replaced by `[key:<first 16 hex of sha256(original key)>]`, flagged `keyAltered` (and `over-bounds` when a bound caused it). Records and outputs are deep-frozen; consumers call `isPolicyApplied` on every span and log. Under `inline`, nested secret-name and content keys inside a content value are replaced by `[REDACTED]` before the inline text is built (the hash stays over the original). For Claude Code, until a fixture confirms attribute names, every record whose `eventName` or `event.name` starts with `claude_code.` treats all string, array and map attributes as content except a documented correlation and metadata list.
- **`redactText` and `redactTextExtended`.** The §6.4 additions live in `redactTextExtended` in the shared core masker file, deliberately separate from `redactText`, so `swain` output stays byte-identical. Folding them into `redactText` is a later, separately reviewed change (an experiment showed no existing golden would change).
- **Attribute keys** are bounded to 256 bytes, control and bidi characters are neutralized (`escapeControlChars`, extended to the full `\p{Cf}` set required by proposed S13), and keys pass through `redactText`. Keys that match a pinned normalizer table entry are compared before redaction, so lookups are not affected. A key changed by redaction is stored redacted and flagged.

#### 6.3 Content keys (pinned list in `@swain/model/src/policy/content-keys.ts`, versioned; exact keys unless marked prefix `*`)

| Family | Keys |
|---|---|
| GenAI | `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`, `gen_ai.tool.description`, `gen_ai.prompt*`, `gen_ai.completion*` (legacy) |
| OpenInference | `input.value`, `output.value`, `llm.input_messages.*`, `llm.output_messages.*`, `llm.prompts*`, `llm.prompt_template.*`, `llm.tools.*`, `tool.parameters`, `retrieval.documents.*`, `reranker.*`, `embedding.*.text` (prefix `embedding.` with suffix `.text`), `metadata` |
| Vercel AI SDK | `ai.prompt*`, `ai.response.*`, `ai.toolCall.args`, `ai.toolCall.result` |
| Traceloop / OpenLLMetry | `traceloop.entity.input`, `traceloop.entity.output` |
| General semconv | `exception.message`, `exception.stacktrace`, `db.statement`, `db.query.text`, `process.command_line`, `process.command_args` |
| Claude Code (CC-T §1) | log attributes `prompt`, `tool_input`, `tool_parameters`, and the error text of `claude_code.api_error`. The exact error-text attribute name is UNVERIFIED in CC-T, so until a sample confirms it, **every string attribute** of an `api_error` record is content, except the correlation attributes named in CC-T §1 (`session.id`, `prompt.id`, `event.sequence`, `user.id`, `organization.id`, `user.account_uuid`). Further metadata keys are added only once a fixture confirms their names. Any other Claude Code attribute that carries user, model or tool text when the `OTEL_LOG_*` flags are on is content (assistant response text, tool content, raw API bodies) |
| Google ADK legacy | **all** of `gcp.vertex.agent.*`, except the explicit ID allowlist `gcp.vertex.agent.invocation_id`, `gcp.vertex.agent.session_id`, `gcp.vertex.agent.event_id` (exact spellings UNVERIFIED, OTF §3; until a sample confirms them, the allowlist is empty and the whole prefix is content) |
| Log records | `body`, for every log record |

Each family has a hostile fixture with a secret in that field (the design spec §6.1).

#### 6.4 Secret-name rule and masking extensions (r2, F15; N-Q3 mitigations)
- **Secret-name rule.** A key matching `/(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|signature)/i`, or any key under `http.request.header.*`, `http.response.header.*` or `rpc.*.metadata.*`, is `content` at any length. The pinned numeric usage keys listed in §6.2 are the only exception, because `token` would otherwise match `gen_ai.usage.input_tokens`.
- **URL rule.** For `url.full`, `url.query`, `url.original`, `http.url`, `http.target` and any metadata string that parses as an absolute URL, userinfo is removed and every query value is replaced by `[REDACTED]`, keeping the parameter names. `url.query` keeps names only.
- **`redactText` additions.** In the shared core masker, with linear-time patterns and a test per pattern:
  - JWT-like `eyJ…\.…\.…`;
  - `Basic <base64>`;
  - `AIza…`, `sk_live_`, `rk_live_`, `glpat-`, `npm_`, `hf_`, `ya29.`, `SG.…`;
  - Slack and Discord webhook URLs;
  - URL userinfo `scheme://user:pass@`;
  - connection strings (`postgres://`, `mysql://`, `mongodb(+srv)://`, `redis://` with credentials; `Password=`/`Pwd=` in ADO-style strings);
  - signature query parameters (`sig`, `signature`, `X-Amz-Signature`, `X-Goog-Signature`, `token`, `access_token`);
  - CLI flag forms: `--password x`, `--token x`, `-p x` after `mysql`/`psql`, `-u user:pass`;
  - a high-entropy heuristic: a token of ≥ 24 characters from at least three character classes with Shannon entropy ≥ 4.0 bits/char. Canonical UUIDs and pure lowercase hex of exactly 16, 32 or 64 characters are exempt, because these ID shapes are common in telemetry; see the reasoning in §11.
- **Label.** Masking remains best-effort (S3). Every UI surface showing kept unknown strings says so.

#### 6.5 Native events and imports (r2, F3)
`/api/v1/ingest/events` and `swain db import-store` apply the project policy to ADR-0002 `ContentRef`s:
- under `hash-only`, `inline` and `redactionCount` are dropped and `retention` is set to `hash-only`;
- under `inline`, inline text longer than `maxInlineContentBytes` is truncated on a code point boundary (`inline-truncated`).

The result is re-validated with `validateEvents`. The import's meta records `contentDowngraded: <count>`. Event IDs do not cover content, so they are unchanged.

### 7. Mapping between layers

#### 7.1 ADR-0002 events → run view (read-time projection, not stored as spans)
An event-backed run is rendered with the existing renderers (ADR-0008). For fleet aggregates, L2 derives operations from events:

| ADR-0002 | L2 operation | Evidence |
|---|---|---|
| `tool.requested` + `result-of` `tool.completed`/`tool.failed` | `tool` (status from the result; duration from `payload.durationMs` or the difference between two valid timestamps, labeled) | link `result-of` |
| `tool.requested` without a result | `tool`, status `no-result` | the request event plus the `capture.gap` |
| `agent.started`/`agent.ended` | `agent` invocation; edge `spawned` to the parent actor's agent | `spawned-by` link / `parentActorId` |
| `model.usage` | `usage` (scope respected; session scope is never summed, M-18) | event |
| `permission.*` | attached to the tool operation by `decides`, else by `toolCallId` | link |
| `message.observed` | no operation; counted | event |

#### 7.2 OTLP logs → ADR-0002 (adapter projection; Claude Code first)
- **The projection.** The projection `swain.otlp-logs-jsonl/1` (`@swain/otlp`) turns one decoded logs batch into one JSONL source per distinct `session.id` value. It is deterministic and preserves document order.
  - Each line is the RFC 8785 canonical JSON of `{ "batch": decodedSha256, "path": <record path>, "resource": <resource attributes>, "scope": {name, version}, "record": <decoded logRecord, OTLP JSON shape> }`.
  - The projection runs **before** the content policy, and the adapter applies the policy itself (`hash-only` → `ContentRef`), so the hashes cover the original values.
- **The adapter.** A new adapter `claude-code.otlp-logs` in `@swain/adapter-claude-code` consumes it: provider `claude-code`, `sourceStability: documented-interface`, `experimental: true`, `testedProviderVersions: []`. ADR-0002 provenance then points into the projection bytes, which can be recomputed from the batch.
  - With `rawRetention: full`, the chain is verifiable end to end.
  - With hash-only it is verifiable by the sender, through the batch hash.
- **Proposed mappings.** The adapter slice must re-check names against CC-T §1 before coding.
  - `claude_code.user_prompt` → `turn.started`, with the prompt `ContentRef` only when the prompt attribute is present, else `null` with content `unavailable`. `prompt.id` is the `nativeTurnKey`.
  - `claude_code.tool_result` → `tool.requested` (subIndex 0) and `tool.completed`/`tool.failed` (subIndex 1), both from the same record. The record attests both the call and its result.
    - `tool_use_id` is the native tool-call key, and `duration_ms` maps to `durationMs`.
    - `success=false` maps to `tool.failed`, with `errorClass` from `error_type` when it is a known value, else `unknown`.
    - This rule must be approved in the adapter slice's G0. The alternative, a lone `tool.completed`, produces a `missing-start` gap for every tool.
    - **Labeling (r2, F18).** The synthesized `tool.requested` carries the allowlisted attribute `claude-code.attested-by: "tool_result"`, and reports render it as "request attested by its result record".
    - **Its `time` is `{value: null, origin: "none", status: "missing"}`**, with `completeness.timestamp = {state: "unavailable", reason: "provider-does-not-expose"}`. ADR-0002 `EventTime` has no "derived" origin, so a computed start never enters the event.
    - The view layer may show `end − duration_ms` as a start, labeled "derived: end minus reported duration". It is never shown as an observed start.
  - `claude_code.api_request` → `model.usage`, scope `message`: model, input/output/cache tokens, and `cost_usd` → `costUsdEstimate`.
  - `claude_code.tool_decision` → `permission.decided`. `decision` and `source` are mapped through closed tables; unknown values map to `unknown`.
  - `claude_code.assistant_response` → `message.observed` (assistant), *only* if the response text attribute is present.
  - Every other event name (`api_error`, `api_refusal`, `subagent_completed`, `mcp_server_connection`, …) → `source.unknown`, until mapped with evidence.
- **Projection bytes** are transient. They are persisted only under `rawRetention: full`, as part of the retained decoded body, and can always be regenerated from it. The `log_records` rows store the post-policy form (§6).
- **Not in ADR-0002 events.** Claude Code metrics (`/v1/metrics`) are not ingested in N1.

#### 7.3 OTel spans → L2 (normalizer, `@swain/model`)
Spans are classified **only by attributes, never by span name or kind** (OTF §1). The normalizer is pinned to `semantic-conventions-genai@<commit>`. PIN-AT-IMPLEMENTATION: the N3 slice records the commit SHA it read in `@swain/model/src/semconv/PIN.md`, and the tests reference it.

| Detector | Value | Operation |
|---|---|---|
| `gen_ai.operation.name` | `chat`, `generate_content`, `text_completion` | `llm` |
|  | `embeddings` / `retrieval` | `llm` (subtype) |
|  | `invoke_agent`, `create_agent` | `agent` |
|  | `execute_tool` | `tool` (`handoff` if `gen_ai.transfer.*` is present) |
|  | `invoke_workflow`, `invoke_runner`, `plan` | `workflow` |
| `openinference.span.kind` | `LLM` | `llm` |
|  | `AGENT` | `agent` |
|  | `TOOL` | `tool` (`handoff` only when the explicit handoff evidence of §9 exists) |
|  | `CHAIN` | `workflow` |
|  | `EMBEDDING`, `RETRIEVER` | `llm` (subtype) |
| neither | n/a | `generic`: kept with all keys, shown in the waterfall, never dropped |

Attribute normalization accepts current names first, then aliases:
- `gen_ai.provider.name`, else `gen_ai.system`, else `llm.provider`, else `llm.system`;
- `gen_ai.request.model`, else `llm.model_name`;
- `gen_ai.response.model`;
- input tokens: `gen_ai.usage.input_tokens`, else `gen_ai.usage.prompt_tokens`, else `llm.token_count.prompt`;
- output tokens: `gen_ai.usage.output_tokens`, else `gen_ai.usage.completion_tokens`, else `llm.token_count.completion`;
- cache-read tokens: `gen_ai.usage.cache_read.input_tokens`, else `llm.token_count.prompt_details.cache_read`;
- cache-write tokens: `gen_ai.usage.cache_write.input_tokens`, else `gen_ai.usage.cache_creation.input_tokens`, else `llm.token_count.prompt_details.cache_write`;
- reasoning tokens: `gen_ai.usage.reasoning.output_tokens`, else `llm.token_count.completion_details.reasoning`;
- tool name: `gen_ai.tool.name`, else `tool.name`;
- tool call ID: `gen_ai.tool.call.id`.

Rules:
- There is no total-token attribute (OTF §1). Totals are computed as input + output and labeled computed.
- The alias that matched is recorded per operation (`normBasis`).
- OpenInference flattened message keys (`llm.input_messages.<i>.message.*`) are unflattened into an ordered list, and only then classified as `content` (§6).

Confidence on names: all are **H** in OTF §1/§4 except that ADK legacy key spellings, CrewAI shapes and OpenAI-Agents handoff payloads are **UNVERIFIED**. Every name is subject to change because the conventions are at Development status.

### 8. Usage
Usage rows: `(runId, operationRef, model, provider, inputTokens?, outputTokens?, cacheRead?, cacheWrite?, reasoning?, costUsdEstimate?, basis)`. Cost is only ever a source-reported estimate (`claude_code.api_request.cost_usd`, `model.usage.costUsdEstimate`). Swain does not price tokens. Session-scope ADR-0002 usage is never summed (M-18).

### 9. Relationship edges: evidence or nothing

`edge = { kind, from: {type, id}, to: {type, id}, basis, rule?, evidence: [{ layer: "L1", ref, keyId }] (1..64), keyIds: KeyId[], crossCredential: boolean, confidence: "asserted" | "inferred" }`

- **Cross-credential edges (r2, F6).** `crossCredential` is true when the evidence of an edge (both endpoints and the asserting record) was delivered by more than one ingest key. Such edges are **excluded from relationship counts by default** and always labeled "multiple credentials contributed". A query parameter shows them. This prevents one key holder from forging relationships onto another key's agents.
- **Conflicting records from different keys (r2, F6).** When two records conflict (ADR-0006 §4) and came from different keys, neither is canonical. The span is shown as "conflicting records from N credentials", with both provenance tuples, and both are excluded from L2 aggregates until an admin resolves the conflict (N4).

| Kind | Allowed bases (asserted) | Notes |
|---|---|---|
| `parent-of` (span → span) | `otlp.parentSpanId` | Same trace |
| `follows` (span → span, cross-trace) | `otlp.link` (span links) | Direction as recorded |
| `invoked` (agent → agent) | `otlp.parentSpanId` where the parent's operation is `agent` and the child's operation is `agent` with a different agent | Derived from two asserted facts. The rule `swain.edge.invoked-from-parent` is recorded |
| `spawned` (agent → agent) | `adr0002.spawned-by`, `adr0002.parentActorId`; Claude Code hook `agent_id`/`agent_type` (N2) | |
| `handoff` (agent → agent) | `attr:gen_ai.transfer.target.name` (+ `gen_ai.transfer.mode`); an OpenInference TOOL span with `graph.node.parent_id` pointing to a node of a different agent; `attr:graph.node.parent_id` | OTF §1/§4. Detection uses **attributes only**. The span name ("handoff to X") is displayed and never used for detection, consistent with §7.3. UNVERIFIED until a fixture passes |
| `called-tool` (agent → tool name) | operation `tool` under an agent's span or actor | Aggregate only |
| `same-session` (run ↔ run) | `attr:session.id`, `attr:gen_ai.conversation.id`, `adr0002.sessionId` | Grouping, never causal. Rendered as "same session" |
| `distributed` (run → run) | W3C `traceparent` propagation gives one trace, so a single run, not an edge; `otlp.link` across traces | |

- **Inferred edges.** These are edges by time proximity, name similarity, or matching tool names. They are created only by named rules (`rule` is required, `confidence: "inferred"`). They are **hidden by default** in every view and always labeled "inferred: <rule>" when shown. N1 to N3 define **no** inference rules. Adding one requires an ADR amendment.
- **Missing parent.** A span whose `parentSpanId` is not (yet) received is shown under the run root as "parent not received". No edge is invented. The edge appears once the parent arrives (read-time tree build).

### 10. Stable IDs and URLs
| URL | Resolves |
|---|---|
| `/` | redirect to the last-used project's fleet |
| `/o/<org-slug>/w/<ws-slug>/p/<project-slug>` | Fleet (agents list) |
| `/a/<agt_…>` | Agent page |
| `/r/<run_…>` | Run view |
| `/r/<run_…>/s/<spanIdHex>` and `/r/<run_…>#evt_…` | Span or event within a run |
| `/r/<run_…>/evidence/<batchId>/<path>` | Provenance view of one L1 record (hashes, path, raw bytes only if retained and permitted) |

IDs are unique per server because their components include the random project ID. Authorization is always checked on resolve (ADR-0007 §3). A run or agent that is not visible returns 404, never 403, so existence does not leak.

### 11. r2 changes (G0 security design review, 2026-11-16)
- F2: content policy on every string- and AnyValue-bearing field, applied recursively, with a per-record metadata cap, `bytesValue` always hash-only, keys neutralized, and an extended content-key list (§6.1 to §6.3).
- F3: native events and imports are downgraded to the project policy (§6.5).
- F5: agent keys are namespaced by basis (§3).
- F6: `keyId` on every L1 row; cross-credential edges and conflicts (§5, §9); pinned keys win (§3).
- F13: `recordSha256` is computed before truncation (§5).
- F15: secret-name rule, URL rule, masker extensions, `metadataPolicy: allowlist`, "best-effort" label (§6.2, §6.4).
- F18: the synthesized `tool.requested` is labeled and has no time (§7.2).
- **Refinements to the review text.** These are noted for the reviewer and are not disagreements with the intent:
  - (a) F15's name rule would match `token` inside `gen_ai.usage.input_tokens`, so the pinned numeric usage keys are exempt.
  - (b) The high-entropy heuristic exempts canonical UUIDs and 16/32/64-character lowercase hex. Telemetry is full of trace, span and request IDs in these shapes, and masking them would destroy correlation. A hex-only secret of those exact lengths in an unknown short attribute stays a residual (ADR-0007 §9 T-N6).
  - (c) F18's "end − duration_ms labeled derived" cannot be represented in an ADR-0002 `EventTime`. It is therefore view-only.
  - (d) The OpenInference handoff detector no longer reads the span name.

## Alternatives considered
| Alternative | Why not |
|---|---|
| Bump ADR-0002 to 0.2 with `provider: "otlp"` and span kinds | Breaks every existing store and export (0.1-only readers), and forces OTel semantics into a closed CLI-evidence schema |
| Store only normalized operations and drop the original records | Violates "preserve the original records and provenance". Normalizer bugs would become data loss |
| Infer handoffs from timing or names | Invents causality, which the project rules forbid |
| Classify by span name | Span names vary by emitter (OTF §1) |
| Store raw bodies by default | Senders like ADK emit content by default (OTF §3), so it would break the hash-only default |

## Consequences
- **Two evidence formats coexist:** ADR-0002 events and OTel records. The UI and fleet aggregates read L2, which is rebuildable.
- **Semconv churn.** Changes to the GenAI conventions change only the normalizer (L2), and old data can be re-normalized because L1 is kept.
- **Hash-only data from OTLP is less useful** than with content inline (the same trade-off as D-4).
- **Verification.** OTLP provenance is weaker than ADR-0002 file provenance unless `rawRetention: full` is set. Every run view states which applies.

## Guarantees changed
| Guarantee | Change |
|---|---|
| ADR-0002 schema, IDs, vectors | Unchanged |
| "No invented tool calls or LLM decisions" | Kept. One explicit adapter rule (§7.2, the `tool_result` pair) needs G0 approval |
| "Unsupported inferences labeled" | Strengthened: no inference rules at all through N3, and inferred edges are hidden by default |
| Hash-only default | Extended to OTLP at the receiver, regardless of the sender |
| Raw records "never copied into events" | Kept for events. OTLP raw bodies are stored only with opt-in |
