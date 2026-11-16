import type {
  AdapterOutput,
  AdapterRegistration,
  DetectResult,
  FramedRecord,
  JsonValue,
  ParseContext,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import { Base, MAX_FANOUT, RUNTIME, usageFields } from "./common.js";
import {
  bound,
  draft,
  get,
  getNonEmptyStr,
  getObj,
  getStr,
  isArr,
  isObj,
  type Obj,
  Out,
  type TimeInfo,
} from "./util.js";

/** `codex exec --json` carries no per-event timestamp (FORMAT-codex section 5). */
const NO_TS: TimeInfo = {
  time: { value: null, origin: "none", status: "missing" },
  facet: { state: "unavailable", reason: "provider-does-not-expose" },
};

const EXEC_TYPES: ReadonlySet<string> = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);
const TOOL_ITEMS: ReadonlySet<string> = new Set([
  "command_execution",
  "mcp_tool_call",
  "collab_tool_call",
]);
const COLLAB_TOOLS: ReadonlySet<string> = new Set([
  "spawn_agent",
  "send_input",
  "wait",
  "close_agent",
]);

/** No attributes are emitted: the stream carries no cwd, source or timestamps. */
export const EXEC_ATTRIBUTE_KEYS: readonly string[] = [];

export class ExecParser extends Base implements RecordParser {
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
    switch (type) {
      case "thread.started": {
        const id = getNonEmptyStr(val, "thread_id");
        out.drafts.push(
          draft({
            kind: "session.started",
            status: "none",
            payload: { nativeSessionId: id === undefined ? null : bound(id), trigger: "startup" },
            role: RUNTIME.role,
            actorKey: RUNTIME.key,
            ts: NO_TS,
            pointer: "",
            providerVersion: this.version,
            nativeSessionId: id === undefined ? null : bound(id),
          }),
        );
        break;
      }
      case "turn.started":
        out.drafts.push(
          draft({
            kind: "turn.started",
            status: "none",
            payload: { prompt: null },
            role: RUNTIME.role,
            actorKey: RUNTIME.key,
            ts: NO_TS,
            pointer: "",
            providerVersion: this.version,
          }),
        );
        break;
      case "turn.completed": {
        out.drafts.push(this.turnEnded("success"));
        const u = getObj(val, "usage");
        const f = u === undefined ? null : usageFields(u, false);
        // cumulative for the thread, not a per-turn delta (FORMAT-codex 5): scope "session".
        // All zeros is what the CLI emits when it saw no usage, so tokens is only partial then.
        if (f !== null) this.usage(out, "session", null, f, NO_TS, "/usage", {}, true);
        break;
      }
      case "turn.failed": {
        out.drafts.push(this.turnEnded("failure"));
        const e = getObj(val, "error");
        const m = e === undefined ? undefined : get(e, "message");
        if (typeof m === "string") {
          this.message(
            out,
            rec,
            val,
            m,
            "system",
            "notification",
            RUNTIME,
            NO_TS,
            "/error/message",
            {},
          );
        }
        break;
      }
      case "error": {
        const m = get(val, "message");
        if (typeof m === "string") {
          this.message(out, rec, val, m, "system", "notification", RUNTIME, NO_TS, "/message", {});
        } else {
          this.unknown(out, rec, val, "error", "/message", "unmapped-field");
        }
        break;
      }
      case "item.started":
        this.itemStarted(out, rec, val);
        break;
      case "item.updated":
        out.dispositions.push({ sourceSequence: seq, kind: "control", into: null });
        break;
      case "item.completed":
        this.itemCompleted(out, rec, val);
        break;
      default:
        this.unknown(out, rec, val, type ?? null, null);
    }
    if (out.drafts.length === 0 && out.dispositions.length === 0) {
      out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
    }
    return this.fin(out);
  }

  end(): AdapterOutput {
    return { drafts: [], warnings: [], dispositions: [] };
  }

  private fin(out: Out): AdapterOutput {
    return { drafts: out.drafts, warnings: out.warnings, dispositions: out.dispositions };
  }

  private turnEnded(status: "success" | "failure") {
    return draft({
      kind: "turn.ended",
      status,
      payload: {},
      role: RUNTIME.role,
      actorKey: RUNTIME.key,
      ts: NO_TS,
      pointer: "",
      providerVersion: this.version,
    });
  }

  private toolIdentity(item: Obj): {
    name: string | undefined;
    mcpServer: string | undefined;
    input: JsonValue | undefined;
  } {
    const t = getStr(item, "type");
    if (t === "command_execution") {
      return { name: "command_execution", mcpServer: undefined, input: get(item, "command") };
    }
    if (t === "mcp_tool_call") {
      return {
        name: getNonEmptyStr(item, "tool"),
        mcpServer: getNonEmptyStr(item, "server"),
        input: get(item, "arguments"),
      };
    }
    const tool = getStr(item, "tool");
    return {
      name: tool !== undefined && COLLAB_TOOLS.has(tool) ? tool : getNonEmptyStr(item, "tool"),
      mcpServer: undefined,
      input: {
        prompt: get(item, "prompt") ?? null,
        receivers: get(item, "receiver_thread_ids") ?? null,
      },
    };
  }

  private itemStarted(out: Out, rec: FramedRecord, val: Obj): void {
    const item = getObj(val, "item");
    const t = item === undefined ? undefined : getStr(item, "type");
    if (item === undefined || t === undefined) {
      this.unknown(out, rec, val, "item.started", "/item", "unmapped-field");
      return;
    }
    if (!TOOL_ITEMS.has(t)) {
      // agent_message/reasoning suppress started; web_search/todo_list started carry no result
      out.dispositions.push({ sourceSequence: rec.sourceSequence, kind: "control", into: null });
      return;
    }
    const id = getNonEmptyStr(item, "id");
    const who = this.toolIdentity(item);
    this.requested(out, {
      id,
      name: who.name,
      mcpServer: who.mcpServer,
      input: who.input,
      ts: NO_TS,
      pointer: "/item",
      attrs: {},
    });
    if (id !== undefined) this.remember(out, id, who.name ?? "");
  }

  private itemCompleted(out: Out, rec: FramedRecord, val: Obj): void {
    const seq = rec.sourceSequence;
    const item = getObj(val, "item");
    const t = item === undefined ? undefined : getStr(item, "type");
    if (item === undefined || t === undefined) {
      this.unknown(out, rec, val, "item.completed", "/item", "unmapped-field");
      return;
    }
    switch (t) {
      case "agent_message": {
        const text = get(item, "text");
        if (typeof text === "string")
          this.message(
            out,
            rec,
            val,
            text,
            "assistant",
            "text",
            { role: "agent", key: "root" },
            NO_TS,
            "/item/text",
            {},
          );
        else this.unknown(out, rec, val, "item.agent_message", "/item", "unmapped-field");
        break;
      }
      case "reasoning": {
        const text = get(item, "text");
        if (typeof text === "string")
          this.message(
            out,
            rec,
            val,
            text,
            "assistant",
            "reasoning",
            { role: "agent", key: "root" },
            NO_TS,
            "/item/text",
            {},
          );
        else this.unknown(out, rec, val, "item.reasoning", "/item", "unmapped-field");
        break;
      }
      case "error": {
        const m = get(item, "message");
        if (typeof m === "string")
          this.message(
            out,
            rec,
            val,
            m,
            "system",
            "notification",
            RUNTIME,
            NO_TS,
            "/item/message",
            {},
          );
        else this.unknown(out, rec, val, "item.error", "/item", "unmapped-field");
        break;
      }
      case "command_execution":
      case "mcp_tool_call":
      case "collab_tool_call":
        this.toolCompleted(out, item, t);
        break;
      case "file_change": {
        const changes = get(item, "changes");
        const st = getStr(item, "status");
        const status = st === "completed" ? "success" : st === "failed" ? "failure" : "unknown";
        if (!isArr(changes)) {
          this.unknown(out, rec, val, "item.file_change", "/item/changes", "unmapped-field");
          break;
        }
        const list = changes.slice(0, MAX_FANOUT + 1).flatMap((c, i) =>
          isObj(c) && typeof get(c, "path") === "string"
            ? [
                {
                  path: getStr(c, "path") ?? "",
                  kind: getStr(c, "kind") ?? "unknown",
                  diff: undefined,
                  pointer: `/item/changes/${i}`,
                },
              ]
            : [],
        );
        if (list.length === 0)
          out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        else this.fileChanges(out, rec, list, status, undefined, NO_TS);
        break;
      }
      case "web_search": {
        const id = getNonEmptyStr(item, "id");
        this.requested(out, {
          id,
          name: "web_search",
          input: { query: get(item, "query") ?? null, action: get(item, "action") ?? null },
          ts: NO_TS,
          pointer: "/item",
          attrs: {},
        });
        this.result(out, {
          id,
          name: "web_search",
          outcome: "unknown",
          output: get(item, "results"),
          ts: NO_TS,
          pointer: "/item/results",
          attrs: {},
        });
        break;
      }
      case "todo_list":
        out.dispositions.push({ sourceSequence: seq, kind: "metadata", into: null });
        break;
      default:
        this.unknown(out, rec, val, `item.${t}`, "/item");
    }
  }

  /** The request is synthesized only when no item.started was seen; its fields are in this record. */
  private toolCompleted(out: Out, item: Obj, t: string): void {
    const id = getNonEmptyStr(item, "id");
    const who = this.toolIdentity(item);
    const seen = id !== undefined && this.calls.has(id);
    if (!seen) {
      this.requested(out, {
        id,
        name: who.name,
        mcpServer: who.mcpServer,
        input: who.input,
        ts: NO_TS,
        pointer: "/item",
        attrs: {},
      });
      if (id !== undefined) this.remember(out, id, who.name ?? "");
    }
    const st = getStr(item, "status");
    let outcome: "success" | "unknown" | "failure" | "denied" = "unknown";
    let exitCode: number | undefined;
    let output: JsonValue | undefined;
    if (t === "command_execution") {
      const code = get(item, "exit_code");
      if (typeof code === "number" && Number.isSafeInteger(code)) exitCode = code + 0;
      const agg = get(item, "aggregated_output");
      output = typeof agg === "string" ? agg : undefined;
      if (st === "completed")
        outcome = exitCode === undefined ? "unknown" : exitCode === 0 ? "success" : "failure";
      else if (st === "failed") outcome = "failure";
      else if (st === "declined") outcome = "denied";
    } else {
      const err = get(item, "error");
      const res = get(item, "result");
      output = isObj(err) ? err : res;
      if (st === "failed" || isObj(err)) outcome = "failure";
      else if (st === "completed") outcome = "success";
    }
    this.result(out, {
      id,
      name: who.name ?? null,
      outcome,
      exitCode,
      output,
      ts: NO_TS,
      pointer: "/item",
      attrs: {},
    });
  }
}

