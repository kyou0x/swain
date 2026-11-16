import type {
  AdapterOutput,
  AdapterRegistration,
  Attributes,
  DetectResult,
  FramedRecord,
  JsonValue,
  ParseContext,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import {
  AGENT,
  Base,
  exitCodeFromHeader,
  joinText,
  MAX_FANOUT,
  RUNTIME,
  USER,
  usageFields,
  type Who,
} from "./common.js";
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
  safeInt,
  type TimeInfo,
  timeOf,
  versionOrNull,
} from "./util.js";

/**
 * `codex-cli.rollout-jsonl`: the on-disk rollout (UNDOCUMENTED, community and source-observed
 * shapes, FORMAT-codex sections 2 to 4). Legacy and paginated `history_mode` share one parser:
 * paginated files add a top-level `ordinal` and persist `item_completed` TurnItems where legacy
 * files persist `user_message`, `agent_message`, `agent_reasoning` and `patch_apply_end`.
 */
export const ROLLOUT_ATTRIBUTE_KEYS: readonly string[] = [
  "codex-cli.cwd",
  "codex-cli.source",
  "codex-cli.history-mode",
  "codex-cli.ordinal",
  "codex-cli.abort-reason",
  "codex-cli.exit-code-source",
  "codex-cli.phase",
];

const ROLLOUT_TYPES: ReadonlySet<string> = new Set([
  "session_meta",
  "dynamic_tools_updated",
  "response_item",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "compacted",
  "turn_context",
  "token_usage_record",
  "world_state",
  "retained_context",
  "security_risk_score",
  "event_msg",
  "realtime_item",
]);
/** Internal bookkeeping lines with no observable agent action: accounted, not mapped. */
const METADATA_TYPES: ReadonlySet<string> = new Set([
  "dynamic_tools_updated",
  "world_state",
  "retained_context",
  "security_risk_score",
  "inter_agent_communication_metadata",
]);
const SOURCES: ReadonlySet<string> = new Set(["cli", "vscode", "exec", "mcp", "unknown"]);
const ABORT_REASONS: ReadonlySet<string> = new Set([
  "interrupted",
  "replaced",
  "review_ended",
  "budget_limited",
]);
const PHASES: ReadonlySet<string> = new Set(["commentary", "partial_answer", "final_answer"]);
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "input_text",
  "output_text",
  "text",
  "Text",
  "summary_text",
  "reasoning_text",
]);
const LINE_KEYS: ReadonlySet<string> = new Set([
  "timestamp",
  "ordinal",
  "type",
  "payload",
  "metadata",
]);
const META_KEYS: ReadonlySet<string> = new Set([
  "account_scoped",
  "creator_user_id",
  "creator_account_id",
  "session_id",
  "id",
  "forked_from_id",
  "attached_thread",
  "forked_from_ordinal_exclusive",
  "parent_thread_id",
  "timestamp",
  "cwd",
  "runtime_workspace_roots",
  "originator",
  "cli_version",
  "source",
  "thread_source",
  "agent_nickname",
  "agent_role",
  "agent_type",
  "agent_path",
  "model_provider",
  "base_instructions",
  "dynamic_tools",
  "selected_capability_roots",
  "memory_mode",
  "history_mode",
  "history_base",
  "subagent_history_start_ordinal",
  "multi_agent_version",
  "context_window",
  "git",
  "instructions",
]);

type Cls = "response" | "event";
interface Seen {
  readonly seq: number;
  readonly key: string;
  readonly cls: Cls;
  consumed: boolean;
}
/** A mirrored text fact (response_item vs event_msg/item_completed) within this many records. */
const MIRROR_WINDOW = 8;

export class RolloutParser extends Base implements RecordParser {
  private sessionSeen = false;
  private historyMode: "legacy" | "paginated" | null = null;
  private model: string | null = null;
  private readonly recent: Seen[] = [];

  constructor(ctx: ParseContext) {
    super(ctx);
  }

