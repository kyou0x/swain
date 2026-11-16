/**
 * `opencode.session-export` mapping. Source semantics: docs/research/FORMAT-opencode.md
 * (opencode v1.19.5 source, never checked against a real export).
 *
 * Record 0 is the envelope (`{info}`, the document without `/messages`); records 1..N are the
 * `{info, parts}` elements. Each element is mapped on push; there is no folding.
 */
import type {
  AdapterOutput,
  AdapterWarning,
  Attributes,
  Completeness,
  DraftEvent,
  EventTime,
  FramedRecord,
  JsonValue,
  ParseContext,
  RecordParser,
} from "@swain/core";
import {
  boundedId,
  count,
  epochTime,
  facets,
  isArr,
  isObj,
  mk,
  nativeKey,
  type Obj,
  own,
  ownStr,
  ptr,
  Refs,
  refJson,
  truncBytes,
  Unmapped,
  unknownDraft,
  utf8Len,
} from "./util.js";

export const PART_TYPES = [
  "text",
  "subtask",
  "reasoning",
  "file",
  "tool",
  "step-start",
  "step-finish",
  "snapshot",
  "patch",
  "agent",
  "retry",
  "compaction",
] as const;

const TOOL_STATUSES = ["pending", "running", "completed", "error"] as const;
const ERROR_NAMES = [
  "ProviderAuthError",
  "UnknownError",
  "MessageOutputLengthError",
  "MessageAbortedError",
  "StructuredOutputError",
  "ContextOverflowError",
  "ContentFilterError",
  "APIError",
] as const;
const FINISH_REASONS = ["stop", "tool-calls", "length", "content-filter", "error", "unknown"];

/** Builtin ids from research section 6. Anything else (MCP, plugins) is `unknown`. */
const BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "apply_patch",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "task",
  "todowrite",
  "skill",
  "question",
  "lsp",
  "invalid",
]);

const VERSION = /^[!-~]{1,64}$/;

export function sessionVersion(info: JsonValue | undefined): string | null {
  const v = isObj(info) ? own(info, "version") : undefined;
  return typeof v === "string" && VERSION.test(v) ? v : null;
}

function closed(v: string | undefined, set: readonly string[]): string | null {
  if (v === undefined) return null;
  return set.includes(v) ? v : "other";
}

function validPath(p: JsonValue | undefined): string | null {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return null;
  if (!p.isWellFormed() || p.includes("\u0000") || utf8Len(p) > 4096) return null;
  return p;
}

interface TimeAt {
  readonly time: EventTime;
  /** True when a message-level time stands in for a part with no time of its own. */
  readonly fallback: boolean;
}

function atOr(raw: JsonValue | undefined, fallback: EventTime): TimeAt {
  return raw === undefined
    ? { time: fallback, fallback: true }
    : { time: epochTime(raw), fallback: false };
}

function timeFacets(t: TimeAt, actor: "user" | "unknown" | "runtime", extra: Completeness = {}) {
  const base = facets(
    t.time,
    actor === "unknown" ? { state: "unknown" } : { state: "captured" },
    extra,
  );
  if (t.fallback) {
    return { ...base, timestamp: { state: "partial", reason: "missing-in-record" } as const };
  }
  return base;
}

interface Msg {
  readonly seq: number;
  readonly sha: string;
  readonly role: "user" | "assistant";
  readonly info: Obj;
  readonly created: EventTime;
  readonly completed: EventTime | null;
}

export class OpenCodeParser implements RecordParser {
  readonly #ctx: ParseContext;
  readonly #version: string | null;
  readonly #refs: Refs;
  readonly #unmapped = new Unmapped();
  readonly #warnings: AdapterWarning[] = [];

  constructor(ctx: ParseContext) {
    this.#ctx = ctx;
    this.#version = ctx.providerVersionSeen;
    this.#refs = new Refs(ctx);
  }

