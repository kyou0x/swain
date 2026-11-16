# ADR-0002: Canonical event schema v0.1 and adapter contract shape

Status: Proposed, r2.2 (2026-11-15; r2.2 folds the the design spec WP-0 contract freeze: single-buffer read (M-5), contract additions, new warning codes, `ImportStats.folded`, PA-1/PA-2/PA-3 resolved and F10; r2.1 erratum: N2 `pathTruncated` rule in §1a, N13 `schemaVersion` pattern in §1 aligned with §1a). Amended for the G0 security conditions C11, C12, I1, I2 and M6 (the internal review record); M8, M9 and M11 were recorded as pending amendments and are resolved in r2.2 (section 12a). the design spec is approved conditionally (the maintainer decision record) and implements this revision. Formal acceptance of the ADR is still pending independent re-review. Supersedes the illustrative example in `CANONICAL-EVENTS.md` (that example is non-normative; `parentEventId` is replaced by `links`, `actorId` by `actor`, `timestamp` by `time`).
Date: 2026-11-15.

## Context

`CANONICAL-EVENTS.md` lists entities, 16 event families and invariants, and leaves enums, validators and IDs to this ADR. Provider research (`docs/research/PROVIDER-SOURCES.md`) shows the four providers differ in timestamps, IDs, model metadata and stability. None of them is fixture-verified yet. The schema therefore has to: (a) represent all four documented shapes without favoring Claude, (b) make "not captured" explicit, (c) make every event traceable to exact source bytes, and (d) be reproducible: same input bytes + same adapter version produce byte-identical output.

## Decision summary

1. Strict, closed envelope; per-kind typed payloads; validator rejects unknown fields (0.1 is not forward-compatible across minors, see section 11).
2. Core frames records, hashes bytes, assigns IDs and provenance. Adapters only map parsed records to *draft* events. Adapters cannot forge provenance or IDs.
3. IDs are SHA-256-derived, domain-separated, length-prefixed, namespaced by provider and source (section 6, with normative test vectors).
4. `sourceSequence` is the order. Timestamps are advisory and carry validity status. Nothing is reordered by time.
5. Every non-blank source record is accounted for. It maps to at least one known event, or to exactly one `source.unknown`, or to exactly one `capture.gap`.
6. By default, content is stored as a hash. Free-text and tool I/O are inlined only when the user opts in. Hashes are always kept.
7. Derived events (for example, a missing tool result) carry `derived` provenance that cites basis event IDs. They are never presented as source records.

## 1. Event envelope (`schemaVersion` "0.1.0")

| Field | Type | Req | Notes |
|---|---|---|---|
| `schemaVersion` | string ≤16, pattern `^0\.1\.[0-9]{1,6}$` (§1a) | yes | Emitted value `"0.1.0"`. See section 11. |
| `eventId` | `evt_` + 32 lowercase hex | yes | Section 6 |
| `kind` | `EventKind` | yes | Section 2 |
| `provider` | `"claude-code" \| "codex-cli" \| "gemini-cli" \| "opencode"` | yes | Closed in 0.1 |
| `providerVersion` | string ≤64 or `null` | yes | `null` = not observed in source. Never guessed from the installed CLI. |
| `sourceKind` | string `^[a-z0-9-]+\.[a-z0-9-]+$` ≤64 | yes | e.g. `codex-cli.exec-jsonl`; declared by adapter manifest |
| `sessionId` | `ses_` + 32 hex | yes | Section 6 |
| `turnId` | `trn_` + 32 hex or `null` | yes | `null` when no turn structure observed |
| `sourceSequence` | integer ≥0 | yes | 0-based index of non-blank record in source; for derived events = record count of source |
| `subIndex` | integer 0..1023 | yes | Order of events emitted from one record (or derived batch) |
| `time` | `EventTime` | yes | Section 7 |
| `actor` | `{ actorId: "act_"+32hex, role: ActorRole }` | yes | Section 4 |
| `status` | `EventStatus` | yes | Section 3; allowed set depends on kind |
| `payload` | per-kind object | yes | Section 9 |
| `links` | `Link[]` ≤16 | yes (may be empty) | Section 8 |
| `provenance` | `RecordProvenance \| DerivedProvenance` | yes | Section 5 |
| `completeness` | `Partial<Record<Facet, FacetCompleteness>>` | yes | Section 3; required facets per kind |
| `attributes` | `Record<string, string\|number\|boolean\|null>` ≤32 entries | yes (may be `{}`) | Keys `^[a-z0-9-]+\.[A-Za-z0-9_.-]{1,64}$` namespaced by provider. Scalars only. Strings ≤256 UTF-8 bytes. Metadata only; adapters MUST NOT place free text here (security-review item). |

All objects are plain JSON. Integers must be safe integers. No floats except `payload.costUsdEstimate`. Strings must be well-formed Unicode: lone surrogates are rejected by the validator, and adapters replace them with U+FFFD and mark the facet `partial` with reason `malformed-value`.

### 1a. String bounds (normative; C11, L4)

Every string field in the schema has a row in this table. A string field without a row is a schema bug. Lengths are UTF-8 bytes unless the row says otherwise. Every string must also be well-formed Unicode. The validator rejects violations; it never truncates.

