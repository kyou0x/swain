# OTel GenAI semconv, OTLP/HTTP and framework telemetry (research, 2026-11-15)

Confidence: H = read in a primary source; M = vendor/secondary; UNVERIFIED = not confirmed.
No framework was run; no real payload was captured. Closing UNVERIFIED items needs one
sample capture per framework.

## 1. GenAI semantic conventions
- Moved out of opentelemetry.io to https://github.com/open-telemetry/semantic-conventions-genai
  (docs/gen-ai/*.md, model/gen-ai/registry.yaml). Status: **Development** for every attribute.
  No release tags yet: pin by commit. (H)
- `gen_ai.operation.name`: chat, generate_content, text_completion, embeddings, retrieval,
  create_agent, invoke_agent, execute_tool, invoke_workflow, invoke_runner, plan, memory ops. (H)
- Classify by `gen_ai.operation.name`, never by span name or span kind (both vary by emitter). (H)
- Attributes (H): gen_ai.provider.name (legacy gen_ai.system), gen_ai.request.model,
  gen_ai.response.model, gen_ai.usage.input_tokens / output_tokens / cache_read.input_tokens /
  cache_write.input_tokens / reasoning.output_tokens (no total), gen_ai.agent.id/name/
  description/version, gen_ai.main_agent.*, gen_ai.conversation.id, gen_ai.tool.name /
  call.id / type / call.arguments / call.result, gen_ai.transfer.mode / target.name (handoff via
  tool call only), gen_ai.input.messages / output.messages / system_instructions (opt-in,
  structured AnyValue or JSON string; parts of type text, tool_call, tool_call_response).
- Content capture env: spec says OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT; shipping libraries use
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT. Content may arrive in log records
  (gen_ai.client.inference.operation.details, or v1.36-era gen_ai.*.message events).
- Deprecated aliases to accept on read: gen_ai.system, gen_ai.usage.prompt_tokens /
  completion_tokens, gen_ai.usage.cache_creation.input_tokens (OpenClaw).
- OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental is honoured by MS Agent Framework,
  OpenClaw and ADK (H); not mentioned in the new repo.

## 2. OTLP/HTTP (https://opentelemetry.io/docs/specs/otlp/) (H)
- POST /v1/traces, /v1/logs, /v1/metrics; default port 4318.
- Content-Type application/x-protobuf **or** application/json; reply in the same type.
- gzip MUST be supported. Default 64 MiB limit, 413 above.
- JSON: lowerCamelCase fields; traceId/spanId as hex; enums as integers; int64/fixed64 as decimal
  strings (accept numbers too); ignore unknown fields.
- 200 + Export*ServiceResponse; partial_success with rejected_spans / rejected_log_records and
  error_message (client must not retry). 400 not retried; 429/502/503/504 retryable with
  Retry-After. JSON error body shape: UNVERIFIED.
- **Real exporters default to protobuf** (OpenClaw is protobuf-only; Python exporter defaults to
  http/protobuf). A JSON-only receiver would not interoperate. gRPC (4317) is common; if Swain is
  HTTP-only, document switching exporters to http/protobuf.

## 3. Frameworks
| Framework | Route to an OTLP receiver | Conventions | Unverified |
|---|---|---|---|
| Claude Code | native OTLP logs/events (+ beta traces), http/json supported | claude_code.* | see SWAIN-CLAUDE-CODE-TELEMETRY.md |
| OpenAI Agents SDK (Py) | no native OTLP; trace processor via openinference-instrumentation-openai-agents (handoff = TOOL span "handoff to X" + graph.node.parent_id) or opentelemetry-instrumentation-genai-openai-agents (drops handoffs); disable default OpenAI export | OpenInference or GenAI | payload samples |
| OpenAI Agents SDK (JS) | @opentelemetry/instrumentation-openai-agents (GenAI) | GenAI | guide prose, handoffs |
| LangGraph/LangChain | openinference-instrumentation-langchain; opentelemetry-instrumentation-genai-langchain (workflow/agent/tool spans); LangSmith OTel export | OpenInference / GenAI | handoff/transfer emission |
| CrewAI | built-in telemetry is private and cannot be redirected; use OpenInference or OpenLLMetry; official GenAI package emits nothing yet | OpenInference | crew/task/delegation shape |
| Google ADK | native; default legacy spans call_llm + gcp.vertex.agent.* **with content on by default**; GenAI mode via OTEL_SEMCONV_STABILITY_OPT_IN | legacy or GenAI | transfer_to_agent shape |
| OpenClaw (github.com/openclaw/openclaw, MIT, TS) | official diagnostics-otel plugin, **OTLP/HTTP protobuf only**; traces, metrics, logs | openclaw.* span names with gen_ai.* attributes | subagent representation; confirm this is the project the user means |
| MS Agent Framework | native GenAI semconv | GenAI | handoffs |

## 4. OpenInference ↔ GenAI normalisation (H for both specs; pairing is ours)
- Detect: `openinference.span.kind` → OpenInference; `gen_ai.operation.name` → GenAI.
- LLM↔chat/generate_content/text_completion; AGENT↔invoke_agent; TOOL↔execute_tool;
  CHAIN≈invoke_workflow; EMBEDDING↔embeddings; RETRIEVER↔retrieval.
- llm.model_name→request model; llm.provider/llm.system→provider; llm.token_count.prompt/
  completion/prompt_details.cache_read/cache_write/completion_details.reasoning→usage.
- Messages: OpenInference flattened `llm.input_messages.<i>.message.*` must be unflattened.
- Whole-span I/O: input.value / output.value (also used by OpenClaw).
- Agents: agent.name, graph.node.id / parent_id; session.id, user.id.

## Implications for Swain
1. Receiver must decode **protobuf and JSON**, with gzip. Protobuf needs a hand-written decoder
   (zero runtime deps); OTLP trace/log messages are a small, fixed schema.
2. Accept /v1/traces and /v1/logs from N1 (Claude Code is log-event based).
3. Normalise GenAI (current + v1.36 aliases) and OpenInference; keep unknown spans as generic
   spans with attributes preserved, never dropped.
4. Handoffs only from explicit evidence (gen_ai.transfer.*, OpenInference handoff TOOL spans,
   graph.node.parent_id); otherwise parent/child only.
5. Integrations are "documented route, untested" until a captured sample passes a fixture test.
