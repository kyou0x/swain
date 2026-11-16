# Codex CLI session formats (field-level)

Source: public `openai/codex` source only. No real session, log or `~/.codex` file was read.

- **Pinned tag: `rust-v0.169.0`** (latest release, published 2026-11-13; `GET /releases/latest`).
- Compared against `rust-v0.167.0` (the locally installed version). Differences are noted per section. Files that are byte-identical between the two tags: `codex-rs/rollout/src/policy.rs`, `codex-rs/exec/src/exec_events.rs`, `codex-rs/rollout/src/rollout_file_name.rs`.
- Citation convention: `[path @0.169.0]` means the file at tag `rust-v0.169.0`. Paths are relative to the repo root. Anything not verified in source is marked **UNKNOWN**.
- Downloads were kept in an isolated temporary directory and treated as untrusted data (never executed).

## 0. Critical findings for an adapter

1. **Two persistence modes exist: `legacy` and `paginated`**, selected by `SessionMeta.history_mode` (`"legacy"` | `"paginated"`, default `legacy` when the field is absent) [codex-rs/protocol/src/protocol.rs `ThreadHistoryMode` @0.169.0]. At 0.169.0 the local store defaults new threads to **`paginated`** (`LocalThreadStore::default_history_mode` returns `Paginated` [codex-rs/thread-store/src/local/mod.rs @0.169.0]; the trait default is `Legacy` [codex-rs/thread-store/src/store.rs @0.169.0]). Old files (and files from older CLIs) are legacy. A startup/RPC job can migrate legacy rollouts to paginated [codex-rs/thread-store/src/local/rollout_migration.rs @0.169.0]; whether that runs by default is UNKNOWN. An adapter MUST handle both.
2. The persistence filter differs by mode (section 4). In paginated mode the legacy `user_message` / `agent_message` / `agent_reasoning` / `patch_apply_end` events are NOT written. They are replaced by `item_completed` events carrying a `TurnItem`. In both modes `exec_command_end` and `exec_command_begin` are never persisted.
3. Paginated lines carry an extra top-level `ordinal` (u64, starts at 0, or at `history_base.end_ordinal_exclusive` for forks) [codex-rs/rollout/src/ordinal.rs, codex-rs/history/src/lib.rs `RolloutLine` @0.169.0]. Legacy lines have no `ordinal`.
4. Files can also exist as `.jsonl.zst` (section 6).
5. `session_meta.payload` has NO `instructions` field any more; instructions moved to `base_instructions` and to `TurnContext` [doc comment on `SessionMeta`, codex-rs/protocol/src/protocol.rs @0.169.0]. Older rollouts may still contain `instructions`; that is UNKNOWN at this tag (not in the struct; serde ignores unknown fields unless `deny_unknown_fields`, which is not present).

## 1. Rollout file: naming and location

- Root: `<codex_home>/sessions/YYYY/MM/DD/` (`SESSIONS_SUBDIR = "sessions"`; archived threads: `<codex_home>/archived_sessions/`, flat layout) [codex-rs/rollout/src/lib.rs, recorder.rs `precompute_new_rollout_path`, `ThreadListLayout` @0.169.0].
- The date directory and the filename timestamp both come from `OffsetDateTime::now_local()` (LOCAL time, no offset in the name) [codex-rs/rollout/src/recorder.rs @0.169.0]. The `SessionMeta.timestamp` field, by contrast, is UTC.
- Filename (parsed by `RolloutFileName::parse`, rendered by `render`) [codex-rs/rollout/src/rollout_file_name.rs @0.169.0]:
  - ordinary: `rollout-YYYY-MM-DDThh-mm-ss-<thread_uuid>.jsonl` (timestamp format `[year]-[month]-[day]T[hour]-[minute]-[second]`, exactly 19 chars, then `-`, then the id).
  - reverted threads: `rollout-<ts>-<thread_uuid>_<rollout_uuid>.jsonl` (thread id and a distinct rollout id joined with `_`).
- Compressed form: `<same name>.zst`, i.e. `rollout-....jsonl.zst` [codex-rs/rollout/src/compression.rs `COMPRESSED_SUFFIX = ".zst"` @0.169.0]. The reader transparently handles both. A plain `.jsonl` sibling wins if both exist ("preferring the plain `.jsonl` file over its `.jsonl.zst` compressed sibling"). Compression is a background worker: zstd level 3, only files with age >= 7 days (`MIN_ROLLOUT_AGE`), run marker throttled at 6 h [compression.rs @0.169.0]. Appending to a compressed rollout first materializes it back to plain `.jsonl`. Whether compression is enabled by default is UNKNOWN (the code mentions a "Statsig cohort" for metrics only). **The adapter must support reading `.jsonl.zst`.**
- Writer lock and maintenance lock files exist (`rollout-maintenance.lock` under `<codex_home>/.tmp/`) [codex-rs/rollout/src/maintenance.rs @0.169.0]; files may be replaced by rename during migration or compression, so read defensively.
- Other on-disk stores (sqlite state DB, `session_index`) exist [codex-rs/rollout/src/state_db.rs, session_index.rs @0.169.0]; their schema is out of scope and UNKNOWN here.
- 0.167.0 vs 0.169.0: file-name code identical.

## 2. Top-level JSONL line

`RolloutLine` [codex-rs/history/src/lib.rs @0.169.0]:

