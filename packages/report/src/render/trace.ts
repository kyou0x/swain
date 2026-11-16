import type { CanonicalEvent, ContentRef, EvtId } from "@swain/core";
import { escapeHtmlText } from "../escape.js";
import type { Part, RenderOptions } from "../types.js";
import { isShellTool } from "./actions.js";
import { contentPart, count, data, eventTimeText, maskFree, text } from "./common.js";
import { esc, evtLink, num, partsHtml } from "./html-util.js";
import {
  pairTools,
  protectedActors,
  type ToolResult,
  type ToolStatus,
  timeMs,
  toolDurationMs,
  toolStatus,
} from "./pairing.js";

/** The trace covers at most this many events (the first ones in order); a static notice says so. */
export const TRACE_MAX_EVENTS = 5000;
const PROMPT_EXCERPT_CHARS = 160;
/** Waterfall resolution: offset classes o0..o50 and width classes w1..w50, 2 percent per step. */
export const BAR_STEPS = 50;
/** Subagents nest at most this deep; deeper agents are listed flat inside the deepest allowed one. */
export const TRACE_MAX_AGENT_DEPTH = 16;

export const NOTICE_TRACE_HASH_ONLY =
  "Prompts and outputs are hidden because this session was imported with hash-only content retention. Re-import with: swain import --include-content --reimport <path> to see them.";
export const NOTICE_TRACE_TRUNCATED_PREFIX = "Trace truncated: showing the first";
export const NOTICE_TRACE_PAIRING =
  "Tool calls whose result lies beyond the cut-off show as no result recorded.";
export const NOTICE_TRACE_DEPTH =
  "Subagent nesting is deeper than 16 levels; deeper subagents and their events are shown inside the 16th level.";
export const NOTICE_TRACE_INFERRED = "paired by turn order (no decides link)";

type Ev<K extends CanonicalEvent["kind"]> = Extract<CanonicalEvent, { kind: K }>;

export type { ToolStatus };

export interface PermissionEntry {
  readonly requested: Ev<"permission.requested"> | null;
  readonly decisions: Ev<"permission.decided">[];
  /** Decisions attached by turn order because no `decides` link resolved; labelled as such. */
  readonly inferred: EvtId[];
}

export interface Bar {
  /** Offset class index 0..50 and width class index 1..50, both in 2 percent steps. */
  readonly offset: number;
  readonly width: number;
}

export interface ToolStep {
  readonly type: "tool";
  readonly request: Ev<"tool.requested"> | null;
  readonly result: ToolResult | null;
  readonly status: ToolStatus;
  readonly toolName: string;
  readonly durationMs: number | null;
  readonly permissions: PermissionEntry[];
  readonly files: Ev<"file.changed">[];
  readonly bar: Bar | null;
}
export interface PermissionStep {
  readonly type: "permission";
  readonly entry: PermissionEntry;
}
export interface EventStep {
  readonly type: "message" | "usage" | "warning" | "file";
  readonly event: CanonicalEvent;
}
export interface AgentStep {
  readonly type: "agent";
  readonly started: Ev<"agent.started">;
  ended: Ev<"agent.ended"> | null;
  /** 1 for a top-level subagent; never above TRACE_MAX_AGENT_DEPTH. */
  readonly depth: number;
  readonly steps: TraceStep[];
}
export type TraceStep = ToolStep | PermissionStep | EventStep | AgentStep;

export interface PromptEntry {
  readonly eventId: EvtId;
  readonly time: string;
  readonly ref: ContentRef;
  readonly viaMessage: boolean;
}

export interface TraceGroup {
  /** 1-based turn number in event order; 0 for the group outside any turn. */
  readonly index: number;
  readonly outside: boolean;
  readonly startTime: string | null;
  readonly durationMs: number | null;
  readonly prompts: PromptEntry[];
  readonly toolCalls: number;
  readonly failedTools: number;
  readonly filesChanged: number;
  readonly messages: number;
  readonly endStatus: string | null;
  readonly steps: TraceStep[];
}

