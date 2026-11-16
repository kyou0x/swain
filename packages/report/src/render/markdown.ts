import { escapeMarkdownText } from "../escape.js";
import type { Explanation, Part, RenderOptions, SessionView, Statement } from "../types.js";
import {
  checkSize,
  describe,
  eventTimeText,
  gapEvents,
  headerFacts,
  maskFree,
  notices,
  provenanceText,
  RE_EVT,
  RE_MD_SAFE_TEXT,
  renderedEvents,
  warningDetail,
} from "./common.js";

const RE_RULE = /^interp\.[a-z]+$/;

function md(s: string, o: RenderOptions): string {
  return escapeMarkdownText(maskFree(s, o));
}

function evtCode(id: string): string {
  // Event IDs are regex-validated; anything else is treated as untrusted text.
  return RE_EVT.test(id) ? `\`${id}\`` : escapeMarkdownText(id);
}

function partsMd(parts: readonly Part[], o: RenderOptions): string {
  let out = "";
  for (const p of parts) {
    if (p.t === "count") out += String(Math.trunc(p.v));
    else if (p.t === "text") out += RE_MD_SAFE_TEXT.test(p.v) ? p.v : escapeMarkdownText(p.v);
    else out += md(p.v, o);
  }
  return out;
}

function statementMd(s: Statement, o: RenderOptions): string {
  const evidence = s.evidence.map(evtCode).join(", ");
  const more =
    s.evidenceTotal > s.evidence.length ? ` and ${s.evidenceTotal - s.evidence.length} more` : "";
  const rule =
    s.kind === "interpretation" && s.rule !== undefined && RE_RULE.test(s.rule)
      ? `rule \`${s.rule}\`; `
      : "";
  const prefix = s.kind === "interpretation" ? "Interpretation: " : "";
  return `- ${prefix}${partsMd(s.parts, o)} (${rule}evidence: ${evidence}${more})`;
}

export function renderMarkdown(view: SessionView, ex: Explanation, o: RenderOptions): string {
  const lines: string[] = [];
  lines.push("# Swain session report", "");
  lines.push("## Notices", "");
  for (const n of notices(view)) lines.push(`- ${n}`);
  lines.push("", "## Session", "");
  for (const f of headerFacts(view, o)) lines.push(`- ${f.label}: ${md(f.value, o)}`);

  lines.push("", "## Explanation", "");
  for (const sec of ex.sections) {
    lines.push(`### ${sec.title}`, "");
    if (sec.statements.length === 0) {
      lines.push("- No evidence-backed statements for this section.");
    } else {
      for (const s of sec.statements) lines.push(statementMd(s, o));
    }
    lines.push("");
  }

  const { shown, total } = renderedEvents(view, o);
  lines.push("## Timeline", "");
  if (shown.length < total) {
    lines.push(`Timeline truncated: showing the first ${shown.length} of ${total} events.`, "");
  }
  lines.push("| Seq | Event | Kind | Status | Actor | Time | Detail | Source |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const e of shown) {
    lines.push(
      `| ${e.sourceSequence}.${e.subIndex} | ${evtCode(e.eventId)} | ${md(e.kind, o)} | ${md(e.status, o)} | ${md(e.actor.role, o)} | ${md(eventTimeText(e), o)} | ${partsMd(
        describe(e, (s) => maskFree(s, o)),
        o,
      )} | ${md(provenanceText(e), o)} |`,
    );
  }

  lines.push("", "## Warnings and gaps", "");
  const gaps = gapEvents(view.result.events);
  if (gaps.length === 0 && view.result.warnings.length === 0) {
    lines.push("- No warnings, capture gaps or unknown records.");
  }
  for (const g of gaps)
    lines.push(
      `- ${evtCode(g.eventId)}: ${partsMd(
        describe(g, (s) => maskFree(s, o)),
        o,
      )}`,
    );
  for (const w of view.result.warnings) {
    lines.push(
      `- warning ${md(w.code, o)} (${md(w.severity, o)}), source sequence ${w.sourceSequence === null ? "none" : String(w.sourceSequence)}: ${md(warningDetail(w.detail), o)}`,
    );
  }
  lines.push("");
  return checkSize(lines.join("\n"), o);
}