```rust
pub struct RolloutLine {
    pub timestamp: String,                       // RFC3339-like string, see note
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u64>,                    // paginated mode only
    #[serde(flatten)]
    pub item: RolloutItem,                       // supplies "type" + "payload" (+ "metadata")
}
```

`RolloutItem` is serialized through `RolloutItemWire` with `#[serde(tag = "type", rename_all = "snake_case")]` [codex-rs/history/src/rollout_payload.rs @0.169.0]. So each line is:

```json
{"timestamp": "...", "ordinal": 0, "type": "<variant>", "payload": { ... }, "metadata": { ... }}
```

`metadata` appears only on `response_item` lines (optional). Line timestamp format: the writer for SessionMeta uses `[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z` [recorder.rs @0.169.0]; the per-line timestamp is presumably the same formatter, but this is UNKNOWN for non-session_meta lines (the type is `String`, so parse leniently).

The reader notes that the generic Serde buffer cannot replay floats inside flattened/tagged fields, so the canonical decoder `decode_rollout_line` removes `timestamp` and `ordinal` from the object and decodes the rest as `RolloutItem` [codex-rs/rollout/src/lib.rs @0.169.0]. An adapter should do the equivalent (read the JSON object, then dispatch on `type`).

### 2.1 `type` values (RolloutItemWire variants) [rollout_payload.rs @0.169.0]

| `type` | `payload` | Persisted? (policy.rs) |
|---|---|---|
| `session_meta` | SessionMetaLine (flattened SessionMeta + `git`) | always |
| `dynamic_tools_updated` | `{thread_id, tools[]}` (DynamicToolsUpdatedPayload; inner tool spec shape UNKNOWN, not fetched) | always |
| `response_item` | ResponseItem (+ sibling `metadata`) | filtered by `should_persist_response_item` |
| `inter_agent_communication` | InterAgentCommunication (codex-rs/protocol/src/protocol.rs:995; field list not captured, UNKNOWN) | always |
| `inter_agent_communication_metadata` | `{trigger_turn: bool}` | always |
| `compacted` | CompactedItem (section 2.5) | always |
| `turn_context` | TurnContextItem (section 2.3) | always |
| `token_usage_record` | TokenUsageRecord (section 2.6) | always |
| `world_state` | `{full: bool, state: {..}}` | always |
| `retained_context` | RetainedContextEvent (internals UNKNOWN) | always |
| `security_risk_score` | SecurityRiskScore (internals UNKNOWN) | always |
| `event_msg` | EventMsg (internally tagged, section 4) | filtered by `persisted_event_msg` |
| `realtime_item` | RealtimeItem | paginated mode only |

Note: there is no `session_meta`-less "header" line type; `session_meta` is the first line written for a new rollout (it is created at writer init [recorder.rs @0.169.0]). Paginated rollouts "never append metadata-only SessionMeta updates" [codex-rs/thread-store/src/thread_metadata_sync.rs @0.169.0]; legacy rollouts may contain additional `session_meta` lines later (UNKNOWN exactly when).

### 2.2 SessionMeta / SessionMetaLine

`payload` = SessionMeta fields flattened + optional `git` [protocol.rs `SessionMeta`, `SessionMetaLine` @0.169.0]. On read, a missing `session_id` is filled from `id`.

| field | type | notes |
|---|---|---|
| `account_scoped` | bool | omitted when false |
| `creator_user_id`, `creator_account_id` | string? | omitted when None |
| `session_id` | SessionId (uuid string) | equals the root thread id; absent in old files (defaults to `id`) |
| `id` | ThreadId (uuid string) | stable thread id |
| `forked_from_id` | ThreadId? | |
| `attached_thread` | bool | omitted when false |
| `forked_from_ordinal_exclusive` | u64? | |
| `parent_thread_id` | ThreadId? | |
| `timestamp` | string | UTC `YYYY-MM-DDThh:mm:ss.mmmZ` |
| `cwd` | path string | |
| `runtime_workspace_roots` | string[]? | absent = unknown |
| `originator` | string | value set by the host; actual values UNKNOWN |
| `cli_version` | string | `CARGO_PKG_VERSION` |
| `source` | SessionSource | `rename_all="lowercase"`: `"cli"`, `"vscode"` (default), `"exec"`, `"mcp"`, `{"custom":"..."}`, `{"internal":...}`, `{"subagent":...}`, `"unknown"` fallback |
| `thread_source` | string? | `user`/`subagent`/`guardian_review`/`memory_consolidation`/feature string |
| `agent_nickname`, `agent_role` (alias `agent_type`), `agent_path` | string? | sub-agent only |
| `model_provider` | string? | e.g. provider id from config |
| `base_instructions` | `{text, provenance?}`? | BaseInstructions [codex-rs/protocol/src/models.rs @0.169.0]; may be missing in old files |
| `dynamic_tools` | DynamicToolSpec[]? | omitted if empty |
| `selected_capability_roots` | SelectedCapabilityRoot[] | omitted if empty; shape UNKNOWN |
| `memory_mode` | string? | `"disabled"` when memory generation is off |
| `history_mode` | `"legacy"`\|`"paginated"` | default legacy |
| `history_base` | `{thread_id, end_ordinal_exclusive, end_byte_offset}`? | prefix of another rollout (`thread_id` is really a rollout id) |
| `subagent_history_start_ordinal` | u64? | |
| `multi_agent_version` | `"disabled"`\|`"v1"`\|`"v2"`? | |
| `context_window` | `{window_id}`? | UUIDv7 |
| `git` | `{commit_hash?, branch?, repository_url?}` | GitInfo, each omitted when None; URL is sanitized |

