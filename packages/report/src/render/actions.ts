import type { CanonicalEvent, ContentRef, EvtId } from "@swain/core";
import { escapeHtmlText } from "../escape.js";
import type { RenderOptions } from "../types.js";
import { eventTimeText, maskHomeInText, truncateCodePoints } from "./common.js";
import { esc, evtLink, num } from "./html-util.js";
import {
  pairTools,
  protectedActors,
  type ToolRequest,
  type ToolResult,
  type ToolStatus,
  timeMs,
  toolDurationMs,
  toolStatus,
} from "./pairing.js";

/** The action log lists at most this many rows (the first ones in order); a static notice says so. */
export const ACTIONS_MAX_ROWS = 5000;
export const COMMAND_EXCERPT_CHARS = 400;
export const OUTPUT_EXCERPT_CHARS = 200;
/** Agent filter classes ag0..ag15; agents beyond 15 share ag15. */
export const AGENT_CLASS_MAX = 15;
/** Nesting paths are cut at this many levels, as in the trace. */
const MAX_PATH = 16;
/** Subagent type text is cut at this many code points before it enters a label. */
const MAX_TYPE_CHARS = 64;
export const AGENT_PATH_SEP = " \u203a ";

export const NOTICE_ACTIONS_HEURISTIC = "Shell tools are identified by tool name (a heuristic).";
export const NOTICE_ACTIONS_TRUNCATED_PREFIX = "Action log truncated: showing the first";

/**
 * Tool names that run shell commands, taken from the adapters and docs/research/FORMAT-*.md:
 * Claude Code `Bash`; Codex `exec_command`, `shell_command`, `shell`, `local_shell` (the name the
 * Codex adapter gives a `local_shell_call`); Gemini CLI `run_shell_command`; OpenCode `bash`.
 */
export const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Bash",
  "bash",
  "exec_command",
  "shell_command",
  "shell",
  "local_shell",
  "run_shell_command",
]);

export function isShellTool(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name);
}

/** Inline JSON fields that name the target of a non-shell tool, in priority order. */
const TARGET_FIELDS = ["file_path", "filePath", "path", "url", "pattern", "query"] as const;

export interface ActionRow {
  /** 1-based position in the full action log. */
  readonly seq: number;
  /** ISO time of the requested event (or of the orphan result); null unless the time is valid. */
  readonly time: string | null;
  readonly timeMs: number | null;
  /** Display form of the time: the ISO value, or `(status)`. */
  readonly timeText: string;
  /** 0 for the main agent, else first-appearance order of the subagent. */
  readonly agentIndex: number;
  /** `main`, or the subagent type (or "(untyped)") followed by ` #index`. */
  readonly agentLabel: string;
  /** Labels from the outermost subagent to this one; empty for main. */
  readonly agentPath: readonly string[];
  readonly toolName: string;
  readonly toolNamespace: string | null;
  readonly isCommand: boolean;
  /** The full command from inline input, else null. */
  readonly command: string | null;
  /** Byte length of a shell input that is not inline (hash-only), else null. */
  readonly commandHiddenBytes: number | null;
  /** Obvious target (path, url, pattern, query) of a non-shell tool, else null. */
  readonly target: string | null;
  readonly status: ToolStatus;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** Output (or error) excerpt of at most 200 code points, from inline content only. */
  readonly excerpt: string | null;
  /** Byte length of an output/error that is not inline, else null. */
  readonly excerptHiddenBytes: number | null;
  readonly requestId: EvtId | null;
  readonly resultId: EvtId | null;
  /** All event ids behind the row, request first. */
  readonly eventIds: readonly EvtId[];
}

