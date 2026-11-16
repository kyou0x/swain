import type { CanonicalEvent, ContentRef, EvtId } from "@swain/core";
import type { RenderOptions, SessionView } from "../types.js";
import {
  type ActionLog,
  type ActionRow,
  AGENT_CLASS_MAX,
  type AgentRef,
  agentPathText,
  attributeAgents,
  isShellTool,
  STATUS_TEXT,
} from "./actions.js";
import {
  eventTimeText,
  headerFacts,
  maskFree,
  provenanceText,
  RE_EVT,
  truncateCodePoints,
} from "./common.js";
import { esc, evtLink, num } from "./html-util.js";
import { maskEvent } from "./json.js";
import { timeMs } from "./pairing.js";
import { type ToolStep, TRACE_MAX_EVENTS, type TraceModel, toolStepsById } from "./trace.js";

/** The event stream and the detail blocks cover at most this many events (the trace's cap). */
export const STREAM_MAX_EVENTS = TRACE_MAX_EVENTS;
/** The minimap draws at most this many ticks, sampled evenly (failures are kept first). */
export const MINIMAP_MAX_TICKS = 2000;
/** Tick positions are quantized to classes x0..x199. */
export const MINIMAP_STEPS = 200;
/** One raw event is cut at this many code points. */
export const RAW_MAX_CHARS = 4096;
/** The turns list of the sidebar is cut at this many entries. */
export const SIDEBAR_MAX_TURNS = 200;
const SUMMARY_CHARS = 240;
/** Command and target text of a row summary is cut at this many code points, after masking. */
export const COMMAND_CHARS = 400;
/** Detail blocks stop being added once their running size passes this share of the output cap. */
export const DETAIL_BUDGET_MAX_BYTES = 8 * 1024 * 1024;
const VALUE_CHARS = 4096;

type Cat = "user" | "assistant" | "reasoning" | "tool" | "command" | "subagent" | "system";

/** Filter chips: id suffix, label, and the `f-` class an item carries. */
export const CHIPS = [
  ["user", "User"],
  ["assistant", "Assistant"],
  ["tool", "Tool"],
  ["command", "Command"],
  ["subagent", "Subagent"],
  ["error", "Error"],
] as const;
export const CATEGORIES = [
  "user",
  "assistant",
  "reasoning",
  "tool",
  "command",
  "subagent",
  "system",
] as const;

interface Item {
  readonly lead: CanonicalEvent;
  readonly second: CanonicalEvent | null;
  readonly cat: Cat;
  readonly label: string;
  readonly bad: boolean;
  readonly noResult: boolean;
  /** Agent class index 0..15. */
  readonly agent: number;
  readonly agentLabel: string;
  readonly row: ActionRow | null;
  readonly step: ToolStep | null;
}

interface TurnBlock {
  readonly index: number;
  readonly items: Item[];
  events: number;
}

const BAD_STATUS = new Set(["failure", "denied", "interrupted"]);

function categoryOf(e: CanonicalEvent, row: ActionRow | null): { cat: Cat; label: string } {
  switch (e.kind) {
    case "turn.started":
      return e.payload.prompt !== null
        ? { cat: "user", label: "user" }
        : { cat: "system", label: "turn" };
    case "turn.ended":
      return { cat: "system", label: "turn" };
    case "session.started":
    case "session.ended":
      return { cat: "system", label: "session" };
    case "message.observed":
      if (e.payload.channel === "reasoning") return { cat: "reasoning", label: "think" };
      if (e.payload.role === "user") return { cat: "user", label: "user" };
      if (e.payload.role === "assistant") return { cat: "assistant", label: "ai" };
      return { cat: "system", label: "msg" };
    case "tool.requested":
    case "tool.completed":
    case "tool.failed": {
      const shell = row !== null ? row.isCommand : isShellTool(e.payload.toolName ?? "");
      return shell ? { cat: "command", label: "cmd" } : { cat: "tool", label: "tool" };
    }
    case "agent.started":
    case "agent.ended":
      return { cat: "subagent", label: "agent" };
    case "file.changed":
      return { cat: "system", label: "file" };
    case "permission.requested":
    case "permission.decided":
      return { cat: "system", label: "perm" };
    case "model.usage":
      return { cat: "system", label: "usage" };
    case "capture.gap":
      return { cat: "system", label: "gap" };
    case "source.unknown":
      return { cat: "system", label: "unknown" };
  }
}