Adapter truncation (§9) happens before validation and is marked in completeness. The core truncates `pointer` and `Issue.path` as described below.

| Field(s) | Bound | Pattern / rule |
|---|---|---|
| `schemaVersion` | ≤16 | `^0\.1\.[0-9]{1,6}$` |
| `eventId`, `sessionId`, `turnId`, `actorId`, `sourceId`, all `*ActorId`, link `target`, `basisEventIds[]` | exactly 36 | `^(evt\|ses\|trn\|act\|src)_[0-9a-f]{32}$`, with the prefix matching the field |
| `toolCallId`, `spawnedByToolCallId`, `viaToolCallId` | exactly 35 | `^tc_[0-9a-f]{32}$` |
| every `sha256`, `recordSha256` | exactly 64 | `^[0-9a-f]{64}$` |
| `providerVersion` | ≤64 | printable ASCII without spaces, `^[!-~]{1,64}$` |
| `sourceKind`, surface ids | ≤64 | `^[a-z0-9-]+\.[a-z0-9-]+$` |
| `provenance.adapter.id` | ≤64 | `^[a-z0-9-]+(\.[a-z0-9-]+)+$` |
| `provenance.adapter.version` | ≤32 | `^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,16})?$` |
| `provenance.rule` (derived) | ≤64 | `^[a-z0-9-]+(\.[a-z0-9-]+)+$` |
| `provenance.pointer` | ≤512, or `null` | RFC 6901 (`""` or begins with `/`, with `~` escapes valid). The core builds the pointer. If it would exceed 512 bytes, the core sets it to `null`, and the record's bytes stay addressable by line and offset. |
| `time.value` | exactly 24 | `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$` |
| `attributes` keys | ≤96 | `^[a-z0-9-]+\.[A-Za-z0-9_.-]{1,64}$` |
| `attributes` string values | ≤256 | none |
| `Bounded256` fields (`toolName`, `mcpServer`, `agentType`, `model`, `nativeSessionId`, `nativeType`, `topLevelKeys[]`) | ≤256 | none |
| `Bounded512` fields (`capture.gap.detail`) | ≤512 | see amendment PA-3 (resolved in r2.2, section 12a) |
| `file.changed.path` | ≤4096 | must not contain NUL |
| `ContentRef.inline` | ≤`maxInlineContentBytes`, absolute maximum 1,048,576 | must not split a code point |
| `SourceDescriptor.displayName` | ≤255 | must not contain `/`, `\` or NUL |
| `AdapterWarning.detail` keys / string values | ≤32 / ≤256 | keys match `^[a-zA-Z][a-zA-Z0-9]{0,31}$`; at most 8 entries |
| Validator `Issue.path` (output, C12) | ≤512 | RFC 6901. Each segment taken from an input key is truncated to 64 code points, then RFC 6901-escaped, then control-escaped. `pathTruncated: true` is set whenever any segment or the total was truncated (r2.1, N2). |

## 2. `kind` (closed enum, 16 families)

`session.started`, `session.ended`, `turn.started`, `turn.ended`, `message.observed`, `tool.requested`, `tool.completed`, `tool.failed`, `agent.started`, `agent.ended`, `file.changed`, `permission.requested`, `permission.decided`, `model.usage`, `capture.gap`, `source.unknown`.

Semantics that prevent over-claiming (S8):
- `tool.requested`: the agent asked for a tool invocation. It does NOT mean the tool ran.
- `tool.completed`: a result was observed from the provider. `status` says whether the provider reported success.
- `tool.failed`: the provider reported error, denial, decline or interruption.
- `file.changed`: emitted only when the provider reports a change (`payload.basis: "provider-reported"`), or when a successful tool result for a known write-type tool exists (`"derived-from-tool-result"`, with derived provenance citing that result). It is never emitted from a request alone.
- `message.observed` with `payload.channel: "reasoning"` is provider-exposed reasoning text (for example a Codex `reasoning` item). It is not hidden chain-of-thought. `completeness.internalReasoning` stays `unavailable`.

## 3. Status and completeness

`EventStatus` = `"none" | "success" | "failure" | "denied" | "interrupted" | "unknown"`.

| kind | allowed status |
|---|---|
| `tool.completed` | `success`, `unknown` (result present, success not stated) |
| `tool.failed` | `failure`, `denied`, `interrupted`, `unknown` |
| `turn.ended`, `agent.ended`, `session.ended` | `success`, `failure`, `interrupted`, `unknown` |
| `file.changed` | `success`, `failure`, `unknown` |
| all others | `none` |

Events are immutable facts. A request with no observed outcome does not get its status changed. Instead the core emits a derived `capture.gap` (`reason: "missing-result"`) linked to it. "Status remains partial" in `CANONICAL-EVENTS.md` is satisfied by that gap, which reports render as "outcome not observed".

`Facet` = `content | inputs | outputs | timestamp | actor | model | tokens | causality | internalReasoning`.
`FacetCompleteness` = `{ state: CompletenessState, reason?: CompletenessReason }`.
- `CompletenessState`:
  - `captured`: the source exposed the value in full.
  - `partial`: exposed but incomplete, truncated by bounds, or malformed.
  - `absent`: this provider/surface normally exposes it, but this record lacks it.
  - `unavailable`: this surface does not expose it by design.
  - `unknown`: the adapter cannot tell.
- `CompletenessReason` = `provider-does-not-expose | missing-in-record | exceeded-bounds | malformed-value | correlation-missing | adapter-unsupported`.
- Required facets: every kind requires `timestamp` and `actor`. `tool.*` also require `inputs` and `outputs`. `message.observed` requires `content` and `internalReasoning`. `model.usage` requires `model` and `tokens`. Links of rel `result-of` or `decides` require `causality`.
- If a facet is missing, the validator does not treat it as captured. Reports render a missing optional facet as "not assessed".

Content retention (whether a value is inlined) is separate from completeness and lives on `ContentRef` (section 10).

## 4. Actor model

`ActorRole` = `"user" | "agent" | "subagent" | "runtime" | "unknown"`. `runtime` is the host CLI itself: hooks, permission engine, compaction, API retries.
- The actor of tool events is the agent or subagent that requested the tool. A tool is not a principal.
- `actorId` = `deriveId("act", [provider, sessionId, actorKey])`. `actorKey` is `"user"`, `"runtime"`, `"root"` (main agent), or `"native:" + nativeAgentId` for subagents.
- The parent/child relationship is declared only in the `agent.started` payload (`agentActorId`, `parentActorId`, `agentType?`, `spawnedByToolCallId?`). Exports build an `actors[]` table from these.
- If a provider does not identify an agent (for example, Gemini has no documented subagent hook), the role is `agent`, the key is `"root"`, and `completeness.actor = {state: "unknown"}`.

## 5. Provenance

`RecordProvenance` (event produced from one physical source record):
```ts
{ type: "record"; sourceId: SrcId; line: number /*1-based physical line*/;
  byteOffset: number /*0-based offset of first record byte*/; byteLength: number;
  sha256: Hex64 /*of exact record bytes*/; pointer: string | null /*RFC 6901 JSON Pointer into record, e.g. "/message/content/2"*/;
  adapter: { id: string; version: string } }