const NO = (reason: string): DetectResult => ({
  verdict: "no-match",
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [reason],
});

/**
 * An exec stream is made only of the documented dotted event types (plus a bare `error`), has
 * no timestamps and no `payload` envelope. At least one dotted `thread.*`/`turn.*`/`item.*`
 * record is required; any other shape vetoes the match.
 */
export function detectExec(sample: readonly FramedRecord[]): DetectResult {
  let strong = false;
  let sid: string | null = null;
  let parsed = 0;
  for (const rec of sample) {
    if (!rec.parse.ok) continue;
    const v = rec.parse.value;
    // stray non-object lines are tolerated; they never count as evidence
    if (!isObj(v)) continue;
    parsed++;
    if (
      Object.hasOwn(v, "payload") ||
      Object.hasOwn(v, "session_id") ||
      Object.hasOwn(v, "sessionId")
    ) {
      return NO("foreign-shape");
    }
    const type = getStr(v, "type");
    if (type === undefined) continue;
    // a closed vocabulary: a non-dotted type other than a bare `error` is some other format
    if (!type.includes(".") && type !== "error") return NO("non-exec-type");
    if (!EXEC_TYPES.has(type)) continue;
    if (type === "thread.started" && getNonEmptyStr(v, "thread_id") !== undefined) {
      strong = true;
      sid = sid ?? bound(getStr(v, "thread_id") ?? "");
    } else if (
      type.startsWith("item.") &&
      isObj(get(v, "item")) &&
      typeof get(getObj(v, "item") ?? {}, "type") === "string"
    ) {
      strong = true;
    } else if (type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
      strong = true;
    }
  }
  if (parsed === 0) return NO("no-parseable-record");
  if (!strong) return NO("no-exec-signal");
  return {
    verdict: "match",
    providerVersionSeen: null,
    nativeSessionId: sid,
    reasons: ["exec-shape"],
  };
}