  push(rec: FramedRecord): AdapterOutput {
    const out = new Out();
    const seq = rec.sourceSequence;
    const val = rec.parse.ok ? rec.parse.value : null;
    if (!isObj(val)) {
      this.unknown(out, rec, null, null, null);
      return this.fin(out);
    }
    const type = getStr(val, "type");
    const payload = getObj(val, "payload");
    const ts = timeOf(get(val, "timestamp"));
    const attrs: Attributes = {};
    const ord = safeInt(get(val, "ordinal"));
    if (ord !== undefined) {
      attrs["codex-cli.ordinal"] = ord;
      this.historyMode = this.historyMode ?? "paginated";
    }
    if (type === undefined || !ROLLOUT_TYPES.has(type)) {
      this.unknown(out, rec, val, type ?? null, null);
    } else if (METADATA_TYPES.has(type)) {
      out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
    } else if (type === "inter_agent_communication" || type === "realtime_item") {
      this.unknown(out, rec, val, type, null);
    } else if (payload === undefined) {
      this.unknown(out, rec, val, type, "/payload", "unmapped-field");
    } else if (type === "session_meta") {
      this.sessionMeta(out, rec, payload, ts);
    } else if (type === "turn_context") {
      const m = getNonEmptyStr(payload, "model");
      if (m !== undefined) this.model = bound(m);
      out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
    } else if (type === "response_item") {
      this.responseItem(out, rec, val, payload, ts, attrs);
    } else if (type === "event_msg") {
      this.eventMsg(out, rec, val, payload, ts, attrs);
    } else if (type === "compacted") {
      const m = get(payload, "message");
      if (typeof m === "string") {
        this.message(
          out,
          rec,
          val,
          m,
          "system",
          "notification",
          RUNTIME,
          ts,
          "/payload/message",
          attrs,
        );
      } else {
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
      }
    } else {
      // token_usage_record
      this.tokenUsageRecord(out, rec, payload, ts, attrs);
    }
    if (out.drafts.length === 0 && out.dispositions.length === 0) {
      out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
    }
    this.unmapped(out, seq, val, LINE_KEYS);
    return this.fin(out);
  }

  end(): AdapterOutput {
    return { drafts: [], warnings: [], dispositions: [] };
  }

  private fin(out: Out): AdapterOutput {
    return { drafts: out.drafts, warnings: out.warnings, dispositions: out.dispositions };
  }

  // --- session_meta ------------------------------------------------------------------

  private sessionMeta(out: Out, rec: FramedRecord, p: Obj, ts: TimeInfo): void {
    const seq = rec.sourceSequence;
    if (this.sessionSeen) {
      // later session_meta lines (legacy) are metadata updates, not another session start
      out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
      return;
    }
    this.sessionSeen = true;
    const v = versionOrNull(get(p, "cli_version"));
    if (v !== null) this.version = v;
    const hm = getStr(p, "history_mode");
    if (hm === "paginated" || hm === "legacy") this.historyMode = hm;
    else if (hm === undefined && this.historyMode === null) this.historyMode = "legacy";
    const attrs: Attributes = {};
    const cwd = getStr(p, "cwd");
    if (cwd !== undefined) attrs["codex-cli.cwd"] = bound(cwd);
    const source = getStr(p, "source");
    if (source !== undefined && SOURCES.has(source)) attrs["codex-cli.source"] = source;
    if (this.historyMode !== null) attrs["codex-cli.history-mode"] = this.historyMode;
    const sid = getNonEmptyStr(p, "session_id") ?? getNonEmptyStr(p, "id");
    out.drafts.push(
      draft({
        kind: "session.started",
        status: "none",
        payload: {
          nativeSessionId: sid === undefined ? null : bound(sid),
          trigger: typeof get(p, "forked_from_id") === "string" ? "fork" : "startup",
        },
        role: RUNTIME.role,
        actorKey: RUNTIME.key,
        ts,
        pointer: "/payload",
        providerVersion: this.version,
        attrs,
        nativeSessionId: sid === undefined ? null : bound(sid),
      }),
    );
    this.unmapped(out, seq, p, META_KEYS);
  }

  // --- mirrored text -----------------------------------------------------------------

