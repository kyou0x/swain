/**
 * The Commands, Timeline and Agents tabs of the server span run page (trace runs). Pure: the view
 * model in, markup out. Agent attribution comes from the server (`ownerAgentId`, computed by the
 * same-credential walk); this file only groups by it and never infers an owner itself.
 *
 * Content rule: arguments, results and messages are content keys. Their text is shown only when the
 * project content policy is `inline` AND the stored reference carries inline text; otherwise the
 * cell says `hash-only` with a short hash. Excerpts are capped at `EXCERPT_BYTES` and every string
 * goes through `esc` (home masking, entity escaping). No script, no style attribute, no handler.
 */
import type { RenderOptions } from "../types.js";
import type { AttrView, SpanRowView, SpanRunView, TextView } from "../web-types.js";
import { AGENT_CLASS_MAX, isShellTool } from "./actions.js";
import { maskFree } from "./common.js";
import { esc, num } from "./html-util.js";
import { formatDuration } from "./stream.js";

export const EXCERPT_BYTES = 2048;
const MAX_DEPTH = 16;
const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_AGT = /^agt_[0-9a-f]{32}$/;
const RE_KEY = /^key_[0-9a-f]{16}$/;
const UNKNOWN_AGENT = "unknown agent";
const NAME_CP_MAX = 128;
const KEY_LABEL_CP_MAX = 64;

const MODEL_KEYS = ["gen_ai.response.model", "gen_ai.request.model", "llm.model_name"] as const;
const IN_TOKEN_KEYS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
] as const;
const OUT_TOKEN_KEYS = [
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
] as const;

// ---- small helpers -------------------------------------------------------------------------------

function nsToMs(ns: bigint | null): number | null {
  if (ns === null || ns <= 0n) return null;
  return Number(ns / 1_000_000n);
}

function isoMs(ms: number | null): string {
  if (ms === null || !Number.isSafeInteger(ms) || ms < 0 || ms > 8_640_000_000_000_000)
    return "n/a";
  return new Date(ms).toISOString();
}

