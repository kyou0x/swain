/** Read-only views: sessions, show, explain. All untrusted text is escaped before it is printed. */
import { type CanonicalEvent, IMPORT_OUTCOMES, type ImportResult, PROVIDERS } from "@swain/core";
import {
  type Explanation,
  explainSession,
  type ImportRecord,
  maskEvent,
  maskParts,
  type Part,
  type Statement,
} from "@swain/report";
import { parseCount } from "./args.js";
import {
  type Ctx,
  EXIT,
  flagOn,
  flagValue,
  homeRenderOptions,
  labelText,
  maskPath,
  openStoreFor,
  resolveRecord,
  usageError,
} from "./context.js";
import { clip, esc, plural, shortEventId, shortImportId, table, terminalJson } from "./text.js";

const DEFAULT_SHOW_LIMIT = 200;
const MAX_SHOW_LIMIT = 1_000_000;
const DETAIL_CHARS = 90;
const EXCERPT_CHARS = 160;
const EVIDENCE_SHOWN = 3;

/** Home-masked copies for `--json`: nothing path-like may carry the home directory. */
function maskedRecord(ctx: Ctx, r: ImportRecord): ImportRecord {
  return { ...r, source: { ...r.source, displayPath: maskPath(ctx, r.source.displayPath) } };
}

function maskedEvent(ctx: Ctx, e: CanonicalEvent): CanonicalEvent {
  return homeRenderOptions(ctx).reduce((ev, o) => maskEvent(ev, o), e);
}

function maskedExplanation(ctx: Ctx, ex: Explanation): Explanation {
  return {
    ...ex,
    sections: ex.sections.map((s) => ({
      ...s,
      statements: s.statements.map((st) => ({
        ...st,
        parts: homeRenderOptions(ctx).reduce<Part[]>((ps, o) => maskParts(ps, o), [...st.parts]),
      })),
    })),
  };
}

export function runSessions(ctx: Ctx): number {
  const provider = flagValue(ctx, "--provider");
  if (provider !== undefined && !(PROVIDERS as readonly string[]).includes(provider)) {
    return usageError(ctx, `--provider must be one of: ${PROVIDERS.join(", ")}`);
  }
  const outcome = flagValue(ctx, "--outcome");
  if (outcome !== undefined && !(IMPORT_OUTCOMES as readonly string[]).includes(outcome)) {
    return usageError(ctx, `--outcome must be one of: ${IMPORT_OUTCOMES.join(", ")}`);
  }
  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;
  const records = store
    .list()
    .filter(
      (r) =>
        (provider === undefined || r.provider === provider) &&
        (outcome === undefined || r.outcome === outcome),
    );
  if (flagOn(ctx, "--json")) {
    ctx.out(
      terminalJson({
        format: "atm.sessions/0.1",
        imports: records.map((r) => maskedRecord(ctx, r)),
      }),
    );
    return EXIT.ok;
  }
  if (records.length === 0) {
    ctx.out(
      "No imports yet. Import a session file with 'swain import <path>'; 'swain sources' shows where each tool keeps its files.\n",
    );
    return EXIT.ok;
  }
  ctx.out(
    table(
      [
        "ID",
        "PROVIDER",
        "SOURCE KIND",
        "OUTCOME",
        "EVENTS",
        "GAPS",
        "FIRST EVENT",
        "FILE",
        "LABELS",
      ],
      records.map((r) => [
        shortImportId(r.importId),
        r.provider,
        esc(r.sourceKind),
        r.outcome,
        String(r.counts.events),
        String(r.counts.gaps),
        r.firstEventTime === null ? "-" : esc(r.firstEventTime),
        clip(r.source.displayName, 40),
        labelText(r),
      ]),
    ),
  );
  ctx.out(
    `\n${plural(records.length, "import")}. Use 'swain show <ID>' or 'swain explain <ID>'.\n`,
  );
  return EXIT.ok;
}

function header(ctx: Ctx, r: ImportRecord): string {
  const lines = [
    `Import ${shortImportId(r.importId)}  ${esc(r.provider)} / ${esc(r.sourceKind)}  (${r.outcome})`,
    `Source  ${esc(maskPath(ctx, r.source.displayPath))}  (${esc(r.adapter.id)} ${esc(r.adapter.version)})`,
    `Labels  ${labelText(r) || "none"}`,
    r.contentRetention === "hash-only"
      ? "Content hash-only: prompts and tool output were not stored"
      : "Content inline, masked on a best-effort basis (masking is not a guarantee)",
  ];
  return `${lines.join("\n")}\n`;
}