  /**
   * The same text is written twice: as a response_item and as an event_msg/TurnItem. The first
   * record emits the message; a later record of the other class with the same role and content
   * hash within a few records is accounted as `superseded` into it. Nothing is dropped silently.
   */
  private text(
    out: Out,
    rec: FramedRecord,
    val: JsonValue,
    value: JsonValue,
    role: "user" | "assistant" | "system",
    channel: "text" | "reasoning",
    who: Who,
    cls: Cls,
    ts: TimeInfo,
    pointer: string,
    attrs: Attributes,
  ): void {
    const seq = rec.sourceSequence;
    const r = makeRef(this.ctx, value);
    const key = `${role}/${channel}/${r.ref?.sha256 ?? ""}`;
    if (r.ref !== null) {
      const hit = this.recent.find(
        (e) => !e.consumed && e.cls !== cls && e.key === key && seq - e.seq <= MIRROR_WINDOW,
      );
      if (hit !== undefined) {
        hit.consumed = true;
        out.dispositions.push({ sourceSequence: seq, kind: "superseded", into: hit.seq });
        return;
      }
    }
    const sha = this.message(out, rec, val, value, role, channel, who, ts, pointer, attrs);
    if (sha !== null) {
      this.recent.push({ seq, key: `${role}/${channel}/${sha}`, cls, consumed: false });
      if (this.recent.length > 16) this.recent.shift();
    }
  }

  private phaseAttrs(attrs: Attributes, phase: JsonValue | undefined): Attributes {
    if (typeof phase === "string" && PHASES.has(phase)) {
      return { ...attrs, "codex-cli.phase": phase };
    }
    return attrs;
  }

  // --- response_item -----------------------------------------------------------------

  private responseItem(
    out: Out,
    rec: FramedRecord,
    val: Obj,
    p: Obj,
    ts: TimeInfo,
    attrs: Attributes,
  ): void {
    const seq = rec.sourceSequence;
    const pt = getStr(p, "type");
    switch (pt) {
      case "message": {
        const role = getStr(p, "role");
        const content = get(p, "content");
        const text = joinText(content, TEXT_TYPES);
        const value: JsonValue | undefined = text ?? (isArr(content) ? content : undefined);
        if (value === undefined || role === undefined) {
          this.unknown(out, rec, val, "response_item.message", "/payload", "unmapped-field");
        } else if (role === "assistant") {
          this.text(
            out,
            rec,
            val,
            value,
            "assistant",
            "text",
            AGENT,
            "response",
            ts,
            "/payload/content",
            this.phaseAttrs(attrs, get(p, "phase")),
          );
        } else if (role === "user") {
          this.text(
            out,
            rec,
            val,
            value,
            "user",
            "text",
            USER,
            "response",
            ts,
            "/payload/content",
            attrs,
          );
        } else if (role === "developer" || role === "system") {
          this.message(
            out,
            rec,
            val,
            value,
            "system",
            "text",
            RUNTIME,
            ts,
            "/payload/content",
            attrs,
          );
        } else {
          this.unknown(out, rec, val, "response_item.message", "/payload/role", "unmapped-field");
        }
        break;
      }
      case "reasoning": {
        const text = [
          joinText(get(p, "summary"), TEXT_TYPES),
          joinText(get(p, "content"), TEXT_TYPES),
        ]
          .filter((x): x is string => x !== undefined)
          .join("\n");
        if (text.length === 0) {
          // encrypted-only reasoning: nothing is exposed
          out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        } else {
          this.text(
            out,
            rec,
            val,
            text,
            "assistant",
            "reasoning",
            AGENT,
            "response",
            ts,
            "/payload",
            attrs,
          );
        }
        break;
      }
      case "function_call": {
        const id = getNonEmptyStr(p, "call_id");
        const name = getNonEmptyStr(p, "name");
        const args = get(p, "arguments");
        let input: JsonValue | undefined = args;
        let partial = false;
        if (typeof args === "string") {
          try {
            input = JSON.parse(args) as JsonValue;
          } catch {
            partial = true;
          }
        } else if (args !== undefined) {
          partial = true;
        }
        this.requested(out, {
          id,
          name,
          input,
          inputPartial: partial,
          ts,
          pointer: "/payload/arguments",
          attrs,
        });
        if (id !== undefined) this.remember(out, id, name ?? "");
        break;
      }
      case "custom_tool_call": {
        const id = getNonEmptyStr(p, "call_id");
        const name = getNonEmptyStr(p, "name");
        const input = get(p, "input");
        this.requested(out, {
          id,
          name,
          input: typeof input === "string" ? input : undefined,
          ts,
          pointer: "/payload/input",
          attrs,
        });
        if (id !== undefined) this.remember(out, id, name ?? "");
        break;
      }
      case "local_shell_call": {
        const id = getNonEmptyStr(p, "call_id");
        this.requested(out, {
          id,
          name: "local_shell",
          input: get(p, "action"),
          ts,
          pointer: "/payload/action",
          attrs,
        });
        if (id !== undefined) this.remember(out, id, "local_shell");
        break;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const id = getNonEmptyStr(p, "call_id");
        const output = get(p, "output");
        const nameRaw = id === undefined ? undefined : this.calls.get(id)?.name;
        const name =
          nameRaw !== undefined && nameRaw.length > 0
            ? nameRaw
            : (getNonEmptyStr(p, "name") ?? null);
        const code = exitCodeFromHeader(output);
        const a: Attributes =
          code === undefined ? attrs : { ...attrs, "codex-cli.exit-code-source": "output-header" };
        this.result(out, {
          id,
          name,
          outcome: code === undefined ? "unknown" : code === 0 ? "success" : "failure",
          exitCode: code,
          output,
          ts,
          pointer: "/payload/output",
          attrs: a,
        });
        break;
      }
      case "compaction":
      case "compaction_summary":
      case "context_compaction":
      case "configuration_update":
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        break;
      default:
        this.unknown(
          out,
          rec,
          val,
          pt === undefined ? "response_item" : `response_item.${pt}`,
          "/payload",
        );
    }
  }