export interface ToolUsageRow {
  readonly toolName: string;
  readonly calls: number;
  readonly succeeded: number;
  readonly completedUnknown: number;
  readonly failed: number;
  readonly noResult: number;
}

export interface TraceModel {
  readonly groups: TraceGroup[];
  readonly usage: ToolUsageRow[];
  /** True when subagent nesting was capped at TRACE_MAX_AGENT_DEPTH. */
  readonly nestingCapped: boolean;
}

export function quantize(startMs: number, endMs: number, t0: number, range: number): Bar {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const offset = clamp(Math.floor(((startMs - t0) / range) * BAR_STEPS), 0, BAR_STEPS - 1);
  const width = clamp(
    Math.round((Math.max(0, endMs - startMs) / range) * BAR_STEPS),
    1,
    BAR_STEPS - offset,
  );
  return { offset, width };
}

/**
 * Pure trace model from events in display order. Pairing uses the `result-of` link and falls back to
 * an equal non-null toolCallId; permission and file events attach by toolCallId. O(n) after grouping.
 */
export function buildTrace(events: readonly CanonicalEvent[]): TraceModel {
  let nestingCapped = false;
  const { reqByCall, resultFor, claimed } = pairTools(events);
  const protectedIds = protectedActors(events);

  // Permissions and file changes.
  const permByReq = new Map<EvtId, PermissionEntry>();
  const permTool = new Map<PermissionEntry, EvtId>();
  const permsOfTool = new Map<EvtId, PermissionEntry[]>();
  const open = new Map<string | null, PermissionEntry>();
  const decidedEntry = new Map<EvtId, PermissionEntry>();
  const filesOfTool = new Map<EvtId, Ev<"file.changed">[]>();
  const consumed = new Set<EvtId>();
  for (const e of events) {
    if (e.kind === "permission.requested") {
      const entry: PermissionEntry = { requested: e, decisions: [], inferred: [] };
      permByReq.set(e.eventId, entry);
      open.set(e.turnId, entry);
      const c = e.payload.toolCallId;
      const req = c === null ? undefined : reqByCall.get(c);
      if (req !== undefined) {
        permTool.set(entry, req);
        consumed.add(e.eventId);
        const list = permsOfTool.get(req) ?? [];
        list.push(entry);
        permsOfTool.set(req, list);
      }
    } else if (e.kind === "permission.decided") {
      let entry: PermissionEntry | undefined;
      for (const l of e.links) {
        if (l.rel === "decides") {
          entry = permByReq.get(l.target);
          if (entry !== undefined) break;
        }
      }
      let inferred = false;
      if (entry === undefined) {
        entry = open.get(e.turnId);
        inferred = entry !== undefined;
      }
      if (entry !== undefined) {
        entry.decisions.push(e);
        if (inferred) entry.inferred.push(e.eventId);
        decidedEntry.set(e.eventId, entry);
        consumed.add(e.eventId);
        if (open.get(e.turnId) === entry) open.delete(e.turnId);
      }
    } else if (e.kind === "file.changed") {
      const c = e.payload.viaToolCallId;
      const req = c === null ? undefined : reqByCall.get(c);
      if (req !== undefined) {
        consumed.add(e.eventId);
        const list = filesOfTool.get(req) ?? [];
        list.push(e);
        filesOfTool.set(req, list);
      }
    }
  }

  // Group by turn in event order; events outside any turn form the last group.
  const byTurn = new Map<string, CanonicalEvent[]>();
  const outsideEvents: CanonicalEvent[] = [];
  for (const e of events) {
    if (e.turnId === null) {
      outsideEvents.push(e);
      continue;
    }
    const list = byTurn.get(e.turnId);
    if (list === undefined) byTurn.set(e.turnId, [e]);
    else list.push(e);
  }

  const usage = new Map<
    string,
    { calls: number; ok: number; unknown: number; bad: number; none: number }
  >();
  const tally = (s: ToolStep): void => {
    const u = usage.get(s.toolName) ?? { calls: 0, ok: 0, unknown: 0, bad: 0, none: 0 };
    u.calls++;
    if (s.status === "none") u.none++;
    else if (s.status === "ok") u.ok++;
    else if (s.status === "unknown") u.unknown++;
    else u.bad++;
    usage.set(s.toolName, u);
  };

  const buildGroup = (evs: readonly CanonicalEvent[], index: number, outside: boolean) => {
    let t0 = Number.POSITIVE_INFINITY;
    let t1 = Number.NEGATIVE_INFINITY;
    for (const e of evs) {
      const ms = timeMs(e);
      if (ms === null) continue;
      if (ms < t0) t0 = ms;
      if (ms > t1) t1 = ms;
    }
    const hasRange = t1 > t0;
    const durationMs = !outside && hasRange ? t1 - t0 : null;

    const steps: TraceStep[] = [];
    const prompts: PromptEntry[] = [];
    let toolCalls = 0;
    let failedTools = 0;
    let filesChanged = 0;
    let messages = 0;
    let endStatus: string | null = null;
    let startTime: string | null = null;
    const agents = new Map<string, AgentStep>();
    /** Agents beyond the depth cap: their events go to `container`; `step` is their flat leaf. */
    const capped = new Map<string, { container: AgentStep; step: AgentStep }>();

    for (const e of evs) {
      if (startTime === null && e.time.status === "valid" && e.time.value !== null) {
        startTime = e.time.value;
      }
      let parent: AgentStep | undefined;
      if (e.kind !== "agent.started" || e.payload.agentActorId !== e.actor.actorId) {
        parent = agents.get(e.actor.actorId) ?? capped.get(e.actor.actorId)?.container;
      }
      const container = parent?.steps ?? steps;
      switch (e.kind) {
        case "turn.started":
          if (e.payload.prompt !== null && !prompts.some((p) => !p.viaMessage)) {
            prompts.unshift({
              eventId: e.eventId,
              time: eventTimeText(e),
              ref: e.payload.prompt,
              viaMessage: false,
            });
          }
          break;
        case "turn.ended":
          endStatus = e.status;
          break;
        case "message.observed":
          messages++;
          if (e.payload.role === "user" && e.payload.channel === "text") {
            prompts.push({
              eventId: e.eventId,
              time: eventTimeText(e),
              ref: e.payload.content,
              viaMessage: true,
            });
          }
          container.push({ type: "message", event: e });
          break;
        case "model.usage":
          container.push({ type: "usage", event: e });
          break;
        case "capture.gap":
        case "source.unknown":
          container.push({ type: "warning", event: e });
          break;
        case "file.changed":
          if (!consumed.has(e.eventId)) {
            filesChanged++;
            container.push({ type: "file", event: e });
          }
          break;
        case "permission.requested": {
          const entry = permByReq.get(e.eventId);
          if (entry !== undefined && !permTool.has(entry)) {
            container.push({ type: "permission", entry });
          }
          break;
        }
        case "permission.decided":
          if (!decidedEntry.has(e.eventId)) {
            container.push({
              type: "permission",
              entry: { requested: null, decisions: [e], inferred: [] },
            });
          }
          break;
        case "tool.requested":
        case "tool.completed":
        case "tool.failed": {
          let request: Ev<"tool.requested"> | null = null;
          let result: ToolResult | null = null;
          if (e.kind === "tool.requested") {
            request = e;
            result = resultFor.get(e.eventId) ?? null;
          } else if (claimed.has(e.eventId)) {
            break;
          } else {
            result = e;
          }
          const files = request === null ? [] : (filesOfTool.get(request.eventId) ?? []);
          const startMs = timeMs(request ?? e);
          const resultMs = result === null ? null : timeMs(result);
          const dur = toolDurationMs(startMs, resultMs, result);
          let bar: Bar | null = null;
          if (hasRange && startMs !== null) {
            const endMs = resultMs !== null ? resultMs : startMs + (dur ?? 0);
            bar = quantize(startMs, endMs, t0, t1 - t0);
          }
          const step: ToolStep = {
            type: "tool",
            request,
            result,
            status: toolStatus(result),
            toolName: request?.payload.toolName ?? result?.payload.toolName ?? "(unnamed)",
            durationMs: dur,
            permissions: request === null ? [] : (permsOfTool.get(request.eventId) ?? []),
            files,
            bar,
          };
          if (request !== null) toolCalls++;
          if (result?.kind === "tool.failed") failedTools++;
          filesChanged += files.length;
          tally(step);
          container.push(step);
          break;
        }
        case "agent.started": {
          const depth = (parent?.depth ?? 0) + 1;
          const id = e.payload.agentActorId;
          if (protectedIds.has(id)) {
            // A start naming the main or a user actor never claims it: listed, never registered.
            container.push({ type: "agent", started: e, ended: null, depth, steps: [] });
            break;
          }
          if (parent !== undefined && depth > TRACE_MAX_AGENT_DEPTH) {
            // Listed as a leaf at the cap; its own events stay in the deepest allowed container.
            const step: AgentStep = {
              type: "agent",
              started: e,
              ended: null,
              depth: parent.depth,
              steps: [],
            };
            if (!agents.has(id) && !capped.has(id)) capped.set(id, { container: parent, step });
            nestingCapped = true;
            container.push(step);
            break;
          }
          const step: AgentStep = { type: "agent", started: e, ended: null, depth, steps: [] };
          if (!agents.has(id) && !capped.has(id)) agents.set(id, step);
          container.push(step);
          break;
        }
        case "agent.ended": {
          const step =
            agents.get(e.payload.agentActorId) ?? capped.get(e.payload.agentActorId)?.step;
          if (step !== undefined) {
            step.ended = e;
            agents.delete(e.payload.agentActorId);
            capped.delete(e.payload.agentActorId);
          } else {
            container.push({ type: "warning", event: e });
          }
          break;
        }
        case "session.started":
        case "session.ended":
          break;
      }
    }
    if (prompts.some((p) => !p.viaMessage)) {
      prompts.splice(0, prompts.length, ...prompts.filter((p) => !p.viaMessage));
    }
    const group: TraceGroup = {
      index,
      outside,
      startTime,
      durationMs,
      prompts,
      toolCalls,
      failedTools,
      filesChanged,
      messages,
      endStatus,
      steps,
    };
    return group;
  };

  const groups: TraceGroup[] = [];
  let i = 0;
  for (const evs of byTurn.values()) groups.push(buildGroup(evs, ++i, false));
  const outside = buildGroup(outsideEvents, 0, true);
  if (outside.steps.length > 0) groups.push(outside);

  const rows: ToolUsageRow[] = [...usage.entries()]
    .map(([toolName, u]) => ({
      toolName,
      calls: u.calls,
      succeeded: u.ok,
      completedUnknown: u.unknown,
      failed: u.bad,
      noResult: u.none,
    }))
    .sort(
      (a, b) =>
        b.calls - a.calls || (a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0),
    );
  return { groups, usage: rows, nestingCapped };
}