```
`DerivedProvenance` (event inferred by a named deterministic rule):
```ts
{ type: "derived"; sourceId: SrcId; rule: string /*e.g. "core.missing-result"*/;
  basisEventIds: EvtId[] /*1..64, all present in same import*/; adapter: { id; version } }
```
Record bytes are the bytes between line terminators. The terminating `0x0A` is excluded. A preceding `0x0D` is included, so the hash is of exactly what is in the file. A UTF-8 BOM at file offset 0 is part of the first record's bytes and is reported as a warning. Verification recipe (documentation, not tooling): `tail -c +$((byteOffset+1)) FILE | head -c byteLength | sha256sum`.

Source descriptor (export-level, one per imported file): `{ sourceId, provider, sourceKind, sourceStability, sha256 /*whole file bytes*/, byteLength, recordCount, blankLineCount, displayName /*basename only, sanitized*/ }`. Full paths are not stored by default. `sourceStability` = `"documented-interface" | "internal-unstable" | "undocumented"`, copied from the adapter manifest and shown in every report.

## 6. Deterministic IDs

`deriveId(type, components)`, where `type` is one of `src | ses | trn | evt | act | tc`:
- Input bytes = UTF-8(`"atm:v0:" + type`) ‖ `0x0A`, then for each component, ASCII(decimal UTF-8 byte length) ‖ `":"` ‖ UTF-8 bytes.
- Components are non-empty well-formed strings or non-negative safe integers (encoded as decimal strings). Anything else throws a typed error.
- Output = `type + "_" +` the first 32 lowercase hex characters (128 bits) of SHA-256(input).

| ID | Components |
|---|---|
| `sourceId` | `[provider, sourceKind, "sha256:" + sha256(whole file)]` |
| `eventId` (record) | `[provider, sourceId, "r", sourceSequence, subIndex]` |
| `eventId` (derived) | `[provider, sourceId, "d", rule, ...basisEventIds]` |
| `sessionId` | `[provider, "native", nativeSessionId]` if the source exposes one, else `[provider, "source", sourceId]` |
| `turnId` | `[provider, sourceId, "native:"+id]` or `[provider, sourceId, "seq:"+sourceSequence of turn start]` |
| `toolCallId` (`tc_`) | `[provider, sourceId, nativeToolCallId]` |
| `actorId` | section 4 |

Rationale:
- Whole-file hashing makes import idempotent for identical bytes. It also keeps two different captures that share a byte-identical prefix from colliding. For example, two Codex `exec resume` streams can both begin `{"type":"thread.started","thread_id":"X"}`.
- Cost: an appended file is a new source with new IDs. Cross-source dedup is deferred to storage (P1). Live capture identity is deferred to P3.
- Native IDs are always namespaced, so a hostile or colliding native ID cannot alias events in another source.
- `sessionId` is namespaced per provider only, on purpose, so resumed captures group together. Grouping is not evidence: every event keeps its own provenance, and a forged session ID only mis-groups. Reports show per-source boundaries.
- Import reads the source once (the design spec M-5, replacing the earlier two-pass wording): one fd, one buffer, and both the hash and the framing use that buffer, so the hashed bytes are the parsed bytes. Change detection compares `fstat` (`size`, `mtimeMs`, `ino`) before and after the read and requires an EOF probe to return 0. Any difference aborts the import with `SourceChangedDuringImport`.

Notes (I1):
- An integer component and its decimal string encode identically. For example, `0` and `"0"` give the same ID. This is by design: each position in a component list has one fixed type defined by the table above, so the two forms never compete.
- 128-bit IDs are identifiers, not integrity proofs. Integrity rests only on the full 256-bit `sha256` values in provenance and `SourceDescriptor`.

Normative test vectors (computed with Node `crypto`, 2026-11-15):

| Call | Result |
|---|---|
| sha256 of record bytes `{"type":"turn.started"}` | `7306b54975174c6eb5111d663a47de795d167520e43cf66ee2923218b19fdb75` |
| sha256 of file `{"type":"turn.started"}\n` | `cf515a4acc6e41e0f111f01c78b13ba4253f611de9374474864f01e69a90c08f` |
| `deriveId("src", ["codex-cli","codex-cli.exec-jsonl","sha256:cf515a4a…c08f"])` | `src_20810c77e61076b845483cdd6effd831` |
| `deriveId("evt", ["codex-cli","src_20810c77e61076b845483cdd6effd831","r",0,0])` | `evt_e28e3b07981adc5141264668ec4d699d` |
| same, `subIndex` 1 | `evt_8bb4f1c2c226b6c4edd0c526e291ea9b` |
| same, `sourceSequence` 1, `subIndex` 0 | `evt_edd241c839d58eacf25615e3da6c3ede` |
| `deriveId("ses", ["claude-code","native","00000000-0000-4000-8000-000000000000"])` | `ses_0456910418276e33cd8c5ce46affbe8d` |
| `deriveId("tc", ["claude-code","src_20810c77e61076b845483cdd6effd831","toolu_é😀"])` | `tc_9df36bfdeb9fd87cd3ea8c32ff21453a` |
| `deriveId("evt", ["ab","c"])` vs `deriveId("evt", ["a","bc"])` | `evt_979219cea6e2cbbda23016f9aa5c7ddd` ≠ `evt_6fb5845637d0f29bf9de939efcc5390a` |

Duplicates: if two records in one source carry the same native record ID, both are emitted, because they are distinct physical evidence. The later one gets `links: [{rel: "duplicate-of", target}]` and a `duplicate-native-record` warning. Exports count it once in summaries and list it in full in the timeline. Nothing is merged silently or dropped.

## 7. Ordering and time

- Order within a source is total: `(sourceSequence, subIndex)`. Order across sources is the import order of sources, and is labeled "not causally ordered" in reports. Events are never reordered by timestamp.
- `EventTime` = `{ value: string | null, origin: "source" | "none", status: "valid" | "missing" | "invalid" }`.
  - `value` is normalized `YYYY-MM-DDTHH:mm:ss.sssZ` (UTC, ms; sub-ms truncated). It is set only when the status is `valid`.
  - `valid` means RFC 3339 with an explicit `Z` or offset, and 1970-01-01 ≤ t < 3000-01-01.
  - A timestamp with no offset, an unparseable one, or one out of range is `invalid` with `value: null`. It also produces a `timestamp-invalid` warning, and the raw text stays verifiable via the provenance hash.
- Import time is never used, because it would break determinism. `origin: "receipt"` is reserved for P3 live capture and is not valid in 0.1.
- If a valid timestamp is earlier than the previous valid one in the same source, the core emits a `timestamp-regression` warning and keeps the order.

## 8. Links

`Link` = `{ rel: LinkRel, target: EvtId }`. `LinkRel` = `result-of` (`tool.completed`/`tool.failed` → `tool.requested`), `decides` (`permission.decided` → `permission.requested`), `spawned-by` (`agent.started` → `tool.requested`), `ends` (`*.ended` → `*.started`), `gap-for` (`capture.gap` → affected event), `duplicate-of`.
- Adapters express links via correlation keys (native tool-call ID etc.). Core resolves them in `end()`.
- Every target must exist in the same import, otherwise the event fails validation.
- An unresolved result produces a derived `capture.gap` with reason `missing-start` (an orphan result), and the result's `causality` facet is set to `absent` with reason `correlation-missing`.

## 9. Payloads (per kind; all fields required unless marked `?`; unknown keys rejected)

- `session.started`: `{ nativeSessionId: Bounded256|null, trigger: "startup"|"resume"|"clear"|"compact"|"fork"|"unknown" }`
- `session.ended`: `{ reason: "exit"|"clear"|"logout"|"prompt-input-exit"|"resume"|"other"|"unknown" }`
- `turn.started`: `{ prompt: ContentRef|null }`. `turn.ended`: `{}`
- `message.observed`: `{ role: "user"|"assistant"|"system", channel: "text"|"reasoning"|"notification", content: ContentRef }`
- `tool.requested`: `{ toolCallId: TcId|null, toolName: Bounded256, toolNamespace: "builtin"|"mcp"|"unknown", mcpServer?: Bounded256, input: ContentRef|null }`
- `tool.completed`: `{ toolCallId: TcId|null, toolName: Bounded256|null, output: ContentRef|null, exitCode?: int, durationMs?: int }`
- `tool.failed`: the `tool.completed` fields plus `{ error: ContentRef|null, errorClass: "error"|"declined"|"denied"|"interrupted"|"timeout"|"unknown" }`
- `agent.started`: `{ agentActorId, parentActorId: ActId|null, agentType: Bounded256|null, spawnedByToolCallId: TcId|null }`. `agent.ended`: `{ agentActorId }`
- `file.changed`: `{ path: BoundedPath4096, changeKind: "add"|"delete"|"update"|"unknown", diff: ContentRef|null, viaToolCallId: TcId|null, basis: "provider-reported"|"derived-from-tool-result" }`. The path is metadata. It is never resolved, opened or normalized against the filesystem.
- `permission.requested`: `{ toolName: Bounded256|null, toolCallId: TcId|null, input: ContentRef|null }`. `permission.decided`: `{ decision: "allow"|"deny"|"ask"|"unknown", decidedBy: "user"|"policy"|"auto-mode"|"unknown", reason: ContentRef|null }`
- `model.usage`: `{ scope: "message"|"turn"|"session", model: Bounded256|null, inputTokens?, outputTokens?, cachedInputTokens?, cacheWriteInputTokens?, reasoningOutputTokens?, totalTokens?: int≥0, costUsdEstimate?: number≥0 }`. Cost is always labeled a provider-side estimate.
- `capture.gap`: `{ reason: GapReason, detail: Bounded512 /*static template text, never untrusted text*/, fromSequence?: int, toSequence?: int }`. `GapReason` = `malformed-record | truncated-final-record | record-too-large | depth-exceeded | invalid-utf8 | missing-result | missing-start | bounds-reached | adapter-error | adapter-output-invalid`.
- `source.unknown`: `{ nativeType: Bounded256|null /*value of the record's discriminator, if any*/, topLevelKeys: Bounded256[] /*≤32, sorted*/, recordSha256: Hex64 }`. This is a parseable record the adapter does not recognize. Its information survives as a hash and a key list, plus the full record via provenance.

`Bounded256` means a string of at most 256 UTF-8 bytes. Adapters truncate on a code-point boundary and mark the relevant facet `partial`/`exceeded-bounds`. Control characters are kept in canonical data. Each exporter is responsible for neutralizing them (S5, proposed S13).

## 10. Content policy

`ContentRef` = `{ sha256: Hex64, byteLength: int, encoding: "utf8" | "jcs-json", retention: "hash-only" | "inline" | "inline-truncated", inline?: string, redactionCount?: int }`.
- Hash input:
  - For a JSON string value: the UTF-8 bytes of the decoded string (`utf8`).
  - For any other JSON value: UTF-8 of its RFC 8785 (JCS) canonical serialization (`jcs-json`). That is `JSON.stringify` with keys sorted recursively by UTF-16 code units, which JCS matches for finite numbers.
- The default is `hash-only` for all `ContentRef`s: prompts, messages, tool inputs and outputs, diffs, errors, reasons. Inline content requires an explicit opt-in (`--include-content`). It is bounded to `maxInlineContentBytes`, and truncated on a code-point boundary, in which case retention is `inline-truncated`. The hash always covers the full original value.
- Metadata (tool names, statuses, exit codes, IDs, token counts, file paths, attributes) is not a `ContentRef` and is always retained. File paths may contain usernames, see register item D-11.
- Raw records are never copied into events. The provenance hash plus offsets is the link back to the evidence.
- Projection (M6): a `jcs-json` hash covers the value after `JSON.parse`. Duplicate keys collapse (the last one wins), numbers are re-serialized (`1.0` becomes `1`) and escapes are normalized. It is therefore not a hash of the source text. Exact source bytes are bound only by `provenance.sha256`.
- `canonicalJson` rejects anything that is not JSON-parsed plain data. It throws a typed error for excess depth, cycles, non-finite numbers, unsupported types, accessors and ill-formed strings.
- Validator consistency (r2.2, F9/F10, the design spec section 3.6):
  - integer `-0` is rejected;
  - `hash-only` means no `inline` and no `redactionCount`;
  - `inline` means `inline` is present, and when `redactionCount` is absent or 0, `utf8ByteLength(inline) === byteLength` and `sha256(utf8(inline)) === sha256` (for both encodings: the `jcs-json` inline is the full JCS text);
  - `inline-truncated` means `inline` is present and `utf8ByteLength(inline) < byteLength`;
  - `redactionCount >= 1` skips the hash check, because the hash covers the original value.
- Equality (I2): two `ContentRef`s describe the same content only if `encoding`, `sha256` and `byteLength` are all equal. The same digest under a different `encoding` is a different claim.
- Known risk (D-14, M10): hashes let anyone holding an export confirm guessed content offline, such as a short command or a password typed in a prompt. This is accepted for P0 only. Every export (S7) must state: "hashes allow confirmation of guessed content; do not share exports".
- Before any sharing or egress feature, all of the following are required:
  - keyed (HMAC or salted) hashes, or no content hashes in shared artifacts;
  - `byteLength` bucketed;
  - a fresh G3 review.

## 11. Versioning and forward compatibility

- `0.x` carries no cross-minor compatibility promise. Readers accept `0.1.*` exactly, and refuse other versions with a typed `UnsupportedSchemaVersion` error that says to re-import from the source. Canonical data is a reproducible projection of the source evidence. The source and its hash are authoritative.
- Patch releases (`0.1.n`) may fix the validator or docs only. They never add or change fields.
- Unknown *provider* data never breaks import: it becomes `source.unknown`, `unmapped-field` warnings, or `attributes`. Unknown *canonical* fields are always a validation error.
- The criteria for freezing 1.0 (not P0): at least two providers fixture-verified, a JSON Schema published and differentially tested against the TypeScript validator, and a migration policy written.

## 12. Adapter contract (TypeScript, contract level; types ship in the design spec, behavior in S3)

```ts
type ProviderId = "claude-code" | "codex-cli" | "gemini-cli" | "opencode";
type CaptureMode = "import-file" | "stream-events" | "live-hook";

