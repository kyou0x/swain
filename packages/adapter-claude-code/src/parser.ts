import type {
  ActorRole,
  AdapterOutput,
  Attributes,
  Completeness,
  DraftEvent,
  FacetCompleteness,
  FramedRecord,
  JsonValue,
  ParseContext,
  RecordParser,
} from "@swain/core";
import {
  bound,
  draft,
  get,
  getNonEmptyStr,
  getObj,
  getStr,
  isArr,
  isObj,
  makeRef,
  type Obj,
  Out,
  refJson,
  safeCost,
  safeInt,
  type TimeInfo,
  timeOf,
  unknownDraft,
  utf8Len,
  versionOrNull,
  warn,
} from "./util.js";

/**
 * Shared mapping for the two Claude Code surfaces. The stream-json variant follows the
 * documented SDKMessage shapes (FORMAT-claude section A); the transcript variant follows the
 * COMMUNITY raw-line shape (section B) and is tolerant by construction: every shape it does not
 * recognise becomes `source.unknown`.
 */
export type Variant = "stream" | "transcript";

const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "MultiEdit",
  "Read",
  "Glob",
  "Grep",
  "Agent",
  "Task",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TaskStop",
  "AskUserQuestion",
  "Monitor",
  "Workflow",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
]);
/** Tools whose successful result supports a derived `file.changed`. Bash is never in this set. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
const API_ERRORS: ReadonlySet<string> = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
  "cloud_credential_error",
]);
const TERMINAL_REASONS: ReadonlySet<string> = new Set([
  "blocking_limit",
  "rapid_refill_breaker",
  "prompt_too_long",
  "image_error",
  "model_error",
  "api_error",
  "malformed_tool_use_exhausted",
  "aborted_streaming",
  "aborted_tools",
  "stop_hook_prevented",
  "hook_stopped",
  "tool_deferred",
  "max_turns",
  "background_requested",
  "completed",
  "budget_exhausted",
  "structured_output_retry_exhausted",
  "tool_deferred_unavailable",
  "turn_setup_failed",
]);

export const STREAM_ATTRIBUTE_KEYS: readonly string[] = [
  "claude-code.cwd",
  "claude-code.permission-mode",
  "claude-code.api-error",
  "claude-code.aborted",
  "claude-code.num-turns",
  "claude-code.duration-ms",
  "claude-code.terminal-reason",
];
export const TRANSCRIPT_ATTRIBUTE_KEYS: readonly string[] = [
  "claude-code.api-error",
  "claude-code.aborted",
];

/** Documented-but-intentionally-unmapped keys are listed so they raise no unmapped-field warning. */
const K_INIT = new Set([
  "type",
  "subtype",
  "uuid",
  "session_id",
  "cwd",
  "claude_code_version",
  "model",
  "permissionMode",
  "apiKeySource",
  "tools",
  "mcp_servers",
  "slash_commands",
  "output_style",
  "skills",
  "plugins",
  "agents",
  "betas",
  "terminal_slash_commands",
  "plugin_errors",
  "fast_mode_state",
  "fast_mode_disabled_reason",
  "effort",
  "view_mode",
  "capabilities",
  "mcp_server_errors",
]);
const K_ASSISTANT_STREAM = new Set([
  "type",
  "message",
  "parent_tool_use_id",
  "uuid",
  "session_id",
  "error",
  "request_id",
  "timestamp",
  "user_message_uuid",
  "user_message_uuids",
  "resume_reason",
  "resumed_from_incomplete_thinking",
  "supersedes",
  "aborted",
  "agent_id",
  "subagent_type",
  "task_description",
  "context_usage",
  "usage_report",
]);
const K_USER_STREAM = new Set([
  "type",
  "message",
  "parent_tool_use_id",
  "uuid",
  "session_id",
  "isSynthetic",
  "priority",
  "origin",
  "shouldQuery",
  "timestamp",
  "client_composed",
  "pasted_content",
  "inline_pastes",
  "agent_id",
  "subagent_type",
  "task_description",
  "tool_use_result",
  "isReplay",
  "file_attachments",
]);
const K_RESULT = new Set([
  "type",
  "subtype",
  "duration_ms",
  "duration_api_ms",
  "is_error",
  "num_turns",
  "stop_reason",
  "total_cost_usd",
  "usage",
  "modelUsage",
  "permission_denials",
  "uuid",
  "session_id",
  "result",
  "structured_output",
  "api_error_status",
  "deferred_tool_use",
  "terminal_reason",
  "errors",
  "queued_turn_count",
  "origin",
  "fast_mode_state",
  "user_message_uuid",
  "user_message_uuids",
  "resume_reason",
  "result_index",
  "credential_expires_at",
  "ttft_ms",
]);
const K_TRANSCRIPT_MSG = new Set([
  "type",
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "cwd",
  "version",
  "gitBranch",
  "isSidechain",
  "userType",
  "entrypoint",
  "slug",
  "requestId",
  "message",
  "toolUseResult",
  "isMeta",
  "isCompactSummary",
  "isApiErrorMessage",
  "isVisibleInTranscriptOnly",
]);
/** Transcript entry types the research doc names as non-conversational (COMMUNITY). */
const TRANSCRIPT_METADATA_TYPES: ReadonlySet<string> = new Set([
  "summary",
  "file-history-snapshot",
  "queue-operation",
]);