0.167.0 vs 0.169.0: SessionMeta field-set diff not exhaustively checked (UNKNOWN); the protocol.rs diff between tags is ~7 KB and mostly additive.

### 2.3 TurnContextItem (`type: "turn_context"`)

[protocol.rs `TurnContextItem`, plus `serialize_turn_context` in rollout_payload.rs @0.169.0]. Written once per real user turn (and again after mid-turn compaction).

| field | type | notes |
|---|---|---|
| `turn_id` | string? | |
| `root_turn_id` | string? | |
| `direct_only_tool_namespaces` | string[]? | |
| `disabled_plugin_ids` | string[]? | |
| `cwd` | absolute path | |
| `approval_policy` | AskForApproval | kebab-case: `"untrusted"`, `"on-request"` (alias `on-failure`), `"never"`, or `{"granular":{sandbox_approval, rules, ...}}` |
| `approvals_reviewer` | ApprovalsReviewer? | values UNKNOWN |
| `permission_profile` | PermissionProfile | tagged `type`, snake_case: `{"type":"managed","file_system":...,"network":...}`, `{"type":"disabled"}`, `{"type":"external","network":...}`. Inner `file_system`/`network` shapes UNKNOWN |
| `active_permission_profile` | `{id, extends?}`? | e.g. `":workspace"` |
| `model` | string | |
| `comp_hash` | string? | |
| `collaboration_mode` | CollaborationMode? | shape UNKNOWN (not fetched) |
| `multi_agent_version`, `realtime_active`, `cyber_access_program` | optional | |
| `effort` | ReasoningEffort? | |
| `summary` | ReasoningSummary? | legacy placeholder |
| **`sandbox_policy`** | SandboxPolicy | written on the wire for older readers (compat shim) [rollout_payload.rs]: tag `type` kebab-case: `{"type":"danger-full-access"}`, `{"type":"read-only","network_access"?}`, `{"type":"external-sandbox","network_access"}`, `{"type":"workspace-write","writable_roots"?, "network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"}` |
| `file_system_sandbox_policy` | RawFileSystemSandboxPolicy? | compat, optional; shape UNKNOWN |

Reader accepts either `permission_profile` or (older files) `sandbox_policy` (+ optional `file_system_sandbox_policy`); one of them is required. **At 0.167.0 `sandbox_policy` was a plain required struct field and `permission_profile` was optional** [v0.167.0 protocol.rs]; at 0.169.0 both are written. Adapters should read `sandbox_policy` first, falling back to `permission_profile`.

### 2.4 ResponseItem (`type: "response_item"`, payload tagged by `type`, snake_case)

[codex-rs/protocol/src/models.rs `ResponseItem` @0.169.0]. All `Option` fields below are `skip_serializing_if = None` (absent when unset). Every variant also may carry `internal_chat_message_metadata_passthrough` (opaque, optional) which I omit from the tables. Variants and persistence (`should_persist_response_item`, policy.rs): persisted = all except `compaction_trigger` and `other`.

| `type` | fields |
|---|---|
| `message` | `role: string` ("user"\|"assistant"\|"developer"\|"system"), `content: ContentItem[]`, `id?`, `status?`, `encrypted_content?`, `phase?` ("commentary"\|"partial_answer"\|"final_answer") |
| `agent_message` | `author`, `recipient`, `content: [{type:"input_text",text} \| {type:"encrypted_content",encrypted_content}]`, `id?` |
| `reasoning` | `summary: [{type:"summary_text",text}]`, `content?: [{type:"reasoning_text"\|"text", text}]`, `encrypted_content: string\|null` (always serialized, may be null), `id?` |
| `local_shell_call` | `call_id: string\|null`, `status: "completed"\|"in_progress"\|"incomplete"`, `action: {type:"exec", command: string[], timeout_ms: u64\|null, working_directory: string\|null, env: map\|null, user: string\|null}`, `id?`, `encrypted_content?` |
| `function_call` | `name`, `arguments: string` (a JSON-encoded string, NOT an object), `call_id`, `namespace?`, `id?`, `status?`, `encrypted_function_args?: string[]`, `encrypted_content?` |
| `function_call_output` | `output` (string OR array of FunctionCallOutputContentItem), `call_id?`, `name?`, `namespace?`, `id?` |
| `custom_tool_call` | `call_id`, `name`, `input: string` (raw freeform text), `namespace?`, `id?`, `status?`, `encrypted_content?` |
| `custom_tool_call_output` | `call_id`, `output` (same encoding as function_call_output), `name?`, `id?` |
| `tool_search_call` | `execution`, `arguments` (JSON value), `call_id?: string\|null`, `status?`, `id?` |
| `tool_search_output` | `status`, `execution`, `tools: []` (opaque JSON), `call_id: string\|null`, `id?` |
| `web_search_call` | `status?`, `action?: {type:"search", query?, queries?} \| {type:"open_page", url?} \| {type:"find_in_page", url?, pattern?} \| other`, `id?` |
| `image_generation_call` | `status`, `result: string`, `revised_prompt?`, `id?` |
| `additional_tools` | `role`, `tools: []` (opaque), `id?` |
| `compaction` (alias `compaction_summary`) | `encrypted_content: string`, `id?` |
| `context_compaction` | `encrypted_content?`, `id?` |
| `configuration_update` | `reasoning: ConfigurationReasoning` (shape UNKNOWN; models/configuration_update.rs not fetched) |
| `compaction_trigger` | `{}`; NOT persisted |
| (unknown type) | deserializes to `Other` via `#[serde(other)]`; NOT persisted. An adapter should keep unknown `type`s as opaque |