  // --- event_msg ----------------------------------------------------------------------

  private eventMsg(
    out: Out,
    rec: FramedRecord,
    val: Obj,
    p: Obj,
    ts: TimeInfo,
    attrs: Attributes,
  ): void {
    const seq = rec.sourceSequence;
    const et = getStr(p, "type");
    const turnKey = getNonEmptyStr(p, "turn_id");
    switch (et) {
      case "task_started":
      case "turn_started":
        out.drafts.push(
          draft({
            kind: "turn.started",
            status: "none",
            payload: { prompt: null },
            role: RUNTIME.role,
            actorKey: RUNTIME.key,
            ts,
            pointer: "/payload",
            providerVersion: this.version,
            attrs,
            ...(turnKey === undefined ? {} : { nativeTurnKey: bound(turnKey) }),
          }),
        );
        break;
      case "task_complete":
      case "turn_complete":
        out.drafts.push(
          draft({
            kind: "turn.ended",
            status: isObj(get(p, "error")) ? "failure" : "success",
            payload: {},
            role: RUNTIME.role,
            actorKey: RUNTIME.key,
            ts,
            pointer: "/payload",
            providerVersion: this.version,
            attrs,
            ...(turnKey === undefined ? {} : { nativeTurnKey: bound(turnKey) }),
          }),
        );
        break;
      case "turn_aborted": {
        const reason = getStr(p, "reason");
        out.drafts.push(
          draft({
            kind: "turn.ended",
            status: "interrupted",
            payload: {},
            role: RUNTIME.role,
            actorKey: RUNTIME.key,
            ts,
            pointer: "/payload",
            providerVersion: this.version,
            attrs:
              reason !== undefined && ABORT_REASONS.has(reason)
                ? { ...attrs, "codex-cli.abort-reason": reason }
                : attrs,
            ...(turnKey === undefined ? {} : { nativeTurnKey: bound(turnKey) }),
          }),
        );
        break;
      }
      case "token_count": {
        const info = getObj(p, "info");
        const total = info === undefined ? undefined : getObj(info, "total_token_usage");
        const u = total === undefined ? null : usageFields(total, true);
        if (u === null) {
          out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        } else {
          // total_token_usage is cumulative for the thread: reported as is, never summed
          this.usage(
            out,
            "session",
            this.model,
            u,
            ts,
            "/payload/info/total_token_usage",
            attrs,
            false,
          );
        }
        break;
      }
      case "user_message": {
        const m = get(p, "message");
        if (typeof m === "string") {
          this.text(out, rec, val, m, "user", "text", USER, "event", ts, "/payload/message", attrs);
        } else {
          this.unknown(out, rec, val, "event_msg.user_message", "/payload", "unmapped-field");
        }
        break;
      }
      case "agent_message": {
        const m = get(p, "message");
        if (typeof m === "string") {
          this.text(
            out,
            rec,
            val,
            m,
            "assistant",
            "text",
            AGENT,
            "event",
            ts,
            "/payload/message",
            this.phaseAttrs(attrs, get(p, "phase")),
          );
        } else {
          this.unknown(out, rec, val, "event_msg.agent_message", "/payload", "unmapped-field");
        }
        break;
      }
      case "agent_reasoning":
      case "agent_reasoning_raw_content": {
        const t = get(p, "text");
        if (typeof t === "string") {
          this.text(
            out,
            rec,
            val,
            t,
            "assistant",
            "reasoning",
            AGENT,
            "event",
            ts,
            "/payload/text",
            attrs,
          );
        } else {
          this.unknown(out, rec, val, `event_msg.${et}`, "/payload", "unmapped-field");
        }
        break;
      }
      case "patch_apply_end": {
        const changes = this.changeList(get(p, "changes"), "/payload/changes");
        const st = getStr(p, "status");
        const ok = get(p, "success");
        const status =
          st === "completed"
            ? "success"
            : st === "failed" || st === "declined"
              ? "failure"
              : ok === true
                ? "success"
                : ok === false
                  ? "failure"
                  : "unknown";
        if (changes === undefined) {
          this.unknown(
            out,
            rec,
            val,
            "event_msg.patch_apply_end",
            "/payload/changes",
            "unmapped-field",
          );
        } else if (changes.length === 0) {
          out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        } else {
          this.fileChanges(out, rec, changes, status, getNonEmptyStr(p, "call_id"), ts);
        }
        break;
      }
      case "item_completed":
        this.itemCompleted(out, rec, val, p, ts, attrs);
        break;
      case "thread_rolled_back":
      case "thread_settings_applied":
      case "thread_goal_updated":
        out.dispositions.push({ sourceSequence: seq, kind: "control", into: null });
        break;
      case "context_compacted":
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        break;
      default:
        this.unknown(out, rec, val, et === undefined ? "event_msg" : `event_msg.${et}`, "/payload");
    }
  }