const MAX_FANOUT = 100;

interface ToolReq {
  readonly name: string;
  readonly input: Obj | undefined;
  readonly actorKey: string;
}

interface UsageAcc {
  first: number;
  last: number;
  model: string | null;
  usage: Obj | undefined;
  ts: JsonValue | undefined;
  role: ActorRole;
  key: string;
}

interface ActorInfo {
  readonly role: ActorRole;
  readonly key: string;
  readonly facet: FacetCompleteness;
  /** parent_tool_use_id when the line belongs to a subagent (stream only). */
  readonly parent: string | null;
}

const ROOT: ActorInfo = { role: "agent", key: "root", facet: { state: "captured" }, parent: null };

export class ClaudeParser implements RecordParser {
  private version: string | null;
  private readonly toolReqs = new Map<string, ToolReq>();
  private readonly usage = new Map<string, UsageAcc>();
  private readonly agents = new Map<string, string>();
  private readonly endedAgents = new Set<string>();
  private readonly emptyAssistant: number[] = [];
  private readonly usageEvidence = new Set<number>();
  private result: { seq: number; status: string } | undefined;
  private foldCapWarned = false;
  private reqCapWarned = false;

  private readonly variant: Variant;
  private readonly ctx: ParseContext;

  constructor(variant: Variant, ctx: ParseContext) {
    this.variant = variant;
    this.ctx = ctx;
    this.version = versionOrNull(ctx.providerVersionSeen);
  }

  push(rec: FramedRecord): AdapterOutput {
    const out = new Out();
    const val = rec.parse.ok ? rec.parse.value : null;
    const seq = rec.sourceSequence;
    if (!isObj(val)) {
      this.unknown(out, rec, null, null, null, "unknown-record-type");
      return this.fin(out);
    }
    const type = getStr(val, "type");
    if (this.variant === "stream") {
      switch (type) {
        case "system":
          this.system(out, rec, val);
          break;
        case "assistant":
          this.assistant(out, rec, val);
          break;
        case "user":
          this.user(out, rec, val);
          break;
        case "result":
          this.resultRecord(out, rec, val);
          break;
        case "stream_event":
          out.dispositions.push({ sourceSequence: seq, kind: "control", into: null });
          break;
        default:
          this.unknown(out, rec, val, type ?? null, null, "unknown-record-type");
      }
    } else {
      if (type !== undefined && TRANSCRIPT_METADATA_TYPES.has(type)) {
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
      } else if (type === "assistant") {
        this.assistant(out, rec, val);
      } else if (type === "user") {
        this.user(out, rec, val);
      } else {
        // `system` entries and every other type: tolerant, never guessed.
        this.unknown(out, rec, val, type ?? null, null, "unknown-record-type");
      }
    }
    if (out.drafts.length === 0 && out.dispositions.length === 0) {
      if (type === "assistant") this.emptyAssistant.push(seq);
      else out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
    }
    return this.fin(out);
  }

  end(): AdapterOutput {
    const out = new Out();
    for (const acc of this.usage.values()) {
      if (acc.usage === undefined) continue;
      const d = this.messageUsage(
        acc.usage,
        acc.model,
        timeOf(acc.ts),
        acc.role,
        acc.key,
        "/message/usage",
        { order: acc.last, evidence: acc.last },
      );
      if (d !== null) {
        out.drafts.push(d);
        this.usageEvidence.add(acc.last);
      } else {
        // usage was present but carried no valid token field: say so, never guess
        out.warnings.push(warn("unmapped-field", acc.last, { fieldCount: 1 }, "info"));
      }
    }
    if (this.result !== undefined) {
      const { seq, status } = this.result;
      out.drafts.push(
        draft({
          kind: "session.ended",
          status,
          payload: { reason: "unknown" },
          role: "runtime",
          actorKey: "runtime",
          ts: timeOf(undefined),
          pointer: "",
          providerVersion: this.version,
          recordRef: { order: seq, evidence: seq },
        }),
      );
    }
    for (const seq of this.emptyAssistant) {
      if (!this.usageEvidence.has(seq)) {
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
      }
    }
    return this.fin(out);
  }