`ContentItem` (tag `type`, snake_case): `{type:"input_text", text}`, `{type:"output_text", text, annotations?, logprobs?}`, `{type:"input_image", image_url | file_id, detail?}` (`detail`: `auto`/`low`/`high`/`original`), `{type:"input_audio", audio_url | file_id}`.

`FunctionCallOutputContentItem`: `input_text{text}`, `input_image{image_url|file_id, detail?}`, `input_audio{audio_url|file_id}`, `encrypted_content{encrypted_content}`.

`function_call_output.output` serializes as a bare string or an array; the internal `success` flag is NOT serialized [models.rs `FunctionCallOutputPayload` @0.169.0]. So success/failure of a shell call must be derived from the text.

Tool names and argument shapes (from tool specs, [codex-rs/core/src/tools/handlers/shell_spec.rs, apply_patch_spec.rs @0.169.0]):
- `exec_command` (function tool): arguments JSON `{cmd (required), workdir?, tty?, yield_time_ms?, max_output_tokens?, shell?, login?, ...approval params}`. `write_stdin` is the companion. `shell_command` is also recognized by the registry [core/src/tools/registry.rs:587]. Older CLIs used `shell` with `command: string[]`; that is UNKNOWN at this tag (not found in `ToolName::plain` list).
- `apply_patch`: a FREEFORM custom tool, so it is a `custom_tool_call` whose `input` is the raw patch text ("*** Begin Patch ... *** End Patch"), not JSON.
- Other tool names seen: `update_plan`, `view_image`, `spawn_agent`, `wait_agent`, `send_message`, `followup_task`, `interrupt_agent`, `list_agents`, `tool_search`, `request_permissions`, `list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`, `exec`, `network_access` [`ToolName::plain` grep over codex-rs/core/src/tools @0.169.0]. MCP tools use `function_call` with a namespaced name; exact naming scheme UNKNOWN.

Output text conventions (model-facing text stored in `output`):
- Unified exec (`exec_command`/`write_stdin`) header [core/src/tools/context.rs `response_header` @0.169.0], joined by `\n`: optional `Chunk ID: <id>`, `Wall time: <secs:.4> seconds`, then `Process exited with code <n>` (when finished) OR `Process running with session ID <id>`, optional `Original token count: <n>`, then `Output:` followed by the output body.
- Classic shell [core/src/tools/mod.rs `format_exec_output_for_model`]: `Exit code: <n>\nWall time: <x> seconds\n[Total output lines: <n>\n]Output:\n<body>`.
- MCP tool output: `Wall time: <secs:.4> seconds\nOutput:\n<text>` prepended as header.
- Exit code in text is the only exit-code signal in the response items; in paginated mode the structured `exit_code` is in the `item_completed` `CommandExecution` item (section 4.2).

`metadata` (sibling of `payload` on `response_item` lines) = `CodexHarnessMetadata`, all optional: `history_sequence`, `sampled_through_sequence`, `guardian_sources`, `guardian_review_ids`, `retained_source`, `client_authored`, `fallback_token_limit_override`, `delivered_assistant_message`, `harness_authored_configuration`, `compaction_model_hash`, etc. [codex-rs/history/src/lib.rs @0.169.0]. Harness-internal; an adapter may ignore it.

### 2.5 CompactedItem (`type: "compacted"`)

[codex-rs/history/src/rollout_payload.rs `CompactedItemWire` @0.169.0]: `message: string`, optional `replacement_history: ResponseItem[]` (+ parallel `replacement_history_metadata[]`, same length or the line is rejected), `guardian_history`, `retained_context`, `mcp_resource_origins`, `window_number`, `first_window_id`, `previous_window_id`, `window_id` (a legacy numeric window number is also accepted on read), `compaction_response_id`, `latest_token_usage_record`, `resume_metadata`. Compaction replaces model history from this point; the `message` is rendered as an assistant output_text message.
0.167.0: `payload: Cow<CompactedItem>` instead of `Cow<Box<CompactedItem>>` (Rust-level only; the JSON shape is not different from that diff).

### 2.6 TokenUsageRecord (`type: "token_usage_record"`)

`{thread_id, turn_id, session_id, root_turn_id, response_id, usage: TokenUsage, turn_token_usage: TokenUsage, thread_token_usage: TokenUsage}` [protocol.rs @0.169.0].

`TokenUsage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` (default 0 on read), `output_tokens`, `reasoning_output_tokens`, `total_tokens` (all i64). `codex_rollout_budget_units` is never serialized.

## 3. EventMsg framing

`EventMsg` is internally tagged: `#[serde(tag = "type", rename_all = "snake_case")]` [protocol.rs @0.169.0]. So an `event_msg` line is `{"timestamp", ["ordinal"], "type":"event_msg", "payload": {"type":"<event>", ...event fields}}`. Renames: `TurnStarted` serializes as `task_started` (alias `turn_started` accepted); `TurnComplete` serializes as `task_complete` (alias `turn_complete`). All other names are snake_case of the variant (`token_count`, `user_message`, `agent_message`, `item_completed`, `turn_aborted`, `thread_rolled_back`, `thread_settings_applied`, `thread_goal_updated`, `patch_apply_end`, `context_compacted`, ...).