/**
 * Capabilities follow the matrix cells that list `codex-cli.exec-jsonl`, minus anything this
 * adapter does not map: llmMetadata unknown (no model id in exec events), subagents unknown
 * (collab calls are mapped as plain tool calls, no agent.* events), timestamps unknown.
 */
export const execAdapter: SourceAdapter = {
  manifest: {
    id: "codex-cli.exec-jsonl",
    adapterVersion: "0.1.0",
    provider: "codex-cli",
    sourceKind: "codex-cli.exec-jsonl",
    sourceStability: "documented-interface",
    captureModes: ["import-file"],
    testedProviderVersions: [],
    capabilities: {
      sessionLifecycle: "partial",
      toolCallInputs: "partial",
      toolCallOutputs: "partial",
      llmMetadata: "unknown",
      filePatches: "partial",
      subagents: "unknown",
      permissions: "partial",
      failures: "partial",
      timestamps: "unknown",
      tokens: "partial",
    },
    framing: { kind: "jsonl" },
    experimental: false,
    attributeKeys: EXEC_ATTRIBUTE_KEYS,
  },
  detect: detectExec,
  createParser(ctx: ParseContext): RecordParser {
    return new ExecParser(ctx);
  },
};

export const execRegistration: AdapterRegistration = {
  adapter: execAdapter,
  discovery: { roots: [], fileNamePattern: "^.+\\.(?:jsonl|ndjson)$" },
};