function isBad(e: CanonicalEvent, row: ActionRow | null): boolean {
  if (row !== null) {
    return row.status === "failed" || row.status === "denied" || row.status === "interrupted";
  }
  if (e.kind === "permission.decided") return e.payload.decision === "deny";
  return BAD_STATUS.has(e.status);
}

/** Stream items per turn, in event order, with each paired result folded into its request. */
function buildItems(
  events: readonly CanonicalEvent[],
  trace: TraceModel,
  log: ActionLog,
): { readonly turns: TurnBlock[]; readonly itemOf: ReadonlyMap<EvtId, Item> } {
  const attribution = attributeAgents(events);
  const rowOf = new Map<EvtId, ActionRow>();
  const claimed = new Set<EvtId>();
  for (const r of log.rows) {
    if (r.requestId !== null) {
      rowOf.set(r.requestId, r);
      if (r.resultId !== null) claimed.add(r.resultId);
    } else if (r.resultId !== null) rowOf.set(r.resultId, r);
  }
  const steps = toolStepsById(trace);
  const byTurn = new Map<string, TurnBlock>();
  const order: TurnBlock[] = [];
  const outside: TurnBlock = { index: 0, items: [], events: 0 };
  const itemOf = new Map<EvtId, Item>();
  const byId = new Map<EvtId, CanonicalEvent>();
  for (const e of events) byId.set(e.eventId, e);
  let next = 0;
  for (const e of events) {
    let block = outside;
    if (e.turnId !== null) {
      let b = byTurn.get(e.turnId);
      if (b === undefined) {
        b = { index: ++next, items: [], events: 0 };
        byTurn.set(e.turnId, b);
        order.push(b);
      }
      block = b;
    }
    block.events++;
    if (claimed.has(e.eventId)) continue; // shown inside its request row
    const isTool =
      e.kind === "tool.requested" || e.kind === "tool.completed" || e.kind === "tool.failed";
    const row = isTool ? (rowOf.get(e.eventId) ?? null) : null;
    const resultId = row?.resultId ?? null;
    const second =
      row !== null && row.requestId !== null && resultId !== null
        ? (byId.get(resultId) ?? null)
        : null;
    const ref: AgentRef | undefined = attribution.of.get(e.eventId);
    const { cat, label } = categoryOf(e, row);
    const item: Item = {
      lead: e,
      second,
      cat,
      label,
      bad: isBad(e, row),
      noResult: row !== null && row.status === "none",
      agent: Math.min(ref?.index ?? 0, AGENT_CLASS_MAX),
      agentLabel: ref?.label ?? "main",
      row,
      step: row === null ? null : (steps.get(e.eventId) ?? null),
    };
    block.items.push(item);
    itemOf.set(e.eventId, item);
    if (second !== null) itemOf.set(second.eventId, item);
  }
  if (outside.items.length > 0) order.push(outside);
  return { turns: order, itemOf };
}

// ---- helpers for text ---------------------------------------------------------------------------

function inlineOf(ref: ContentRef | null): string | null {
  return ref !== null && ref.inline !== undefined && ref.retention !== "hash-only"
    ? ref.inline
    : null;
}

/**
 * Plain one-line text of a content reference; hash-only stays hash-only. Home paths are masked
 * BEFORE the cut, so the cut can never expose part of one.
 */
function excerpt(ref: ContentRef | null, max: number, o: RenderOptions): string {
  if (ref === null) return "";
  const inline = inlineOf(ref);
  if (inline !== null) return truncateCodePoints(maskFree(inline, o), max);
  return `hash-only, ${Math.trunc(ref.byteLength)} bytes`;
}