interface AdapterManifest {
  id: string;                       // e.g. "claude-code.stream-json"
  adapterVersion: string;           // semver of adapter mapping; part of provenance
  provider: ProviderId;
  sourceKind: string;
  sourceStability: "documented-interface" | "internal-unstable" | "undocumented";
  captureModes: readonly CaptureMode[];          // P0: ["import-file"] only
  testedProviderVersions: readonly string[];     // exact versions with committed fixtures; may be []
  capabilities: ProviderCapabilities;            // must not exceed capability-matrix.json (contract test)
  framing: Framing;                              // r2.2 (the design spec M-6)
  experimental: boolean;                         // r2.2 (M-17): undocumented or internal surface; shown in every output
  attributeKeys: readonly string[];              // r2.2 (PA-3): exact allowlist of `attributes` keys
}

type Framing =                                   // r2.2
  | { kind: "jsonl" }
  | { kind: "json-document"; recordArrays: readonly string[] };   // RFC 6901 pointers to object keys, 1..4 entries

interface FramedRecord {               // produced by core reader, never by adapters
  sourceSequence: number; line: number; byteOffset: number; byteLength: number;
  sha256: string; finalWithoutNewline: boolean;
  parse: { ok: true; value: JsonValue } | { ok: false; failure: "malformed" | "too-large" | "depth" | "invalid-utf8" };
}