// ---- stylesheet (static: depends on no data) --------------------------------------------------

export function traceStyle(): string[] {
  const offsets: string[] = [];
  const widths: string[] = [];
  for (let k = 0; k < BAR_STEPS; k++) offsets.push(`.o${k}{left:${k * 2}%}`);
  for (let k = 1; k <= BAR_STEPS; k++) widths.push(`.w${k}{width:${k * 2}%}`);
  return [offsets.join(""), widths.join("")];
}

/** Every tool step by the ids of its request and result events, nested agents included. */
export function toolStepsById(model: TraceModel): Map<EvtId, ToolStep> {
  const out = new Map<EvtId, ToolStep>();
  const walk = (steps: readonly TraceStep[]): void => {
    for (const s of steps) {
      if (s.type === "tool") {
        if (s.request !== null) out.set(s.request.eventId, s);
        if (s.result !== null) out.set(s.result.eventId, s);
      } else if (s.type === "agent") walk(s.steps);
    }
  };
  for (const g of model.groups) walk(g.steps);
  return out;
}

// ---- HTML -------------------------------------------------------------------------------------

export interface TraceRenderInfo {
  readonly hashOnly: boolean;
  /** Number of events the trace covers (after the timeline and trace caps). */
  readonly covered: number;
  /** Number of events in the session. */
  readonly total: number;
}