/** Cut at `max` code points; `more` is the number of code points that were dropped. */
function cut(
  s: string,
  max: number,
): { readonly text: string; readonly cut: boolean; readonly more: number } {
  let n = 0;
  let end = 0;
  let at = -1;
  for (const ch of s) {
    if (n === max) at = end;
    n++;
    end += ch.length;
  }
  return at < 0
    ? { text: s, cut: false, more: 0 }
    : { text: s.slice(0, at), cut: true, more: n - max };
}

function truncMark(more: number): string {
  return `<span class="trunc">${num(more)} more characters truncated</span>`;
}

function clock(e: CanonicalEvent): string {
  if (e.time.status === "valid" && e.time.value !== null) {
    const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})/.exec(e.time.value);
    if (m?.[1] !== undefined) return m[1];
  }
  return eventTimeText(e);
}

function summaryOf(it: Item, o: RenderOptions): { readonly name: string; readonly text: string } {
  const e = it.lead;
  const r = it.row;
  switch (e.kind) {
    case "tool.requested":
    case "tool.completed":
    case "tool.failed": {
      const name = r?.toolName ?? e.payload.toolName ?? "(unnamed)";
      if (r === null) return { name, text: "" };
      const cutText = (t: string): string => truncateCodePoints(maskFree(t, o), COMMAND_CHARS);
      if (r.command !== null)
        return { name, text: r.command === "" ? "(empty command)" : cutText(r.command) };
      if (r.commandHiddenBytes !== null) {
        return {
          name,
          text: `command hidden (hash-only, ${Math.trunc(r.commandHiddenBytes)} bytes)`,
        };
      }
      return { name, text: r.target === null ? "" : cutText(r.target) };
    }
    case "turn.started":
      return {
        name: "",
        text:
          e.payload.prompt === null ? "(no prompt)" : excerpt(e.payload.prompt, SUMMARY_CHARS, o),
      };
    case "message.observed":
      return { name: "", text: excerpt(e.payload.content, SUMMARY_CHARS, o) };
    case "agent.started":
      return { name: "started", text: e.payload.agentType ?? "(untyped)" };
    case "agent.ended":
      return { name: "ended", text: "" };
    case "file.changed":
      return { name: e.payload.changeKind, text: e.payload.path };
    case "permission.requested":
      return { name: "requested", text: e.payload.toolName ?? "(unnamed)" };
    case "permission.decided":
      return { name: e.payload.decision, text: `by ${e.payload.decidedBy}` };
    case "model.usage":
      return {
        name: e.payload.scope,
        text: `${e.payload.model ?? "(unspecified)"}${e.payload.totalTokens === undefined ? "" : `, ${num(e.payload.totalTokens)} tokens`}`,
      };
    case "capture.gap":
      return { name: e.payload.reason, text: e.payload.detail };
    case "source.unknown":
      return { name: "unknown", text: e.payload.nativeType ?? "(none)" };
    case "session.started":
      return { name: "started", text: e.payload.trigger };
    case "session.ended":
      return { name: "ended", text: e.payload.reason };
    case "turn.ended":
      return { name: "ended", text: e.status };
  }
}

// ---- detail blocks ------------------------------------------------------------------------------

function contentValue(ref: ContentRef | null, o: RenderOptions): string {
  if (ref === null) return '<span class="dim">none</span>';
  const inline = inlineOf(ref);
  if (inline === null) {
    return `hash-only, ${num(ref.byteLength)} bytes, sha256 ${esc(truncateCodePoints(ref.sha256, 12), o)}`;
  }
  const c = cut(maskFree(inline, o), VALUE_CHARS);
  return `<code class="v">${esc(c.text, o)}</code>${c.cut ? truncMark(c.more) : ""}`;
}

/** Plain data with object keys in code point order, so the raw block never depends on key order. */
function sortedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    // Defence in depth: a hash-only content reference never carries inline text into the block.
    const hashOnly = rec["retention"] === "hash-only";
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(rec).sort()) {
      if (hashOnly && k === "inline") continue;
      out[k] = sortedKeys(rec[k]);
    }
    return out;
  }
  return v;
}