## 4. Which EventMsg variants reach the rollout

Verbatim from `persisted_event_msg` [codex-rs/rollout/src/policy.rs @0.169.0 (identical at 0.167.0)]:

Always persisted:
```
EventMsg::TokenCount, ThreadGoalUpdated, ThreadRolledBack, TurnAborted, TurnStarted,
TurnComplete, ThreadSettingsApplied
```
`ItemCompleted` goes through `persisted_item_completed_event`:
- **Legacy mode**: only when `item` is `FunctionCallOutput`, `Plan`, `Extension(Sleep)` or `SubAgentActivity` with `kind == Completed`.
- **Paginated mode**: persisted for ALL item kinds. `CommandExecution.aggregated_output` is truncated to 64 KiB (middle truncation, marker `"\n... command output truncated for persistence ...\n"`) and `McpToolCall.result` is truncated to 64 KiB.

Persisted ONLY when `history_mode == Legacy`:
```
UserMessage, AgentMessage, AgentReasoning, AgentReasoningRawContent, EnteredReviewMode,
ExitedReviewMode, PatchApplyEnd, ContextCompacted, McpToolCallEnd, WebSearchEnd,
ImageGenerationEnd
SubAgentActivity (Legacy and kind != Completed)
```
Never persisted (verbatim "Transient, non-durable events"): `Error, ThreadQueueChanged, GuardianAssessment, ExecCommandEnd, ViewImageToolCall, Collab*End, DynamicToolCallRequest, DynamicToolCallResponse, Warning, AuthRecovery*, GuardianWarning, RealtimeConversation*, SafetyBuffering, ModelReroute, ModelVerification, TurnModerationMetadata, AgentReasoningSectionBreak, PrivateSessionEvent, RawResponseItem, RawResponseCompleted, SessionConfigured, EnvironmentConnected/Disconnected, McpToolCallBegin, ExecCommandBegin, TerminalInteraction, ExecCommandOutputDelta, ExecApprovalRequest, RequestPermissions, RequestUserInput, ElicitationRequest, ElicitationAbandoned, NetworkApprovalResolved, ApplyPatchApprovalRequest, StreamError, PatchApplyBegin, PatchApplyUpdated, TurnDiff, McpStartup*, WebSearchBegin, PlanUpdate, ShutdownComplete, DeprecationNotice, ItemStarted, HookStarted/Completed, *Delta, ImageGenerationBegin, Collab*Begin`.

Consequence: errors are NOT in rollouts except via `task_complete.error` / `turn_aborted.error`. `exec_command_end` (exit code, duration) is never in a rollout; paginated mode has it only inside `item_completed` `CommandExecution`.

### 4.1 Persisted event payloads

All event payloads include `"type"` (the EventMsg tag) alongside these fields. Citations: [protocol.rs @0.169.0].

- `task_started` (TurnStartedEvent): `turn_id: string`, `model_context_window: i64|null`, `collaboration_mode_kind` (ModeKind, default; values UNKNOWN), optional `turn_attribution`, `root_turn_id`, `trace_id`, `started_at` (unix secs).
- `task_complete` (TurnCompleteEvent): `turn_id`, `last_agent_message: string|null`, optional `root_turn_id`, `error` (ErrorEvent), `started_at`, `completed_at` (unix secs), `duration_ms`, `time_to_first_token_ms`.
- `turn_aborted`: `turn_id: string|null`, `reason: "interrupted"|"replaced"|"review_ended"|"budget_limited"`, optional `root_turn_id`, `error`, `started_at`, `completed_at`, `duration_ms`.
- `token_count` (TokenCountEvent): `info: TokenUsageInfo|null`, `rate_limits: RateLimitSnapshot|null` (both always present as keys). `TokenUsageInfo` = `{total_token_usage: TokenUsage, last_token_usage: TokenUsage, last_usage_includes_reasoning?: bool, model_context_window: i64|null}`. `total_token_usage` is cumulative for the thread (`new_or_append` adds `last` into `total`); `last_token_usage` is the most recent response. `RateLimitSnapshot` fields: `limit_id, limit_name, normal_model_slug?, primary, secondary, credits, individual_limit, spend_control_reached, plan_type, rate_limit_reached_type` (sub-struct shapes UNKNOWN).
- `error` (ErrorEvent; transient, NOT persisted): `message`, `codex_error_info?`.
- `thread_rolled_back`: `{num_turns: u32}` (legacy marker; "live rollback operations are unsupported").
- `thread_settings_applied`: `{thread_id?, thread_settings: {model, model_provider_id, service_tier?, approval_policy, approvals_reviewer, requested_approvals_reviewer?, ...}}` (rest of snapshot not fully captured, UNKNOWN).
- `thread_goal_updated`: `{thread_id, turn_id?, goal}`; NOTE this struct is `rename_all = "camelCase"`.
- `item_completed` (ItemCompletedEvent): `thread_id`, `turn_id`, `item: TurnItem`, optional `content_token_count: u64` (new in 0.169.0 vs 0.167.0), optional `started_at_ms: i64`, `completed_at_ms: i64` (defaults to 0 when absent).
- Legacy-only (persisted only in `legacy` mode):
  - `user_message`: `message: string`, `images?: string[]`, `image_details[]`, `file_ids?`, `file_id_details[]`, `image_order[]`, `local_images: path[]`, `local_image_details[]`, `audio?`, `audio_references?`, `audio_order[]`, `local_audio[]`, `text_elements` (not fully captured), `client_id?`.
  - `agent_message`: `message`, `phase?`, `memory_citation?`, `moderation?`, `delivery?`, `questions?`.
  - `agent_reasoning` / `agent_reasoning_raw_content`: `{text}`.
  - `patch_apply_end`: `call_id`, `turn_id` (default ""), `stdout`, `stderr`, `success: bool`, `changes: {<path>: FileChange}`, `status: "completed"|"failed"|"declined"`.
  - `mcp_tool_call_end`: `call_id`, `turn_id`, `invocation`, `connector_id?`, ... plus result fields (full struct not captured, UNKNOWN).
  - `web_search_end`: `call_id`, `query`, `action`, `results?`.
  - `image_generation_end`: `call_id`, `status`, `revised_prompt?`, flattened image ref, `transparent_background?`, `failure?`.
  - `context_compacted`: unit struct (no fields).
  - `entered_review_mode` / `exited_review_mode`: structs not captured (UNKNOWN).
