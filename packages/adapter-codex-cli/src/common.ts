import type {
  ActorRole,
  Attributes,
  Completeness,
  FacetCompleteness,
  FramedRecord,
  JsonValue,
  ParseContext,
} from "@swain/core";
import {
  bound,
  draft,
  get,
  getStr,
  isArr,
  isObj,
  makeRef,
  type Obj,
  type Out,
  refJson,
  safeInt,
  type TimeInfo,
  unknownDraft,
  utf8Len,
  versionOrNull,
  warn,
} from "./util.js";

/** Who performed an observed action. Keys follow ADR-0002 section 4. */
export interface Who {
  readonly role: ActorRole;
  readonly key: string;
}
export const AGENT: Who = { role: "agent", key: "root" };
export const USER: Who = { role: "user", key: "user" };
export const RUNTIME: Who = { role: "runtime", key: "runtime" };

export const MAX_FANOUT = 100;

/** Names the Codex tool specs define (FORMAT-codex 2.4). Everything else is namespace unknown. */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "exec_command",
  "write_stdin",
  "shell_command",
  "shell",
  "apply_patch",
  "update_plan",
  "view_image",
  "spawn_agent",
  "wait_agent",
  "send_message",
  "followup_task",
  "interrupt_agent",
  "list_agents",
  "tool_search",
  "request_permissions",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_mcp_resource_templates",
  "exec",
  "network_access",
]);

export interface ToolReq {
  readonly name: string;
}

export type Outcome = "success" | "unknown" | "failure" | "denied";

export interface UsageFields {
  readonly fields: Record<string, number>;
  readonly bad: boolean;
  readonly allZero: boolean;
}

/** Cumulative counters are reported as given and never summed (SPEC-002 M-18). */
export function usageFields(u: Obj, withTotal: boolean): UsageFields | null {
  const mapping: (readonly [string, string])[] = [
    ["input_tokens", "inputTokens"],
    ["cached_input_tokens", "cachedInputTokens"],
    ["cache_write_input_tokens", "cacheWriteInputTokens"],
    ["output_tokens", "outputTokens"],
    ["reasoning_output_tokens", "reasoningOutputTokens"],
  ];
  if (withTotal) mapping.push(["total_tokens", "totalTokens"]);
  const fields: Record<string, number> = {};
  let bad = false;
  for (const [src, dst] of mapping) {
    if (!Object.hasOwn(u, src)) continue;
    const n = safeInt(u[src]);
    if (n === undefined) bad = true;
    else fields[dst] = n;
  }
  const vals = Object.values(fields);
  if (vals.length === 0) return null;
  return { fields, bad, allZero: vals.every((x) => x === 0) };
}

export class Base {
  protected version: string | null;
  protected readonly ctx: ParseContext;
  protected readonly calls = new Map<string, ToolReq>();
  private capWarned = false;

  constructor(ctx: ParseContext) {
    this.ctx = ctx;
    this.version = versionOrNull(ctx.providerVersionSeen);
  }

  protected remember(out: Out, id: string, name: string): void {
    if (this.calls.size < this.ctx.bounds.maxOpenCorrelations || this.calls.has(id)) {
      this.calls.set(id, { name });
    } else if (!this.capWarned) {
      this.capWarned = true;
      out.warnings.push(
        warn("bounds-reached", null, { limit: this.ctx.bounds.maxOpenCorrelations }),
      );
    }
  }

  protected unknown(
    out: Out,
    rec: FramedRecord,
    val: JsonValue,
    nativeType: string | null,
    pointer: string | null,
    code: "unknown-record-type" | "unmapped-field" = "unknown-record-type",
  ): void {
    out.drafts.push(unknownDraft(rec, val, nativeType, pointer, this.version));
    out.warnings.push(warn(code, rec.sourceSequence));
  }

  protected unmapped(out: Out, seq: number, val: Obj, known: ReadonlySet<string>): void {
    let n = 0;
    for (const k of Object.keys(val)) if (!known.has(k)) n++;
    if (n > 0) out.warnings.push(warn("unmapped-field", seq, { fieldCount: n }, "info"));
  }