const BADGE_CLASS: Readonly<Record<ToolStatus, string>> = {
  ok: "b-ok",
  unknown: "b-warn",
  failed: "b-bad",
  denied: "b-bad",
  interrupted: "b-bad",
  none: "b-warn",
};

function statusLabel(s: ToolStep): Part[] {
  switch (s.status) {
    case "ok":
      return [text("ok")];
    case "unknown":
      return [text("completed, status unknown")];
    case "denied":
      return [text("denied")];
    case "interrupted":
      return [text("interrupted")];
    case "none":
      return [text("no result recorded")];
    case "failed":
      return [
        text("failed ("),
        data(s.result?.kind === "tool.failed" ? s.result.payload.errorClass : "unknown"),
        text(")"),
      ];
  }
}

/** Bar track colour classes come from this closed mapping only. */
function barClass(s: ToolStep): string {
  if (s.status === "failed" || s.status === "denied" || s.status === "interrupted") return " bad";
  if (s.status === "none") return " nr";
  return isShellTool(s.toolName) ? " k-command" : " k-tool";
}

function barHtml(s: ToolStep): string {
  const b = s.bar;
  if (b === null) return '<span class="wf"></span>';
  return `<span class="wf"><span class="bar o${num(b.offset)} w${num(b.width)}${barClass(s)}"></span></span>`;
}