  private fin(out: Out): AdapterOutput {
    return { drafts: out.drafts, warnings: out.warnings, dispositions: out.dispositions };
  }

  private unknown(
    out: Out,
    rec: FramedRecord,
    val: Obj | null,
    nativeType: string | null,
    pointer: string | null,
    code: "unknown-record-type" | "unmapped-field",
  ): void {
    out.drafts.push(unknownDraft(rec, val ?? null, nativeType, pointer, this.version));
    out.warnings.push(warn(code, rec.sourceSequence));
  }

  private unmapped(out: Out, seq: number, val: Obj, known: ReadonlySet<string>): void {
    let n = 0;
    for (const k of Object.keys(val)) if (!known.has(k)) n++;
    if (n > 0) out.warnings.push(warn("unmapped-field", seq, { fieldCount: n }, "info"));
  }

  private actorOf(val: Obj): ActorInfo {
    if (this.variant === "stream") {
      const p = get(val, "parent_tool_use_id");
      if (typeof p === "string" && p.length > 0) {
        return {
          role: "subagent",
          key: `native:${bound(p, 200)}`,
          facet: { state: "captured" },
          parent: p,
        };
      }
      return ROOT;
    }
    if (get(val, "isSidechain") === true) {
      return {
        role: "subagent",
        key: "native:sidechain",
        facet: { state: "unknown" },
        parent: null,
      };
    }
    return ROOT;
  }

  private toolUseResult(val: Obj): JsonValue | undefined {
    return get(val, this.variant === "stream" ? "tool_use_result" : "toolUseResult");
  }

  /** Emit `agent.started` the first time a subagent actor is seen (stream only). */
  private maybeAgentStarted(out: Out, a: ActorInfo, val: Obj, ts: TimeInfo): void {
    if (a.parent === null || this.agents.has(a.parent)) return;
    this.agents.set(a.parent, a.key);
    const req = this.toolReqs.get(a.parent);
    const typeRaw =
      getNonEmptyStr(val, "subagent_type") ?? getNonEmptyStr(req?.input ?? {}, "subagent_type");
    out.drafts.push(
      draft({
        kind: "agent.started",
        status: "none",
        payload: {
          agentActorId: a.key,
          parentActorId: req?.actorKey ?? "root",
          agentType: typeRaw === undefined ? null : bound(typeRaw),
          spawnedByToolCallId: req === undefined ? null : a.parent,
        },
        role: "subagent",
        actorKey: a.key,
        ts,
        pointer: "/parent_tool_use_id",
        providerVersion: this.version,
        anchor: a.key,
        ...(req === undefined
          ? {}
          : {
              refs: [{ rel: "spawned-by" as const, key: a.parent }],
              facets: { causality: { state: "captured" as const } },
            }),
      }),
    );
  }

  private message(
    out: Out,
    value: JsonValue,
    role: "user" | "assistant" | "system",
    channel: "text" | "reasoning" | "notification",
    a: ActorInfo,
    ts: TimeInfo,
    pointer: string,
    rec: FramedRecord,
    val: Obj,
    attrs: Attributes,
  ): void {
    const r = makeRef(this.ctx, value);
    if (r.ref === null) {
      this.unknown(out, rec, val, null, pointer, "unmapped-field");
      return;
    }
    out.drafts.push(
      draft({
        kind: "message.observed",
        status: "none",
        payload: { role, channel, content: refJson(r.ref) },
        role: a.role,
        actorKey: a.key,
        actorFacet: a.facet,
        ts,
        pointer,
        providerVersion: this.version,
        attrs,
        facets: {
          content: r.partial
            ? { state: "partial", reason: "malformed-value" }
            : { state: "captured" },
          internalReasoning: { state: "unavailable", reason: "provider-does-not-expose" },
        },
      }),
    );
  }

  /** Content blocks as `[block, pointer]`; a bare string content is one text block. */
  private blocks(
    content: JsonValue | undefined,
  ): { block: JsonValue; pointer: string; bare: boolean }[] | undefined {
    if (typeof content === "string") {
      return [{ block: content, pointer: "/message/content", bare: true }];
    }
    if (!isArr(content)) return undefined;
    return content.map((block, i) => ({ block, pointer: `/message/content/${i}`, bare: false }));
  }

  // --- system -------------------------------------------------------------------------