function rawEvent(e: CanonicalEvent, o: RenderOptions): string {
  let json: string;
  try {
    json = JSON.stringify(sortedKeys(maskEvent(e, o)), null, 2);
  } catch {
    json = "(event could not be serialized)";
  }
  // Mask the whole serialized text, then cut, then escape each line (L1 stays inside its line).
  const c = cut(maskFree(json, o), RAW_MAX_CHARS);
  const lines = c.text
    .split("\n")
    .map((l) => `<span class="rl">${esc(l, o)}</span>`)
    .join("");
  return `<div class="raw"><code>${lines}</code>${c.cut ? truncMark(c.more) : ""}</div>`;
}

const STATUS_CLASS: Readonly<Record<string, string>> = {
  ok: "",
  unknown: " warn",
  failed: " bad",
  denied: " bad",
  interrupted: " bad",
  none: " warn",
};

function toolCallOf(e: CanonicalEvent): string | null {
  return e.kind === "tool.requested" || e.kind === "tool.completed" || e.kind === "tool.failed"
    ? e.payload.toolCallId
    : null;
}

function detailHtml(it: Item, o: RenderOptions, anchors: ReadonlySet<string>): string {
  const e = it.lead;
  const kv: string[] = [];
  const add = (k: string, v: string): void => {
    kv.push(`<dt>${k}</dt><dd>${v}</dd>`);
  };
  const t = (s: string): string => esc(s, o);
  const links = (ids: readonly string[]): string => ids.map((id) => evtLink(id, anchors)).join(" ");

  add("Kind", t(it.second === null ? e.kind : `${e.kind} + ${it.second.kind}`));
  const r = it.row;
  if (r !== null) {
    const req = e.kind === "tool.requested" ? e : null;
    add(
      "Tool",
      t(
        `${r.toolName}${req === null ? "" : ` (${req.payload.toolNamespace}${req.payload.mcpServer === undefined ? "" : `, server ${req.payload.mcpServer}`})`}`,
      ),
    );
  }
  add("Thread", t(r === null ? it.agentLabel : agentPathText(r)));
  if (r !== null) {
    const failedClass =
      it.second?.kind === "tool.failed"
        ? it.second.payload.errorClass
        : e.kind === "tool.failed"
          ? e.payload.errorClass
          : null;
    add(
      "Status",
      `<span class="st${STATUS_CLASS[r.status] ?? ""}">${STATUS_TEXT[r.status]}</span>${failedClass === null ? "" : ` (${t(failedClass)})`}`,
    );
    if (r.exitCode !== null) add("Exit", num(r.exitCode));
    if (r.durationMs !== null) add("Duration", `${num(r.durationMs)} ms`);
  } else if (e.status !== "none") {
    add(
      "Status",
      `<span class="st${BAD_STATUS.has(e.status) ? " bad" : ""}">${t(e.status)}</span>`,
    );
  }
  add("Started", t(eventTimeText(e)));

  // Kind-specific fields. Content is shown only as stored.
  switch (e.kind) {
    case "tool.requested":
      add("Input", contentValue(e.payload.input, o));
      break;
    case "tool.completed":
      add("Output", contentValue(e.payload.output, o));
      break;
    case "tool.failed":
      add("Error", contentValue(e.payload.error, o));
      break;
    case "turn.started":
      add("Prompt", contentValue(e.payload.prompt, o));
      break;
    case "message.observed":
      add("Role", t(`${e.payload.role} / ${e.payload.channel}`));
      add("Content", contentValue(e.payload.content, o));
      break;
    case "agent.started":
      add("Agent type", t(e.payload.agentType ?? "(untyped)"));
      break;
    case "file.changed":
      add("Path", t(e.payload.path));
      add("Change", t(`${e.payload.changeKind}, ${e.payload.basis}`));
      break;
    case "permission.requested":
      add("Tool", t(e.payload.toolName ?? "(unnamed)"));
      add("Input", contentValue(e.payload.input, o));
      break;
    case "permission.decided":
      add("Decision", t(`${e.payload.decision} by ${e.payload.decidedBy}`));
      add("Reason", contentValue(e.payload.reason, o));
      break;
    case "model.usage":
      add("Model", t(`${e.payload.model ?? "(unspecified)"}, scope ${e.payload.scope}`));
      break;
    case "capture.gap":
      add("Gap", t(`${e.payload.reason}: ${e.payload.detail}`));
      break;
    case "source.unknown":
      add("Native type", t(e.payload.nativeType ?? "(none)"));
      break;
    default:
      break;
  }
  const second = it.second;
  if (second?.kind === "tool.completed") add("Output", contentValue(second.payload.output, o));
  if (second?.kind === "tool.failed") add("Error", contentValue(second.payload.error, o));
  const step = it.step;
  if (step !== null && step.permissions.length > 0) {
    const text = step.permissions
      .map((pe) => {
        const bits: string[] = [];
        if (pe.requested !== null) bits.push("requested");
        for (const d of pe.decisions) bits.push(`${d.payload.decision} by ${d.payload.decidedBy}`);
        return bits.join(", ");
      })
      .join("; ");
    add("Permissions", t(text));
  }
  if (step !== null && step.files.length > 0) {
    add(
      "Files changed",
      step.files.map((f) => `<span class="ln">${t(f.payload.path)}</span>`).join(""),
    );
  }

  // Correlation, evidence and provenance.
  const call = toolCallOf(e);
  const callId = call ?? (second === null ? null : toolCallOf(second));
  const rels = [...e.links, ...(second?.links ?? [])].map(
    (l) => `${t(l.rel)} ${evtLink(l.target, anchors)}`,
  );
  if (callId !== null || rels.length > 0) {
    add(
      "Correlation",
      [callId === null ? "" : `toolCallId ${t(callId)}`, ...rels]
        .filter((x) => x !== "")
        .map((x) => `<span class="ln">${x}</span>`)
        .join(""),
    );
  }
  add("Evidence", links(it.second === null ? [e.eventId] : [e.eventId, it.second.eventId]));
  add("Provenance", t(provenanceText(e)));
  if (second !== null) add("Result provenance", t(provenanceText(second)));

  const head = `<div class="dh"><span class="lb">${it.label}</span><span class="dn">${t(summaryOf(it, o).name === "" ? e.kind : summaryOf(it, o).name)}</span></div>`;
  const raws = [
    `<div class="rawh">RAW EVENT${second === null ? "" : " (request)"}</div>${rawEvent(e, o)}`,
    ...(second === null
      ? []
      : [`<div class="rawh">RAW EVENT (result)</div>${rawEvent(second, o)}`]),
  ];
  return `<div class="d">${head}<dl class="kv">${kv.join("")}</dl>${raws.join("")}</div>`;
}