- Not persisted but defined (needed only for context): `exec_command_end` has `call_id`, exit code, output, duration etc. [protocol.rs:4001]; `patch_apply_begin` has `call_id, turn_id, auto_approved, changes`.

`FileChange` (tag `type`, snake_case): `{type:"add", content}`, `{type:"delete", content}`, `{type:"update", unified_diff, move_path: string|null}`.

### 4.2 TurnItem inside `item_completed.item` (paginated mode)

`TurnItem` is `#[serde(tag = "type")]` with NO rename_all, so the tag values are the Rust variant names verbatim (PascalCase) [codex-rs/protocol/src/items.rs @0.169.0]: `UserMessage`, `FunctionCallOutput`, `HookPrompt`, `AgentMessage`, `Plan`, `Reasoning`, `CommandExecution`, `DynamicToolCall`, `CollabAgentToolCall`, `SubAgentActivity`, `WebSearch`, `ImageView`, `Extension`, `ImageGeneration`, `EnteredReviewMode`, `ExitedReviewMode`, `FileChange`, `McpToolCall`, `ContextCompaction`. Fields of the ones that matter:

- `UserMessage`: `{id, client_id?, content: UserInput[]}`. `UserInput` is tagged `type` snake_case: `text{text, text_elements: []}`, `image{image_url|file_id, detail?}`, `local_image{path, detail?}`, `audio{...}`, `local_audio{path}`, `skill{name, path}`, `mention{name, path}` [codex-rs/protocol/src/user_input.rs @0.169.0].
- `AgentMessage`: `{id, content: [{type:"Text", text}], phase?, moderation?, memory_citation?, delivery?, questions?}`. Note `AgentMessageContent` is `#[serde(tag="type")]` without rename, so the tag is `"Text"` (capital T).
- `Reasoning`: `{id, summary_text: string[], raw_content: string[]}`.
- `CommandExecution`: `{id, plugin_id?, script_path?, process_id?, command: string[], cwd: PathUri, parsed_cmd: ParsedCommand[], source, interaction_input?, status, aggregated_output?, exit_code?, duration?}`. `source` is `"agent"|"user_shell"|"unified_exec_startup"|"unified_exec_interaction"`; `status` is `"in_progress"|"completed"|"failed"|"declined"`; `ParsedCommand` is tagged `type` snake_case: `read{cmd,name,path}`, `list_files{cmd,path}`, `search{cmd,query,path}`, `unknown{cmd}`. `PathUri` wire form and `duration` wire form (std `Duration`, probably `{secs,nanos}`) are UNKNOWN (not fetched/confirmed).
- `FileChange`: `{id, changes: {<path>: FileChange}, status?: "completed"|"failed"|"declined", auto_approved?, stdout?, stderr?}`.
- `McpToolCall`, `WebSearch{id, query, action, results?}`, `DynamicToolCall`, `CollabAgentToolCall`, `Plan`, `ImageView{id,path}`, etc.: partial; see items.rs.

## 5. `codex exec --json` stdout stream

Source: [codex-rs/exec/src/exec_events.rs @0.169.0 (identical at 0.167.0)] for types and [codex-rs/exec/src/event_processor_with_jsonl_output.rs @0.169.0] for the mapping. One JSON object per line (`println!` of `serde_json::to_string`). If serialization fails, the line is `{"type":"error","message":"failed to serialize exec json event: ..."}`.

`ThreadEvent` is `#[serde(tag = "type")]` with explicit renames:

| `type` | payload fields |
|---|---|
| `thread.started` | `thread_id: string` |
| `turn.started` | `{}` |
| `turn.completed` | `usage: {input_tokens, cached_input_tokens, cache_write_input_tokens (default 0), output_tokens, reasoning_output_tokens}` (i64). NO `total_tokens`. Value is the LAST `thread/tokenUsage` TOTAL (cumulative for the thread), not a per-turn delta; all zeros if none seen (`usage_from_last_total`) |
| `turn.failed` | `error: {message}` |
| `item.started` | `item: ThreadItem` |
| `item.updated` | `item: ThreadItem` (used only for the todo list) |
| `item.completed` | `item: ThreadItem` |
| `error` | `message: string` (fatal stream error) |

