import { IMPORT_OUTCOMES, PROVIDERS } from "@swain/core";
import { escapeHtmlText } from "../escape.js";
import type { Explanation, ImportRecord, RenderOptions, SessionView, Statement } from "../types.js";
import { buildActionLog, renderActions } from "./actions.js";
import {
  checkSize,
  describe,
  eventTimeText,
  gapEvents,
  maskFree,
  NOTICE_MASKED,
  notices,
  provenanceText,
  RE_EVT,
  RE_IMP,
  renderedEvents,
  warningDetail,
} from "./common.js";
import { esc, evtLink, num, partsHtml } from "./html-util.js";
import { CSP, htmlDoc, resolveBrand, topBar } from "./shell.js";
import { cardsHtml, formatDuration, renderStream, sessionCards, spanMs } from "./stream.js";
import { TABS } from "./theme.js";
import { buildTrace, renderTrace, TRACE_MAX_EVENTS } from "./trace.js";

export { CSP };

const RE_RULE = /^interp\.[a-z]+$/;

function statementHtml(s: Statement, o: RenderOptions, anchors: ReadonlySet<string>): string {
  const links = s.evidence.map((id) => evtLink(id, anchors)).join(" ");
  const more =
    s.evidenceTotal > s.evidence.length ? ` and ${s.evidenceTotal - s.evidence.length} more` : "";
  const interp = s.kind === "interpretation";
  const rule =
    interp && s.rule !== undefined && RE_RULE.test(s.rule) ? `rule <code>${s.rule}</code>; ` : "";
  const tag = interp ? '<span class="tag">Interpretation:</span> ' : "";
  return `<li${interp ? ' class="interp"' : ""}>${tag}${partsHtml(s.parts, o)} <span class="ev">(${rule}evidence: ${links}${more})</span></li>`;
}

/** Closed mapping from a status to a fixed class name; unknown values get none. */
function statusClass(status: string): string {
  return status === "failure" || status === "denied" || status === "interrupted"
    ? ' class="bad"'
    : "";
}

function idCode(id: string): string {
  return RE_EVT.test(id) ? `<code>${id}</code>` : escapeHtmlText(id);
}

function noticeList(view: SessionView): string {
  // The raw event blocks are on every session page, so the masking caveat always applies.
  const list = notices(view);
  const all = list.includes(NOTICE_MASKED) ? list : [...list, NOTICE_MASKED];
  return `<ul class="notice">${all.map((n) => `<li>${escapeHtmlText(n)}</li>`).join("")}</ul>`;
}

function importCode(id: string): string {
  return RE_IMP.test(id) ? `<code>${id.slice(0, 12)}</code>` : escapeHtmlText(id.slice(0, 12));
}