  push(record: FramedRecord): AdapterOutput {
    if (!record.parse.ok) return { drafts: [], warnings: [] };
    const before = this.#warnings.length;
    const v = record.parse.value;
    let drafts: DraftEvent[];
    let dispositions: AdapterOutput["dispositions"];
    if (record.sourceSequence === 0) {
      drafts = this.#envelope(record, v);
    } else {
      const r = this.#element(record, v);
      drafts = r.drafts;
      dispositions = r.dispositions;
    }
    const cap = this.#ctx.bounds.maxDraftsPerRecord;
    if (drafts.length > cap) {
      this.#warnings.push({
        code: "bounds-reached",
        severity: "warn",
        sourceSequence: record.sourceSequence,
        detail: { reasonCode: "oc.drafts-capped", limit: cap },
      });
      drafts = drafts.slice(0, cap);
    }
    const warnings = this.#warnings.splice(before);
    return dispositions === undefined ? { drafts, warnings } : { drafts, warnings, dispositions };
  }

  end(): AdapterOutput {
    const warnings: AdapterWarning[] = [];
    for (const [code, n] of this.#unmapped.entries()) {
      warnings.push({
        code: "unmapped-field",
        severity: "info",
        sourceSequence: null,
        detail: { fieldCode: code, occurrences: n },
      });
    }
    return { drafts: [], warnings };
  }

  #unknown(
    record: FramedRecord,
    v: JsonValue,
    nativeType: string | null,
    pointer: string,
    time: EventTime = epochTime(undefined),
  ): DraftEvent {
    this.#warnings.push({
      code: "unknown-record-type",
      severity: "warn",
      sourceSequence: record.sourceSequence,
      detail: { reasonCode: "oc.unknown-shape" },
    });
    return unknownDraft(v, nativeType, record.sha256, {
      time,
      role: "unknown",
      actorKey: "root",
      order: record.sourceSequence,
      evidence: record.sourceSequence,
      pointer,
      version: this.#version,
    });
  }

  // ---- envelope

  #envelope(record: FramedRecord, v: JsonValue): DraftEvent[] {
    const info = isObj(v) ? own(v, "info") : undefined;
    if (!isObj(v) || !isObj(info)) return [this.#unknown(record, v, null, "")];
    const times = isObj(own(info, "time")) ? (own(info, "time") as Obj) : undefined;
    const created = epochTime(times === undefined ? undefined : own(times, "created"));
    const out: DraftEvent[] = [];
    const cwd = own(info, "directory");
    const attrs: Attributes =
      typeof cwd === "string" && cwd.isWellFormed() && utf8Len(cwd) <= 256
        ? { "opencode.cwd": cwd }
        : {};
    const sid = boundedId(own(info, "id"));
    out.push(
      mk(
        "session.started",
        "none",
        { nativeSessionId: sid, trigger: "unknown" },
        {
          time: created,
          role: "runtime",
          actorKey: "runtime",
          order: 0,
          evidence: 0,
          pointer: "/info",
          version: this.#version,
          nativeSessionId: sid,
          attributes: attrs,
          completeness: facets(created, { state: "captured" }),
        },
      ),
    );
    // Session totals are cumulative as reported (M-18): scope "session".
    const tokens = own(info, "tokens");
    const cost = own(info, "cost");
    if (isObj(tokens) || typeof cost === "number") {
      const updated = epochTime(times === undefined ? undefined : own(times, "updated"));
      const model = own(info, "model");
      const modelId = isObj(model) ? ownStr(model, "id") : undefined;
      const u = this.#usagePayload("session", modelId, isObj(tokens) ? tokens : undefined, cost);
      out.push(
        mk("model.usage", "none", u.payload, {
          time: updated.status === "missing" ? created : updated,
          role: "runtime",
          actorKey: "runtime",
          order: 0,
          evidence: 0,
          pointer: isObj(tokens) ? "/info/tokens" : "/info/cost",
          version: this.#version,
          completeness: facets(
            updated,
            { state: "captured" },
            {
              model: u.model
                ? { state: "captured" }
                : { state: "absent", reason: "missing-in-record" },
              tokens: u.tokens
                ? { state: "captured" }
                : { state: "absent", reason: "missing-in-record" },
            },
          ),
        }),
      );
    }
    for (const k of [
      "slug",
      "projectID",
      "workspaceID",
      "path",
      "parentID",
      "summary",
      "share",
      "title",
      "agent",
      "metadata",
      "permission",
      "revert",
    ]) {
      if (Object.hasOwn(info, k)) {
        this.#unmapped.note("oc.session-info-fields");
        break;
      }
    }
    return out;
  }

  #usagePayload(
    scope: "message" | "session",
    model: string | undefined,
    t: Obj | undefined,
    cost: JsonValue | undefined,
  ): { payload: { [key: string]: JsonValue }; model: boolean; tokens: boolean } {
    const payload: { [key: string]: JsonValue } = {
      scope,
      model: model === undefined ? null : truncBytes(model, 256),
    };
    let tokens = false;
    const put = (k: string, v: JsonValue | undefined): void => {
      const n = count(v);
      if (n !== undefined) {
        payload[k] = n;
        tokens = true;
      }
    };
    if (t !== undefined) {
      put("inputTokens", own(t, "input"));
      put("outputTokens", own(t, "output"));
      put("reasoningOutputTokens", own(t, "reasoning"));
      put("totalTokens", own(t, "total"));
      const cache = own(t, "cache");
      if (isObj(cache)) {
        put("cachedInputTokens", own(cache, "read"));
        put("cacheWriteInputTokens", own(cache, "write"));
      }
    }
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      payload["costUsdEstimate"] = cost;
    }
    return { payload, model: model !== undefined, tokens };
  }

  // ---- elements

  #element(
    record: FramedRecord,
    v: JsonValue,
  ): { drafts: DraftEvent[]; dispositions?: AdapterOutput["dispositions"] } {
    const info = isObj(v) ? own(v, "info") : undefined;
    const role = isObj(info) ? ownStr(info, "role") : undefined;
    if (!isObj(v) || !isObj(info) || (role !== "user" && role !== "assistant")) {
      return { drafts: [this.#unknown(record, v, role ?? null, "")] };
    }
    const times = isObj(own(info, "time")) ? (own(info, "time") as Obj) : undefined;
    const created = epochTime(times === undefined ? undefined : own(times, "created"));
    const completedRaw = times === undefined ? undefined : own(times, "completed");
    const msg: Msg = {
      seq: record.sourceSequence,
      sha: record.sha256,
      role,
      info,
      created,
      completed: completedRaw === undefined ? null : epochTime(completedRaw),
    };
    const partsRaw = own(v, "parts");
    if (!isArr(partsRaw)) return { drafts: [this.#unknown(record, v, role, "/parts")] };
    const parts = partsRaw;
    for (const k of [
      "system",
      "tools",
      "format",
      "summary",
      "path",
      "mode",
      "structured",
      "variant",
      "finish",
      "parentID",
    ]) {
      if (Object.hasOwn(info, k)) {
        this.#unmapped.note("oc.message-fields");
        break;
      }
    }

    const out: DraftEvent[] = [];
    const patchPaths = new Set<string>();
    parts.forEach((p) => {
      if (isObj(p) && ownStr(p, "type") === "patch") {
        const files = own(p, "files");
        if (isArr(files))
          for (const f of files) if (validPath(f) !== null) patchPaths.add(f as string);
      }
    });

    if (role === "user") this.#userTurn(msg, parts, out);
    let sawStepFinish = false;
    parts.forEach((p, i) => {
      const pointer = ptr("parts", i);
      if (!isObj(p)) {
        out.push(this.#unknown(record, p, null, pointer, created));
        return;
      }
      const type = ownStr(p, "type");
      if (type === "step-finish") sawStepFinish = true;
      if (type === undefined || !(PART_TYPES as readonly string[]).includes(type)) {
        out.push(this.#unknown(record, p, type ?? null, pointer, created));
        return;
      }
      this.#part(msg, p, type as (typeof PART_TYPES)[number], pointer, patchPaths, out);
    });

    if (role === "assistant") {
      const err = own(info, "error");
      if (isObj(err)) {
        const t = atOr(completedRaw, created);
        const r = this.#refs.make(err);
        if (r !== null) {
          out.push(
            this.#notice(msg, r, "/info/error", t, {
              ...this.#attr("opencode.error_name", closed(ownStr(err, "name"), ERROR_NAMES)),
            }),
          );
        }
      }
      if (!sawStepFinish) {
        const tk = own(info, "tokens");
        const cost = own(info, "cost");
        if (isObj(tk) || typeof cost === "number") {
          out.push(
            this.#usage(
              msg,
              isObj(tk) ? tk : undefined,
              cost,
              isObj(tk) ? "/info/tokens" : "/info/cost",
              undefined,
            ),
          );
        }
      }
    }

    if (out.length === 0) {
      return { drafts: [], dispositions: [{ sourceSequence: msg.seq, kind: "metadata", into: 0 }] };
    }
    return { drafts: out };
  }

  #attr(key: string, value: string | null): Attributes {
    return value === null ? {} : { [key]: value };
  }

  #userTurn(msg: Msg, parts: readonly JsonValue[], out: DraftEvent[]): void {
    const texts: string[] = [];
    let first = -1;
    parts.forEach((p, i) => {
      if (
        isObj(p) &&
        ownStr(p, "type") === "text" &&
        own(p, "synthetic") !== true &&
        own(p, "ignored") !== true
      ) {
        const t = own(p, "text");
        if (typeof t === "string") {
          if (first < 0) first = i;
          texts.push(t);
        }
      }
    });
    const prompt = texts.length === 0 ? null : this.#refs.make(texts.join("\n"));
    const t: TimeAt = { time: msg.created, fallback: false };
    out.push(
      mk(
        "turn.started",
        "none",
        { prompt: refJson(prompt) },
        {
          time: msg.created,
          role: "user",
          actorKey: "user",
          order: msg.seq,
          evidence: msg.seq,
          pointer: first < 0 ? "/info" : ptr("parts", first),
          version: this.#version,
          completeness: timeFacets(
            t,
            "user",
            prompt === null
              ? { content: { state: "absent", reason: "missing-in-record" } }
              : { content: { state: "captured" } },
          ),
        },
      ),
    );
  }

  #notice(
    msg: Msg,
    content: NonNullable<ReturnType<Refs["make"]>>,
    pointer: string,
    t: TimeAt,
    attributes: Attributes,
  ): DraftEvent {
    return mk(
      "message.observed",
      "none",
      { role: "system", channel: "notification", content: refJson(content) },
      {
        time: t.time,
        role: "runtime",
        actorKey: "runtime",
        order: msg.seq,
        evidence: msg.seq,
        pointer,
        version: this.#version,
        attributes,
        completeness: timeFacets(t, "runtime", {
          content: { state: "captured" },
          internalReasoning: { state: "unavailable", reason: "provider-does-not-expose" },
        }),
      },
    );
  }

  #usage(
    msg: Msg,
    tokens: Obj | undefined,
    cost: JsonValue | undefined,
    pointer: string,
    reason: string | undefined,
  ): DraftEvent {
    const modelId = ownStr(msg.info, "modelID");
    const u = this.#usagePayload("message", modelId, tokens, cost);
    const at = msg.completed ?? msg.created;
    const t: TimeAt = { time: at, fallback: false };
    return mk("model.usage", "none", u.payload, {
      time: at,
      role: "agent",
      actorKey: "root",
      order: msg.seq,
      evidence: msg.seq,
      pointer,
      version: this.#version,
      attributes: this.#attr(
        "opencode.finish_reason",
        reason === undefined ? null : closed(reason, FINISH_REASONS),
      ),
      completeness: timeFacets(t, "unknown", {
        model: u.model ? { state: "captured" } : { state: "absent", reason: "missing-in-record" },
        tokens: u.tokens ? { state: "captured" } : { state: "absent", reason: "missing-in-record" },
      }),
    });
  }

  #part(
    msg: Msg,
    p: Obj,
    type: (typeof PART_TYPES)[number],
    pointer: string,
    patchPaths: ReadonlySet<string>,
    out: DraftEvent[],
  ): void {
    const ptime = isObj(own(p, "time")) ? (own(p, "time") as Obj) : undefined;
    const attr = (extra: Attributes = {}): Attributes => ({ "opencode.part_type": type, ...extra });
    switch (type) {
      case "text":
      case "reasoning": {
        if (type === "text" && msg.role === "user") return; // carried by turn.started
        const text = own(p, "text");
        if (typeof text !== "string") {
          out.push(this.#malformed(msg, p, pointer));
          return;
        }
        const r = this.#refs.make(text);
        if (r === null) return;
        const t = atOr(ptime === undefined ? undefined : own(ptime, "start"), msg.created);
        const flags: Attributes = {
          ...(own(p, "synthetic") === true ? { "opencode.synthetic": true } : {}),
          ...(own(p, "ignored") === true ? { "opencode.ignored": true } : {}),
        };
        out.push(
          mk(
            "message.observed",
            "none",
            {
              role: "assistant",
              channel: type === "text" ? "text" : "reasoning",
              content: refJson(r),
            },
            {
              time: t.time,
              role: "agent",
              actorKey: "root",
              order: msg.seq,
              evidence: msg.seq,
              pointer,
              version: this.#version,
              attributes: attr(flags),
              // `reasoning` is provider-exposed reasoning text, never hidden chain-of-thought.
              completeness: timeFacets(t, "unknown", {
                content: { state: "captured" },
                internalReasoning: { state: "unavailable", reason: "provider-does-not-expose" },
              }),
            },
          ),
        );
        return;
      }
      case "tool":
        this.#tool(msg, p, pointer, patchPaths, out);
        return;
      case "step-start":
        return; // step bracket only; carries a git tree hash we do not map
      case "step-finish": {
        out.push(
          this.#usage(
            msg,
            isObj(own(p, "tokens")) ? (own(p, "tokens") as Obj) : undefined,
            own(p, "cost"),
            pointer,
            ownStr(p, "reason"),
          ),
        );
        return;
      }
      case "patch": {
        const files = own(p, "files");
        if (!isArr(files)) {
          out.push(this.#malformed(msg, p, pointer));
          return;
        }
        const t: TimeAt = { time: msg.completed ?? msg.created, fallback: true };
        files.forEach((f, j) => {
          const path = validPath(f);
          if (path === null) return;
          out.push(
            mk(
              "file.changed",
              "success",
              {
                path,
                changeKind: "unknown",
                diff: null,
                viaToolCallId: null,
                basis: "provider-reported",
              },
              {
                time: t.time,
                role: "agent",
                actorKey: "root",
                order: msg.seq,
                evidence: msg.seq,
                pointer: `${pointer}/files/${j}`,
                version: this.#version,
                attributes: attr(),
                completeness: timeFacets(t, "unknown"),
              },
            ),
          );
        });
        return;
      }
      case "subtask": {
        const agent = ownStr(p, "agent");
        const key = nativeKey(own(p, "id")) ?? `subtask-${msg.seq}-${pointer}`;
        const t: TimeAt = { time: msg.created, fallback: true };
        // A subtask part records a delegation request; that the subagent ran is not observed here.
        out.push(
          mk(
            "agent.started",
            "none",
            {
              agentActorId: `native:${key}`,
              parentActorId: "root",
              agentType: agent === undefined ? null : truncBytes(agent, 256),
              spawnedByToolCallId: null,
            },
            {
              time: t.time,
              role: "subagent",
              actorKey: `native:${key}`,
              order: msg.seq,
              evidence: msg.seq,
              pointer,
              version: this.#version,
              attributes: attr(),
              completeness: timeFacets(t, "unknown"),
            },
          ),
        );
        return;
      }
      case "retry": {
        const err = own(p, "error");
        const r = this.#refs.make(isObj(err) ? err : p);
        if (r === null) return;
        const t = atOr(ptime === undefined ? undefined : own(ptime, "created"), msg.created);
        const attempt = count(own(p, "attempt"));
        out.push(
          this.#notice(
            msg,
            r,
            pointer,
            t,
            attr(attempt === undefined ? {} : { "opencode.retry_attempt": attempt }),
          ),
        );
        return;
      }
      case "compaction": {
        const r = this.#refs.make(p);
        if (r === null) return;
        const auto = own(p, "auto");
        const t: TimeAt = { time: msg.created, fallback: true };
        out.push(
          this.#notice(
            msg,
            r,
            pointer,
            t,
            attr(typeof auto === "boolean" ? { "opencode.compaction_auto": auto } : {}),
          ),
        );
        return;
      }
      case "file":
        this.#unmapped.note("oc.file-part");
        return;
      case "snapshot":
        this.#unmapped.note("oc.snapshot-part");
        return;
      case "agent":
        // An `@agent` mention is a request, not an observed agent start: not mapped (flagged).
        this.#unmapped.note("oc.agent-part");
        return;
    }
  }

  #malformed(msg: Msg, p: Obj, pointer: string): DraftEvent {
    this.#warnings.push({
      code: "unknown-record-type",
      severity: "warn",
      sourceSequence: msg.seq,
      detail: { reasonCode: "oc.malformed-part" },
    });
    const t = ownStr(p, "type");
    return unknownDraft(p, t ?? null, msg.sha, {
      time: msg.created,
      role: "unknown",
      actorKey: "root",
      order: msg.seq,
      evidence: msg.seq,
      pointer,
      version: this.#version,
    });
  }

  #tool(
    msg: Msg,
    p: Obj,
    pointer: string,
    patchPaths: ReadonlySet<string>,
    out: DraftEvent[],
  ): void {
    const tool = ownStr(p, "tool");
    if (tool === undefined) {
      out.push(this.#malformed(msg, p, pointer));
      return;
    }
    const callId = nativeKey(own(p, "callID"));
    const stateRaw = own(p, "state");
    const state = isObj(stateRaw) ? stateRaw : undefined;
    const status = state === undefined ? undefined : ownStr(state, "status");
    const times =
      state !== undefined && isObj(own(state, "time")) ? (own(state, "time") as Obj) : undefined;
    const startRaw = times === undefined ? undefined : own(times, "start");
    const endRaw = times === undefined ? undefined : own(times, "end");
    const input = state === undefined ? undefined : own(state, "input");
    const inRef = isObj(input) ? this.#refs.make(input) : null;
    const name = truncBytes(tool, 256);
    const stAttr = closed(status, TOOL_STATUSES);
    const attrs: Attributes = {
      "opencode.part_type": "tool",
      ...(stAttr === null ? {} : { "opencode.tool_status": stAttr }),
    };
    const rt = atOr(startRaw, msg.created);
    out.push(
      mk(
        "tool.requested",
        "none",
        {
          toolCallId: callId,
          toolName: name,
          toolNamespace: BUILTIN_TOOLS.has(tool) ? "builtin" : "unknown",
          input: refJson(inRef),
        },
        {
          time: rt.time,
          role: "agent",
          actorKey: "root",
          order: msg.seq,
          evidence: msg.seq,
          pointer,
          version: this.#version,
          attributes: attrs,
          ...(callId === null ? {} : { anchor: callId }),
          completeness: timeFacets(rt, "unknown", {
            inputs:
              inRef !== null
                ? { state: "captured" }
                : input === undefined
                  ? { state: "absent", reason: "missing-in-record" }
                  : { state: "partial", reason: "malformed-value" },
            outputs: { state: "unknown" },
          }),
        },
      ),
    );
    if (status !== "completed" && status !== "error") return; // pending/running: outcome not observed
    if (state === undefined) return;

    const et = atOr(endRaw, msg.created);
    const startMs = typeof startRaw === "number" ? startRaw : undefined;
    const endMs = typeof endRaw === "number" ? endRaw : undefined;
    const duration =
      startMs !== undefined &&
      endMs !== undefined &&
      Number.isSafeInteger(startMs) &&
      Number.isSafeInteger(endMs) &&
      endMs >= startMs
        ? endMs - startMs
        : undefined;
    const causality: Completeness =
      callId === null
        ? { causality: { state: "absent", reason: "correlation-missing" } }
        : { causality: { state: "captured" } };
    const base = {
      time: et.time,
      role: "agent" as const,
      actorKey: "root",
      order: msg.seq,
      evidence: msg.seq,
      version: this.#version,
      attributes: attrs,
      ...(callId === null ? {} : { resultOf: callId }),
    };
    const metadata = isObj(own(state, "metadata")) ? (own(state, "metadata") as Obj) : undefined;
    if (status === "completed") {
      const outText = own(state, "output");
      const outRef = typeof outText === "string" ? this.#refs.make(outText) : null;
      const exit = tool === "bash" && metadata !== undefined ? own(metadata, "exit") : undefined;
      const payload: { [key: string]: JsonValue } = {
        toolCallId: callId,
        toolName: name,
        output: refJson(outRef),
      };
      if (typeof exit === "number" && Number.isSafeInteger(exit) && !Object.is(exit, -0)) {
        payload["exitCode"] = exit;
      }
      if (duration !== undefined) payload["durationMs"] = duration;
      out.push(
        mk("tool.completed", "success", payload, {
          ...base,
          pointer: `${pointer}/state`,
          completeness: timeFacets(et, "unknown", {
            ...causality,
            inputs: { state: "unknown" },
            outputs:
              outRef !== null
                ? { state: "captured" }
                : { state: "absent", reason: "missing-in-record" },
          }),
        }),
      );
      this.#fileChanged(msg, tool, pointer, state, metadata, input, et, callId, patchPaths, out);
      return;
    }
    const errText = own(state, "error");
    const errRef = typeof errText === "string" ? this.#refs.make(errText) : null;
    const payload: { [key: string]: JsonValue } = {
      toolCallId: callId,
      toolName: name,
      output: null,
      error: refJson(errRef),
      errorClass: "error",
    };
    if (duration !== undefined) payload["durationMs"] = duration;
    out.push(
      mk("tool.failed", "failure", payload, {
        ...base,
        pointer: `${pointer}/state`,
        completeness: timeFacets(et, "unknown", {
          ...causality,
          inputs: { state: "unknown" },
          outputs:
            errRef !== null
              ? { state: "captured" }
              : { state: "absent", reason: "missing-in-record" },
        }),
      }),
    );
  }

  /** `file.changed` from a completed `write`/`edit` result; a `patch` part for the path wins. */
  #fileChanged(
    msg: Msg,
    tool: string,
    pointer: string,
    state: Obj,
    metadata: Obj | undefined,
    input: JsonValue | undefined,
    et: TimeAt,
    callId: string | null,
    patchPaths: ReadonlySet<string>,
    out: DraftEvent[],
  ): void {
    if (tool !== "write" && tool !== "edit") return;
    const fd = metadata === undefined ? undefined : own(metadata, "filediff");
    let path: string | null = null;
    let at = `${pointer}/state`;
    if (isObj(fd) && validPath(own(fd, "file")) !== null) {
      path = validPath(own(fd, "file"));
      at = `${pointer}/state/metadata/filediff/file`;
    } else if (isObj(input) && validPath(own(input, "filePath")) !== null) {
      path = validPath(own(input, "filePath"));
      at = `${pointer}/state/input/filePath`;
    }
    if (path === null || patchPaths.has(path)) return;
    let changeKind: "add" | "update" | "unknown" = tool === "edit" ? "update" : "unknown";
    if (tool === "write" && metadata !== undefined) {
      const ex = own(metadata, "exists");
      if (ex === true) changeKind = "update";
      else if (ex === false) changeKind = "add";
    }
    let diff: JsonValue = null;
    if (tool === "edit" && metadata !== undefined) {
      const patch = isObj(fd) ? own(fd, "patch") : undefined;
      const d = typeof patch === "string" ? patch : own(metadata, "diff");
      if (typeof d === "string") diff = refJson(this.#refs.make(d));
    }
    void state;
    out.push(
      mk(
        "file.changed",
        "success",
        { path, changeKind, diff, viaToolCallId: callId, basis: "derived-from-tool-result" },
        {
          time: et.time,
          role: "agent",
          actorKey: "root",
          order: msg.seq,
          evidence: msg.seq,
          pointer: at,
          version: this.#version,
          attributes: { "opencode.part_type": "tool", "opencode.tool_status": "completed" },
          completeness: timeFacets(et, "unknown"),
        },
      ),
    );
  }
}