`ThreadItem` = `{id: string, ...details}` where `details` is flattened and tagged `type` snake_case. IDs are synthetic `item_0`, `item_1`, ... (counter per process; a started/completed pair shares an id).

| item `type` | fields |
|---|---|
| `agent_message` | `text` (natural language or a JSON string when structured output requested) |
| `reasoning` | `text` (summary lines joined with `\n`; items with empty summary are suppressed) |
| `command_execution` | `command: string` (single string), `aggregated_output: string` (empty string if None), `exit_code: i32|null`, `status: "in_progress"|"completed"|"failed"|"declined"` |
| `file_change` | `changes: [{path: string, kind: "add"|"delete"|"update"}]`, `status: "in_progress"|"completed"|"failed"` (app-server `declined` is mapped to `failed`). Per the doc comment emitted only as completed |
| `mcp_tool_call` | `server`, `tool`, `arguments` (JSON), `result: {content: [], _meta?, structured_content}|null`, `error: {message}|null`, `status: "in_progress"|"completed"|"failed"` |
| `collab_tool_call` | `tool: "spawn_agent"|"send_input"|"wait"|"close_agent"`, `sender_thread_id`, `receiver_thread_ids[]`, `prompt|null`, `agents_states: {<id>: {status, message}}`, `status` |
| `web_search` | `id` (inner), `query`, `action: {type:"search"|"open_page"|"find_in_page"|"other",...}`, `results?`. NOTE: `WebSearchItem` has its own `id` field AND `ThreadItem` flattens another `id`; the serialized object therefore has a duplicate `id` key. Treat last-wins/first-wins defensively |
| `todo_list` | `items: [{text, completed: bool}]` (started on the first plan update, `item.updated` on later ones, `item.completed` on turn end) |
| `error` | `message` (non-fatal: warnings, config warnings, deprecation notices, `model rerouted: A -> B (reason)`) |

Behaviors:
- `agent_message` and `reasoning` emit only `item.completed` (their started events are suppressed).
- Turn-end paths: `Completed` emits `turn.completed`; `Failed` emits `turn.failed` (error = turn error, else last critical error, else "turn failed"); `Interrupted` emits nothing terminal. Unfinished started items are completed first.
- Fatal `error` events are also remembered as `last_critical_error`. `ErrorEvent` message format: `"<message> (<additional_details>)"` when details exist.
- Collab tools `send_message`, `followup_task`, `interrupt_agent`, `list_agents` are dropped from exec output.
- There is no per-event timestamp, no tool-call arguments, no user message and no token breakdown per item in this stream.

## 6. Differences found between rust-v0.167.0 and rust-v0.169.0 (cheap diff)

- Identical: `rollout/src/policy.rs`, `exec/src/exec_events.rs`, `rollout/src/rollout_file_name.rs`.
- `history/src/rollout_payload.rs`: `turn_context` now serialized via `serialize_turn_context` (writes `sandbox_policy` plus optional `file_system_sandbox_policy` alongside `permission_profile`); `compacted` payload boxed (no JSON change).
- `protocol.rs`: `ItemCompletedEvent.content_token_count` added; `ErrorEvent.rejected_audio_file_ids` added (host-only, schema-skipped); `TargetedAnswerModeration` added; `InferenceHookDenied` error-info variant added; `Op::CancelPatchApproval` added; realtime sideband types added.
- `models.rs`: `PermissionProfile::legacy_sandbox_policy_label` and an `mcp_content` module added.
- Whether 0.167.0 already defaulted to paginated for new local threads was not checked (UNKNOWN).

## 7. UNKNOWN list

- Wire format of per-line `timestamp` for non-`session_meta` lines (type is `String`; formatter not confirmed).
- Actual `originator` values; `collaboration_mode`, `ModeKind`, `ApprovalsReviewer`, `ReasoningEffort`, `ReasoningSummary` value sets; `PermissionProfile.file_system` / `network` inner shape; `PathUri` and `Duration` JSON forms.
- Whether paginated is the default on every platform/build (confirmed only for `LocalThreadStore`); whether legacy-to-paginated migration and zstd compression run by default.
- `exec_command` output body text beyond the header lines; exact `apply_patch` success/failure text; MCP tool naming scheme; the older `shell`/`local_shell_call` usage at this tag.
- Fields of `InterAgentCommunication`, `RetainedContextEvent`, `SecurityRiskScore`, `DynamicToolSpec`, `RealtimeItem`, `ConfigurationReasoning`, `McpToolCallEndEvent` (full), `EnteredReviewModeEvent`, `ExitedReviewModeEvent`, `ThreadSettingsSnapshot` (full), `RateLimitSnapshot` sub-structs.
- Whether `codex exec` writes a rollout by default or only with a flag (not checked); `session_meta.source` is `"exec"` for exec sessions by type, but the mapping was not traced.
- Whether files older than 0.167.0 contain a top-level `instructions` in `session_meta` (struct no longer has it).

## 8. SYNTHETIC example rollout (paginated mode, 0.169.0 shapes)

All ids, paths and values are fake. Shapes follow the verified structs above; text bodies (command output, patch text) are illustrative, not verified literals. One JSON object per line (wrapped here only by the code fence). `metadata` omitted. `permission_profile` uses the verified `{"type":"disabled"}` variant to avoid guessing the managed inner shape.

