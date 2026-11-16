# Claude Code: documented interfaces for continuous ingestion (research, 2026-11-15)

Source: official docs at code.claude.com/docs only. Pages were read through a summarizing fetch;
re-check exact spellings against the pages before hard-coding. "Not read in full" items are
unverified.

## 1. OpenTelemetry (https://code.claude.com/docs/en/monitoring-usage)
- Enable: `CLAUDE_CODE_ENABLE_TELEMETRY=1`.
- Exporters: `OTEL_METRICS_EXPORTER` (otlp|prometheus|console|none), `OTEL_LOGS_EXPORTER`
  (otlp|console|none), `OTEL_TRACES_EXPORTER` (otlp|console|none).
- Protocol: `OTEL_EXPORTER_OTLP_PROTOCOL` = grpc | http/json | http/protobuf (default
  http/protobuf for http(s) endpoints, v2.1.323+). Per-signal `_PROTOCOL`, `_ENDPOINT`,
  `_HEADERS` variants. `otelHeadersHelper` for dynamic headers.
- Export intervals: metrics 60000 ms, logs 5000 ms, traces 5000 ms (defaults).
- Content gates (all off by default): `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`,
  `OTEL_LOG_TOOL_DETAILS` (tool inputs, Bash commands), `OTEL_LOG_TOOL_CONTENT` (needs tracing),
  `OTEL_LOG_RAW_API_BODIES`.
- **Traces are beta**: need `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`. Span names:
  `claude_code.interaction`, `claude_code.llm_request`, `claude_code.tool`,
  `claude_code.tool.blocked_on_user`, `claude_code.tool.execution` (`claude_code.hook` debug only).
- Events (logs): `claude_code.user_prompt`, `claude_code.assistant_response`,
  `claude_code.tool_result` (tool_name, tool_use_id, success, duration_ms, error_type,
  decision_type, tool_input with OTEL_LOG_TOOL_DETAILS), `claude_code.api_request` (model,
  cost_usd, duration_ms, input/output/cache tokens, request_id), `claude_code.api_error`,
  `claude_code.api_refusal`, `claude_code.tool_decision` (decision, source, tool_source).
  Referenced, not read in full: `subagent_completed`, `mcp_server_connection`, others.
- Metrics: `claude_code.session.count`, `.token.usage`, `.cost.usage`, `.lines_of_code.count`,
  `.commit.count`, `.pull_request.count`, `.code_edit_tool.decision`, `.active_time.total`.
- Correlation: `session.id`, `prompt.id` (events only), `event.sequence`, `user.id`,
  `organization.id`, `user.account_uuid` (when authenticated). Custom: `OTEL_RESOURCE_ATTRIBUTES`.
- Config: settings.json `env` (user) and managed settings. **Repository settings files cannot
  enable telemetry or choose a destination.** OTEL_* vars are not passed to child processes.

## 2. Hooks (https://code.claude.com/docs/en/hooks)
- Events include SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
  PermissionDenied, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop,
  StopFailure, PreCompact, PostCompact, SessionEnd and more.
- Common stdin: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `permission_mode`, and `agent_id`/`agent_type` inside a subagent.
- PreToolUse: `tool_name`, `tool_input`, `tool_use_id`. PostToolUse adds `tool_response`
  (tool-specific shape). SubagentStart/Stop: `agent_id`, `agent_type`; SubagentStop also
  `agent_transcript_path`, `last_assistant_message`.
- Handler types: `command`, `http` (POSTs the JSON input to a URL), `mcp_tool`, `prompt`,
  `agent`. SessionStart supports only command/mcp_tool. **The http request contract (method,
  headers) was not read in full: verify before relying on it.**
- `"async": true` on command hooks runs in background without blocking.
- Locations: user, project, local, managed settings; plugins; skill/subagent frontmatter.

## 3. Session files
- Transcripts `~/.claude/projects/<project>/<session>.jsonl`: docs say the format "is internal to
  Claude Code and changes between versions". Unstable: backfill only.
- `--output-format stream-json`: documented, partial schema, no stability statement.
- Agent SDK message types: documented (Python), TS types referenced.

## 4. Retention
- `cleanupPeriodDays` default 30 (https://code.claude.com/docs/en/claude-directory).

## Ranking for Swain (documented interfaces only)
1. OTLP logs/events (+ beta traces) over **http/json** to Swain `/v1/logs` and `/v1/traces`.
2. Hooks (async command or http) for per-tool input/response and subagent identity.
3. Headless stream-json for spawned runs (existing adapter).
4. Agent SDK messages (when the user runs the agent).
5. Transcript JSONL (existing adapter, unstable, backfill only).
