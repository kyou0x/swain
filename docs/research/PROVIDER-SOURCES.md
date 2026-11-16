# Provider Event / Transcript Sources (research note)

Retrieved: 2026-11-15. Method: public docs and GitHub files fetched through a summarizing fetch tool (content passed through a small model, so verbatim quotes are only as reliable as that summarizer; re-verify anything load-bearing against the URL). No provider CLI was run except `--version` / `--help`. No session files were read.

Evidence labels: **DOCUMENTED** (official docs), **SOURCE-OBSERVED** (official repo source; path + URL), **LOCAL-OBSERVED** (local `--help`/`--version`), **COMMUNITY** (third-party, NOT sufficient for compatibility claims), **UNKNOWN**.

Note: several docs pages carry future-dated banners (e.g. Gemini CLI "replaced by Antigravity CLI on June 18, 2026"). Treat provider longevity as a risk (see Gemini).

---

## 1. Claude Code

Latest version found: LOCAL-OBSERVED 2.1.325. Public docs do not show a single "latest" version; they reference feature minimums (v2.1.199 .. v2.1.314). Docs pages show no publication date.

### 1a. Hooks (DOCUMENTED) - https://code.claude.com/docs/en/hooks
- 33 events listed: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult, SessionEnd.
- Common input fields (all events): `session_id`, `prompt_id` (absent until first input), `transcript_path`, `cwd`, `scratchpad_dir` (v2.1.257+, optional), `permission_mode` (default|plan|acceptEdits|auto|dontAsk|bypassPermissions), `effort{level}`, `hook_event_name`, `agent_id` / `agent_type` (when inside a subagent or `--agent`).
- No timestamp field is documented among common fields (not seen on the page; Gemini has one, Claude does not as far as read). Hook timing must be taken at receipt (advisory).
- SessionStart: `source` (startup|resume|clear|compact|fork), optional `model`, `agent_type`, `session_title`; on resume/fork adds `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`.
- UserPromptSubmit: `prompt`, optional `session_title`.
- PreToolUse: `tool_name`, `tool_input`, `tool_use_id`.
- PostToolUse: `tool_name`, `tool_input`, `tool_response` (tool-dependent shape), `tool_use_id`, optional `duration_ms`. Bash may include `bashEditDiff` (v2.1.269+, "public beta", best-effort changed-files record; docs say not for policy enforcement).
- PostToolUseFailure: same as above plus `error` (Bash: first line `Exit code N`), optional `is_interrupt`, optional `duration_ms`.
- PermissionRequest: `tool_name`, `tool_input`, no `tool_use_id`; `mcp_server` for MCP tools; optional `permission_suggestions`.
- PermissionDenied (auto mode only): `tool_name`, `tool_input`, `tool_use_id`, `reason`.
- Notification: `message`, optional `title`, `notification_type`.
- SubagentStart: `agent_id`, `agent_type`.
- SubagentStop: `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path` (nested `subagents/` folder, per example `~/.claude/projects/.../<id>/subagents/agent-<id>.jsonl`), `last_assistant_message`.
- Stop: `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. StopFailure: `error` (type), optional `error_details`, optional `last_assistant_message` (holds the API error text).
- SessionEnd: `reason` in {clear, resume, logout, prompt_input_exit, other} (docs say `bypass_permissions_disabled` removed in v2.1.234). Note: "exit" is not listed here; Claude docs differ from Gemini's reason enum.
- PreModelSwitch/PostModelSwitch: `from_model`, `to_model`. PreCompact/PostCompact, TaskCreated/Completed: events exist; exact fields NOT extracted by me (UNKNOWN to this note; see page).
- Not extracted (fetch truncation / not read in detail): Setup, UserPromptExpansion, PostToolBatch, MessageDisplay, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, Worktree*, Elicitation*. UNKNOWN here.
- `transcript_path` timing: docs say the file is written asynchronously and may lag; "isn't guaranteed to include the final message at Stop time on all versions". Use `last_assistant_message` instead.

### 1b. On-disk transcript JSONL
- DOCUMENTED location: `~/.claude/projects/<project>/<session-id>.jsonl` (`<project>` = cwd with non-alphanumerics -> `-`; >200 chars truncated + hash). Configurable via `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`. Default retention 30 days (`cleanupPeriodDays`). Source: https://code.claude.com/docs/en/sessions (section "Where transcripts are stored").
- DOCUMENTED: "Each line is a JSON object: a message, a tool use or result, a record of a request Claude Code sent the model, or a metadata entry. **The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release.**" Same page. => NOT a stable schema. Record types/fields: UNKNOWN from official sources (no official schema found; I did not read local files per constraints).
- DOCUMENTED: subagent transcripts live in a nested `subagents/` folder (hooks page, SubagentStop). Resume accepts an absolute `.jsonl` path.
- DOCUMENTED: `/export` writes human-readable plain text (not structured).
- Implication: transcript import must be tolerant/versioned; hooks and stream-json are the documented structured surfaces.

### 1c. `claude -p --output-format stream-json` (DOCUMENTED) - https://code.claude.com/docs/en/headless
- Formats: `text` (default), `json`, `stream-json` (newline-delimited). `--verbose` and `--include-partial-messages` used with stream-json; last line is a `result` message (final text, cost, session metadata). `--output-format json` includes `session_id`, usage, `total_cost_usd`, per-model cost breakdown (client-side estimates), `result`, `structured_output` with `--json-schema`.
- Stream message kinds named in the page: `system/init` (model, tools, MCP servers, plugins, `plugin_errors`, `mcp_servers`, `mcp_server_errors`, optional `capabilities`), `system/api_retry` (fields: type, subtype, attempt, max_retries, retry_delay_ms, error_status, no_response, error, uuid, session_id), `system/plugin_install`, `hook_started` / `hook_progress` / `hook_response`, `stream_event` (with `.event.delta.text` for text deltas), `assistant`, `user`, `permission_denied` system messages, final `result` with `permission_denials`, warning messages ("informational").
- Subagents: `assistant`/`user` messages carry `parent_tool_use_id` (null for main thread); subagent `tool_use`/`tool_result` forwarded by default; text/thinking with `--forward-subagent-text`; forked-skill prefix `forked-command-`.
- Full typed message schema is in the Agent SDK reference (https://code.claude.com/docs/en/agent-sdk/typescript, e.g. `SDKSystemMessage`) - NOT read in detail; per-message field lists UNKNOWN to this note.
- LOCAL-OBSERVED: `claude --help` shows `--output-format`, `--input-format`, `--include-partial-messages`, `--no-session-persistence`, `--replay-user-messages`, `--verbose` (print mode only).

---

## 2. Codex CLI (openai/codex)

Latest version found: GitHub release `rust-v0.169.0`, published 2026-11-13 (https://github.com/openai/codex/releases/tag/rust-v0.169.0; via api.github.com releases/latest). LOCAL-OBSERVED installed: codex-cli 0.167.0.

### 2a. `codex exec --json`
- LOCAL-OBSERVED: `codex exec --help` lists `--json` ("Print events to stdout as JSONL"), subcommands `resume`, `fork`, `review`, `--ephemeral`-class flags not re-verified locally.
- DOCUMENTED - https://learn.chatgpt.com/docs/non-interactive-mode (308 redirect from https://developers.openai.com/codex/noninteractive): event types include `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error`. Item types listed: agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, plan updates. Sample: `thread.started{thread_id}`; `item.started/completed{item{id,type,command|status|text}}`; `turn.completed{usage{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}`. The page has no field reference, dates or versions. `--ephemeral` avoids persisting rollout files; `exec resume` depends on saved sessions.
- SOURCE-OBSERVED - `codex-rs/exec/src/exec_events.rs` on main (https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs), as summarized by the fetch tool:
  - `ThreadEvent` (`#[serde(tag="type")]`): `thread.started{thread_id}`, `turn.started`, `turn.completed{usage}`, `turn.failed{error}`, `item.started{item}`, `item.updated{item}`, `item.completed{item}`, `error{message}`.
  - `ThreadItem{id, ...details}` tagged snake_case: `agent_message{text}`, `reasoning{text}`, `command_execution{command, aggregated_output, exit_code?, status}`, `file_change{changes[], status}`, `mcp_tool_call{server, tool, arguments, result, error, status}`, `collab_tool_call{tool, sender_thread_id, receiver_thread_ids, prompt, agents_states, status}`, `web_search{id, query, action, results?}`, `todo_list{items}`, `error{message}`.
  - `Usage` (i64): `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` (serde default), `output_tokens`, `reasoning_output_tokens`.
  - Enums: CommandExecutionStatus in_progress|completed|failed|declined; PatchApplyStatus in_progress|completed|failed; PatchChangeKind add|delete|update; CollabTool spawn_agent|send_input|wait|close_agent; CollabAgentStatus pending_init|running|interrupted|completed|errored|shutdown|not_found.
  - Observations: no timestamp field and no model id field appear in these types (as summarized; verify in file). `file_change.changes` per-file diff content not confirmed (FileUpdateChange fields UNKNOWN).
  - Caveat: this is `main`; installed 0.167.0 and latest 0.169.0 may differ. Pin by tag when building fixtures.
- Permissions/approvals: only `command_execution.status = declined` seen; no dedicated approval event in the exec stream (as summarized).

### 2b. On-disk rollout files (`~/.codex/sessions`)
- DOCUMENTED only indirectly: the non-interactive page refers to "session rollout files" persisted unless `--ephemeral`; it does not give location or schema.
- COMMUNITY (not authoritative): date-partitioned `sessions/YYYY/MM/DD/rollout-<ISO8601>-<thread-id>.jsonl`; record types session_meta, response_item, event_msg, turn_context (others e.g. compacted, world_state); an `event_msg` mirror stream reportedly changes between versions; compression to `.jsonl.zst` reported. Sources: https://github.com/daymade/claude-code-skills/blob/main/daymade-claude-code/read-codex-history/references/codex_rollout_format.md ; https://github.com/openai/codex/issues/25215 ; https://github.com/openai/codex/issues/30932. Treat as UNKNOWN for compatibility claims. Official definition would be in codex-rs protocol/rollout crate (path NOT verified).
- `exec --json` events are a distinct, thinner model than rollout records (consistent with ADAPTER-CONTRACT note); mapping between them is UNKNOWN.
- Codex app-server (JSON-RPC) exists; schema directory `codex-rs/app-server-protocol/schema/json/` was seen in the repo tree listing (SOURCE-OBSERVED path only; contents not read).
- Codex hooks: not researched (UNKNOWN).

---

## 3. Gemini CLI (google-gemini/gemini-cli)

Latest version found: GitHub release v0.68.0, 2026-11-10 (https://github.com/google-gemini/gemini-cli/releases/tag/v0.68.0). Hooks page "last updated Apr 13, 2026". Not installed locally.
Risk: docs banner states Gemini CLI was replaced by Antigravity CLI on June 18, 2026 for unpaid-tier and Google One users (https://geminicli.com/docs/hooks/). Continued support/stability: UNKNOWN.

### 3a. Hooks - DOCUMENTED
- https://geminicli.com/docs/hooks/ : events SessionStart, SessionEnd, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, BeforeTool, AfterTool, PreCompress, Notification. Input on stdin as JSON; env vars `GEMINI_PROJECT_DIR`, `GEMINI_PLANS_DIR`, `GEMINI_SESSION_ID`, `GEMINI_CWD`, `CLAUDE_PROJECT_DIR` (alias). Exit 0 = JSON parsed from stdout, 2 = block, other = warning.
- https://geminicli.com/docs/hooks/reference/ :
  - Base input: `session_id`, `transcript_path` (absolute path to session transcript JSON; its schema is NOT documented there), `cwd`, `hook_event_name`, `timestamp` (ISO 8601).
  - BeforeTool: `tool_name`, `tool_input`, optional `mcp_context`, `original_request_name`.
  - AfterTool: those plus `tool_response{llmContent, returnDisplay, error?}`.
  - BeforeAgent: `prompt`. AfterAgent: `prompt`, `prompt_response`, `stop_hook_active`.
  - BeforeModel / BeforeToolSelection: `llm_request{model, messages[{role,content}], config, toolConfig}` (non-text parts filtered out). AfterModel: `llm_request`, `llm_response{candidates[{content, finishReason}], usageMetadata{totalTokenCount}}` (may be a single chunk when streaming).
  - SessionStart: `source` (startup|resume|clear). SessionEnd: `reason` (exit|clear|logout|prompt_input_exit|other). Notification: `notification_type` ("ToolPermission"), `message`, `details`. PreCompress: `trigger` (auto|manual).
  - No documented subagent hook event; no distinct failure event (tool errors via `tool_response.error`).

### 3b. Telemetry - DOCUMENTED (https://geminicli.com/docs/cli/telemetry/)
- OTLP (`otlpEndpoint` default http://localhost:4317, grpc|http), file `outfile` (format NOT specified), or GCP target. Opt-in.
- Log events: `gemini_cli.config` (model, approval_mode), `gemini_cli.user_prompt`, `gemini_cli.tool_call` (function_name, function_args, duration_ms, success, decision, tool_type, prompt_id), `gemini_cli.api_request` (model), `gemini_cli.api_response` (model, duration_ms, input/output/cached/thoughts/tool/total token counts, finish_reasons), `gemini_cli.api_error`, `gen_ai.client.inference.operation.details`, plus file_operation, agent.start/finish, hook_call, rewind, chat_compression, etc.
- Common attribute `session.id`; traces map `gen_ai.conversation.id`. Metrics include `gemini_cli.token.usage`. Per-record timestamps are standard OTel but not described on the page.
- Session/checkpoint/export format: NOT documented on this page (links to "Checkpointing", "Manage sessions and history", "Rewind" - not read). UNKNOWN.

---

## 4. OpenCode

Current official repo: github.com/anomalyco/opencode (fetched page presents itself as the repo; project site opencode.ai; the user-supplied candidate sst/opencode was not confirmed as redirect - fetch tool returned the anomalyco repo content). Treat anomalyco/opencode as current but "official" status rests on site/repo self-description only. Latest release: v1.19.5, 2026-10-28 (https://github.com/anomalyco/opencode/releases/tag/v1.19.5). Not installed locally. Docs show both a v1-style (`opencode.ai/docs/...`) and a "v2" (`opencode.ai/v2/docs/...`) tree: plugin/CLI shapes differ between them.

### 4a. SDK / server events
- DOCUMENTED https://opencode.ai/docs/sdk/ : `event.subscribe()` returns an SSE stream; each event has `type` and `properties`. The page does NOT enumerate event types. Session methods: list/get/children/messages/message/create/update/delete/prompt (`noReply`)/command/shell/summarize/init/abort/revert/unrevert/share (discontinued)/unshare; a permission-response method.
- DOCUMENTED https://opencode.ai/docs/server/ : `/event` SSE ("First event is `server.connected`, then bus events"), `GET /global/event`, OpenAPI 3.1 spec at `http://<host>:<port>/doc`. Event type list NOT given in prose; the OpenAPI spec/generated types are the authority (not read).
- Event names `message.updated`, `message.part.updated`, `session.*`, `permission.*`: UNKNOWN - I could not verify them from docs or source (my attempts to fetch `packages/sdk/js/src/gen/types.gen.ts` returned 404 at guessed paths). Do not assert them.

### 4b. Plugin API - DOCUMENTED (v2 docs)
- https://opencode.ai/docs/build/plugins/server : hooks registered via `ctx.<domain>.hook(name, cb)`: session (`fork`, `prompt`, `context`, `generate`, `compaction`, `title`, `experimental.model.resolve`, `model.request`, `http.request`, `http.response`, `retry`, ws.*), `permission.evaluate` (sessionID, action, resources, mutable effect allow|ask|deny), `shell.create.before`, `tool.execute.before` (as `execute.before`; shape unspecified), `tool.execute.after` (`status` completed+result | error+error.message). `ctx.event.subscribe` documented names: `server.connected` (excluded for plugins), `config.updated`, `worktree.updated` only; payload typed by `V2EventEncoded` (not reproduced). V1 hook name `tool.execute.before` noted.

### 4c. Export - DOCUMENTED (v2 CLI docs) https://opencode.ai/v2/docs/cli/commands/
- `opencode session export <id>` ("Export session data as JSON"), `--sanitize` ("Redact sensitive transcript and file data"), `opencode session import <file|url>`, `opencode run --format json` ("newline-delimited JSON"). The v1 doc page https://opencode.ai/docs/cli/ does NOT document export/import or `--format json`.
- COMMUNITY (non-authoritative): top-level `opencode export [sessionID]` prints `{info, messages}` JSON to stdout, progress on stderr (https://payhip.com/Superkamoubot/blog/superkamoubot/how-to-export-an-opencode-session-and-what-is-inside-the-file). Export JSON schema: UNKNOWN officially. Storage is reportedly SQLite (community PyPI tool), not verified.

---

## 5. Capability table

Status key: available | partial | unknown | unsupported. Basis in parentheses: D documented, S source-observed, L local, C community only.

| Capability | Claude Code | Codex CLI (`exec --json`) | Gemini CLI | OpenCode |
|---|---|---|---|---|
| Session lifecycle | available via hooks SessionStart/SessionEnd (D); stream-json `system/init` + `result` (D) | partial: `thread.started`, `turn.*` (D,S); no explicit session end event | available via hooks SessionStart/SessionEnd (D) | unknown: SSE `session.*` names unverified; `server.connected` only (D); export has `info` (C) |
| Tool call inputs | available: PreToolUse/PostToolUse `tool_input`, `tool_use_id` (D) | partial: `command_execution.command`, `mcp_tool_call.arguments` (S); other tool types unclear | available: BeforeTool `tool_input` (D) | partial: plugin `tool.execute.before` (D, shape unspecified); stream shape unknown |
| Tool call outputs | available: `tool_response` (shape tool-dependent) (D) | available: `aggregated_output`, `exit_code`, mcp `result` (S) | available: AfterTool `tool_response{llmContent,returnDisplay,error}` (D) | partial: `tool.execute.after` result/error (D) |
| LLM metadata (model id) | partial: SessionStart `model` (optional), Pre/PostModelSwitch, stream `system/init` model (D); per-message model in transcript UNKNOWN | unknown: not in exec event types (S); `-m` flag (L) | partial: `llm_request.model` in BeforeModel/AfterModel; telemetry `model` (D) | partial: plugin `context` hook carries `model` (D); event payloads unknown |
| File patches | partial: Write/Edit appear in `tool_input`/`tool_response`; Bash `bashEditDiff` beta (D) | partial: `file_change.changes[]` + status (S); diff contents unverified | partial: derivable only from tool inputs; telemetry `file_operation` (D) | unknown (revert APIs exist; patch event shape unverified) |
| Subagents | available: SubagentStart/Stop, `agent_id`, `agent_transcript_path`, stream `parent_tool_use_id` (D) | partial: `collab_tool_call` spawn_agent/send_input/wait/close_agent (S) | unknown: no subagent hook documented; telemetry `agent.start/finish` (D) | unknown: session `children` method (D); events unverified |
| Permissions | available: PermissionRequest, PermissionDenied (auto mode only), stream `permission_denied` (D) | partial: `command_execution.status=declined` only (S) | partial: Notification `ToolPermission`; telemetry `decision` (D) | partial: plugin `permission.evaluate` hook (D); SDK permission response method (D) |
| Failures | available: PostToolUseFailure, StopFailure, stream `api_retry` (D) | available: `turn.failed`, `error`, item status failed (S) | partial: `tool_response.error`, telemetry `api_error` (D); no failure hook | partial: `execute.after` error, `retry` hook (D) |
| Timestamps | partial: no hook timestamp documented; stream/transcript timestamps UNKNOWN (use receipt time, advisory) | unknown: none in exec event types (S) | available in hooks: `timestamp` ISO 8601 (D) | unknown |
| Tokens | partial: stream-json `result` usage/cost (D); per-call hook tokens not documented; SessionStart `context_tokens` on resume only | available: `turn.completed.usage` (D,S) per turn | partial: AfterModel `usageMetadata.totalTokenCount` (D); telemetry detailed counts (D) | unknown: plugin `compaction.result.tokens` only mentioned; message token fields unverified |

Transcript/file-import viability: Claude on-disk = documented location but explicitly unstable schema (partial, best-effort); Codex rollout = no official schema (unknown); Gemini transcript = path given, schema undocumented (unknown); OpenCode = official `session export` documented in v2 docs, JSON schema unknown (partial).

---

## 6. Known unknowns (could NOT verify)

Claude Code
1. Official schema of transcript JSONL records (documented as internal and unstable). Record types/fields not sourced.
2. Per-event fields for ~20 less-common hook events (Setup, PostToolBatch, TaskCreated/Completed, Worktree*, Elicitation*, ConfigChange, etc.).
3. Full typed stream-json message schema (Agent SDK TS/Python reference not read); timestamps in stream messages; whether `result` usage has per-model token breakdown fields.
4. Whether hooks carry any timestamp.

Codex
1. Official schema/location of rollout files and mapping to `exec --json` items (only community sources).
2. `FileUpdateChange` fields (diff content?), whether exec events carry timestamps or model id; behavior of 0.167.0 vs main/0.169.0 (source read from `main`, not tag).
3. Codex hooks and app-server event schema not read.
4. Why docs moved to learn.chatgpt.com (redirect origin unverified).

Gemini CLI
1. Transcript file (`transcript_path`) schema; session/checkpoint export format; telemetry `outfile` format.
2. Subagent events; per-hook latency/failure semantics.
3. Product continuity after the Antigravity CLI banner (June 18, 2026) and which tiers remain supported.
4. Dates on hooks page beyond "last updated Apr 13, 2026".

OpenCode
1. Event type names (message.updated, message.part.updated, session.*, permission.*) - not confirmed from any official page or source; need OpenAPI `/doc` output or generated types file (path not located).
2. Export JSON schema and whether top-level `opencode export` exists vs `opencode session export` (version-dependent; v1 docs silent).
3. Whether sst/opencode redirects to anomalyco/opencode (not confirmed); official-ownership assertion rests on self-description.
4. Token/cost/model fields on messages; patch/diff representations; subagent event shapes.

General caveat: fetch results were produced by a summarizing model; field lists should be re-checked against the cited URL before being frozen into fixtures.