// ---- stream, minimap, sidebar -------------------------------------------------------------------

function durationText(it: Item): string {
  const ms = it.row?.durationMs ?? null;
  return ms === null ? "" : `${num(ms)} ms`;
}

function itemHtml(it: Item, o: RenderOptions, detail: string): string {
  const e = it.lead;
  const f: string[] = [];
  if (it.cat === "user") f.push("f-user");
  else if (it.cat === "assistant" || it.cat === "reasoning") f.push("f-assistant");
  else if (it.cat === "tool") f.push("f-tool");
  else if (it.cat === "command") f.push("f-command");
  if (it.cat === "subagent" || it.agent > 0) f.push("f-subagent");
  if (it.bad) f.push("f-error");
  const cls = `item k-${it.cat} ${f.join(" ")} ag${num(it.agent)}${it.bad ? " bad" : ""}${it.noResult ? " nr" : ""}`;
  const idAttr = RE_EVT.test(e.eventId) ? ` id="${e.eventId}"` : "";
  const href = RE_EVT.test(e.eventId) ? ` href="#${e.eventId}"` : "";
  const second = it.second;
  const anchor =
    second !== null && RE_EVT.test(second.eventId)
      ? `<span class="an" id="${second.eventId}"></span>`
      : "";
  const sm = summaryOf(it, o);
  const status = it.bad
    ? ` <span class="st bad">${it.row === null ? esc(e.status, o) : STATUS_TEXT[it.row.status]}</span>`
    : it.noResult
      ? ' <span class="st warn">no result</span>'
      : "";
  const bar =
    it.step?.bar === undefined || it.step.bar === null
      ? ""
      : `<span class="bar o${num(it.step.bar.offset)} w${num(it.step.bar.width)}"></span>`;
  return `<div class="${cls}"${idAttr}>${anchor}<a class="row"${href}><span class="tm">${esc(clock(e), o)}</span><span class="lb">${it.label}</span><span class="ag">${esc(it.agentLabel, o)}</span><span class="sm">${sm.name === "" ? "" : `<span class="tn">${esc(sm.name, o)}</span>`}${esc(sm.text, o)}${status}</span><span class="du">${durationText(it)}</span><span class="dtk">${bar}</span></a>${detail}</div>`;
}