function sessionBody(
  view: SessionView,
  ex: Explanation,
  o: RenderOptions,
  nav: string,
  extra: string,
): string {
  const { shown, total } = renderedEvents(view, o);
  // The stream, its detail blocks and the trace cover the same prefix; its ids are the anchors.
  const covered = shown.length > TRACE_MAX_EVENTS ? shown.slice(0, TRACE_MAX_EVENTS) : shown;
  const anchors = new Set<string>(covered.map((e) => e.eventId));
  const homes = [o.homeDir, o.realHomeDir ?? null];
  const mask = (s: string): string => maskFree(s, o);
  const trace = buildTrace(covered);
  const log = buildActionLog(shown, homes);
  const streamLog = covered === shown ? log : buildActionLog(covered, homes);
  const stream = renderStream(view, covered, total, trace, streamLog, o, anchors);
  // Cards, duration and the top bar all use the same scope: the events the stream and trace cover.
  const span = spanMs(covered);
  const { record } = view;
  const flags = [
    record.adapter.experimental ? "experimental" : "",
    record.adapter.sourceStability === "undocumented" ? "undocumented" : "",
    record.adapter.sourceStability === "internal-unstable" ? "internal" : "",
    record.contentRetention === "hash-only" ? "hash-only" : "inline",
  ].filter((x) => x !== "");
  const stats = [
    `<span><span class="em">${num(total)}</span> events</span>`,
    `<span>${span === null ? "duration n/a" : formatDuration(span)}</span>`,
    `<span>${esc(record.provider, o)}</span>`,
    ...flags.map((f) => `<span class="flag">${f}</span>`),
  ].join("");
  const crumb = `/ ${nav === "" ? "sessions" : nav} / ${esc(record.provider, o)} / ${importCode(record.importId)}`;

  const out: string[] = [topBar(crumb, stats, resolveBrand(o))];
  // `extra` is trusted markup built by the server page code (run header, navigation); empty for
  // exports, which keeps them byte-identical.
  if (extra !== "") out.push(extra);
  out.push(noticeList(view));
  out.push(cardsHtml(sessionCards(trace, stream.subagents, span)));
  if (covered.length < total) {
    out.push(
      `<p class="sn dim cardnote">Cards are computed over the first ${num(covered.length)} of ${num(total)} events.</p>`,
    );
  }
  out.push(stream.minimap, stream.grid);

  out.push('<section class="tabs" id="tabs">');
  const bar = TABS.map(
    ([k, name], i) =>
      `<input type="radio" name="tab" id="t-${k}"${i === 0 ? " checked" : ""}><label for="t-${k}">${name}</label>`,
  );
  out.push(`<div class="tabbar">${bar.join("")}</div>`);

  out.push('<div class="panel" id="p-ex"><h2>Explanation</h2>');
  for (const sec of ex.sections) {
    out.push(`<h3>${escapeHtmlText(sec.title)}</h3>`);
    if (sec.statements.length === 0) {
      out.push('<p class="dim">No evidence-backed statements for this section.</p>');
    } else {
      out.push("<ul>", ...sec.statements.map((s) => statementHtml(s, o, anchors)), "</ul>");
    }
  }
  out.push("</div>");

  out.push(
    '<div class="panel" id="p-wf"><h2>Trace</h2>',
    renderTrace(
      trace,
      {
        hashOnly: record.contentRetention === "hash-only",
        covered: covered.length,
        total,
      },
      o,
      anchors,
    ),
    "</div>",
  );

  out.push(
    '<div class="panel" id="p-cm"><h2>Commands and actions</h2>',
    renderActions(log, { covered: shown.length, total }, o, anchors),
    "</div>",
  );

  out.push('<div class="panel" id="p-tl"><h2>Timeline</h2>');
  if (shown.length < total) {
    out.push(
      `<p class="dim">Timeline truncated: showing the first ${num(shown.length)} of ${num(total)} events.</p>`,
    );
  }
  out.push(
    '<div class="scroll"><table>',
    "<thead><tr><th>Seq</th><th>Event</th><th>Kind</th><th>Status</th><th>Actor</th><th>Time</th><th>Detail</th><th>Source</th></tr></thead>",
    "<tbody>",
  );
  for (const e of shown) {
    out.push(
      `<tr${statusClass(e.status)}><td>${num(e.sourceSequence)}.${num(e.subIndex)}</td><td>${idCode(e.eventId)}</td><td>${esc(e.kind, o)}</td><td>${esc(e.status, o)}</td><td>${esc(e.actor.role, o)}</td><td>${esc(eventTimeText(e), o)}</td><td>${partsHtml(describe(e, mask), o)}</td><td>${esc(provenanceText(e), o)}</td></tr>`,
    );
  }
  out.push("</tbody></table></div></div>");

  out.push('<div class="panel" id="p-wn"><h2>Warnings and gaps</h2>');
  const gaps = gapEvents(view.result.events);
  if (gaps.length === 0 && view.result.warnings.length === 0) {
    out.push('<p class="dim">No warnings, capture gaps or unknown records.</p>');
  } else {
    out.push(
      '<div class="scroll"><table><thead><tr><th>Where</th><th>Kind</th><th>Detail</th></tr></thead><tbody>',
    );
    for (const g of gaps) {
      out.push(
        `<tr><td>${evtLink(g.eventId, anchors)}</td><td>${esc(g.kind, o)}</td><td>${partsHtml(describe(g, mask), o)}</td></tr>`,
      );
    }
    for (const w of view.result.warnings) {
      out.push(
        `<tr><td>${w.sourceSequence === null ? "none" : num(w.sourceSequence)}</td><td>warning ${esc(w.code, o)} (${esc(w.severity, o)})</td><td>${esc(warningDetail(w.detail), o)}</td></tr>`,
      );
    }
    out.push("</tbody></table></div>");
  }
  out.push("</div>", "</section>");
  return out.join("\n");
}

