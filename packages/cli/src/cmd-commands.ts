/**
 * `swain commands`: tool commands each agent requested, with results where recorded, in order.
 * Untrusted text is home-masked (before any cut) and escaped; output is bounded.
 */
import { DEFAULT_BOUNDS } from "@swain/core";
import {
  type ActionRow,
  actionSummary,
  agentPathText,
  buildActionLog,
  type ImportRecord,
  maskHomeInText,
  mergeRowsChronologically,
  STATUS_TEXT,
  sortEvents,
} from "@swain/report";
import { type Ctx, EXIT, flagOn, openStoreFor, resolveRecord, usageError } from "./context.js";
import { esc, plural, shortImportId, table, terminalJson } from "./text.js";

export const MAX_SESSIONS = 64;
export const MAX_ROWS = 20_000;
export const MAX_JSON_TEXT_CHARS = 8192;

const NOTE_HEURISTIC = "shell tools are identified by tool name (a heuristic)";
const NOTICE =
  "Commands are tool requests identified by tool name (a heuristic); an MCP tool with a shell-like name counts as a command. Command text exists only for imports made with --include-content. Captured output may contain secrets; home-directory masking is best-effort and not a guarantee. The store is local to this machine.";
const ORDER_NOTE =
  "ordered by timestamp across sessions; rows without a valid time are listed last; SEQ is per-session source order";

/** Home masking for free text: the command line may mention the home directory anywhere. */
function maskText(ctx: Ctx, s: string): string {
  return maskHomeInText(maskHomeInText(s, ctx.homeDir), ctx.realHomeDir);
}

/** Cut at `max` code points without an ellipsis; reports whether anything was cut. */
function cut(s: string, max: number): { readonly text: string; readonly cut: boolean } {
  let n = 0;
  let end = 0;
  for (const ch of s) {
    if (n === max) return { text: s.slice(0, end), cut: true };
    n++;
    end += ch.length;
  }
  return { text: s, cut: false };
}

interface Item {
  readonly row: ActionRow;
  readonly order: number;
  readonly record: ImportRecord;
}

function jsonRow(ctx: Ctx, it: Item): Record<string, unknown> {
  const r = it.row;
  const m = (s: string): string => maskText(ctx, s);
  // Row text is home-masked already (before any cut); the JSON cap is applied after masking.
  const command = r.command === null ? null : cut(r.command, MAX_JSON_TEXT_CHARS);
  const target = r.target === null ? null : cut(r.target, MAX_JSON_TEXT_CHARS);
  return {
    session: it.record.importId,
    seq: r.seq,
    time: r.time,
    agent: { index: r.agentIndex, label: m(r.agentLabel), path: r.agentPath.map(m) },
    toolName: m(r.toolName),
    toolNamespace: r.toolNamespace,
    isCommand: r.isCommand,
    command: command === null ? null : command.text,
    commandTruncated: command?.cut === true,
    commandHiddenBytes: r.commandHiddenBytes,
    target: target === null ? null : target.text,
    targetTruncated: target?.cut === true,
    status: r.status,
    statusLabel: STATUS_TEXT[r.status],
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    excerpt: r.excerpt,
    excerptHiddenBytes: r.excerptHiddenBytes,
    eventIds: r.eventIds,
  };
}

function tooLarge(ctx: Ctx): number {
  ctx.err("swain: output refused (too-large): the rendering exceeds the size limit\n");
  return EXIT.outputRefused;
}

export function runCommands(ctx: Ctx): number {
  const all = flagOn(ctx, "--all");
  const ids = [...new Set(ctx.inv.positionals)];
  if (ids.length > MAX_SESSIONS) {
    return usageError(ctx, `commands: at most ${MAX_SESSIONS} sessions per call`);
  }
  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;
  const records = new Map<string, ImportRecord>();
  for (const id of ids) {
    const record = resolveRecord(ctx, store, id);
    if (record === null) return EXIT.notFound;
    if (!records.has(record.importId)) records.set(record.importId, record);
  }
  const list = [...records.values()];
  const multi = list.length > 1;
  const homes = [ctx.homeDir, ctx.realHomeDir];
  const items: Item[] = [];
  list.forEach((record, order) => {
    const log = buildActionLog(sortEvents(store.load(record.importId).events), homes);
    for (const row of log.rows) if (all || row.isCommand) items.push({ row, order, record });
  });
  // One session keeps source order; several are merged by timestamp.
  const ordered = multi ? mergeRowsChronologically(items) : items;
  const merged = ordered.length > MAX_ROWS ? ordered.slice(0, MAX_ROWS) : ordered;
  const truncated = ordered.length - merged.length;
  const limit = DEFAULT_BOUNDS.maxOutputBytes;
  const sizeOk = (s: string): boolean => new TextEncoder().encode(s).length <= limit;

  if (flagOn(ctx, "--json")) {
    const json = terminalJson({
      format: "atm.commands/0.1",
      classification: NOTE_HEURISTIC,
      notice: NOTICE,
      ordering: multi ? ORDER_NOTE : "source order",
      all,
      truncated,
      sessions: list.map((r) => r.importId),
      rows: merged.map((x) => jsonRow(ctx, x)),
    });
    if (!sizeOk(json)) return tooLarge(ctx);
    ctx.out(json);
    return EXIT.ok;
  }
  if (merged.length === 0) {
    ctx.out(
      `No ${all ? "tool actions" : "shell commands"} found (${NOTE_HEURISTIC}).${all ? "" : " Use --all to list every tool action."}\n`,
    );
    return EXIT.ok;
  }
  const hidden = merged.filter((x) => x.row.commandHiddenBytes !== null).length;
  const headers = [
    "SEQ",
    "TIME",
    ...(multi ? ["SESSION"] : []),
    "AGENT",
    "STATUS",
    "EXIT",
    "COMMAND",
  ];
  let text = table(
    headers,
    merged.map((x) => {
      const r = x.row;
      return [
        String(r.seq),
        esc(r.timeText),
        ...(multi ? [shortImportId(x.record.importId)] : []),
        esc(maskText(ctx, agentPathText(r))),
        r.status === "none" ? "no-result" : r.status,
        r.exitCode === null ? "-" : String(r.exitCode),
        esc(actionSummary(r)),
      ];
    }),
  );
  text += `\n${plural(merged.length, all ? "action" : "command")} requested (${NOTE_HEURISTIC}; results where recorded).\n`;
  if (truncated > 0) {
    text += `Output truncated: showing the first ${MAX_ROWS} of ${ordered.length} rows.\n`;
  }
  if (multi) text += `${ORDER_NOTE}.\n`;
  if (hidden > 0) {
    text += `${plural(hidden, "command")} hidden because the import is hash-only; re-import with --include-content to see command text.\n`;
  }
  text += "An MCP tool with a shell-like name counts as a command.\n";
  text +=
    "Captured output may contain secrets; masking is best-effort. The store is local to this machine.\n";
  if (!sizeOk(text)) return tooLarge(ctx);
  ctx.out(text);
  return EXIT.ok;
}