function minimapHtml(
  events: readonly CanonicalEvent[],
  itemOf: ReadonlyMap<EvtId, Item>,
  anchors: ReadonlySet<string>,
): string {
  const n = events.length;
  if (n === 0) return "";
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  const ms: (number | null)[] = events.map((e) => timeMs(e));
  for (const v of ms) {
    if (v === null) continue;
    if (v < t0) t0 = v;
    if (v > t1) t1 = v;
  }
  const byTime = t1 > t0;
  const xs: number[] = [];
  let last = 0;
  for (let i = 0; i < n; i++) {
    const v = ms[i] ?? null;
    if (byTime) {
      if (v !== null)
        last = Math.min(
          MINIMAP_STEPS - 1,
          Math.max(0, Math.floor(((v - t0) / (t1 - t0)) * MINIMAP_STEPS)),
        );
      xs.push(last);
    } else xs.push(Math.min(MINIMAP_STEPS - 1, Math.floor((i * MINIMAP_STEPS) / n)));
  }
  const picks: number[] = [];
  if (n <= MINIMAP_MAX_TICKS) for (let i = 0; i < n; i++) picks.push(i);
  else {
    for (let k = 0; k < MINIMAP_MAX_TICKS; k++) {
      const lo = Math.floor((k * n) / MINIMAP_MAX_TICKS);
      const hi = Math.max(lo + 1, Math.floor(((k + 1) * n) / MINIMAP_MAX_TICKS));
      let pick = lo;
      for (let i = lo; i < hi; i++) {
        const ev = events[i];
        const item = ev === undefined ? undefined : itemOf.get(ev.eventId);
        if (item?.bad === true) {
          pick = i;
          break;
        }
      }
      picks.push(pick);
    }
  }
  const ticks: string[] = [];
  for (const i of picks) {
    const e = events[i];
    if (e === undefined) continue;
    const item = itemOf.get(e.eventId);
    const cat = item?.cat ?? "system";
    if (!anchors.has(e.eventId) || !RE_EVT.test(e.eventId)) continue;
    ticks.push(
      `<a class="t x${num(xs[i] ?? 0)} k-${cat}${item?.bad === true ? " bad" : ""}" href="#${e.eventId}">${cat}</a>`,
    );
  }
  const note =
    picks.length < n
      ? `<span class="mmn">Sampled: ${num(picks.length)} of ${num(n)} events are drawn; failures are kept first.</span>`
      : "";
  return `<div class="mmw"><div class="mm">${ticks.join("")}</div>${note}</div>`;
}

export interface StreamParts {
  readonly minimap: string;
  readonly grid: string;
  /** Number of subagents seen in the streamed events. */
  readonly subagents: number;
}