  /** Returns the SHA-256 of the content, or null when no event was emitted. */
  protected message(
    out: Out,
    rec: FramedRecord,
    val: JsonValue,
    value: JsonValue,
    role: "user" | "assistant" | "system",
    channel: "text" | "reasoning" | "notification",
    who: Who,
    ts: TimeInfo,
    pointer: string,
    attrs: Attributes,
  ): string | null {
    const r = makeRef(this.ctx, value);
    if (r.ref === null) {
      this.unknown(out, rec, val, null, pointer, "unmapped-field");
      return null;
    }
    out.drafts.push(
      draft({
        kind: "message.observed",
        status: "none",
        payload: { role, channel, content: refJson(r.ref) },
        role: who.role,
        actorKey: who.key,
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
    return r.ref.sha256;
  }

  protected requested(
    out: Out,
    o: {
      id: string | undefined;
      name: string | undefined;
      mcpServer?: string | undefined;
      input: JsonValue | undefined;
      inputPartial?: boolean;
      ts: TimeInfo;
      pointer: string;
      attrs: Attributes;
    },
  ): void {
    const ref = o.input === undefined ? undefined : makeRef(this.ctx, o.input);
    const name = o.name === undefined || o.name.length === 0 ? "unknown" : bound(o.name);
    const mcp = o.mcpServer !== undefined && o.mcpServer.length > 0;
    const ns = mcp
      ? "mcp"
      : o.name !== undefined && BUILTIN_TOOLS.has(o.name)
        ? "builtin"
        : "unknown";
    const payload: { [key: string]: JsonValue } = {
      toolCallId: o.id ?? null,
      toolName: name,
      toolNamespace: ns,
      input: ref === undefined ? null : refJson(ref.ref),
    };
    if (mcp && o.mcpServer !== undefined) payload["mcpServer"] = bound(o.mcpServer);
    const inputs: FacetCompleteness =
      ref === undefined
        ? { state: "absent", reason: "missing-in-record" }
        : ref.partial || o.inputPartial === true || ref.ref === null
          ? { state: "partial", reason: "malformed-value" }
          : { state: "captured" };
    out.drafts.push(
      draft({
        kind: "tool.requested",
        status: "none",
        payload,
        role: AGENT.role,
        actorKey: AGENT.key,
        ts: o.ts,
        pointer: o.pointer,
        providerVersion: this.version,
        attrs: o.attrs,
        facets: { inputs, outputs: { state: "unavailable" } },
        ...(o.id === undefined ? {} : { anchor: o.id }),
      }),
    );
  }

  protected result(
    out: Out,
    o: {
      id: string | undefined;
      name: string | null;
      outcome: Outcome;
      exitCode?: number | undefined;
      output: JsonValue | undefined;
      ts: TimeInfo;
      pointer: string;
      attrs: Attributes;
    },
  ): void {
    const r = o.output === undefined ? undefined : makeRef(this.ctx, o.output);
    const outputs: FacetCompleteness =
      o.output === undefined
        ? { state: "absent", reason: "missing-in-record" }
        : r === undefined || r.partial || r.ref === null
          ? { state: "partial", reason: "malformed-value" }
          : { state: "captured" };
    const facets: Completeness = {
      inputs: { state: "unavailable" },
      outputs,
      ...(o.id === undefined ? {} : { causality: { state: "captured" as const } }),
    };
    const base = {
      role: AGENT.role,
      actorKey: AGENT.key,
      ts: o.ts,
      pointer: o.pointer,
      providerVersion: this.version,
      attrs: o.attrs,
      facets,
      ...(o.id === undefined ? {} : { refs: [{ rel: "result-of" as const, key: o.id }] }),
    };
    const common: { [key: string]: JsonValue } = {
      toolCallId: o.id ?? null,
      toolName: o.name === null ? null : bound(o.name),
    };
    if (o.exitCode !== undefined) common["exitCode"] = o.exitCode;
    if (o.outcome === "success" || o.outcome === "unknown") {
      out.drafts.push(
        draft({
          ...base,
          kind: "tool.completed",
          status: o.outcome,
          payload: { ...common, output: r === undefined ? null : refJson(r.ref) },
        }),
      );
      return;
    }
    const denied = o.outcome === "denied";
    out.drafts.push(
      draft({
        ...base,
        kind: "tool.failed",
        status: denied ? "denied" : "failure",
        payload: {
          ...common,
          output: null,
          error: denied || r === undefined ? null : refJson(r.ref),
          errorClass: denied ? "declined" : "error",
        },
      }),
    );
  }

  /** One `file.changed` per provider-reported change. Never derived from a request. */
  protected fileChanges(
    out: Out,
    rec: FramedRecord,
    changes: readonly {
      path: string;
      kind: string;
      diff: JsonValue | undefined;
      pointer: string;
    }[],
    status: "success" | "failure" | "unknown",
    via: string | undefined,
    ts: TimeInfo,
  ): void {
    for (const c of changes.slice(0, MAX_FANOUT)) {
      if (c.path.length === 0 || c.path.includes("\u0000") || utf8Len(c.path) > 4096) {
        out.warnings.push(warn("unmapped-field", rec.sourceSequence, { fieldCount: 1 }, "info"));
        continue;
      }
      const diff = c.diff === undefined ? undefined : makeRef(this.ctx, c.diff);
      out.drafts.push(
        draft({
          kind: "file.changed",
          status,
          payload: {
            path: c.path,
            changeKind:
              c.kind === "add" || c.kind === "delete" || c.kind === "update" ? c.kind : "unknown",
            diff: diff === undefined ? null : refJson(diff.ref),
            viaToolCallId: via !== undefined && this.calls.has(via) ? via : null,
            basis: "provider-reported",
          },
          role: AGENT.role,
          actorKey: AGENT.key,
          ts,
          pointer: c.pointer,
          providerVersion: this.version,
        }),
      );
    }
    if (changes.length > MAX_FANOUT) {
      out.warnings.push(
        warn("bounds-reached", rec.sourceSequence, { limit: MAX_FANOUT, seen: changes.length }),
      );
    }
  }

  protected usage(
    out: Out,
    scope: "session" | "turn",
    model: string | null,
    u: UsageFields,
    ts: TimeInfo,
    pointer: string,
    attrs: Attributes,
    suspectZero: boolean,
  ): void {
    out.drafts.push(
      draft({
        kind: "model.usage",
        status: "none",
        payload: { scope, model, ...u.fields },
        role: RUNTIME.role,
        actorKey: RUNTIME.key,
        ts,
        pointer,
        providerVersion: this.version,
        attrs,
        facets: {
          model:
            model === null
              ? { state: "absent", reason: "missing-in-record" }
              : { state: "captured" },
          tokens: u.bad
            ? { state: "partial", reason: "malformed-value" }
            : suspectZero && u.allZero
              ? { state: "partial", reason: "missing-in-record" }
              : { state: "captured" },
        },
      }),
    );
  }
}

/** Text of an array of `{type, text}` items whose type is in `types`, joined by LF. */
export function joinText(
  items: JsonValue | undefined,
  types: ReadonlySet<string>,
): string | undefined {
  if (!isArr(items)) return undefined;
  const parts: string[] = [];
  for (const it of items) {
    if (isObj(it)) {
      const t = getStr(it, "type");
      const text = get(it, "text");
      if (t !== undefined && types.has(t) && typeof text === "string") parts.push(text);
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

/** Exit code from the model-facing header convention (FORMAT-codex 2.4); never from free text elsewhere. */
export function exitCodeFromHeader(output: JsonValue | undefined): number | undefined {
  let text: string | undefined;
  if (typeof output === "string") text = output;
  else text = joinText(output, new Set(["input_text", "output_text", "text"]));
  if (text === undefined) return undefined;
  const head = text.split("\n", 8);
  for (const line of head) {
    const m = /^(?:Process exited with code|Exit code:) (-?\d{1,6})$/.exec(line.trimEnd());
    if (m?.[1] !== undefined) return Number(m[1]) + 0;
  }
  return undefined;
}