function detail(ctx: Ctx, e: CanonicalEvent): string {
  const home = (p: string): string => maskPath(ctx, p);
  switch (e.kind) {
    case "session.started":
      return `trigger ${e.payload.trigger}`;
    case "session.ended":
      return `reason ${e.payload.reason}`;
    case "turn.started":
      return "turn started";
    case "turn.ended":
      return "turn ended";
    case "message.observed":
      return `${e.payload.channel} message from ${e.payload.role}`;
    case "tool.requested":
      return `requested ${e.payload.toolName}`;
    case "tool.completed":
      return `completed ${e.payload.toolName ?? "(tool)"}`;
    case "tool.failed":
      return `failed ${e.payload.toolName ?? "(tool)"} (${e.payload.errorClass})`;
    case "agent.started":
      return `agent ${e.payload.agentType ?? "(none)"}`;
    case "agent.ended":
      return "agent ended";
    case "file.changed":
      return `${e.payload.changeKind} ${home(e.payload.path)}`;
    case "permission.requested":
      return `permission requested for ${e.payload.toolName ?? "(tool)"}`;
    case "permission.decided":
      return `${e.payload.decision} by ${e.payload.decidedBy}`;
    case "model.usage":
      return `usage (${e.payload.scope})${e.payload.totalTokens === undefined ? "" : `, ${e.payload.totalTokens} tokens`}`;
    case "capture.gap":
      return `gap: ${e.payload.reason}`;
    case "source.unknown":
      return `unrecognised record (${e.payload.nativeType ?? "no type"})`;
  }
}

export function runShow(ctx: Ctx): number {
  const limitRaw = flagValue(ctx, "--limit");
  const limit =
    limitRaw === undefined ? DEFAULT_SHOW_LIMIT : parseCount(limitRaw, 1, MAX_SHOW_LIMIT);
  if (limit === null)
    return usageError(ctx, `--limit must be an integer from 1 to ${MAX_SHOW_LIMIT}`);
  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;
  const record = resolveRecord(ctx, store, ctx.inv.positionals[0] ?? "");
  if (record === null) return EXIT.notFound;
  const result: ImportResult = store.load(record.importId);
  const shown = result.events.slice(0, limit);
  if (flagOn(ctx, "--json")) {
    ctx.out(
      terminalJson({
        format: "atm.show/0.1",
        record: maskedRecord(ctx, record),
        events: shown.map((e) => maskedEvent(ctx, e)),
        truncated: result.events.length - shown.length,
      }),
    );
    return EXIT.ok;
  }
  ctx.out(header(ctx, record));
  ctx.out(
    `Events  ${result.events.length}${shown.length < result.events.length ? ` (showing the first ${shown.length}; use --limit N)` : ""}\n\n`,
  );
  ctx.out(
    table(
      ["SEQ", "EVENT", "TIME", "KIND", "STATUS", "DETAIL"],
      shown.map((e) => [
        e.subIndex === 0 ? String(e.sourceSequence) : `${e.sourceSequence}.${e.subIndex}`,
        shortEventId(e.eventId),
        e.time.status === "valid" && e.time.value !== null
          ? esc(e.time.value)
          : `(${e.time.status})`,
        e.kind,
        e.status,
        clip(detail(ctx, e), DETAIL_CHARS),
      ]),
    ),
  );
  return EXIT.ok;
}

function partText(ctx: Ctx, p: Part): string {
  if (p.t === "text") return p.v;
  if (p.t === "count") return String(p.v);
  return esc(maskPath(ctx, p.v));
}

function statementLine(ctx: Ctx, st: Statement): string {
  const body = st.parts.map((p) => partText(ctx, p)).join("");
  const ids = st.evidence.slice(0, EVIDENCE_SHOWN).map(shortEventId);
  const more = st.evidenceTotal - ids.length;
  const cite = `${ids.join(", ")}${more > 0 ? `${ids.length > 0 ? ", " : ""}+${more} more` : ""}`;
  if (st.kind === "interpretation") {
    return `  - Interpretation: ${body}  [${esc(st.rule ?? "")}; basis: ${cite}]\n`;
  }
  return `  - ${body}  [${cite}]\n`;
}

export function runExplain(ctx: Ctx): number {
  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;
  const record = resolveRecord(ctx, store, ctx.inv.positionals[0] ?? "");
  if (record === null) return EXIT.notFound;
  const result = store.load(record.importId);
  const ex = explainSession(
    { record, result },
    {
      includeContentExcerpts: record.contentRetention === "inline",
      excerptChars: EXCERPT_CHARS,
      homeDirs: [ctx.homeDir, ctx.realHomeDir],
    },
  );
  if (flagOn(ctx, "--json")) {
    ctx.out(terminalJson(maskedExplanation(ctx, ex)));
    return EXIT.ok;
  }
  ctx.out(header(ctx, record));
  for (const section of ex.sections) {
    if (section.statements.length === 0) continue;
    ctx.out(`\n${esc(section.title)}\n`);
    for (const st of section.statements) ctx.out(statementLine(ctx, st));
  }
  ctx.out(
    "\nEvery statement cites event IDs (see 'swain show'). Interpretations are labeled and rule-based.\n",
  );
  return EXIT.ok;
}