/** The minimap and the three-column grid: sidebar, event stream with detail blocks, session facts. */
export function renderStream(
  view: SessionView,
  events: readonly CanonicalEvent[],
  total: number,
  trace: TraceModel,
  log: ActionLog,
  o: RenderOptions,
  anchors: ReadonlySet<string>,
): StreamParts {
  const { turns, itemOf } = buildItems(events, trace, log);
  const attribution = attributeAgents(events);
  const promptOf = new Map<number, string>();
  for (const g of trace.groups) {
    const p = g.prompts[0];
    if (p !== undefined && !g.outside) promptOf.set(g.index, excerpt(p.ref, 120, o));
  }

  // Sidebar threads: counts per agent class over all streamed events.
  const perAgent = new Map<number, number>();
  const labels = new Map<number, string>([[0, "main"]]);
  for (const a of attribution.agents) {
    const k = Math.min(a.index, AGENT_CLASS_MAX);
    if (a.index > AGENT_CLASS_MAX) labels.set(k, "15+");
    else if (!labels.has(k)) labels.set(k, a.label);
  }
  for (const e of events) {
    const k = Math.min(attribution.of.get(e.eventId)?.index ?? 0, AGENT_CLASS_MAX);
    perAgent.set(k, (perAgent.get(k) ?? 0) + 1);
  }
  const threadInputs = [
    `<input type="radio" name="th" id="th-all" checked><label for="th-all"><span>All events</span><span class="n">${num(events.length)}</span></label>`,
    ...[...labels.keys()]
      .sort((a, b) => a - b)
      .map(
        (k) =>
          `<input type="radio" name="th" id="th-${num(k)}"><label for="th-${num(k)}"><span>${esc(labels.get(k) ?? "", o)}</span><span class="n">${num(perAgent.get(k) ?? 0)}</span></label>`,
      ),
  ];
  const turnLinks = turns.slice(0, SIDEBAR_MAX_TURNS).map((b) => {
    const name = b.index === 0 ? "Outside turns" : `Turn ${num(b.index)}`;
    return `<li><a href="#turn-${num(b.index)}"><span>${name}</span><span class="n">${num(b.events)}</span></a></li>`;
  });
  const more =
    turns.length > SIDEBAR_MAX_TURNS
      ? `<li class="dim">${num(turns.length - SIDEBAR_MAX_TURNS)} more turns are listed in the stream.</li>`
      : "";
  const side = `<aside class="side"><h2>Threads</h2><div class="rl">${threadInputs.join("")}</div><h2>Turns</h2><ul class="turns">${turnLinks.join("")}${more}</ul></aside>`;

  // Centre: header with chips, then one turn block per group.
  let operations = 0;
  for (const r of log.rows) if (r.requestId !== null) operations++;
  const chips = [
    '<input type="radio" name="cf" id="c-all" checked><label for="c-all">All</label>',
    ...CHIPS.map(
      ([k, name]) =>
        `<input type="radio" name="cf" id="c-${k}"><label for="c-${k}">${name}</label>`,
    ),
  ];
  const cut2 =
    events.length < total
      ? `<p class="sn dim">Event stream and details cover the first ${num(events.length)} of ${num(total)} events; later events appear only in the Timeline tab.</p>`
      : "";
  const blocks: string[] = [];
  // Detail blocks are added until their running size passes the budget; later rows stay, without one.
  const budget = Math.min(DETAIL_BUDGET_MAX_BYTES, Math.floor(o.maxOutputBytes / 4));
  const encoder = new TextEncoder();
  let used = 0;
  let omitted = 0;
  const rowHtml = (it: Item): string => {
    let d = "";
    if (used <= budget) {
      d = detailHtml(it, o, anchors);
      used += encoder.encode(d).length;
    }
    if (used > budget && d === "") omitted++;
    else if (used > budget) {
      d = "";
      omitted++;
    }
    return itemHtml(it, o, d);
  };
  for (const b of turns) {
    const prompt =
      b.index === 0 ? "Session (outside turns)" : (promptOf.get(b.index) ?? "no prompt recorded");
    let tools = 0;
    let failed = 0;
    for (const it of b.items) {
      if (it.row !== null && it.row.requestId !== null) tools++;
      if (it.row !== null && it.bad) failed++;
    }
    blocks.push(
      `<details class="turn" id="turn-${num(b.index)}" open><summary><span class="tg k-user">${b.index === 0 ? "Outside" : `Turn ${num(b.index)}`}</span><span class="pr">${esc(prompt, o)}</span><span class="cn">${num(b.events)} events, ${num(tools)} tool requests, ${num(failed)} failed tools</span></summary>${b.items.map(rowHtml).join("")}</details>`,
    );
  }
  const jump =
    '<p class="sn dim jump">Jump to: <a href="#tabs">Waterfall &middot; Commands &middot; Explanation &middot; Timeline &middot; Warnings</a></p>';
  const budgetNote =
    omitted > 0
      ? `<p class="sn dim">Detail blocks and raw events are omitted for the last ${num(omitted)} rows to keep this page small; see the Timeline and Commands tabs, or use swain report.</p>`
      : "";
  const stream =
    `<main class="stream"><div class="sh"><h2>Event stream</h2><span class="cnt">${num(events.length)} events &middot; ${num(operations)} tool requests</span><div class="chips">${chips.join("")}</div></div>${jump}${cut2}__BUDGET__${blocks.join("")}</main>`.replace(
      "__BUDGET__",
      budgetNote,
    );

  // Right: session facts shown when nothing is selected.
  const facts = headerFacts(view, o)
    .map((f) => `<dt>${esc(f.label, o)}</dt><dd>${esc(f.value, o)}</dd>`)
    .join("");
  const details = `<aside class="details"><h2>Details</h2><div class="d-default"><p class="dim">Select an event to see its fields and raw record. Session facts:</p><dl class="kv">${facts}</dl></div></aside>`;

  return {
    minimap: minimapHtml(events, itemOf, anchors),
    grid: `<div class="grid">${side}${stream}${details}</div>`,
    subagents: attribution.agents.length,
  };
}