  private system(out: Out, rec: FramedRecord, val: Obj): void {
    const seq = rec.sourceSequence;
    const sub = getStr(val, "subtype");
    const ts = timeOf(get(val, "timestamp"));
    if (sub === "init") {
      this.initRecord(out, rec, val, ts);
    } else if (sub === "permission_denied") {
      this.denial(out, val, val, "", ts, seq, `${seq}`);
      this.unmapped(
        out,
        seq,
        val,
        new Set([
          "type",
          "subtype",
          "uuid",
          "session_id",
          "tool_name",
          "tool_use_id",
          "agent_id",
          "decision_reason_type",
          "decision_reason",
          "message",
          "timestamp",
        ]),
      );
    } else if (sub === "api_retry" || sub === "compact_boundary") {
      const keep: Record<string, JsonValue> = {};
      for (const k of sub === "api_retry"
        ? ["subtype", "attempt", "max_retries", "retry_delay_ms", "error_status", "error"]
        : ["subtype", "compact_metadata"]) {
        const v = get(val, k);
        if (v !== undefined) keep[k] = v;
      }
      this.message(
        out,
        keep,
        "system",
        "notification",
        {
          role: "runtime",
          key: "runtime",
          facet: { state: "captured" },
          parent: null,
        },
        ts,
        "",
        rec,
        val,
        {},
      );
    } else if (sub === "status") {
      out.dispositions.push({ sourceSequence: seq, kind: "control", into: null });
    } else {
      this.unknown(
        out,
        rec,
        val,
        sub === undefined ? "system" : `system.${sub}`,
        null,
        "unknown-record-type",
      );
    }
  }

  private initRecord(out: Out, rec: FramedRecord, val: Obj, ts: TimeInfo): void {
    const v = versionOrNull(get(val, "claude_code_version"));
    if (v !== null) this.version = v;
    const attrs: Attributes = {};
    const cwd = getStr(val, "cwd");
    if (cwd !== undefined) attrs["claude-code.cwd"] = bound(cwd);
    const pm = getStr(val, "permissionMode");
    if (pm !== undefined && PERMISSION_MODES.has(pm)) attrs["claude-code.permission-mode"] = pm;
    const sid = getStr(val, "session_id");
    out.drafts.push(
      draft({
        kind: "session.started",
        status: "none",
        payload: {
          nativeSessionId: sid === undefined ? null : bound(sid),
          trigger: "startup",
        },
        role: "runtime",
        actorKey: "runtime",
        ts,
        pointer: "",
        providerVersion: this.version,
        attrs,
        nativeSessionId: sid === undefined ? null : bound(sid),
      }),
    );
    this.unmapped(out, rec.sourceSequence, val, K_INIT);
  }

  // --- assistant ----------------------------------------------------------------------

  private assistant(out: Out, rec: FramedRecord, val: Obj): void {
    const seq = rec.sourceSequence;
    const msg = getObj(val, "message");
    const blocks = msg === undefined ? undefined : this.blocks(get(msg, "content"));
    if (msg === undefined || blocks === undefined) {
      this.unknown(out, rec, val, "assistant", "/message", "unmapped-field");
      return;
    }
    const a = this.actorOf(val);
    const ts = timeOf(get(val, "timestamp"));
    const attrs: Attributes = {};
    const err = getStr(val, "error");
    if (err !== undefined && API_ERRORS.has(err)) attrs["claude-code.api-error"] = err;
    if (get(val, "aborted") === true) attrs["claude-code.aborted"] = true;
    this.maybeAgentStarted(out, a, val, ts);
    for (const { block, pointer, bare } of blocks.slice(0, MAX_FANOUT)) {
      if (bare) {
        this.message(out, block, "assistant", "text", a, ts, pointer, rec, val, attrs);
        continue;
      }
      if (!isObj(block)) {
        this.unknown(out, rec, val, null, pointer, "unmapped-field");
        continue;
      }
      const bt = getStr(block, "type");
      if (bt === "text" && typeof get(block, "text") === "string") {
        this.message(
          out,
          get(block, "text") ?? "",
          "assistant",
          "text",
          a,
          ts,
          pointer,
          rec,
          val,
          attrs,
        );
      } else if (bt === "thinking" && typeof get(block, "thinking") === "string") {
        this.message(
          out,
          get(block, "thinking") ?? "",
          "assistant",
          "reasoning",
          a,
          ts,
          pointer,
          rec,
          val,
          attrs,
        );
      } else if (bt === "tool_use") {
        this.toolUse(out, block, a, ts, pointer, attrs);
      } else {
        this.unknown(out, rec, val, bt ?? null, pointer, "unknown-record-type");
      }
    }
    if (blocks.length > MAX_FANOUT) {
      out.warnings.push(warn("bounds-reached", seq, { limit: MAX_FANOUT, seen: blocks.length }));
    }
    this.foldUsage(out, seq, msg, val, a, ts);
    this.unmapped(out, seq, val, this.variant === "stream" ? K_ASSISTANT_STREAM : K_TRANSCRIPT_MSG);
  }