interface DetectResult {
  verdict: "match" | "no-match" | "unsupported";
  providerVersionSeen: string | null; nativeSessionId: string | null;
  reasons: readonly DetectReasonCode[];          // static codes, no untrusted text
}

interface SourceAdapter {
  readonly manifest: AdapterManifest;
  detect(sample: readonly FramedRecord[]): DetectResult;   // pure; sample ≤ bounds.detectSampleRecords
  createParser(ctx: ParseContext): RecordParser;          // ctx: provider version seen, bounds, content policy
}

interface RecordParser {                // synchronous, pure w.r.t. inputs; no I/O, no clock, no randomness
  push(record: FramedRecord): AdapterOutput;   // called only for parse.ok records; core handles failures
  end(): AdapterOutput;                        // flush: unresolved correlations
}
interface AdapterOutput { drafts: readonly DraftEvent[]; warnings: readonly AdapterWarning[];
  dispositions?: readonly RecordDisposition[] }                  // r2.2
// DraftEvent = envelope minus {schemaVersion,eventId,provider,sourceKind,sessionId,turnId,
//   sourceSequence,subIndex,provenance,links}; plus {pointer, nativeSessionId?, nativeTurnKey?,
//   actorKey, recordRef?: RecordRef, correlation?: {anchor?: string, refs?: {rel: LinkRel, key: string}[] /* <= 4 */}}.
//   r2.2: `recordRef` is required for drafts returned by end() and optional in push (default: the current record).
//   Payload IDs are given as native keys; core derives tc_/act_ IDs.
interface RecordRef { order: number; evidence: number }        // r2.2: sourceSequence values of already-pushed records
interface RecordDisposition { sourceSequence: number;          // r2.2 (M-7): accounts for a record that yields no event of its own
  kind: "superseded" | "control" | "rewound" | "metadata"; into: number | null }