// ---- stat strip ---------------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const v = Number.isFinite(ms) ? Math.max(0, Math.trunc(ms)) : 0;
  if (v < 1000) return `${num(v)} ms`;
  if (v < 60_000) return `${num(Math.floor(v / 1000))}.${num(Math.floor((v % 1000) / 100))} s`;
  if (v < 3_600_000)
    return `${num(Math.floor(v / 60_000))}m ${num(Math.floor((v % 60_000) / 1000))}s`;
  return `${num(Math.floor(v / 3_600_000))}h ${num(Math.floor((v % 3_600_000) / 60_000))}m`;
}

/** Milliseconds between the first and last valid event time, or null. */
export function spanMs(events: readonly CanonicalEvent[]): number | null {
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const e of events) {
    const v = timeMs(e);
    if (v === null) continue;
    if (v < t0) t0 = v;
    if (v > t1) t1 = v;
  }
  return t1 >= t0 ? t1 - t0 : null;
}

export interface Card {
  readonly label: string;
  readonly value: string;
  readonly bad?: boolean;
}

export function cardsHtml(cards: readonly Card[]): string {
  return `<div class="stats">${cards
    .map(
      (c) =>
        `<div class="card${c.bad === true ? " bad" : ""}"><div class="cl">${c.label}</div><div class="cv">${c.value}</div></div>`,
    )
    .join("")}</div>`;
}

/** Session cards, computed from the trace model; nothing is recounted. */
export function sessionCards(
  trace: TraceModel,
  subagents: number,
  duration: number | null,
): readonly Card[] {
  let tools = 0;
  let none = 0;
  for (const u of trace.usage) {
    tools += u.calls;
    none += u.noResult;
  }
  let failed = 0;
  let files = 0;
  for (const g of trace.groups) {
    failed += g.failedTools;
    files += g.filesChanged;
  }
  return [
    { label: "Tool requests", value: num(tools) },
    { label: "Failed / denied / interrupted", value: num(failed), bad: failed > 0 },
    { label: "No result", value: num(none) },
    { label: "Files changed", value: num(files) },
    { label: "Subagents", value: num(subagents) },
    { label: "Duration", value: duration === null ? "n/a" : formatDuration(duration) },
  ];
}