  private toolUse(
    out: Out,
    b: Obj,
    a: ActorInfo,
    ts: TimeInfo,
    pointer: string,
    attrs: Attributes,
  ): void {
    const id = getNonEmptyStr(b, "id");
    const name = getNonEmptyStr(b, "name");
    const input = get(b, "input");
    const toolName = name === undefined ? "unknown" : bound(name);
    let ns: "builtin" | "mcp" | "unknown" = "unknown";
    let mcpServer: string | undefined;
    if (name?.startsWith("mcp__")) {
      ns = "mcp";
      const server = name.split("__")[1];
      if (server !== undefined && server.length > 0) mcpServer = bound(server);
    } else if (name !== undefined && BUILTIN_TOOLS.has(name)) {
      ns = "builtin";
    }
    const ref = input === undefined ? undefined : makeRef(this.ctx, input);
    const facets: Completeness = {
      inputs:
        ref === undefined
          ? { state: "absent", reason: "missing-in-record" }
          : ref.partial
            ? { state: "partial", reason: "malformed-value" }
            : { state: "captured" },
      outputs: { state: "unavailable" },
    };
    const payload: { [key: string]: JsonValue } = {
      toolCallId: id ?? null,
      toolName,
      toolNamespace: ns,
      input: ref === undefined ? null : refJson(ref.ref),
    };
    if (mcpServer !== undefined) payload["mcpServer"] = mcpServer;
    out.drafts.push(
      draft({
        kind: "tool.requested",
        status: "none",
        payload,
        role: a.role,
        actorKey: a.key,
        actorFacet: a.facet,
        ts,
        pointer,
        providerVersion: this.version,
        attrs,
        facets,
        ...(id === undefined ? {} : { anchor: id }),
      }),
    );
    if (id !== undefined) {
      if (this.toolReqs.size < this.ctx.bounds.maxOpenCorrelations || this.toolReqs.has(id)) {
        this.toolReqs.set(id, {
          name: name ?? "",
          input: isObj(input) ? input : undefined,
          actorKey: a.key,
        });
      } else if (!this.reqCapWarned) {
        this.reqCapWarned = true;
        out.warnings.push(
          warn("bounds-reached", null, { limit: this.ctx.bounds.maxOpenCorrelations }),
        );
      }
    }
  }

  private foldUsage(out: Out, seq: number, msg: Obj, val: Obj, a: ActorInfo, ts: TimeInfo): void {
    const usage = getObj(msg, "usage");
    const modelRaw = getNonEmptyStr(msg, "model");
    const model = modelRaw === undefined ? null : bound(modelRaw);
    const id = getNonEmptyStr(msg, "id");
    const rawTs = get(val, "timestamp");
    const existing = id === undefined ? undefined : this.usage.get(id);
    if (
      id !== undefined &&
      (existing !== undefined || this.usage.size < this.ctx.bounds.maxOpenCorrelations)
    ) {
      if (existing === undefined) {
        this.usage.set(id, {
          first: seq,
          last: seq,
          model,
          usage,
          ts: rawTs,
          role: a.role,
          key: a.key,
        });
      } else {
        existing.last = seq;
        existing.ts = rawTs;
        if (usage !== undefined) existing.usage = usage;
        if (model !== null) existing.model = model;
      }
      return;
    }
    if (id !== undefined && !this.foldCapWarned) {
      this.foldCapWarned = true;
      out.warnings.push(
        warn("bounds-reached", seq, { limit: this.ctx.bounds.maxOpenCorrelations }),
      );
    }
    if (usage !== undefined) {
      const d = this.messageUsage(usage, model, ts, a.role, a.key, "/message/usage", undefined);
      if (d !== null) out.drafts.push(d);
    }
  }

  private messageUsage(
    u: Obj,
    model: string | null,
    ts: TimeInfo,
    role: ActorRole,
    key: string,
    pointer: string,
    recordRef: { order: number; evidence: number } | undefined,
  ): DraftEvent | null {
    const t = tokenFields(u, [
      ["input_tokens", "inputTokens"],
      ["output_tokens", "outputTokens"],
      ["cache_read_input_tokens", "cachedInputTokens"],
      ["cache_creation_input_tokens", "cacheWriteInputTokens"],
    ]);
    if (t === null) return null;
    return draft({
      kind: "model.usage",
      status: "none",
      payload: { scope: "message", model, ...t.fields },
      role,
      actorKey: key,
      ts,
      pointer,
      providerVersion: this.version,
      facets: {
        model:
          model === null ? { state: "absent", reason: "missing-in-record" } : { state: "captured" },
        tokens: t.bad ? { state: "partial", reason: "malformed-value" } : { state: "captured" },
      },
      ...(recordRef === undefined ? {} : { recordRef }),
    });
  }

  // --- user ---------------------------------------------------------------------------