interface DiscoveryRoot { base: "home" | "xdg-data" | "xdg-config"; segments: readonly string[] }   // r2.2
interface AdapterRegistration { adapter: SourceAdapter;        // r2.2: each adapter package exports exactly
  discovery: { roots: readonly DiscoveryRoot[]; fileNamePattern: string /* anchored regex source, no backreferences */ } }
//   `export const registrations: readonly AdapterRegistration[]`
interface AdapterWarning { code: WarningCode; severity: "info" | "warn" | "error";
  sourceSequence: number | null; detail: Readonly<Record<string, string | number>> /* ≤8 entries, bounded */ }

interface Bounds {                      // defaults; CLI may lower, raise only with explicit flag
  maxFileBytes: 268_435_456;            // 256 MiB
  maxRecordBytes: 16_777_216;           // 16 MiB
  maxJsonDepth: 64;  maxRecords: 2_000_000;  maxDraftsPerRecord: 1024;
  maxOpenCorrelations: 100_000;  maxInlineContentBytes: 65_536;
  maxWarnings: 1_000 /* then aggregated by code */;  detectSampleRecords: 64;
  maxAdapterErrors: 100 /* then abort: outcome "failed" */;
  // r2.2 (PA-2). Exceeding maxEvents or maxTotalInlineBytes gives a `bounds-reached` gap/warning and outcome `partial`.
  maxDocumentBytes: 67_108_864;         // 64 MiB, whole-buffer cap for json-document framing
  maxEvents: 1_000_000;
  maxTotalInlineBytes: 67_108_864;      // 64 MiB across all retained inline content
  maxOutputBytes: 268_435_456;          // 256 MiB rendered output; exceeding it throws OutputTooLarge
}
const ABSOLUTE_MAX_FILE_BYTES = 1_073_741_824;   // r2.2 (PA-2): ceiling that --max-file-bytes cannot raise maxFileBytes above
```
`WarningCode` = `untested-provider-version | unknown-record-type | unmapped-field | malformed-record | record-too-large | depth-exceeded | invalid-utf8 | truncated-final-record | utf8-bom | timestamp-invalid | timestamp-regression | duplicate-native-record | missing-result | orphan-result | bounds-reached | adapter-output-invalid | adapter-error | empty-source | blank-lines | warnings-aggregated | duplicate-json-key | record-array-missing | folded-records | attribute-not-allowed` (the last four are new in r2.2).

Core pipeline responsibilities (S2/S3):
- Input confinement: regular files only (no FIFO or device); size checked before read.
- Single-buffer read (M-5): the hashed bytes are the parsed bytes; change detection by pre/post `fstat` plus an EOF probe. Two framings (M-6): `jsonl` and `json-document` with declared record arrays.
- Framing and depth pre-scan before `JSON.parse`. Depth is counted over bytes outside strings, so the parse cannot recurse into hostile nesting.
- Strict UTF-8 decode.
- Turning parse failures into `capture.gap`.
- Calling the adapter inside try/catch. A throw becomes an `adapter-error` gap for that record.
- Validating every draft. An invalid draft is replaced by an `adapter-output-invalid` gap.
- Assigning IDs, provenance and links.
- Enforcing the record-accounting invariant.
- Emitting the `untested-provider-version` warning whenever the observed version is not in `testedProviderVersions`, including when that list is empty.

Wall-clock limits abort the import (outcome `failed`, nothing written). They never produce truncated "successful" output. Parsed objects are data only: keys such as `__proto__` or `constructor` are read with `Object.hasOwn`, and parsed values are never merged into internal objects.

Capability conformance is checked per surface (M12, S3/S4). An adapter may declare a capability above `unknown` only if its `manifest.sourceKind` is listed in that matrix cell's `surfaces`, and only up to that cell's `value`.

`ImportResult` = `{ source: SourceDescriptor, events: CanonicalEvent[], warnings: AdapterWarning[], stats: { records, blankLines, eventsByKind, gaps, unknowns, derived, folded }, outcome: "complete" | "partial" | "failed" }`. `partial` means at least one `capture.gap` or `source.unknown` exists. `stats.folded` (r2.2) counts records accounted for by a `RecordDisposition` instead of an event; it does not affect the outcome.

## 12a. Amendments PA-1 to PA-3 (all resolved in r2.2 by the design spec)

- **PA-1 (M8) Duplicate JSON keys: RESOLVED in r2.2 (the design spec M-8).**
  - A byte-level scanner detects duplicate keys at any depth during framing (keys compared as raw bytes, decoded only when they contain a backslash).
  - The record is still mapped, because `JSON.parse` keeps the last value, and the core emits warning `duplicate-json-key`.
- **PA-2 (M9) Aggregate bounds: RESOLVED in r2.2.** `maxDocumentBytes`, `maxEvents`, `maxTotalInlineBytes` and `maxOutputBytes` are in `Bounds` with the defaults in section 12, plus `ABSOLUTE_MAX_FILE_BYTES` (1 GiB), which `--max-file-bytes` cannot raise `maxFileBytes` above. Exceeding `maxEvents` gives a `bounds-reached` gap and outcome `partial`; exceeding `maxTotalInlineBytes` downgrades later refs to `hash-only` with one `bounds-reached` warning; exceeding `maxOutputBytes` throws `OutputTooLarge` (no partial output).
- **PA-3 (M11) Default-leak channels outside `ContentRef`: RESOLVED in r2.2 (the design spec section 3.5).** These fields carry source-derived text even under `hash-only`, and are now constrained:
  - `attributes`: per-manifest allowlist (`attributeKeys`, exact keys), scalars only, never free text. A key outside the allowlist replaces the draft with an `adapter-output-invalid` gap and emits `attribute-not-allowed`. `cwd` may appear only as `<provider>.cwd`, and displays mask it;
  - `capture.gap.detail` and warning `detail`: static template strings and integers only. Conformance asserts that no detail value appears in fixture record text;
  - `topLevelKeys`: each key truncated to 64 code points, at most 32 keys;
  - `pointer`: segments from untrusted keys are bounded by the section 1a rules (over 512 bytes becomes `null`);
  - home-prefix masking is the default on every display surface (D-11 resolved as the design spec M-12): canonical events keep the raw path, displays show `~/...`.

## 13. Consequences and risks

- The closed enums mean adding a fifth provider or a new kind requires a minor bump (0.2). That is acceptable while the schema is pre-1.0.
- With hash-only defaults, reports are less useful out of the box (they show tool names and statuses, not commands). This is a deliberate safety trade-off and is listed in the register for human confirmation.
- Whole-file source identity gives up idempotence across appended files in P0.
- Reasoning-channel messages could be misread as chain-of-thought. Reports must label them "provider-exposed reasoning text".

## Appendix A: capability matrix JSON Schema (to be materialized by slice S4 as `docs/architecture/capability-matrix.schema.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "swain:capability-matrix:0.1",
  "type": "object",
  "additionalProperties": false,
  "required": ["$schema", "matrixVersion", "generatedFrom", "rows", "providers"],
  "properties": {
    "$schema": { "type": "string" },
    "matrixVersion": { "const": "0.1.0" },
    "generatedFrom": { "type": "string", "minLength": 1 },
    "rows": { "type": "array", "items": { "$ref": "#/$defs/row" }, "minItems": 10, "maxItems": 10, "uniqueItems": true },
    "providers": {
      "type": "object", "additionalProperties": false,
      "required": ["claude-code", "codex-cli", "gemini-cli", "opencode"],
      "patternProperties": { "^(claude-code|codex-cli|gemini-cli|opencode)$": { "$ref": "#/$defs/provider" } }
    }
  },
  "$defs": {
    "row": { "enum": ["sessionLifecycle", "toolCallInputs", "toolCallOutputs", "llmMetadata", "filePatches", "subagents", "permissions", "failures", "timestamps", "tokens"] },
    "evidence": { "enum": ["DOCUMENTED", "SOURCE-OBSERVED", "LOCAL-OBSERVED", "NONE"] },
    "versionSeen": {
      "type": "object", "additionalProperties": false, "required": ["version", "evidence", "source"],
      "properties": { "version": { "type": ["string", "null"] }, "evidence": { "$ref": "#/$defs/evidence" }, "source": { "type": "string" } }
    },
    "surface": {
      "type": "object", "additionalProperties": false, "required": ["id", "stability", "p0Use", "source"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9-]+\\.[a-z0-9-]+$" },
        "stability": { "enum": ["documented-interface", "internal-unstable", "undocumented"] },
        "p0Use": { "enum": ["import-candidate", "fixture-shape-only", "deferred", "not-used"] },
        "source": { "type": "string" }, "note": { "type": "string" }
      }
    },
    "cell": {
      "type": "object", "additionalProperties": false,
      "required": ["value", "evidence", "surfaces", "source", "note", "verifiedByFixture"],
      "properties": {
        "value": { "enum": ["available", "partial", "unknown", "unsupported"] },
        "evidence": { "$ref": "#/$defs/evidence" },
        "surfaces": { "type": "array", "items": { "type": "string" } },
        "source": { "type": "string" },
        "note": { "type": "string" },
        "verifiedByFixture": { "type": "boolean" },
        "fixture": { "type": "string" }
      },
      "allOf": [
        { "if": { "properties": { "value": { "enum": ["available", "partial", "unsupported"] } } },
          "then": { "properties": { "evidence": { "not": { "const": "NONE" } }, "source": { "pattern": "^https://" } } } },
        { "if": { "properties": { "verifiedByFixture": { "const": true } } },
          "then": { "required": ["fixture"], "properties": { "fixture": { "type": "string", "pattern": "^fixtures/" } } } }
      ]
    },
    "provider": {
      "type": "object", "additionalProperties": false,
      "required": ["captureMode", "importViability", "testedVersions", "documentedVersionSeen", "localObservedVersion", "surfaces", "cells"],
      "properties": {
        "captureMode": { "type": "string" },
        "importViability": { "type": "string" },
        "testedVersions": { "type": "array", "items": { "type": "string" }, "uniqueItems": true },
        "documentedVersionSeen": { "$ref": "#/$defs/versionSeen" },
        "localObservedVersion": { "$ref": "#/$defs/versionSeen" },
        "surfaces": { "type": "array", "items": { "$ref": "#/$defs/surface" }, "minItems": 1 },
        "cells": {
          "type": "object",
          "required": ["sessionLifecycle", "toolCallInputs", "toolCallOutputs", "llmMetadata", "filePatches", "subagents", "permissions", "failures", "timestamps", "tokens"],
          "propertyNames": { "$ref": "#/$defs/row" },
          "additionalProperties": { "$ref": "#/$defs/cell" }
        }
      }
    }
  }
}
```
JSON Schema cannot express two of the matrix rules, so S4 tests them directly:
- If `testedVersions` is empty, then every cell has `verifiedByFixture: false`.
- Every `fixture` path in a cell exists on disk.