  private changeList(
    changes: JsonValue | undefined,
    base: string,
  ): { path: string; kind: string; diff: JsonValue | undefined; pointer: string }[] | undefined {
    if (!isObj(changes)) return undefined;
    const list: { path: string; kind: string; diff: JsonValue | undefined; pointer: string }[] = [];
    for (const path of Object.keys(changes).slice(0, MAX_FANOUT + 1)) {
      const c = changes[path];
      const kind = isObj(c) ? (getStr(c, "type") ?? "unknown") : "unknown";
      let diff: JsonValue | undefined;
      if (isObj(c)) {
        diff = kind === "update" ? get(c, "unified_diff") : get(c, "content");
        if (typeof diff !== "string") diff = undefined;
      }
      // path keys come from the source: JSON Pointer escaping is applied to the segment
      list.push({
        path,
        kind,
        diff,
        pointer: `${base}/${path.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      });
    }
    return list;
  }

  // --- item_completed (paginated) ----------------------------------------------------

  private itemCompleted(
    out: Out,
    rec: FramedRecord,
    val: Obj,
    p: Obj,
    ts: TimeInfo,
    attrs: Attributes,
  ): void {
    const seq = rec.sourceSequence;
    const item = getObj(p, "item");
    const it = item === undefined ? undefined : getStr(item, "type");
    if (item === undefined || it === undefined) {
      this.unknown(out, rec, val, "event_msg.item_completed", "/payload/item", "unmapped-field");
      return;
    }
    switch (it) {
      case "UserMessage": {
        const content = get(item, "content");
        const text = joinText(content, TEXT_TYPES);
        const value: JsonValue | undefined = text ?? (isArr(content) ? content : undefined);
        if (value === undefined)
          this.unknown(
            out,
            rec,
            val,
            "item_completed.UserMessage",
            "/payload/item",
            "unmapped-field",
          );
        else
          this.text(
            out,
            rec,
            val,
            value,
            "user",
            "text",
            USER,
            "event",
            ts,
            "/payload/item/content",
            attrs,
          );
        break;
      }
      case "AgentMessage": {
        const content = get(item, "content");
        const text = joinText(content, TEXT_TYPES);
        const value: JsonValue | undefined = text ?? (isArr(content) ? content : undefined);
        if (value === undefined)
          this.unknown(
            out,
            rec,
            val,
            "item_completed.AgentMessage",
            "/payload/item",
            "unmapped-field",
          );
        else
          this.text(
            out,
            rec,
            val,
            value,
            "assistant",
            "text",
            AGENT,
            "event",
            ts,
            "/payload/item/content",
            this.phaseAttrs(attrs, get(item, "phase")),
          );
        break;
      }
      case "Reasoning": {
        const strs = (v: JsonValue | undefined): string[] =>
          isArr(v) ? v.filter((x): x is string => typeof x === "string") : [];
        const text = [...strs(get(item, "summary_text")), ...strs(get(item, "raw_content"))].join(
          "\n",
        );
        if (text.length === 0)
          out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        else
          this.text(
            out,
            rec,
            val,
            text,
            "assistant",
            "reasoning",
            AGENT,
            "event",
            ts,
            "/payload/item",
            attrs,
          );
        break;
      }
      case "CommandExecution": {
        const id = getNonEmptyStr(item, "id");
        const known = id !== undefined && this.calls.has(id);
        const st = getStr(item, "status");
        const code = safeIntSigned(get(item, "exit_code"));
        const outc = get(item, "aggregated_output");
        const output = typeof outc === "string" ? outc : undefined;
        let outcome: "success" | "unknown" | "failure" | "denied" = "unknown";
        if (st === "completed")
          outcome = code === undefined ? "unknown" : code === 0 ? "success" : "failure";
        else if (st === "failed") outcome = "failure";
        else if (st === "declined") outcome = "denied";
        const nameRaw = known && id !== undefined ? this.calls.get(id)?.name : undefined;
        this.result(out, {
          id: known ? id : undefined,
          name: nameRaw !== undefined && nameRaw.length > 0 ? nameRaw : "command_execution",
          outcome,
          exitCode: code,
          output,
          ts,
          pointer: "/payload/item",
          attrs,
        });
        break;
      }
      case "FileChange": {
        const changes = this.changeList(get(item, "changes"), "/payload/item/changes");
        const st = getStr(item, "status");
        const status =
          st === "completed"
            ? "success"
            : st === "failed" || st === "declined"
              ? "failure"
              : "unknown";
        if (changes === undefined)
          this.unknown(
            out,
            rec,
            val,
            "item_completed.FileChange",
            "/payload/item",
            "unmapped-field",
          );
        else if (changes.length === 0)
          out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        else this.fileChanges(out, rec, changes, status, getNonEmptyStr(item, "id"), ts);
        break;
      }
      case "FunctionCallOutput":
        // legacy mirror of the response_item function_call_output (shape not captured in research)
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        break;
      default:
        this.unknown(out, rec, val, `item_completed.${it}`, "/payload/item");
    }
  }

  // --- token_usage_record ------------------------------------------------------------

  private tokenUsageRecord(
    out: Out,
    rec: FramedRecord,
    p: Obj,
    ts: TimeInfo,
    attrs: Attributes,
  ): void {
    const seq = rec.sourceSequence;
    const thread = getObj(p, "thread_token_usage");
    const turn = getObj(p, "turn_token_usage");
    const tu = thread === undefined ? null : usageFields(thread, true);
    const nu = turn === undefined ? null : usageFields(turn, true);
    if (tu !== null)
      this.usage(out, "session", this.model, tu, ts, "/payload/thread_token_usage", attrs, false);
    if (nu !== null)
      this.usage(out, "turn", this.model, nu, ts, "/payload/turn_token_usage", attrs, false);
    if (tu === null && nu === null)
      out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
  }
}

function safeIntSigned(v: JsonValue | undefined): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) ? v + 0 : undefined;
}

const NO = (reason: string): DetectResult => ({
  verdict: "no-match",
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [reason],
});

/**
 * A rollout line is `{timestamp, [ordinal], type, payload}` with an underscore type. Dotted
 * exec types, camelCase or snake_case Claude keys veto the match. An unrecognized
 * `history_mode` is `unsupported` rather than guessed.
 */
export function detectRollout(sample: readonly FramedRecord[]): DetectResult {
  let strong = false;
  let unsupported = false;
  let version: string | null = null;
  let sid: string | null = null;
  let parsed = 0;
  for (const rec of sample) {
    if (!rec.parse.ok) continue;
    const v = rec.parse.value;
    // stray non-object lines are tolerated; they never count as evidence
    if (!isObj(v)) continue;
    parsed++;
    if (
      Object.hasOwn(v, "sessionId") ||
      Object.hasOwn(v, "session_id") ||
      Object.hasOwn(v, "parentUuid") ||
      Object.hasOwn(v, "parent_tool_use_id")
    ) {
      return NO("foreign-shape");
    }
    const type = getStr(v, "type");
    if (type?.includes(".")) return NO("foreign-shape");
    if (type === undefined || !ROLLOUT_TYPES.has(type)) continue;
    const payload = getObj(v, "payload");
    if (payload === undefined || typeof get(v, "timestamp") !== "string") continue;
    if (type === "session_meta") {
      const id = getNonEmptyStr(payload, "session_id") ?? getNonEmptyStr(payload, "id");
      if (id !== undefined || typeof get(payload, "cli_version") === "string") {
        strong = true;
        sid = sid ?? (id === undefined ? null : bound(id));
        version = version ?? versionOrNull(get(payload, "cli_version"));
        const hm = get(payload, "history_mode");
        if (hm !== undefined && hm !== "legacy" && hm !== "paginated") unsupported = true;
      }
    } else if (type === "turn_context") {
      strong = true;
    } else if (
      (type === "response_item" || type === "event_msg") &&
      typeof get(payload, "type") === "string"
    ) {
      strong = true;
    }
  }
  if (parsed === 0) return NO("no-parseable-record");
  if (!strong) return NO("no-rollout-signal");
  return {
    verdict: unsupported ? "unsupported" : "match",
    providerVersionSeen: version,
    nativeSessionId: sid,
    reasons: [unsupported ? "unknown-history-mode" : "rollout-shape"],
  };
}

/**
 * UNDOCUMENTED surface. capability-matrix.json has a surface row for `codex-cli.rollout-jsonl`
 * (p0Use not-used) but no capability cell lists it, so every cell is `unknown` (M-12, M-16).
 * Would claim after L-MATRIX uplift:
 * sessionLifecycle partial, toolCallInputs partial, toolCallOutputs partial, filePatches partial,
 * failures partial, tokens partial (cumulative only), timestamps partial; llmMetadata partial
 * via turn_context.model; permissions and subagents stay unknown.
 */
export const rolloutAdapter: SourceAdapter = {
  manifest: {
    id: "codex-cli.rollout-jsonl",
    adapterVersion: "0.1.0",
    provider: "codex-cli",
    sourceKind: "codex-cli.rollout-jsonl",
    sourceStability: "undocumented",
    captureModes: ["import-file"],
    testedProviderVersions: [],
    capabilities: {
      sessionLifecycle: "unknown",
      toolCallInputs: "unknown",
      toolCallOutputs: "unknown",
      llmMetadata: "unknown",
      filePatches: "unknown",
      subagents: "unknown",
      permissions: "unknown",
      failures: "unknown",
      timestamps: "unknown",
      tokens: "unknown",
    },
    framing: { kind: "jsonl" },
    experimental: true,
    attributeKeys: ROLLOUT_ATTRIBUTE_KEYS,
  },
  detect: detectRollout,
  createParser(ctx: ParseContext): RecordParser {
    return new RolloutParser(ctx);
  },
};

export const rolloutRegistration: AdapterRegistration = {
  adapter: rolloutAdapter,
  discovery: {
    roots: [{ base: "home", segments: [".codex", "sessions"] }],
    fileNamePattern: "^rollout-.+\\.jsonl(?:\\.zst)?$",
  },
};