export function renderTrace(
  model: TraceModel,
  info: TraceRenderInfo,
  o: RenderOptions,
  anchors: ReadonlySet<string>,
): string {
  const P = (parts: readonly Part[]): string => partsHtml(parts, o);
  const mask = (s: string): string => maskFree(s, o);
  const link = (id: string): string => evtLink(id, anchors);
  const out: string[] = [];

  if (info.hashOnly)
    out.push(`<ul class="notice"><li>${escapeHtmlText(NOTICE_TRACE_HASH_ONLY)}</li></ul>`);
  if (info.covered < info.total) {
    out.push(
      `<p class="dim">${NOTICE_TRACE_TRUNCATED_PREFIX} ${num(info.covered)} of ${num(info.total)} events. ${NOTICE_TRACE_PAIRING}</p>`,
    );
  }
  if (model.nestingCapped) out.push(`<p class="dim">${escapeHtmlText(NOTICE_TRACE_DEPTH)}</p>`);

  const label = (g: TraceGroup): string =>
    g.outside ? "Session (outside turns)" : `Turn ${num(g.index)}`;
  const promptParts = (p: PromptEntry, max: number): Part[] =>
    contentPart("prompt", p.ref, "", max, mask);

  out.push("<h3>What you asked</h3>");
  const asked = model.groups.filter((g) => g.prompts.length > 0 || !g.outside);
  if (asked.length === 0) {
    out.push('<p class="dim">No turns or user messages in this trace.</p>');
  } else {
    out.push('<ol class="prompts">');
    for (const g of asked) {
      const head = `<a href="#turn-${num(g.index)}">${label(g)}</a>`;
      if (g.prompts.length === 0) {
        out.push(`<li>${head}: <span class="dim">no prompt recorded</span></li>`);
      }
      for (const p of g.prompts) {
        out.push(
          `<li>${head} (${esc(p.time, o)}${p.viaMessage ? ", user message" : ""}): ${P(promptParts(p, PROMPT_EXCERPT_CHARS))} ${link(p.eventId)}</li>`,
        );
      }
    }
    out.push("</ol>");
  }

  const contentLine = (name: string, ref: ContentRef | null): string =>
    ref === null ? "" : `<li>${P(contentPart(name, ref, "", undefined, mask))}</li>`;

  const ind = (depth: number): string => num(Math.min(depth, TRACE_MAX_AGENT_DEPTH));
  /** A tree line without a bar: the label spans the name column. */
  const row = (depth: number, inner: string): string =>
    `<div class="wr"><div class="wn i${ind(depth)}">${inner}</div><div class="wb"></div><div class="wd"></div></div>`;

  const stepHtml = (s: TraceStep, depth: number): string => {
    switch (s.type) {
      case "tool": {
        const req = s.request;
        const ns =
          req === null
            ? ""
            : ` (${P([data(req.payload.toolNamespace)])}${req.payload.mcpServer === undefined ? "" : `, server ${P([data(req.payload.mcpServer)])}`})`;
        const exit =
          s.result?.payload.exitCode === undefined
            ? ""
            : `, exit code ${num(s.result.payload.exitCode)}`;
        const orphan = req === null ? ' <span class="b-warn">result without request</span>' : "";
        const ids = [req?.eventId, s.result?.eventId].filter((x): x is EvtId => x !== undefined);
        const details: string[] = [];
        if (req !== null) details.push(contentLine("input", req.payload.input));
        if (s.result?.kind === "tool.completed")
          details.push(contentLine("output", s.result.payload.output));
        if (s.result?.kind === "tool.failed")
          details.push(contentLine("error", s.result.payload.error));
        for (const pe of s.permissions) details.push(`<li>${permissionHtml(pe)}</li>`);
        for (const f of s.files) {
          details.push(`<li>${P(fileParts(f))} ${link(f.eventId)}</li>`);
        }
        const kc = isShellTool(s.toolName) ? "k-command" : "k-tool";
        return `<li><div class="wr"><div class="wn i${ind(depth)}"><span class="tg ${kc}">Tool</span> <code>${P([data(s.toolName)])}</code>${ns} <span class="${BADGE_CLASS[s.status]}">${P(statusLabel(s))}</span>${exit}${orphan} ${ids.map(link).join(" ")}</div><div class="wb">${barHtml(s)}</div><div class="wd">${s.durationMs === null ? "" : `${num(s.durationMs)} ms`}</div></div><details><summary>Input, output, permissions, file changes</summary><ul>${details.join("")}</ul></details></li>`;
      }
      case "permission":
        return `<li>${row(depth, `<span class="tg k-system">Permission</span> ${permissionHtml(s.entry)}`)}</li>`;
      case "message": {
        const e = s.event;
        if (e.kind !== "message.observed") return "";
        const reasoning = e.payload.channel === "reasoning";
        return `<li>${row(depth, `<span class="tg k-assistant">Message</span> ${P([text(reasoning ? "provider-exposed reasoning, role " : `${e.payload.channel}, role `), data(e.payload.role), ...contentPart("content", e.payload.content, " ", undefined, mask)])} ${link(e.eventId)}`)}</li>`;
      }
      case "usage": {
        const e = s.event;
        if (e.kind !== "model.usage") return "";
        const p = e.payload;
        const bits: Part[] = [
          text("scope "),
          data(p.scope),
          text(", model "),
          data(p.model ?? "(unspecified)"),
        ];
        for (const [name, v] of [
          ["input", p.inputTokens],
          ["output", p.outputTokens],
          ["total", p.totalTokens],
        ] as const) {
          if (v !== undefined) bits.push(text(`, ${name} tokens `), count(v));
        }
        return `<li>${row(depth, `<span class="dim">Usage (this event only, not summed): ${P(bits)}</span> ${link(e.eventId)}`)}</li>`;
      }
      case "warning": {
        const e = s.event;
        const desc =
          e.kind === "capture.gap"
            ? P([text("capture gap "), data(e.payload.reason), text(": "), data(e.payload.detail)])
            : e.kind === "source.unknown"
              ? P([
                  text("unrecognized record, native type "),
                  data(e.payload.nativeType ?? "(none)"),
                ])
              : P([text("agent ended without a matching start")]);
        return `<li>${row(depth, `<span class="tg b-warn">Warning</span> ${desc} ${link(e.eventId)}`)}</li>`;
      }
      case "file": {
        const e = s.event;
        if (e.kind !== "file.changed") return "";
        return `<li>${row(depth, `<span class="tg k-system">File</span> ${P(fileParts(e))} ${link(e.eventId)}`)}</li>`;
      }
      case "agent": {
        const st = s.started;
        const inner = s.steps.map((x) => stepHtml(x, depth + 1)).join("");
        const end =
          s.ended === null
            ? '<span class="b-warn">no end recorded</span>'
            : `ended ${link(s.ended.eventId)}`;
        return `<li>${row(depth, `<span class="tg k-subagent">Subagent</span> ${P([data(st.payload.agentType ?? "(untyped)")])} ${link(st.eventId)} ${end}`)}<ol class="trace sub">${inner}</ol></li>`;
      }
    }
  };

  const permissionHtml = (pe: PermissionEntry): string => {
    const parts: string[] = [];
    if (pe.requested !== null) {
      parts.push(
        `${P([text("requested for "), data(pe.requested.payload.toolName ?? "(unnamed)")])} ${link(pe.requested.eventId)}`,
      );
    }
    for (const d of pe.decisions) {
      parts.push(
        `${P([text("decision "), data(d.payload.decision), text(" by "), data(d.payload.decidedBy), ...contentPart("reason", d.payload.reason, " ", undefined, mask)])}${pe.inferred.includes(d.eventId) ? ` <span class="b-warn">${escapeHtmlText(NOTICE_TRACE_INFERRED)}</span>` : ""} ${link(d.eventId)}`,
      );
    }
    return parts.join("; ");
  };

  for (const g of model.groups) {
    const prompt = g.prompts[0];
    const head: string[] = [`<span class="tg k-user">${label(g)}</span>`];
    if (prompt !== undefined && !g.outside) {
      head.push(`<span class="pr">${P(promptParts(prompt, PROMPT_EXCERPT_CHARS))}</span>`);
    }
    const bits: string[] = [];
    if (g.startTime !== null) bits.push(`started ${esc(g.startTime, o)}`);
    if (g.durationMs !== null) bits.push(`duration ${num(g.durationMs)} ms`);
    bits.push(
      `tool requests ${num(g.toolCalls)}`,
      `failed ${num(g.failedTools)}`,
      `files ${num(g.filesChanged)}`,
      `messages ${num(g.messages)}`,
    );
    if (!g.outside)
      bits.push(`status ${g.endStatus === null ? "(no turn.ended)" : esc(g.endStatus, o)}`);
    const dur = g.durationMs;
    const axis =
      dur === null
        ? ""
        : `<div class="wr axis"><div class="wn">ms from the first event of the turn</div><div class="wb ticks">${[0, 1, 2, 3, 4].map((k) => `<span>${num(Math.round((dur * k) / 4))}</span>`).join("")}</div><div class="wd"></div></div>`;
    out.push(
      `<details class="wturn" open><summary>${head.join(" ")} <span class="meta">${bits.join(" | ")}</span></summary>${axis}<ol class="trace">${g.steps.map((s) => stepHtml(s, 0)).join("")}</ol></details>`,
    );
  }

  out.push("<h3>Tool usage</h3>");
  if (model.usage.length === 0) {
    out.push('<p class="dim">No tool calls in this trace.</p>');
  } else {
    out.push(
      '<div class="scroll"><table><thead><tr><th>Tool</th><th>Requests</th><th>Succeeded</th><th>Completed, status unknown</th><th>Failed</th><th>No result recorded</th></tr></thead><tbody>',
    );
    for (const r of model.usage) {
      out.push(
        `<tr><td>${esc(r.toolName, o)}</td><td>${num(r.calls)}</td><td>${num(r.succeeded)}</td><td>${num(r.completedUnknown)}</td><td>${num(r.failed)}</td><td>${num(r.noResult)}</td></tr>`,
      );
    }
    out.push("</tbody></table></div>");
  }
  return out.join("\n");
}

function fileParts(e: Ev<"file.changed">): Part[] {
  return [
    text("file "),
    data(e.payload.path),
    text(", change kind "),
    data(e.payload.changeKind),
    text(`, status ${e.status === "success" || e.status === "failure" ? e.status : "unknown"}`),
  ];
}