```jsonl
{"timestamp":"2026-11-15T09:00:00.000Z","ordinal":0,"type":"session_meta","payload":{"session_id":"00000000-0000-4000-8000-000000000001","id":"00000000-0000-4000-8000-000000000001","timestamp":"2026-11-15T09:00:00.000Z","cwd":"/home/user/project","originator":"fake_originator","cli_version":"0.169.0","source":"cli","model_provider":"openai","base_instructions":{"text":"FAKE BASE INSTRUCTIONS"},"history_mode":"paginated","git":{"commit_hash":"0000000000000000000000000000000000000000","branch":"main","repository_url":"https://example.invalid/repo.git"}}}
{"timestamp":"2026-11-15T09:00:01.000Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"00000000-0000-4000-8000-0000000000a1","model_context_window":200000,"collaboration_mode_kind":"default","started_at":1794733201}}
{"timestamp":"2026-11-15T09:00:01.010Z","ordinal":2,"type":"turn_context","payload":{"turn_id":"00000000-0000-4000-8000-0000000000a1","cwd":"/home/user/project","approval_policy":"on-request","permission_profile":{"type":"disabled"},"model":"fake-model","sandbox_policy":{"type":"danger-full-access"}}}
{"timestamp":"2026-11-15T09:00:01.020Z","ordinal":3,"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Run ls and fix the typo in a.txt"}]}}
{"timestamp":"2026-11-15T09:00:01.030Z","ordinal":4,"type":"event_msg","payload":{"type":"item_completed","thread_id":"00000000-0000-4000-8000-000000000001","turn_id":"00000000-0000-4000-8000-0000000000a1","item":{"type":"UserMessage","id":"item-u1","content":[{"type":"text","text":"Run ls and fix the typo in a.txt","text_elements":[]}]},"completed_at_ms":1794733201030}}
{"timestamp":"2026-11-15T09:00:02.000Z","ordinal":5,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls\",\"workdir\":\"/home/user/project\"}","call_id":"call_fake_1"}}
{"timestamp":"2026-11-15T09:00:02.100Z","ordinal":6,"type":"response_item","payload":{"type":"function_call_output","call_id":"call_fake_1","output":"Wall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\na.txt\n"}}
{"timestamp":"2026-11-15T09:00:03.000Z","ordinal":7,"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"cat missing.txt\"}","call_id":"call_fake_2"}}
{"timestamp":"2026-11-15T09:00:03.100Z","ordinal":8,"type":"response_item","payload":{"type":"function_call_output","call_id":"call_fake_2","output":"Wall time: 0.0100 seconds\nProcess exited with code 1\nOutput:\ncat: missing.txt: No such file or directory\n"}}
{"timestamp":"2026-11-15T09:00:04.000Z","ordinal":9,"type":"response_item","payload":{"type":"custom_tool_call","call_id":"call_fake_3","name":"apply_patch","input":"*** Begin Patch\n*** Update File: a.txt\n@@\n-helo\n+hello\n*** End Patch\n"}}
{"timestamp":"2026-11-15T09:00:04.100Z","ordinal":10,"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call_fake_3","output":"Success. Updated the following files:\nM a.txt\n"}}
{"timestamp":"2026-11-15T09:00:04.110Z","ordinal":11,"type":"event_msg","payload":{"type":"item_completed","thread_id":"00000000-0000-4000-8000-000000000001","turn_id":"00000000-0000-4000-8000-0000000000a1","item":{"type":"FileChange","id":"call_fake_3","changes":{"/home/user/project/a.txt":{"type":"update","unified_diff":"@@ -1 +1 @@\n-helo\n+hello\n","move_path":null}},"status":"completed","auto_approved":true},"completed_at_ms":1794733204110}}
{"timestamp":"2026-11-15T09:00:05.000Z","ordinal":12,"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done: fixed the typo."}],"phase":"final_answer"}}
{"timestamp":"2026-11-15T09:00:05.010Z","ordinal":13,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1200,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":150,"reasoning_output_tokens":40,"total_tokens":1350},"last_token_usage":{"input_tokens":1200,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":150,"reasoning_output_tokens":40,"total_tokens":1350},"model_context_window":200000},"rate_limits":null}}
{"timestamp":"2026-11-15T09:00:05.020Z","ordinal":14,"type":"event_msg","payload":{"type":"task_complete","turn_id":"00000000-0000-4000-8000-0000000000a1","last_agent_message":"Done: fixed the typo.","started_at":1794733201,"completed_at":1794733205,"duration_ms":4020}}
```

Legacy-mode equivalent differences: no `ordinal`; `session_meta.history_mode` absent or `"legacy"`; line 4 would instead be `{"type":"event_msg","payload":{"type":"user_message","message":"Run ls and fix the typo in a.txt","local_images":[],"local_audio":[]...}}` (no `item_completed` for user messages); line 11 would be `{"type":"event_msg","payload":{"type":"patch_apply_end","call_id":"call_fake_3","turn_id":"...","stdout":"...","stderr":"","success":true,"changes":{...},"status":"completed"}}`; an `event_msg` `agent_message` would follow the assistant `response_item`; no `exec_command_*` events in either mode.

## 9. SYNTHETIC `codex exec --json` stdout (6 lines)

```jsonl
{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000001"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls","aggregated_output":"a.txt\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Done."}}
{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"cache_write_input_tokens":0,"output_tokens":150,"reasoning_output_tokens":40}}
```

(`turn.started` serializes as `{"type":"turn.started"}` since `TurnStartedEvent {}` has no fields; internally-tagged unit-like structs emit only the tag.)