/** A self-contained report: CSP with a hashed style block, no script, no external resource. */
export function renderHtmlReport(view: SessionView, ex: Explanation, o: RenderOptions): string {
  return renderSessionPage(view, ex, o, "");
}

/** The nav link of a local-UI session page (fixed relative index file). */
export const UI_SESSION_NAV = '<a href="../index.html">sessions</a>';

/** A session page of the local UI; links back to the fixed relative index file. */
export function renderUiSessionPage(view: SessionView, ex: Explanation, o: RenderOptions): string {
  return renderSessionPage(view, ex, o, UI_SESSION_NAV);
}

/**
 * One complete session document; `nav` is trusted markup (see `UI_SESSION_NAV`). `web` is set only
 * by server run pages: trusted markup inserted under the top bar, and the server CSP.
 */
export function renderSessionPage(
  view: SessionView,
  ex: Explanation,
  o: RenderOptions,
  nav: string,
  web?: { readonly extra: string },
): string {
  return checkSize(
    htmlDoc(
      `${resolveBrand(o).name} session report`,
      sessionBody(view, ex, o, nav, web?.extra ?? ""),
      web === undefined ? "static" : "server",
    ),
    o,
  );
}

function filterGroup(
  legend: string,
  prefix: "p" | "o",
  values: readonly string[],
  name: string,
): string {
  const inputs = [
    `<input type="radio" name="${name}" id="f-${prefix}-all" checked><label for="f-${prefix}-all">all</label>`,
    ...values.map(
      (v) =>
        `<input type="radio" name="${name}" id="f-${prefix}-${v}"><label for="f-${prefix}-${v}">${escapeHtmlText(v)}</label>`,
    ),
  ];
  return `<fieldset><legend>${escapeHtmlText(legend)}</legend>${inputs.join("")}</fieldset>`;
}

function member<T extends string>(list: readonly T[], v: string): T | null {
  return list.find((x) => x === v) ?? null;
}

/**
 * Static stub page for a session whose full page exceeds the size limit. It carries no session data
 * except the validated import id and the escaped provider.
 */
export function renderUiTooLargePage(record: ImportRecord, o: RenderOptions): string {
  const crumb = `<a href="../index.html">sessions</a> / ${esc(record.provider, o)} / ${importCode(record.importId)}`;
  const body = [
    topBar(`/ ${crumb}`, "", resolveBrand(o)),
    '<ul class="notice"><li>This session is too large for a static page and was not rendered. Use swain report or swain commands to read it.</li></ul>',
  ].join("\n");
  return htmlDoc(`${resolveBrand(o).name} session too large`, body);
}