export interface ActionLog {
  readonly rows: readonly ActionRow[];
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inlineText(ref: ContentRef | null): string | null {
  return ref !== null && ref.inline !== undefined && ref.retention !== "hash-only"
    ? ref.inline
    : null;
}

function ownString(o: Record<string, unknown>, k: string): string | null {
  if (!Object.hasOwn(o, k)) return null;
  const v = o[k];
  return typeof v === "string" ? v : null;
}

/** A `command` or `cmd` field as a string, or an all-string array joined with spaces. */
function commandField(o: Record<string, unknown>): string | null {
  for (const k of ["command", "cmd"]) {
    if (!Object.hasOwn(o, k)) continue;
    const v = o[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) {
      return v.join(" ");
    }
  }
  return null;
}

function parseJson(s: string): { readonly ok: true; readonly v: unknown } | { readonly ok: false } {
  try {
    return { ok: true, v: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Tools that spawn a subagent; the Claude adapter lists both names (`Task` is the old alias). */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * Command and target from a tool input. The command is read from inline JSON (`command` or `cmd`).
 * For a shell tool whose inline input is not JSON at all (the Codex fixture records `ls src`), the
 * raw text is the command. Hash-only input yields no command. For `Agent`/`Task` the target is
 * `subagent_type - description`. An empty command is "" (distinct from null, not recorded).
 */
export function extractInput(
  toolName: string,
  input: ContentRef | null,
): {
  readonly command: string | null;
  readonly hiddenBytes: number | null;
  readonly target: string | null;
} {
  const shell = isShellTool(toolName);
  const inline = inlineText(input);
  if (input === null) return { command: null, hiddenBytes: null, target: null };
  if (inline === null) {
    return { command: null, hiddenBytes: shell ? input.byteLength : null, target: null };
  }
  const parsed = parseJson(inline);
  if (parsed.ok) {
    const v = parsed.v;
    if (!isPlainRecord(v)) return { command: null, hiddenBytes: null, target: null };
    if (shell) return { command: commandField(v), hiddenBytes: null, target: null };
    if (SPAWN_TOOLS.has(toolName)) {
      const parts = ["subagent_type", "description"]
        .map((k) => ownString(v, k))
        .filter((x): x is string => x !== null && x !== "");
      if (parts.length > 0) return { command: null, hiddenBytes: null, target: parts.join(" - ") };
    }
    let target: string | null = null;
    for (const k of TARGET_FIELDS) {
      const s = ownString(v, k);
      if (s !== null && s !== "") {
        target = s;
        break;
      }
    }
    return { command: null, hiddenBytes: null, target };
  }
  return { command: shell ? inline : null, hiddenBytes: null, target: null };
}

interface AgentInfo {
  readonly index: number;
  readonly label: string;
  readonly path: readonly string[];
}

function agentLabel(type: string | null, index: number): string {
  if (type === null) return `subagent (untyped) #${index}`;
  const t = truncateCodePoints(type, MAX_TYPE_CHARS);
  return `subagent ${JSON.stringify(t)} #${index}`;
}

/**
 * Forward-pass subagent attribution, consistent with the trace: an `agent.started` activates its
 * `agentActorId` and an `agent.ended` deactivates it; only events in between belong to it. A start
 * that names a protected actor (the first event's actor or a user actor) is ignored. The parent is
 * the emitting actor if it is active, or `payload.parentActorId` when the agent emits its own start.
 */
class AgentTracker {
  readonly #registry = new Map<string, AgentInfo>();
  readonly #active = new Set<string>();
  readonly #protected: ReadonlySet<string>;
  #next = 1;
  constructor(events: readonly CanonicalEvent[]) {
    this.#protected = protectedActors(events);
  }
  started(e: Extract<CanonicalEvent, { kind: "agent.started" }>): void {
    const id = e.payload.agentActorId;
    if (this.#protected.has(id)) return;
    const known = this.#registry.get(id);
    if (known !== undefined) {
      this.#active.add(id);
      return;
    }
    const parentId =
      id === e.actor.actorId ? (e.payload.parentActorId ?? undefined) : e.actor.actorId;
    const parent =
      parentId === undefined || parentId === id || !this.#active.has(parentId)
        ? undefined
        : this.#registry.get(parentId);
    const index = this.#next++;
    const label = agentLabel(e.payload.agentType, index);
    const path = [...(parent?.path ?? []), label];
    this.#registry.set(id, {
      index,
      label,
      path: path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path,
    });
    this.#active.add(id);
  }
  ended(id: string): void {
    this.#active.delete(id);
  }
  of(actorId: string): AgentInfo | undefined {
    return this.#active.has(actorId) ? this.#registry.get(actorId) : undefined;
  }
  all(): AgentInfo[] {
    return [...this.#registry.values()];
  }
}

export interface AgentRef {
  readonly index: number;
  readonly label: string;
}

/**
 * Subagent attribution for every event, with the same forward pass as the action log. Events that
 * belong to the main agent have no entry. `agents` lists each subagent once, in index order.
 */
export function attributeAgents(events: readonly CanonicalEvent[]): {
  readonly of: ReadonlyMap<EvtId, AgentRef>;
  readonly agents: readonly AgentRef[];
} {
  const tracker = new AgentTracker(events);
  const of = new Map<EvtId, AgentRef>();
  for (const e of events) {
    if (e.kind === "agent.started") tracker.started(e);
    const a = tracker.of(e.actor.actorId);
    if (a !== undefined) of.set(e.eventId, { index: a.index, label: a.label });
    if (e.kind === "agent.ended") tracker.ended(e.payload.agentActorId);
  }
  return { of, agents: tracker.all().map((a) => ({ index: a.index, label: a.label })) };
}

function excerptOf(
  result: ToolResult | null,
  mask: (s: string) => string,
): {
  readonly text: string | null;
  readonly hidden: number | null;
} {
  if (result === null) return { text: null, hidden: null };
  const ref = result.kind === "tool.completed" ? result.payload.output : result.payload.error;
  if (ref === null) return { text: null, hidden: null };
  const inline = inlineText(ref);
  if (inline === null) return { text: null, hidden: ref.byteLength };
  return { text: truncateCodePoints(mask(inline), OUTPUT_EXCERPT_CHARS), hidden: null };
}

/**
 * Pure action log from events in display order: one row per tool span (a request with its paired
 * result, if any) and one per orphan result, at the position of the first event of the span.
 * Pairing is the trace's (`pairTools`). O(n). `homes` are home directories masked in command,
 * target and output text BEFORE any truncation, so a cut can never expose part of a home path.
 */
export function buildActionLog(
  events: readonly CanonicalEvent[],
  homes: readonly (string | null)[] = [],
): ActionLog {
  const { resultFor, claimed } = pairTools(events);
  const agents = new AgentTracker(events);
  const mask = (s: string): string => homes.reduce<string>((acc, h) => maskHomeInText(acc, h), s);
  const rows: ActionRow[] = [];
  for (const e of events) {
    if (e.kind === "agent.started") {
      agents.started(e);
      continue;
    }
    if (e.kind === "agent.ended") {
      agents.ended(e.payload.agentActorId);
      continue;
    }
    let request: ToolRequest | null = null;
    let result: ToolResult | null = null;
    if (e.kind === "tool.requested") {
      request = e;
      result = resultFor.get(e.eventId) ?? null;
    } else if (
      (e.kind === "tool.completed" || e.kind === "tool.failed") &&
      !claimed.has(e.eventId)
    ) {
      result = e;
    } else continue;
    const lead: CanonicalEvent = request ?? (result as ToolResult);
    const toolName = request?.payload.toolName ?? result?.payload.toolName ?? "(unnamed)";
    const agent = agents.of(lead.actor.actorId);
    const startMs = timeMs(lead);
    const input = extractInput(toolName, request === null ? null : request.payload.input);
    const ex = excerptOf(result, mask);
    const ids: EvtId[] = [];
    if (request !== null) ids.push(request.eventId);
    if (result !== null) ids.push(result.eventId);
    const exit = result?.payload.exitCode;
    rows.push({
      seq: rows.length + 1,
      time: lead.time.status === "valid" && lead.time.value !== null ? lead.time.value : null,
      timeMs: startMs,
      timeText: eventTimeText(lead),
      agentIndex: agent?.index ?? 0,
      agentLabel: agent?.label ?? "main",
      agentPath: agent?.path ?? [],
      toolName,
      toolNamespace: request === null ? null : request.payload.toolNamespace,
      isCommand: isShellTool(toolName),
      command: input.command === null ? null : mask(input.command),
      commandHiddenBytes: input.hiddenBytes,
      target: input.target === null ? null : mask(input.target),
      status: toolStatus(result),
      exitCode: exit !== undefined && Number.isFinite(exit) ? exit : null,
      durationMs: toolDurationMs(startMs, result === null ? null : timeMs(result), result),
      excerpt: ex.text,
      excerptHiddenBytes: ex.hidden,
      requestId: request?.eventId ?? null,
      resultId: result?.eventId ?? null,
      eventIds: ids,
    });
  }
  return { rows };
}

/** `main`, or the quoted subagent labels joined by a separator that type text cannot fake. */
export function agentPathText(r: ActionRow): string {
  return r.agentPath.length === 0 ? "main" : r.agentPath.join(AGENT_PATH_SEP);
}

/**
 * Plain text for "Command or target"; the caller escapes it. The row's text is already home-masked,
 * so the 400 code point cut cannot split a home path.
 */
export function actionSummary(r: ActionRow): string {
  if (r.command !== null) {
    return r.command === ""
      ? "(empty command)"
      : truncateCodePoints(r.command, COMMAND_EXCERPT_CHARS);
  }
  if (r.commandHiddenBytes !== null) {
    return `command hidden (hash-only, ${Math.trunc(r.commandHiddenBytes)} bytes)`;
  }
  if (r.isCommand) return `${r.toolName} (command not recorded)`;
  if (r.target !== null)
    return `${r.toolName}: ${truncateCodePoints(r.target, COMMAND_EXCERPT_CHARS)}`;
  return r.toolName;
}

/** Merge rows of several sessions: timed rows chronologically, then untimed rows in session order. */
export function mergeRowsChronologically<
  T extends { readonly row: ActionRow; readonly order: number },
>(items: readonly T[]): T[] {
  const timed = items.filter((x) => x.row.timeMs !== null);
  const untimed = items.filter((x) => x.row.timeMs === null);
  const cmp = (a: T, b: T): number =>
    (a.row.timeMs ?? 0) - (b.row.timeMs ?? 0) || a.order - b.order || a.row.seq - b.row.seq;
  const byOrder = (a: T, b: T): number => a.order - b.order || a.row.seq - b.row.seq;
  return [...timed.sort(cmp), ...untimed.sort(byOrder)];
}

// ---- static stylesheet ------------------------------------------------------------------------

/** Selector rules for the fixed filter ids; depend on no data. */
export function actionsStyle(): string[] {
  const rules: string[] = ["body:has(#a-s-cmd:checked) .acts tbody tr:not(.cmd){display:none}"];
  for (let k = 0; k <= AGENT_CLASS_MAX; k++) {
    rules.push(`body:has(#a-g-${k}:checked) .acts tbody tr:not(.ag${k}){display:none}`);
    rules.push(`body:has(#a-g-${k}:checked) .tlx tbody tr:not(.ag${k}){display:none}`);
  }
  return rules;
}

// ---- HTML -------------------------------------------------------------------------------------

const BADGE: Readonly<Record<ToolStatus, string>> = {
  ok: "b-ok",
  unknown: "b-warn",
  failed: "b-bad",
  denied: "b-bad",
  interrupted: "b-bad",
  none: "b-warn",
};
export const STATUS_TEXT: Readonly<Record<ToolStatus, string>> = {
  ok: "ok",
  unknown: "completed, status unknown",
  failed: "failed",
  denied: "denied",
  interrupted: "interrupted",
  none: "no result recorded",
};

export function renderActions(
  log: ActionLog,
  info: { readonly covered: number; readonly total: number },
  o: RenderOptions,
  anchors: ReadonlySet<string>,
): string {
  const out: string[] = [];
  const all = log.rows;
  const rows = all.length > ACTIONS_MAX_ROWS ? all.slice(0, ACTIONS_MAX_ROWS) : all;
  out.push(
    `<p class="dim">${escapeHtmlText(NOTICE_ACTIONS_HEURISTIC)} Command text is shown only when the session was imported with content retention; captured output may contain secrets, and masking is best-effort.</p>`,
  );
  if (info.covered < info.total) {
    out.push(
      `<p class="dim">Events truncated: the first ${num(info.covered)} of ${num(info.total)} events were examined.</p>`,
    );
  }
  if (rows.length < all.length) {
    out.push(
      `<p class="dim">${NOTICE_ACTIONS_TRUNCATED_PREFIX} ${num(rows.length)} of ${num(all.length)} actions.</p>`,
    );
  }
  if (rows.length === 0) {
    out.push('<p class="dim">No tool actions in this session.</p>');
    return out.join("\n");
  }
  // Agent radios: only indices go into ids; the label is escaped data.
  const labels = new Map<number, string>();
  for (const r of rows) {
    const k = Math.min(r.agentIndex, AGENT_CLASS_MAX);
    if (r.agentIndex > AGENT_CLASS_MAX) labels.set(k, "15+");
    else if (!labels.has(k)) labels.set(k, r.agentLabel);
  }
  const agentInputs = [...labels.keys()]
    .sort((a, b) => a - b)
    .map(
      (k) =>
        `<input type="radio" name="ag" id="a-g-${num(k)}"><label for="a-g-${num(k)}">${esc(labels.get(k) ?? "", o)}</label>`,
    );
  out.push(
    `<fieldset><legend>Show</legend><input type="radio" name="as" id="a-s-all" checked><label for="a-s-all">All actions</label><input type="radio" name="as" id="a-s-cmd"><label for="a-s-cmd">Only shell commands</label></fieldset>`,
    `<fieldset><legend>Agent</legend><input type="radio" name="ag" id="a-g-all" checked><label for="a-g-all">all</label>${agentInputs.join("")}</fieldset>`,
  );
  out.push(
    '<div class="scroll acts"><table><thead><tr><th>#</th><th>Time</th><th>Agent</th><th>Tool</th><th>Command or target (shell tools identified by tool name)</th><th>Status</th><th>Exit</th><th>Duration (ms)</th><th>Output excerpt</th><th>Evidence</th></tr></thead><tbody>',
  );
  for (const r of rows) {
    const cls = `${r.isCommand ? "cmd " : ""}ag${num(Math.min(r.agentIndex, AGENT_CLASS_MAX))}`;
    const agent = agentPathText(r);
    const excerpt =
      r.excerpt !== null
        ? esc(r.excerpt, o)
        : r.excerptHiddenBytes !== null
          ? `output hidden (hash-only, ${num(r.excerptHiddenBytes)} bytes)`
          : "";
    out.push(
      `<tr class="${cls}"><td>${num(r.seq)}</td><td>${esc(r.timeText, o)}</td><td>${esc(agent, o)}</td><td>${esc(r.toolName, o)}</td><td>${r.isCommand ? "<code>" : ""}${esc(actionSummary(r), o)}${r.isCommand ? "</code>" : ""}</td><td><span class="${BADGE[r.status]}">${STATUS_TEXT[r.status]}</span></td><td>${r.exitCode === null ? "" : num(r.exitCode)}</td><td>${r.durationMs === null ? "" : num(r.durationMs)}</td><td>${excerpt}</td><td>${r.eventIds.map((id) => evtLink(id, anchors)).join(" ")}</td></tr>`,
    );
  }
  out.push("</tbody></table></div>");
  return out.join("\n");
}