  private isHumanPrompt(val: Obj, a: ActorInfo): boolean {
    if (a.role !== "agent") return false;
    if (get(val, "isSynthetic") === true || get(val, "isMeta") === true) return false;
    if (get(val, "isCompactSummary") === true) return false;
    const origin = getObj(val, "origin");
    if (origin !== undefined) {
      const kind = getStr(origin, "kind");
      if (kind !== "human") return false;
    }
    return true;
  }

  private user(out: Out, rec: FramedRecord, val: Obj): void {
    const seq = rec.sourceSequence;
    const msg = getObj(val, "message");
    const blocks = msg === undefined ? undefined : this.blocks(get(msg, "content"));
    if (msg === undefined || blocks === undefined) {
      this.unknown(out, rec, val, "user", "/message", "unmapped-field");
      return;
    }
    const a = this.actorOf(val);
    const ts = timeOf(get(val, "timestamp"));
    const human = this.isHumanPrompt(val, a);
    const sys: ActorInfo = {
      role: "runtime",
      key: "runtime",
      facet: { state: "captured" },
      parent: null,
    };
    let promptTaken = false;
    this.maybeAgentStarted(out, a, val, ts);
    for (const { block, pointer, bare } of blocks.slice(0, MAX_FANOUT)) {
      const text = bare
        ? block
        : isObj(block) && getStr(block, "type") === "text"
          ? get(block, "text")
          : undefined;
      if (typeof text === "string") {
        if (human && !promptTaken) {
          promptTaken = true;
          const r = makeRef(this.ctx, text);
          out.drafts.push(
            draft({
              kind: "turn.started",
              status: "none",
              payload: { prompt: refJson(r.ref) },
              role: "user",
              actorKey: "user",
              ts,
              pointer,
              providerVersion: this.version,
            }),
          );
        } else {
          const nonHumanMain = a.role === "agent";
          this.message(
            out,
            text,
            "user",
            "text",
            nonHumanMain ? sys : a,
            ts,
            pointer,
            rec,
            val,
            {},
          );
        }
        continue;
      }
      if (!isObj(block)) {
        this.unknown(out, rec, val, null, pointer, "unmapped-field");
        continue;
      }
      const bt = getStr(block, "type");
      if (bt === "tool_result") {
        this.toolResult(out, rec, val, block, a, ts, pointer);
      } else if (bt === "image" || bt === "document") {
        this.message(
          out,
          block,
          "user",
          "text",
          a.role === "agent" ? sys : a,
          ts,
          pointer,
          rec,
          val,
          {},
        );
      } else {
        this.unknown(out, rec, val, bt ?? null, pointer, "unknown-record-type");
      }
    }
    if (blocks.length > MAX_FANOUT) {
      out.warnings.push(warn("bounds-reached", seq, { limit: MAX_FANOUT, seen: blocks.length }));
    }
    this.unmapped(out, seq, val, this.variant === "stream" ? K_USER_STREAM : K_TRANSCRIPT_MSG);
  }

  private toolResult(
    out: Out,
    rec: FramedRecord,
    val: Obj,
    b: Obj,
    a: ActorInfo,
    ts: TimeInfo,
    pointer: string,
  ): void {
    const id = getNonEmptyStr(b, "tool_use_id");
    const req = id === undefined ? undefined : this.toolReqs.get(id);
    const isErrRaw = get(b, "is_error");
    const isErr = isErrRaw === true;
    const flagMalformed = isErrRaw !== undefined && typeof isErrRaw !== "boolean";
    const tur = this.toolUseResult(val);
    const turObj = isObj(tur) ? tur : undefined;
    const interrupted = turObj !== undefined && get(turObj, "interrupted") === true;
    const content = get(b, "content");
    const contentOk = typeof content === "string" || isArr(content);
    const r = contentOk ? makeRef(this.ctx, content) : undefined;
    const outputsFacet: FacetCompleteness =
      content === undefined
        ? { state: "absent", reason: "missing-in-record" }
        : r === undefined || r.partial || r.ref === null
          ? { state: "partial", reason: "malformed-value" }
          : { state: "captured" };
    const facets: Completeness = {
      inputs: { state: "unavailable" },
      outputs: outputsFacet,
      ...(id === undefined ? {} : { causality: { state: "captured" as const } }),
    };
    const base = {
      role: a.role,
      actorKey: a.key,
      actorFacet: a.facet,
      ts,
      pointer,
      providerVersion: this.version,
      facets,
      ...(id === undefined ? {} : { refs: [{ rel: "result-of" as const, key: id }] }),
    };
    const toolName = req === undefined || req.name.length === 0 ? null : bound(req.name);
    if (isErr || interrupted) {
      out.drafts.push(
        draft({
          ...base,
          kind: "tool.failed",
          status: interrupted && !isErr ? "interrupted" : "failure",
          payload: {
            toolCallId: id ?? null,
            toolName,
            output: null,
            error: r === undefined ? null : refJson(r.ref),
            errorClass: interrupted && !isErr ? "interrupted" : "error",
          },
        }),
      );
    } else {
      out.drafts.push(
        draft({
          ...base,
          kind: "tool.completed",
          status: flagMalformed ? "unknown" : "success",
          payload: {
            toolCallId: id ?? null,
            toolName,
            output: r === undefined ? null : refJson(r.ref),
          },
        }),
      );
      this.fileChanged(out, req, id, turObj, a, ts, pointer);
    }
    if (id !== undefined) {
      const agentKey = this.agents.get(id);
      if (agentKey !== undefined && !this.endedAgents.has(id)) {
        this.endedAgents.add(id);
        out.drafts.push(
          draft({
            kind: "agent.ended",
            status: isErr ? "failure" : interrupted ? "interrupted" : "success",
            payload: { agentActorId: agentKey },
            role: "subagent",
            actorKey: agentKey,
            ts,
            pointer,
            providerVersion: this.version,
            refs: [{ rel: "ends", key: agentKey }],
            facets: { causality: { state: "captured" } },
          }),
        );
      }
    }
    void rec;
  }

