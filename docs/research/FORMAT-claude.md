# Claude Code session formats (research)

Status: research, no real session read. Date: 2026-11-15.

## 0. Sources and versions

| Id | Source | Version / date |
|----|--------|----------------|
| SDK | npm `@anthropic-ai/claude-agent-sdk`, files `sdk.d.ts`, `sdk-tools.d.ts` (tarball `anthropic-ai-claude-agent-sdk-0.3.325.tgz`, extracted, never installed or executed) | **0.3.325** |
| CLI | `claude --version` / `claude --help` | 2.1.325 |
| DOC-H | https://code.claude.com/docs/en/headless | fetched 2026-11-15 |
| DOC-TS | https://code.claude.com/docs/en/agent-sdk/typescript | fetched 2026-11-15 |
| API | Anthropic Messages API content-block shapes. `@anthropic-ai/sdk` is NOT bundled (peer dep `>=0.93.0`, package.json); `sdk.d.ts` imports `BetaMessage`, `BetaRawMessageStreamEvent`, `BetaUsage`, `MessageParam` from it (sdk.d.ts lines 1-8). Block shapes below are from the public Messages API reference (https://docs.anthropic.com/en/api/messages), NOT re-verified in this research | n/a |

Confidence labels: **VERIFIED** (read in SDK .d.ts/docs above), **API** (public Messages API, not re-verified here), **COMMUNITY** (widely observed, no official schema), **UNKNOWN**.

Rule for adapters: unknown `type` / `subtype` / extra fields must be preserved and ignored, not rejected. The SDKMessage union is large and grows by version.

---

## A. `claude -p --output-format stream-json --verbose` (primary)

Transport: newline-delimited JSON on stdout, one `SDKMessage` per line (DOC-H "Get structured output"). `--verbose` is required with stream-json in print mode (task brief; CLI help says stream-json "only works with --print"). The last line is a `result` message (DOC-H). VERIFIED.

Relevant CLI flags (claude --help 2.1.325): `--include-partial-messages` (adds `stream_event` lines), `--include-hook-events` (hook lifecycle lines), `--replay-user-messages` (re-emit stdin user messages on stdout; requires `--input-format=stream-json`), `--input-format text|stream-json`, `--session-id <uuid>`.

### A.1 The `SDKMessage` union (sdk.d.ts:5805, v0.3.325) VERIFIED

Discriminated by `type` (and `subtype` for `system`):

- `assistant` (SDKAssistantMessage)
- `user` (SDKUserMessage, SDKUserMessageReplay)
- `result` (SDKResultSuccess | SDKResultError)
- `system` + subtype: `init`, `compact_boundary`, `status`, `api_retry`, `permission_denied`, plus the others in the union whose subtype strings were not enumerated here: SDKModelRefusalFallbackMessage, SDKModelRefusalNoFallbackMessage, SDKLocalCommandOutputMessage, SDKHookStarted/Progress/ResponseMessage, SDKPluginInstallMessage, SDKTaskNotification/Started/Updated/ProgressMessage, SDKBackgroundTasksChangedMessage, SDKSessionStateChangedMessage, SDKCommandsChangedMessage, SDKNotificationMessage, SDKFilesPersistedEvent, SDKMemoryRecallMessage, SDKElicitationCompleteMessage, SDKMirrorErrorMessage, SDKInformationalMessage, SDKConversationResetMessage, SDKSessionWritesLostMessage, SDKWorkerShuttingDownMessage. Exact `type`/`subtype` literals for these: UNKNOWN (read sdk.d.ts near the cited type names before supporting them).
- `stream_event` (SDKPartialAssistantMessage)
- Other top-level types in the union: SDKControlRequestProgressMessage, SDKToolProgressMessage, SDKAuthStatusMessage, SDKThinkingTokensMessage, SDKToolUseSummaryMessage, SDKRateLimitEvent, SDKPromptSuggestionMessage. Their literals: UNKNOWN. (`active_goal` exists as SDKActiveGoalMessage, sdk.d.ts:3814, but is not in the SDKMessage union.)

Every message listed below carries `uuid` and `session_id` (SDKUserMessage: both optional).

### A.2 system / init (sdk.d.ts:6510) VERIFIED

`type:"system"`, `subtype:"init"`, `uuid`, `session_id`, `cwd: string`, `claude_code_version: string`, `model: string`, `permissionMode` (`default|acceptEdits|bypassPermissions|plan|dontAsk|auto`), `apiKeySource` (`ANTHROPIC_API_KEY|apiKeyHelper|/login managed key|none|user|project|org|temporary|oauth`), `tools: string[]`, `mcp_servers: {name, status, source?}[]`, `slash_commands: string[]`, `output_style: string`, `skills: string[]`, `plugins: {name, path, version?}[]`.
Optional: `agents?: string[]`, `betas?: string[]`, `terminal_slash_commands?`, `plugin_errors?`, `fast_mode_state?`, `fast_mode_disabled_reason?`, `effort?` (`low|medium|high|xhigh|max|null`), `view_mode?` (`focus|default`), `capabilities?: string[]`. DOC-H adds `mcp_server_errors?` (name, type, message); it is not in the 0.3.325 .d.ts block read, so treat as DOC-only.
Ordering: init is first unless `plugin_install` or `hook_*` events precede it (DOC-H).

### A.3 assistant (sdk.d.ts:3852) VERIFIED

```
type: "assistant"
message: BetaMessage          // Messages API message: id, type:"message", role:"assistant", model, content[], stop_reason, usage, ...
parent_tool_use_id: string | null   // null = main conversation; tool_use id of Agent/Skill call for subagent output
uuid, session_id
error?: 'authentication_failed'|'oauth_org_not_allowed'|'account_on_hold'|'verification_required'|'billing_error'|'rate_limit'|'overloaded'|'invalid_request'|'model_not_found'|'server_error'|'unknown'|'max_output_tokens'|'cloud_credential_error'
request_id?, timestamp? (ISO 8601, display only, DOC-TS), user_message_uuid?, user_message_uuids?, resume_reason?,
resumed_from_incomplete_thinking?: true, supersedes?: UUID[] (drop the listed earlier messages), aborted?: true,
agent_id?, subagent_type?, task_description?, context_usage?, usage_report?
```
Notes (DOC-TS): one API turn may produce several assistant lines sharing `message.id`, each with one or more content blocks and its own `timestamp`. So group by `message.id`, not by line. `agent_id` absent on main thread.

### A.4 user (sdk.d.ts:6869 SDKUserMessage, 6972 SDKUserMessageReplay) VERIFIED

```
type: "user"
message: MessageParam            // {role:"user", content: string | ContentBlockParam[]}
parent_tool_use_id: string | null
uuid?, session_id?               // required on the Replay variant
isSynthetic?: boolean, priority?: 'now'|'next'|'later', origin?: SDKMessageOrigin, shouldQuery?: boolean,
timestamp?, client_composed?: true, pasted_content?, inline_pastes?, agent_id?, subagent_type?, task_description?
tool_use_result?: unknown        // structured tool output (see A.8), present on messages carrying a tool_result block
isReplay: true, file_attachments?: unknown[]   // Replay variant only
```
`SDKMessageOrigin` (sdk.d.ts:5810): `{kind:"human"}` | `{kind:"channel", server}` | `{kind:"peer", from, fromMode?, name?, fromSession?}` | task-notification kind (carries `runId`, DOC-TS); full set not enumerated: UNKNOWN.

Is the initial prompt echoed? With a plain `claude -p "<text>"`, the docs do not say the prompt is emitted: UNKNOWN. The documented echo mechanism is `--replay-user-messages` (stdin stream-json input only), which yields `SDKUserMessageReplay` (`isReplay:true`). Tool results always arrive as `type:"user"` lines containing `tool_result` blocks. An adapter must not rely on the echo: take the prompt from the wrapper's own invocation record.

### A.5 stream_event (sdk.d.ts:5966), only with `--include-partial-messages` VERIFIED

`type:"stream_event"`, `event: BetaRawMessageStreamEvent` (Messages API streaming events: message_start, content_block_start, content_block_delta with `delta.type` text_delta / input_json_delta / thinking_delta ..., content_block_stop, message_delta, message_stop; API), `parent_tool_use_id`, `uuid`, `session_id`, `ttft_ms?`, `user_message_uuid?`, `user_message_uuids?`, `resume_reason?`. DOC-H shows `.event.delta.type == "text_delta"` with `.event.delta.text`. Adapters can ignore stream_event and rely on the complete `assistant` lines.

### A.6 result (sdk.d.ts:6257 success, 6162 error) VERIFIED

Common: `type:"result"`, `subtype`, `duration_ms`, `duration_api_ms`, `is_error: boolean`, `num_turns`, `stop_reason: string|null`, `total_cost_usd: number`, `usage: NonNullableUsage` (BetaUsage keys made non-null; Messages API usage: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, ... API), `modelUsage: Record<model, ModelUsage>`, `permission_denials: SDKPermissionDenial[]`, `uuid`, `session_id`.
- Success (`subtype:"success"`): adds `result: string`, `structured_output?`, `api_error_status?`, `deferred_tool_use?`, plus many optional timing fields (`ttft_ms`, ...).
- Error (`subtype` = `error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries`): adds `errors: string[]`; no `result` field.
- Optional on both: `terminal_reason?` (`blocking_limit|rapid_refill_breaker|prompt_too_long|image_error|model_error|api_error|malformed_tool_use_exhausted|aborted_streaming|aborted_tools|stop_hook_prevented|hook_stopped|tool_deferred|max_turns|background_requested|completed|budget_exhausted|structured_output_retry_exhausted|tool_deferred_unavailable|turn_setup_failed`), `queued_turn_count?`, `origin?`, `fast_mode_state?`, `user_message_uuid(s)?`, `resume_reason?`, `result_index?`, `credential_expires_at?`.
- `ModelUsage` (sdk.d.ts:1554): `inputTokens`, `outputTokens`, `thinkingTokens?`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `cacheCreationEphemeral5mInputTokens?`, `cacheCreationEphemeral1hInputTokens?`, `webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel?`, `provider?`, `costBasis?` (`list|managed|unknown`).
- `SDKPermissionDenial` (sdk.d.ts:5995): `{tool_name, tool_use_id, tool_input: Record<string,unknown>}`.
- Note: `is_error` can be true while `subtype` is `success` (both fields exist independently). Use both.
- `usage` is cumulative for the run; whether it equals the sum of per-message `message.usage`: UNKNOWN.

### A.7 Other system subtypes of interest VERIFIED

- `compact_boundary` (sdk.d.ts:4002): `compact_metadata:{trigger:'manual'|'auto', pre_tokens, post_tokens?, duration_ms?, preserved_segment?:{head_uuid, anchor_uuid, tail_uuid}, preserved_messages?:{anchor_uuid, uuids[]}}`, `uuid`, `session_id`.
- `api_retry` (sdk.d.ts:3830): `attempt`, `max_retries`, `retry_delay_ms`, `error_status: number|null`, `error` (same enum as assistant `error`), `no_response?:{waited_ms, retry_wait_ms}`, `uuid`, `session_id`.
- `status` (sdk.d.ts:6492): `status: 'compacting'|'requesting'|null`, `permissionMode?`, `compact_result?: 'success'|'failed'`, `compact_error?`.
- `permission_denied` (sdk.d.ts:6004): `tool_name`, `tool_use_id`, `agent_id?`, `decision_reason_type?`, `decision_reason?`, `message`.
- `plugin_install` (DOC-H): `status: started|installed|failed|completed`, `name?`, `error?`, `uuid`, `session_id`.
- Subagent forwarding (DOC-H): subagent assistant/user lines have `parent_tool_use_id` = id of the Agent/Skill `tool_use`; forked skill started via `/<skill>` prompt uses a value starting `forked-command-`. Text/thinking of subagents only with `--forward-subagent-text`.

### A.8 Content blocks (Messages API, source API; not bundled in SDK 0.3.325)

In `assistant.message.content[]`:
- `{type:"text", text}`
- `{type:"thinking", thinking, signature}` (also `redacted_thinking {data}`)
- `{type:"tool_use", id, name, input}` (`id` like `toolu_...`; `input` is the tool's input object)
- also server tool blocks (`server_tool_use`, `web_search_tool_result`, ...): not enumerated, UNKNOWN for adapters.

In `user.message.content[]` (a string is also legal for human prompts):
- `{type:"text", text}`, `{type:"image", source}`, `{type:"document", ...}`
- `{type:"tool_result", tool_use_id, content, is_error?}` where `content` is a string or an array of text/image blocks; `is_error` is optional (absent means false).

Join: `tool_result.tool_use_id` == earlier `tool_use.id`. VERIFIED link to `tool_use_result` (sdk.d.ts:6869 doc): shape is per tool, keyed by the matching tool_use `name`; typed `unknown`; MCP/dynamic tools carry their own shapes. Some calls produce `{detachedToolCall:true}` (DOC-TS).

### A.9 Built-in tools and input keys (sdk-tools.d.ts 0.3.325; names from DOC-TS "Tool Input Types") VERIFIED

| Tool name | Input (sdk-tools.d.ts) | File-change relevance |
|-----------|------------------------|-----------------------|
| `Bash` | `command`, `timeout?`, `description?`, `run_in_background?`, `dangerouslyDisableSandbox?` (BashInput:807) | Arbitrary; cannot know changed files from input. Output `stdout`, `stderr`, `interrupted`, `backgroundTaskId?`, `gitOperation?{commit{sha,kind,branch?},push,branch,pr}` (BashOutput:3447) |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all?` (FileEditInput:857) | Writes `file_path`. Output: `filePath`, `oldString`, `newString`, `originalFile: string|null`, `structuredPatch[{oldStart,oldLines,newStart,newLines,lines}]`, `userModified`, `replaceAll`, `gitDiff?`, `staged?` (FileEditOutput:3584) |
| `Write` | `file_path`, `content` (FileWriteInput:897) | Writes `file_path`. Output: `type:"create"|"update"`, `filePath`, `content`, `structuredPatch`, `originalFile: string|null`, `gitDiff?`, `userModified?`, `staged?` (FileWriteOutput:3636) |
| `NotebookEdit` | `notebook_path`, `cell_id?`, `new_source`, `cell_type?` (`code|markdown`), `edit_mode?` (`replace|insert|delete`) (:1004) | Writes `notebook_path`. Output has `original_file`, `updated_file`, `error?` |
| `Read` | `file_path`, `offset?`, `limit?`, `pages?`, `allow_large?` (:875) | read-only |
| `Glob` | `pattern`, `path?` (:907) | read-only |
| `Grep` | `pattern`, `path?`, `glob?`, `output_mode?`, ... (:917) | read-only |
| `Agent` | `description`, `prompt`, `subagent_type?`, `model?`, `effort?`, `run_in_background?`, `name?`, `team_name?`, `mode?`, `isolation?` (AgentInput:765) | Spawns subagent. Name is `Agent`; the old name `Task` "is still accepted as an alias" (DOC-TS line ~2855), so older streams/transcripts may say `Task`. |
| `WebFetch`, `WebSearch`, `TodoWrite`, `TaskStop`, `AskUserQuestion`, `Monitor`, `Workflow`, `TaskCreate/Get/Update` | see sdk-tools.d.ts | not file-changing |

- `MultiEdit`: NOT present in sdk-tools.d.ts or DOC-TS 0.3.325 (grep found no occurrence). Treat as legacy/UNKNOWN: an adapter may recognize the name defensively but must not assume a schema (commonly `{file_path, edits:[{old_string,new_string,replace_all?}]}` is COMMUNITY only).
- MCP tools are named `mcp__<server>__<tool>` (convention; the literal prefix is COMMUNITY, not re-verified here).
- Paths in `file_path` are absolute in tool schemas by convention; relative values: UNKNOWN. `Edit`/`Write` pre-image is available from `tool_use_result.originalFile` (null when the file did not exist), which is the best source for before/after snapshots without reading the disk.

---

## B. On-disk transcript `~/.claude/projects/<project>/<session-id>.jsonl` (EXPERIMENTAL adapter)

### B.1 What is official

No published schema. `sdk.d.ts` (0.3.325) says explicitly (SessionStoreEntry doc, ~line 7230): the on-disk transcript is "a large discriminated union over `type` covering user/assistant messages, summaries, titles, tags, mode changes, etc.", that union "is CLI-internal and not part of the SDK API surface", and the only guaranteed structure is: every entry has a string `type`; most carry a `uuid` and ISO `timestamp`; the rest is opaque JSON. VERIFIED.

Official APIs that read it (sdk.d.ts, DOC-TS):
- `listSessions({dir?, limit?, offset?, includeWorktrees?})` returns `SDKSessionInfo` (sdk.d.ts:6387): `sessionId`, `summary`, `lastModified` (ms), `fileSize?`, `customTitle?`, `firstPrompt?`, `gitBranch?`, `cwd?`, `tag?`, `createdAt?`, `archived?: boolean` VERIFIED.
- `getSessionInfo(sessionId, {dir?})`, `getSessionMessages(sessionId, {dir?, limit?, offset?, includeSystemMessages?})`, `getSubagentMessages(sessionId, agentId, ...)` VERIFIED. Docs: it "parses the transcript, builds the conversation chain via `parentUuid` links, and returns user/assistant messages in chronological order". This confirms `parentUuid` linking exists in the file.
- `SessionMessage` (sdk.d.ts:7112): `{type:'user'|'assistant'|'system', uuid, session_id, message: unknown, parent_tool_use_id: string|null, parent_agent_id: string|null}`. Note this is the SDK's normalized view, NOT the raw line (snake_case `session_id` vs. raw camelCase `sessionId`).
- `SessionStore` interface (alpha) mirrors entries: `append(key, entries)`, `load(key)`; "one per line in the local JSONL file"; entries without `uuid` include "titles, tags, mode markers" (sdk.d.ts ~7195-7330). Entries are `SessionStoreEntry = {type: string; uuid?: string; timestamp?: string; [k]: unknown}`. VERIFIED.
- Subagent transcripts live in separate files/subkeys ("subpath", `listSubkeys`) VERIFIED existence; path layout UNKNOWN.

Safest adapter strategy: use `getSessionMessages` / `listSessions` through the SDK where a Node runtime is acceptable; parse raw JSONL only as EXPERIMENTAL with the field table below.

### B.2 Path layout

`~/.claude/projects/<project>/<session-id>.jsonl`: `<session-id>` is a UUID (`--session-id <uuid>` per CLI help). `<project>` is the project cwd with path separators replaced by `-` (e.g. `/home/user/project` -> `-home-user-project`): COMMUNITY, not verified (the SDK calls it `projectKey`, sdk.d.ts:1126, no encoding rule given: UNKNOWN). The `CLAUDE_CONFIG_DIR` override: UNKNOWN.

### B.3 Raw line fields (COMMUNITY unless noted)

| Field | Applies to | Confidence |
|-------|------------|------------|
| `type`: `user`, `assistant`, `system`, `summary`, plus others (titles, tags, mode markers, file-history-snapshot, queue-operation, ...) | all | `type` string VERIFIED; the value list is COMMUNITY/UNKNOWN |
| `uuid` | most entries | VERIFIED (optional) |
| `timestamp` (ISO 8601) | most entries | VERIFIED (optional) |
| `parentUuid` (string or null for root) | user/assistant/system | COMMUNITY; existence of `parentUuid` linking VERIFIED via getSessionMessages doc |
| `sessionId` | message entries | COMMUNITY |
| `cwd` | message entries | COMMUNITY (SDKSessionInfo exposes `cwd`, VERIFIED derived) |
| `version` (Claude Code version) | message entries | COMMUNITY |
| `gitBranch` | message entries | COMMUNITY (SDKSessionInfo `gitBranch` VERIFIED derived) |
| `isSidechain` (bool; true for subagent branches) | message entries | COMMUNITY |
| `userType`, `entrypoint`, `slug`, `requestId` | various | COMMUNITY, weak |
| `message` | user/assistant | role/content per Messages API; assistant adds `id`, `model`, `stop_reason`, `usage` (API/COMMUNITY) |
| `toolUseResult` (camelCase raw counterpart of stream `tool_use_result`) | user entries with tool_result | COMMUNITY; the stream-side `tool_use_result` shape is VERIFIED (A.8), the raw name is not |
| `isMeta`, `isCompactSummary`, `isApiErrorMessage`, `isVisibleInTranscriptOnly` | various | COMMUNITY, weak |
| `summary` (string), `leafUuid` | `type:"summary"` lines | COMMUNITY |
| `subtype`, `content`, `level`, `compactMetadata` | `type:"system"` lines | COMMUNITY, weak |

Raw-vs-stream differences to expect (COMMUNITY): (1) camelCase raw keys vs snake_case in the stream; (2) one assistant API message may be split across several lines sharing `message.id`, each with its own `uuid` (matches DOC-TS note on A.3); (3) lines are appended incrementally, so a trailing partial line is possible when the file is read live: UNKNOWN, parse defensively; (4) `/compact` yields summary and boundary entries; (5) the file is rewritten/forked on resume: UNKNOWN whether resume appends to the same file or creates a new `<session-id>`. Treat `uuid` as the idempotency key (sdk.d.ts SessionStore doc).

---

## C. Open questions (UNKNOWN)

1. Whether `claude -p "<text>"` echoes the prompt as a `user` line in stream-json (docs silent; only `--replay-user-messages` documented).
2. Exact `type`/`subtype` literals for ~25 minor system and progress messages (A.1).
3. Full `SDKMessageOrigin` variants and `BetaUsage` full key list (the `@anthropic-ai/sdk` types are not bundled).
4. `mcp_server_errors` presence in the typed init message (DOC-H only).
5. `MultiEdit` existence and schema in 0.3.325 (absent from types).
6. Raw transcript: authoritative field list, project-directory encoding, resume file behavior, subagent file layout, partial-line behavior, compaction entries.
7. Whether stream `usage` equals the sum of per-message usage.
8. Whether `tool_result.content` for Edit/Write errors has a stable text format (e.g. "File has not been read yet"): UNKNOWN; do not parse the message text.

---

## D. SYNTHETIC examples (fake values only)

Shapes follow section A (VERIFIED fields only; content-block shapes per API). Stream lines are one JSON object per line; `usage` is abbreviated to the keys named in A.6 (a real `usage` carries more BetaUsage keys).

### D.1 stream-json (10 lines)

```jsonl
{"type":"system","subtype":"init","cwd":"/home/user/project","session_id":"11111111-1111-4111-8111-111111111111","uuid":"aaaaaaaa-0000-4000-8000-000000000001","claude_code_version":"0.0.0-example","model":"example-model","permissionMode":"default","apiKeySource":"none","tools":["Bash","Edit","Read","Write"],"mcp_servers":[],"slash_commands":[],"output_style":"default","skills":[],"plugins":[]}
{"type":"user","message":{"role":"user","content":"Fix the typo in README.md"},"parent_tool_use_id":null,"uuid":"aaaaaaaa-0000-4000-8000-000000000002","session_id":"11111111-1111-4111-8111-111111111111","isReplay":true}
{"type":"assistant","message":{"id":"msg_example01","type":"message","role":"assistant","model":"example-model","content":[{"type":"text","text":"I will look at the file first."},{"type":"tool_use","id":"toolu_example01","name":"Bash","input":{"command":"cat README.md","description":"Show README"}}],"stop_reason":"tool_use","usage":{"input_tokens":10,"output_tokens":20}},"parent_tool_use_id":null,"uuid":"aaaaaaaa-0000-4000-8000-000000000003","session_id":"11111111-1111-4111-8111-111111111111"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_example01","content":"# Projct\n"}]},"parent_tool_use_id":null,"uuid":"aaaaaaaa-0000-4000-8000-000000000004","session_id":"11111111-1111-4111-8111-111111111111","tool_use_result":{"stdout":"# Projct\n","stderr":"","interrupted":false}}
{"type":"assistant","message":{"id":"msg_example02","type":"message","role":"assistant","model":"example-model","content":[{"type":"tool_use","id":"toolu_example02","name":"Edit","input":{"file_path":"/home/user/project/README.md","old_string":"Projct","new_string":"Project"}}],"stop_reason":"tool_use","usage":{"input_tokens":30,"output_tokens":15}},"parent_tool_use_id":null,"uuid":"aaaaaaaa-0000-4000-8000-000000000005","session_id":"11111111-1111-4111-8111-111111111111"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_example02","content":"File has not been read yet. Read it first before writing to it.","is_error":true}]},"parent_tool_use_id":null,"uuid":"aaaaaaaa-0000-4000-8000-000000000006","session_id":"11111111-1111-4111-8111-111111111111"}
{"type":"assistant","message":{"id":"msg_example03","type":"message","role":"assistant","model":"example-model","content":[{"type":"text","text":"The edit failed; I stopped."}],"stop_reason":"end_turn","usage":{"input_tokens":40,"output_tokens":8}},"parent_tool_use_id":null,"uuid":"aaaaaaaa-0000-4000-8000-000000000007","session_id":"11111111-1111-4111-8111-111111111111"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":4200,"duration_api_ms":3900,"num_turns":3,"result":"The edit failed; I stopped.","stop_reason":"end_turn","total_cost_usd":0.0123,"usage":{"input_tokens":80,"output_tokens":43,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"modelUsage":{"example-model":{"inputTokens":80,"outputTokens":43,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.0123,"contextWindow":200000,"maxOutputTokens":32000}},"permission_denials":[],"uuid":"aaaaaaaa-0000-4000-8000-000000000008","session_id":"11111111-1111-4111-8111-111111111111"}
```

(Line 2, the user prompt echo, is shown as a replay line; per C.1 it may be absent in real plain `-p` output. Line 6's error text is fake.)

### D.2 transcript JSONL (6 lines, COMMUNITY shape, EXPERIMENTAL)

```jsonl
{"type":"summary","summary":"Fix README typo","leafUuid":"bbbbbbbb-0000-4000-8000-000000000005"}
{"type":"user","uuid":"bbbbbbbb-0000-4000-8000-000000000001","parentUuid":null,"sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/home/user/project","version":"0.0.0-example","gitBranch":"main","isSidechain":false,"message":{"role":"user","content":"Fix the typo in README.md"}}
{"type":"assistant","uuid":"bbbbbbbb-0000-4000-8000-000000000002","parentUuid":"bbbbbbbb-0000-4000-8000-000000000001","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T00:00:02.000Z","cwd":"/home/user/project","version":"0.0.0-example","gitBranch":"main","isSidechain":false,"message":{"id":"msg_example01","role":"assistant","model":"example-model","content":[{"type":"tool_use","id":"toolu_example01","name":"Edit","input":{"file_path":"/home/user/project/README.md","old_string":"Projct","new_string":"Project"}}],"usage":{"input_tokens":10,"output_tokens":20}}}
{"type":"user","uuid":"bbbbbbbb-0000-4000-8000-000000000003","parentUuid":"bbbbbbbb-0000-4000-8000-000000000002","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T00:00:03.000Z","cwd":"/home/user/project","version":"0.0.0-example","gitBranch":"main","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_example01","content":"The file has been updated."}]},"toolUseResult":{"filePath":"/home/user/project/README.md","oldString":"Projct","newString":"Project","originalFile":"# Projct\n","structuredPatch":[],"userModified":false,"replaceAll":false}}
{"type":"assistant","uuid":"bbbbbbbb-0000-4000-8000-000000000004","parentUuid":"bbbbbbbb-0000-4000-8000-000000000003","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T00:00:04.000Z","cwd":"/home/user/project","version":"0.0.0-example","gitBranch":"main","isSidechain":false,"message":{"id":"msg_example02","role":"assistant","model":"example-model","content":[{"type":"text","text":"Done."}],"usage":{"input_tokens":30,"output_tokens":4}}}
{"type":"system","uuid":"bbbbbbbb-0000-4000-8000-000000000005","parentUuid":"bbbbbbbb-0000-4000-8000-000000000004","sessionId":"11111111-1111-4111-8111-111111111111","timestamp":"2026-01-01T00:00:05.000Z","subtype":"example_unknown_subtype"}
```