/** `+mm:ss` from the run start; minutes are not wrapped into hours and are capped for display. */
function offsetText(ms: number | null, t0: number | null): string {
  if (ms === null || t0 === null || ms < t0) return "";
  const sec = Math.floor((ms - t0) / 1000);
  const mm = Math.min(Math.floor(sec / 60), 99_999);
  return `+${String(mm).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function durationText(s: SpanRowView): string {
  const a = nsToMs(s.startNs);
  const b = nsToMs(s.endNs);
  return a === null || b === null || b < a ? "n/a" : formatDuration(b - a);
}

function findAttr(s: SpanRowView, key: string): AttrView | undefined {
  return s.attributes.find((a) => a.key === key);
}

/** A metadata value (text or scalar) as plain text; content and structures give null. */
function plainOf(t: TextView | undefined): string | null {
  if (t === undefined) return null;
  if (t.kind === "text" && t.value !== "") return t.value;
  if (t.kind === "scalar" && t.value !== "") return t.value;
  return null;
}

function firstPlain(s: SpanRowView, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = plainOf(findAttr(s, k)?.value);
    if (v !== null) return v;
  }
  return null;
}

function tokenOf(s: SpanRowView, keys: readonly string[]): number | null {
  const v = firstPlain(s, keys);
  return v !== null && /^[0-9]{1,15}$/.test(v) ? Number(v) : null;
}

/** Longest prefix of `s` that fits `EXCERPT_BYTES` of UTF-8, cut on a code point boundary. */
export function capBytes(s: string): { text: string; cut: boolean } {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + b > EXCERPT_BYTES) return { text: s.slice(0, end), cut: true };
    bytes += b;
    end += ch.length;
  }
  return { text: s, cut: false };
}

/** At most `n` code points of `s`, with an ellipsis when cut. */
export function capCp(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : `${cps.slice(0, n).join("")}…`;
}

/**
 * Escapes free text and keeps line structure: LF and CRLF become real line breaks and a tab stays a
 * tab (the cell is `white-space: pre-wrap`); every other control character is neutralized by `esc`.
 */
export function escLines(s: string, o: RenderOptions): string {
  return s
    .split(/(\r\n|\n|\t)/)
    .map((p) => (p === "\r\n" || p === "\n" ? "\n" : p === "\t" ? "\t" : esc(p, o)))
    .join("");
}

/**
 * A content-key cell. Text only when the project policy is `inline` AND the stored reference has
 * inline text; everything else is `hash-only` with a short hash. Masking runs before the cap so a
 * cut can never leave half of a home path.
 */
function contentCell(t: TextView | undefined, inline: boolean, o: RenderOptions): string {
  if (t === undefined) return "";
  if (t.kind !== "content") return '<span class="dim">n/a</span>';
  if (inline && t.inline !== null) {
    const { text, cut } = capBytes(maskFree(t.inline, o));
    return `${escLines(text, o)}${cut ? ' <span class="tag">truncated</span>' : ""}`;
  }
  const h = RE_HEX64.test(t.sha256) ? t.sha256.slice(0, 12) : "invalid";
  return `<span class="dim">hash-only <code>${h}</code></span>`;
}

/** UNSET and OK both read "ok"; the raw OTel value stays on the Spans tab. */
function statusCell(code: number): string {
  return code === 2 ? '<span class="b-bad">error</span>' : '<span class="b-ok">ok</span>';
}

function byStart(a: SpanRowView, b: SpanRowView): number {
  const x = a.startNs ?? 0n;
  const y = b.startNs ?? 0n;
  if (a.startNs === null && b.startNs !== null) return 1;
  if (a.startNs !== null && b.startNs === null) return -1;
  return x < y ? -1 : x > y ? 1 : a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
}

// ---- model ---------------------------------------------------------------------------------------

interface Row {
  readonly span: SpanRowView;
  /** The agent this span is attributed to: the trusted enclosing agent, else its own agent. */
  readonly agent: string;
}

interface AgentInfo {
  readonly id: string;
  /** Display label: the (capped) name or the short ID, with the short ID added on a name clash. */
  label: string;
  readonly index: number;
  parent: string | null;
  /** The credential that delivered the earliest canonical agent span of this agent. */
  homeKey: string | null;
  start: number | null;
  end: number | null;
  tools: number;
  chats: number;
  inTokens: number;
  outTokens: number;
  errors: number;
  readonly models: string[];
}

interface Model {
  readonly rows: readonly Row[];
  readonly agents: ReadonlyMap<string, AgentInfo>;
  readonly t0: number | null;
  readonly keyLabels: ReadonlyMap<string, string>;
}

function agentKey(s: SpanRowView): string {
  const owner = s.ownerAgentId;
  if (typeof owner === "string" && RE_AGT.test(owner)) return owner;
  return typeof s.agentId === "string" && RE_AGT.test(s.agentId) ? s.agentId : "";
}

/** `agt_` plus the first 8 hex digits, or the unknown-agent text for a missing or invalid ID. */
function shortId(id: string): string {
  return RE_AGT.test(id) ? id.slice(0, 12) : UNKNOWN_AGENT;
}

function buildModel(v: SpanRunView): Model {
  const names = new Map<string, string>();
  for (const a of v.agents ?? []) if (RE_AGT.test(a.agentId)) names.set(a.agentId, a.name);
  const keyLabels = new Map<string, string>();
  for (const c of v.run.credentials) {
    if (RE_KEY.test(c.keyId) && c.label !== null) keyLabels.set(c.keyId, c.label);
  }
  const sorted = [...v.spans].sort(byStart);
  const rows: Row[] = sorted.map((span) => ({ span, agent: agentKey(span) }));
  const agents = new Map<string, AgentInfo>();
  let t0: number | null = null;
  for (const { span, agent } of rows) {
    const a0 = nsToMs(span.startNs);
    if (a0 !== null && (t0 === null || a0 < t0)) t0 = a0;
    let info = agents.get(agent);
    if (info === undefined) {
      const name = names.get(agent);
      info = {
        id: agent,
        label: name === undefined ? shortId(agent) : capCp(name, NAME_CP_MAX),
        index: agents.size,
        parent: null,
        homeKey: null,
        start: null,
        end: null,
        tools: 0,
        chats: 0,
        inTokens: 0,
        outTokens: 0,
        errors: 0,
        models: [],
      };
      agents.set(agent, info);
    }
    const b0 = nsToMs(span.endNs) ?? a0;
    if (a0 !== null && (info.start === null || a0 < info.start)) info.start = a0;
    if (b0 !== null && (info.end === null || b0 > info.end)) info.end = b0;
    if (span.opClass === "tool") info.tools++;
    if (span.opClass === "llm") {
      info.chats++;
      info.inTokens += tokenOf(span, IN_TOKEN_KEYS) ?? 0;
      info.outTokens += tokenOf(span, OUT_TOKEN_KEYS) ?? 0;
      const m = firstPlain(span, MODEL_KEYS);
      if (m !== null && !info.models.includes(m) && info.models.length < 3) {
        info.models.push(capCp(m, NAME_CP_MAX));
      }
    }
    if (span.statusCode === 2) info.errors++;
    if (span.opClass === "agent") {
      if (info.parent === null) {
        const p = span.parentOwnerAgentId;
        if (typeof p === "string" && RE_AGT.test(p) && p !== agent) info.parent = p;
      }
      if (info.homeKey === null && span.canonical && RE_KEY.test(span.keyId)) {
        info.homeKey = span.keyId;
      }
    }
  }
  // names are sender-supplied: when two agents share a label, add the short ID to every one of them
  const byLabel = new Map<string, AgentInfo[]>();
  for (const info of agents.values()) {
    const l = byLabel.get(info.label);
    if (l === undefined) byLabel.set(info.label, [info]);
    else l.push(info);
  }
  for (const group of byLabel.values()) {
    if (group.length > 1) {
      for (const info of group) info.label = `${info.label} (${shortId(info.id)})`;
    }
  }
  return { rows, agents, t0, keyLabels };
}

function agentDepth(id: string, agents: ReadonlyMap<string, AgentInfo>): number {
  let depth = 0;
  const seen = new Set<string>([id]);
  let cur = agents.get(id)?.parent ?? null;
  while (cur !== null && depth < MAX_DEPTH && !seen.has(cur)) {
    seen.add(cur);
    depth++;
    cur = agents.get(cur)?.parent ?? null;
  }
  return depth;
}

function agentClass(info: AgentInfo): string {
  return `ag${num(Math.min(info.index, AGENT_CLASS_MAX))}`;
}

function agentLabel(info: AgentInfo | undefined, o: RenderOptions): string {
  return esc(info === undefined ? UNKNOWN_AGENT : info.label, o);
}

/** The credential that delivered a span: its label or the first 8 hex digits, plus a mismatch tag. */
function credentialCell(
  s: SpanRowView,
  info: AgentInfo | undefined,
  m: Model,
  o: RenderOptions,
): string {
  if (!RE_KEY.test(s.keyId)) return '<span class="dim">invalid</span>';
  const label = m.keyLabels.get(s.keyId);
  const shown = label === undefined ? s.keyId.slice(4, 12) : capCp(label, KEY_LABEL_CP_MAX);
  const other =
    info !== undefined && info.homeKey !== null && info.homeKey !== s.keyId
      ? ' <span class="tag">from another credential</span>'
      : "";
  return `${esc(shown, o)}${other}`;
}

// ---- panels --------------------------------------------------------------------------------------

/** One byte budget (UTF-8) shared by the Commands, Timeline and Agents panels. */
class Budget {
  private left: number;
  private readonly enc = new TextEncoder();
  constructor(o: RenderOptions) {
    this.left = Math.max(0, Math.floor(o.maxOutputBytes / 6));
  }
  /** Takes the row when it fits; the first row of a panel is always taken. */
  take(html: string, first: boolean): boolean {
    const n = this.enc.encode(html).length;
    if (!first && n > this.left) {
      this.left = 0;
      return false;
    }
    this.left = Math.max(0, this.left - n);
    return true;
  }
}

function capNotice(shown: number, total: number): string {
  return shown < total
    ? `<p class="dim">Output size cap: showing the first ${num(shown)} of ${num(total)} rows.</p>`
    : "";
}

function agentFilterHtml(m: Model, o: RenderOptions): string {
  const labels = new Map<number, string>();
  for (const info of m.agents.values()) {
    const k = Math.min(info.index, AGENT_CLASS_MAX);
    if (info.index > AGENT_CLASS_MAX) labels.set(k, "15+ (others)");
    else labels.set(k, info.label);
  }
  const inputs = [...labels.keys()]
    .sort((a, b) => a - b)
    .map(
      (k) =>
        `<input type="radio" name="ag" id="a-g-${num(k)}"><label for="a-g-${num(k)}">${esc(labels.get(k) ?? "", o)}</label>`,
    );
  return `<fieldset class="agf"><legend>Agent</legend><input type="radio" name="ag" id="a-g-all" checked><label for="a-g-all">all</label>${inputs.join("")}</fieldset>`;
}

function commandsPanel(m: Model, inline: boolean, o: RenderOptions, b: Budget): string {
  const tools = m.rows.filter((r) => r.span.opClass === "tool");
  const out: string[] = [
    '<p class="dim">One row per tool call, in start order. The Agent column is the nearest enclosing agent span from the same credential; without one it is the span\'s own agent. Agent names are supplied by the sender: check the Credential column. Arguments and results are shown only when the content policy is inline.</p>',
  ];
  if (tools.length === 0) {
    out.push('<p class="dim">No tool calls in this run.</p>');
    return out.join("\n");
  }
  out.push(
    '<fieldset><legend>Show</legend><input type="radio" name="as" id="a-s-all" checked><label for="a-s-all">All actions</label><input type="radio" name="as" id="a-s-cmd"><label for="a-s-cmd">Only shell commands</label></fieldset>',
  );
  const rows: string[] = [];
  for (const r of tools) {
    const s = r.span;
    const info = m.agents.get(r.agent);
    const toolName = plainOf(findAttr(s, "gen_ai.tool.name")?.value) ?? "";
    const shell = isShellTool(toolName);
    const cls = `${shell ? "cmd " : ""}${info === undefined ? "ag0" : agentClass(info)}${s.statusCode === 2 ? " bad" : ""}`;
    const a0 = nsToMs(s.startNs);
    const args = contentCell(findAttr(s, "gen_ai.tool.call.arguments")?.value, inline, o);
    const argCell =
      shell && args !== "" && !args.startsWith("<span") ? `<code>${args}</code>` : args;
    const html = `<tr class="${cls}"><td>${num(rows.length + 1)}</td><td>${esc(isoMs(a0), o)} <span class="dim">${offsetText(a0, m.t0)}</span></td><td>${agentLabel(info, o)}</td><td>${credentialCell(s, info, m, o)}</td><td>${esc(toolName, o)}</td><td><div class="pc">${argCell}</div></td><td><div class="pc">${contentCell(findAttr(s, "gen_ai.tool.call.result")?.value, inline, o)}</div></td><td>${durationText(s)}</td><td>${statusCell(s.statusCode)}</td></tr>`;
    if (!b.take(html, rows.length === 0)) break;
    rows.push(html);
  }
  out.push(
    capNotice(rows.length, tools.length),
    '<div class="scroll acts"><table><thead><tr><th>#</th><th>Start (UTC)</th><th>Agent</th><th>Credential</th><th>Tool</th><th>Command or arguments</th><th>Result</th><th>Duration</th><th>Status</th></tr></thead><tbody>',
    rows.join("\n"),
    "</tbody></table></div>",
  );
  return out.join("\n");
}

interface TlRow {
  readonly ms: number | null;
  readonly order: number;
  readonly agent: string;
  readonly kind: string;
  readonly detail: string;
  readonly span: SpanRowView;
  readonly dur: string;
}

function timelinePanel(m: Model, inline: boolean, o: RenderOptions, b: Budget): string {
  const list: TlRow[] = [];
  let order = 0;
  for (const { span: s, agent } of m.rows) {
    const a0 = nsToMs(s.startNs);
    const b0 = nsToMs(s.endNs);
    const nameText = (): string => {
      const n = s.name;
      return n.kind === "text" || n.kind === "scalar" ? esc(capCp(n.value, NAME_CP_MAX), o) : "";
    };
    const push = (ms: number | null, kind: string, detail: string, dur: string): void => {
      list.push({ ms, order: order++, agent, kind, detail, span: s, dur });
    };
    switch (s.opClass) {
      case "agent":
        push(a0, "agent start", nameText(), "");
        if (b0 !== null) push(b0, "agent end", nameText(), durationText(s));
        break;
      case "llm": {
        const model = firstPlain(s, MODEL_KEYS);
        const i = tokenOf(s, IN_TOKEN_KEYS);
        const t = tokenOf(s, OUT_TOKEN_KEYS);
        const parts = [
          model === null ? "model n/a" : esc(capCp(model, NAME_CP_MAX), o),
          `${i === null ? "?" : num(i)} &rarr; ${t === null ? "?" : num(t)} tokens`,
        ];
        const inMsg = findAttr(s, "gen_ai.input.messages")?.value;
        const outMsg = findAttr(s, "gen_ai.output.messages")?.value;
        const msgs =
          (inMsg === undefined
            ? ""
            : `<div class="pc">in: ${contentCell(inMsg, inline, o)}</div>`) +
          (outMsg === undefined
            ? ""
            : `<div class="pc">out: ${contentCell(outMsg, inline, o)}</div>`);
        push(a0, "chat", `${parts.join(", ")}${msgs}`, durationText(s));
        break;
      }
      case "tool": {
        const tool = plainOf(findAttr(s, "gen_ai.tool.name")?.value);
        push(a0, "tool", tool === null ? nameText() : esc(tool, o), durationText(s));
        break;
      }
      default:
        push(
          a0,
          s.opClass === "handoff" || s.opClass === "workflow" ? s.opClass : "span",
          nameText(),
          durationText(s),
        );
    }
  }
  list.sort((x, y) => {
    if (x.ms === null && y.ms !== null) return 1;
    if (x.ms !== null && y.ms === null) return -1;
    return (x.ms ?? 0) - (y.ms ?? 0) || x.order - y.order;
  });
  if (list.length === 0) return '<p class="dim">No spans.</p>';
  const rows: string[] = [];
  for (const r of list) {
    const info = m.agents.get(r.agent);
    const cls = `${info === undefined ? "ag0" : agentClass(info)}${r.span.statusCode === 2 ? " bad" : ""}`;
    const depth = info === undefined ? 0 : agentDepth(info.id, m.agents);
    const html = `<tr class="${cls}"><td>${esc(isoMs(r.ms), o)} <span class="dim">${offsetText(r.ms, m.t0)}</span></td><td><div class="i${num(depth)}">${agentLabel(info, o)}</div></td><td>${credentialCell(r.span, info, m, o)}</td><td>${r.kind}</td><td>${r.detail}</td><td>${r.dur}</td><td>${statusCell(r.span.statusCode)}</td></tr>`;
    if (!b.take(html, rows.length === 0)) break;
    rows.push(html);
  }
  return [
    '<p class="dim">Every span in chronological order, indented by agent depth. Message excerpts follow the content policy.</p>',
    capNotice(rows.length, list.length),
    '<div class="scroll tlx"><table><thead><tr><th>Time (UTC)</th><th>Agent</th><th>Credential</th><th>Event</th><th>Detail</th><th>Duration</th><th>Status</th></tr></thead><tbody>',
    rows.join("\n"),
    "</tbody></table></div>",
  ].join("\n");
}

function agentsPanel(m: Model, o: RenderOptions, b: Budget): string {
  if (m.agents.size === 0) return '<p class="dim">No agents.</p>';
  const rows: string[] = [];
  for (const a of m.agents.values()) {
    const parent = a.parent === null ? undefined : m.agents.get(a.parent);
    const dur = a.start !== null && a.end !== null ? formatDuration(a.end - a.start) : "n/a";
    const html = `<tr><td>${agentLabel(a, o)}</td><td>${parent === undefined ? '<span class="dim">none</span>' : agentLabel(parent, o)}</td><td>${a.models.length === 0 ? '<span class="dim">n/a</span>' : a.models.map((x) => esc(x, o)).join(", ")}</td><td>${esc(isoMs(a.start), o)}</td><td>${esc(isoMs(a.end), o)}</td><td>${dur}</td><td>${num(a.tools)}</td><td>${num(a.chats)}</td><td>${num(a.inTokens)}</td><td>${num(a.outTokens)}</td><td>${a.errors > 0 ? `<span class="b-bad">${num(a.errors)}</span>` : "0"}</td></tr>`;
    if (!b.take(html, rows.length === 0)) break;
    rows.push(html);
  }
  return `${capNotice(rows.length, m.agents.size)}<div class="scroll usage"><table><thead><tr><th>Agent</th><th>Parent agent</th><th>Model</th><th>Start (UTC)</th><th>End (UTC)</th><th>Duration</th><th>Tool calls</th><th>Chats</th><th>Input tokens</th><th>Output tokens</th><th>Errors</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>`;
}

export interface RunTabs {
  /** The agent filter, placed above the tab bar. */
  readonly filter: string;
  readonly commands: string;
  readonly timeline: string;
  readonly agents: string;
}

export function renderRunTabs(v: SpanRunView, o: RenderOptions): RunTabs {
  const inline = v.run.contentPolicy === "inline";
  const m = buildModel(v);
  const budget = new Budget(o);
  return {
    filter: m.rows.length === 0 ? "" : agentFilterHtml(m, o),
    commands: commandsPanel(m, inline, o, budget),
    timeline: timelinePanel(m, inline, o, budget),
    agents: agentsPanel(m, o, budget),
  };
}