  /**
   * `file.changed` only from a successful result of a known write tool whose request was seen
   * earlier. A request alone never produces one (requested is not ran). Bash is never inferred.
   */
  private fileChanged(
    out: Out,
    req: ToolReq | undefined,
    id: string | undefined,
    tur: Obj | undefined,
    a: ActorInfo,
    ts: TimeInfo,
    pointer: string,
  ): void {
    if (
      req === undefined ||
      id === undefined ||
      !FILE_TOOLS.has(req.name) ||
      req.input === undefined
    )
      return;
    const keyName = req.name === "NotebookEdit" ? "notebook_path" : "file_path";
    const path = getNonEmptyStr(req.input, keyName);
    if (path === undefined || path.includes("\u0000") || utf8Len(path) > 4096) return;
    if (tur !== undefined) {
      const e = get(tur, "error");
      if (typeof e === "string" && e.length > 0) return;
    }
    let changeKind: "add" | "update" | "unknown" = "update";
    if (req.name === "Write") {
      const t = tur === undefined ? undefined : getStr(tur, "type");
      changeKind = t === "create" ? "add" : t === "update" ? "update" : "unknown";
    }
    const patch = tur === undefined ? undefined : get(tur, "structuredPatch");
    const diff = req.name !== "NotebookEdit" && isArr(patch) ? makeRef(this.ctx, patch) : undefined;
    out.drafts.push(
      draft({
        kind: "file.changed",
        status: "success",
        payload: {
          path,
          changeKind,
          diff: diff === undefined ? null : refJson(diff.ref),
          viaToolCallId: id,
          basis: "derived-from-tool-result",
        },
        role: a.role,
        actorKey: a.key,
        actorFacet: a.facet,
        ts,
        pointer,
        providerVersion: this.version,
      }),
    );
  }

  // --- result (stream) ----------------------------------------------------------------