function recordSpanMs(r: ImportRecord): number | null {
  if (r.firstEventTime === null || r.lastEventTime === null) return null;
  const a = new Date(r.firstEventTime).getTime();
  const b = new Date(r.lastEventTime).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

/**
 * The static session explorer: stat cards and a dense table with CSS-only provider and outcome
 * filters. Every figure comes from the `ImportRecord`; no session is loaded.
 */
export function renderUiIndex(records: readonly ImportRecord[], o: RenderOptions): string {
  const sorted = [...records].sort((a, b) => {
    const ta = a.firstEventTime ?? "";
    const tb = b.firstEventTime ?? "";
    return ta < tb
      ? -1
      : ta > tb
        ? 1
        : a.importId < b.importId
          ? -1
          : a.importId > b.importId
            ? 1
            : 0;
  });
  const out: string[] = [];
  out.push(
    topBar(
      "/ sessions",
      `<span><span class="em">${num(sorted.length)}</span> sessions</span><span>local, offline</span>`,
      resolveBrand(o),
    ),
  );
  const labels = [
    "hashes allow confirmation of guessed content; do not share exports",
    "content is hash-only unless an import kept inline content, which is masked best-effort; masking is not a guarantee",
    "sources marked experimental or undocumented may change without notice",
  ];
  out.push(
    `<ul class="notice">${labels.map((n) => `<li>${escapeHtmlText(n)}</li>`).join("")}</ul>`,
  );
  let events = 0;
  let failed = 0;
  let withGaps = 0;
  for (const r of sorted) {
    events += r.counts.events;
    failed += r.counts.byKind["tool.failed"] ?? 0;
    if (r.counts.gaps > 0) withGaps++;
  }
  out.push(
    cardsHtml([
      { label: "Sessions", value: num(sorted.length) },
      { label: "Providers", value: num(new Set(sorted.map((r) => r.provider)).size) },
      { label: "Events", value: num(events) },
      { label: "Failed / denied / interrupted", value: num(failed), bad: failed > 0 },
      { label: "Imports with gaps", value: num(withGaps) },
    ]),
  );
  out.push(
    `<div class="filters">${filterGroup("Provider", "p", PROVIDERS, "fp")}${filterGroup("Outcome", "o", IMPORT_OUTCOMES, "fo")}</div>`,
  );
  out.push(
    '<div class="wrap scroll"><table class="idx">',
    "<thead><tr><th>Provider</th><th>Import</th><th>Outcome</th><th>First time</th><th>Duration</th><th>Events</th><th>Tool requests</th><th>Failed / denied / interrupted</th><th>Gaps</th><th>Source</th></tr></thead>",
    "<tbody>",
  );
  if (sorted.length === 0) out.push('<tr><td colspan="10">No sessions imported yet.</td></tr>');
  for (const r of sorted) {
    const prov = member(PROVIDERS, r.provider);
    const outc = member(IMPORT_OUTCOMES, r.outcome);
    const attrs = `${prov === null ? "" : ` data-provider="${prov}"`}${outc === null ? "" : ` data-outcome="${outc}"`}`;
    const idCell = RE_IMP.test(r.importId)
      ? `<a href="sessions/${r.importId}.html"><code>${r.importId.slice(0, 12)}</code></a>`
      : escapeHtmlText(r.importId);
    const flags = [
      r.adapter.experimental ? "experimental" : "",
      r.adapter.sourceStability === "undocumented" ? "undocumented" : "",
    ].filter((x) => x !== "");
    const kind = `${esc(r.sourceKind, o)}${flags.length > 0 ? ` <span class="tag">${flags.join(", ")}</span>` : ""}`;
    const span = recordSpanMs(r);
    const nFailed = r.counts.byKind["tool.failed"] ?? 0;
    out.push(
      `<tr${attrs}><td>${esc(r.provider, o)}</td><td>${idCell}</td><td>${esc(r.outcome, o)}</td><td>${esc(r.firstEventTime ?? "(none)", o)}</td><td>${span === null ? "n/a" : formatDuration(span)}</td><td>${num(r.counts.events)}</td><td>${num(r.counts.byKind["tool.requested"] ?? 0)}</td><td${nFailed > 0 ? ' class="f"' : ""}>${num(nFailed)}</td><td>${num(r.counts.gaps)}</td><td>${esc(r.source.displayName, o)} ${kind}</td></tr>`,
    );
  }
  out.push("</tbody></table></div>");
  return checkSize(htmlDoc(`${resolveBrand(o).name} sessions`, out.join("\n")), o);
}