  private resultRecord(out: Out, rec: FramedRecord, val: Obj): void {
    const seq = rec.sourceSequence;
    const ts = timeOf(get(val, "timestamp"));
    const sub = getStr(val, "subtype");
    const isErr = get(val, "is_error");
    const terminal = getStr(val, "terminal_reason");
    let status: string;
    if (terminal?.startsWith("aborted")) status = "interrupted";
    else if (isErr === true || (sub !== undefined && sub !== "success")) status = "failure";
    else if (sub === "success") status = "success";
    else status = "unknown";
    const attrs: Attributes = {};
    const turns = safeInt(get(val, "num_turns"));
    if (turns !== undefined) attrs["claude-code.num-turns"] = turns;
    const dur = safeInt(get(val, "duration_ms"));
    if (dur !== undefined) attrs["claude-code.duration-ms"] = dur;
    if (terminal !== undefined && TERMINAL_REASONS.has(terminal))
      attrs["claude-code.terminal-reason"] = terminal;
    out.drafts.push(
      draft({
        kind: "turn.ended",
        status,
        payload: {},
        role: "runtime",
        actorKey: "runtime",
        ts,
        pointer: "",
        providerVersion: this.version,
        attrs,
      }),
    );
    this.result = { seq, status };

    // Cumulative run totals: scope "session" (M-18); never summed with message-scope usage.
    const modelUsage = getObj(val, "modelUsage");
    let emitted = 0;
    if (modelUsage !== undefined) {
      for (const m of Object.keys(modelUsage).slice(0, 16)) {
        const mu = modelUsage[m];
        if (!isObj(mu)) continue;
        const t = tokenFields(mu, [
          ["inputTokens", "inputTokens"],
          ["outputTokens", "outputTokens"],
          ["thinkingTokens", "reasoningOutputTokens"],
          ["cacheReadInputTokens", "cachedInputTokens"],
          ["cacheCreationInputTokens", "cacheWriteInputTokens"],
        ]);
        if (t === null) continue;
        const cost = safeCost(get(mu, "costUSD"));
        out.drafts.push(this.sessionUsage(m, t, cost, ts, `/modelUsage`));
        emitted++;
      }
    }
    if (emitted === 0) {
      const u = getObj(val, "usage");
      const t =
        u === undefined
          ? null
          : tokenFields(u, [
              ["input_tokens", "inputTokens"],
              ["output_tokens", "outputTokens"],
              ["cache_read_input_tokens", "cachedInputTokens"],
              ["cache_creation_input_tokens", "cacheWriteInputTokens"],
            ]);
      if (t !== null) {
        out.drafts.push(
          this.sessionUsage(null, t, safeCost(get(val, "total_cost_usd")), ts, "/usage"),
        );
      }
    }

    const errors = get(val, "errors");
    if (isArr(errors) && errors.length > 0) {
      this.message(
        out,
        errors,
        "system",
        "notification",
        {
          role: "runtime",
          key: "runtime",
          facet: { state: "captured" },
          parent: null,
        },
        ts,
        "/errors",
        rec,
        val,
        {},
      );
    }
    const denials = get(val, "permission_denials");
    if (isArr(denials)) {
      denials.slice(0, MAX_FANOUT).forEach((d, i) => {
        if (isObj(d)) this.denial(out, d, val, `/permission_denials/${i}`, ts, seq, `${seq}:${i}`);
        else this.unknown(out, rec, val, null, `/permission_denials/${i}`, "unmapped-field");
      });
      if (denials.length > MAX_FANOUT) {
        out.warnings.push(warn("bounds-reached", seq, { limit: MAX_FANOUT, seen: denials.length }));
      }
    }
    this.unmapped(out, seq, val, K_RESULT);
  }

  private sessionUsage(
    model: string | null,
    t: { fields: Record<string, number>; bad: boolean },
    cost: number | undefined,
    ts: TimeInfo,
    pointer: string,
  ): DraftEvent {
    return draft({
      kind: "model.usage",
      status: "none",
      payload: {
        scope: "session",
        model: model === null ? null : bound(model),
        ...t.fields,
        ...(cost === undefined ? {} : { costUsdEstimate: cost }),
      },
      role: "runtime",
      actorKey: "runtime",
      ts,
      pointer,
      providerVersion: this.version,
      facets: {
        model:
          model === null ? { state: "absent", reason: "missing-in-record" } : { state: "captured" },
        tokens: t.bad ? { state: "partial", reason: "malformed-value" } : { state: "captured" },
      },
    });
  }

  /** A permission denial is a provider-reported deny decision; it never fabricates a tool failure. */
  private denial(
    out: Out,
    d: Obj,
    _val: Obj,
    pointer: string,
    ts: TimeInfo,
    seq: number,
    key: string,
  ): void {
    const name = getNonEmptyStr(d, "tool_name");
    const id = getNonEmptyStr(d, "tool_use_id");
    const input = get(d, "tool_input");
    const r = input === undefined ? undefined : makeRef(this.ctx, input);
    const anchor = `deny:${key}`;
    const common = {
      role: "runtime" as const,
      actorKey: "runtime",
      ts,
      providerVersion: this.version,
    };
    out.drafts.push(
      draft({
        ...common,
        kind: "permission.requested",
        status: "none",
        payload: {
          toolName: name === undefined ? null : bound(name),
          toolCallId: id ?? null,
          input: r === undefined ? null : refJson(r.ref),
        },
        pointer: pointer === "" ? "" : pointer,
        anchor,
      }),
    );
    out.drafts.push(
      draft({
        ...common,
        kind: "permission.decided",
        status: "none",
        payload: { decision: "deny", decidedBy: "unknown", reason: null },
        pointer: pointer === "" ? "" : pointer,
        refs: [{ rel: "decides", key: anchor }],
        facets: { causality: { state: "captured" } },
      }),
    );
    void seq;
  }
}

function tokenFields(
  u: Obj,
  mapping: readonly (readonly [string, string])[],
): { fields: Record<string, number>; bad: boolean } | null {
  const fields: Record<string, number> = {};
  let bad = false;
  for (const [src, dst] of mapping) {
    if (!Object.hasOwn(u, src)) continue;
    const n = safeInt(u[src]);
    if (n === undefined) bad = true;
    else fields[dst] = n;
  }
  return Object.keys(fields).length === 0 ? null : { fields, bad };
}
