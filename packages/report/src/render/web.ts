/**
 * Server-rendered Swain pages (SPEC-003 N1.6, ADR-0007 section 5, ADR-0008): login, fleet, agent,
 * runs list, run header and the span run page, plus static messages. Pure: strings in, string out.
 *
 * Rules: no script, no `on*` attribute, no `style` attribute, no external URL. Every untrusted string
 * goes through `esc` (home-directory masking, entity escaping, L1 neutralization); every ID is
 * regex-validated before it is placed in markup or in an `href`, and every `href` is built from a
 * fixed route and a validated ID. The one stylesheet and its CSP hash are the static viewer's.
 */
import { escapeHtmlText } from "../escape.js";
import type { RenderOptions, SessionView } from "../types.js";
import type {
  AgentPageView,
  AttrView,
  CredentialView,
  FleetRowView,
  FleetView,
  RunHeader,
  RunRowView,
  RunStatusName,
  RunsListView,
  SpanRowView,
  SpanRunView,
  TextView,
  WebMessageCode,
  WebNav,
} from "../web-types.js";
import { checkSize, maskFree } from "./common.js";
import { esc, num } from "./html-util.js";
import { capBytes, renderRunTabs } from "./runtabs.js";
import { htmlDoc, resolveBrand, topBar } from "./shell.js";
import { formatDuration } from "./stream.js";
import { BAR_STEPS, quantize } from "./trace.js";

const RE_AGT = /^agt_[0-9a-f]{32}$/;
const RE_RUN = /^run_[0-9a-f]{32}$/;
const RE_KEY = /^key_[0-9a-f]{16}$/;
const RE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RE_HEX64 = /^[0-9a-f]{64}$/;
const RE_HEX32 = /^[0-9a-f]{32}$/;
const RE_SPAN = /^[0-9a-f]{16}$/;
/** A login code: 32 random bytes in unpadded base64url. */
const RE_CODE = /^[A-Za-z0-9_-]{43}$/;

/** Static, input-free page texts (SPEC-003 section 3.1: no error ever echoes input). */
export const WEB_MESSAGES: Readonly<
  Record<WebMessageCode, { readonly heading: string; readonly lines: readonly string[] }>
> = Object.freeze({
  "signin-required": {
    heading: "Sign in required",
    lines: [
      "No valid session. Run swain open in a terminal on this machine and paste the printed URL into your browser.",
      "The link works once and expires after 60 seconds. Pasting is preferred over launching a browser with xdg-open.",
    ],
  },
  "not-found": { heading: "Not found", lines: ["Nothing is visible at this address."] },
  csrf: {
    heading: "Request refused",
    lines: ["The request did not come from this server's own page."],
  },
  "bad-request": { heading: "Bad request", lines: ["The request is malformed."] },
  "method-not-allowed": {
    heading: "Method not allowed",
    lines: ["This address does not accept that method."],
  },
  "rate-limited": { heading: "Too many requests", lines: ["Wait a moment and try again."] },
  busy: { heading: "Busy", lines: ["The server is busy. Retry later."] },
  internal: { heading: "Internal error", lines: ["Something went wrong. Nothing was changed."] },
  "too-large": {
    heading: "Run too large to render",
    lines: ["This run is too large to render as one page. Its data is stored and unchanged."],
  },
  misdirected: {
    heading: "Misdirected request",
    lines: ["This server answers only to its own loopback address."],
  },
});

function iso(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 8_640_000_000_000_000) return "n/a";
  return new Date(ms).toISOString();
}

function nsToMs(ns: bigint | null): number | null {
  if (ns === null || ns <= 0n) return null;
  return Number(ns / 1_000_000n);
}

function statusHtml(s: RunStatusName, error: boolean): string {
  const cls = s === "incomplete" ? "b-warn" : "b-ok";
  const word =
    s === "active" || s === "idle" || s === "ended" || s === "incomplete" ? s : "unknown";
  return `<span class="${cls}">${word}</span>${error ? ' <span class="b-bad">error</span>' : ""}`;
}

function idLink(prefix: "/a/" | "/r/", id: string, ok: RegExp, shown: number): string {
  if (!ok.test(id)) return escapeHtmlText(id.slice(0, 12));
  return `<a href="${prefix}${id}"><code>${id.slice(0, shown)}</code></a>`;
}

function credentialsHtml(list: readonly CredentialView[], o: RenderOptions): string {
  if (list.length === 0) return '<span class="dim">none recorded</span>';
  return list
    .map((c) => {
      const id = RE_KEY.test(c.keyId)
        ? `<code>${c.keyId}</code>`
        : escapeHtmlText(c.keyId.slice(0, 20));
      const label = c.label === null ? "" : ` ${esc(c.label, o)}`;
      const pin =
        c.agentName === null ? "" : ` <span class="dim">pinned to ${esc(c.agentName, o)}</span>`;
      return `<span class="ln">${id}${label}${pin} <span class="dim">${num(c.records)} records</span></span>`;
    })
    .join("");
}

/** The persistent notice of ADR-0008 section 2 when more than one credential delivered records. */
function multiCredentialNotice(list: readonly CredentialView[]): string {
  return list.length > 1
    ? '<ul class="notice"><li>multiple credentials contributed to this run; each row shows the credential that delivered it, agent names are supplied by the sender, and none is treated as canonical over another</li></ul>'
    : "";
}

function navBlock(w: WebNav): string {
  const form =
    w.csrf !== null && RE_HEX64.test(w.csrf)
      ? `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${w.csrf}"><button type="submit">Sign out</button></form>`
      : "";
  return `<div class="wrap"><a href="/">Fleet</a> <a href="/runs">Runs</a> <span class="dim">as of ${iso(w.nowMs)}</span>${form}</div>`;
}

const CONTENT_NOTICES = [
  "hashes allow confirmation of guessed content; do not share these pages",
  "kept metadata strings are masked best-effort; masking is not a guarantee",
];

function noticeHtml(lines: readonly string[]): string {
  return `<ul class="notice">${lines.map((n) => `<li>${escapeHtmlText(n)}</li>`).join("")}</ul>`;
}

function shell(title: string, crumb: string, parts: readonly string[], o: RenderOptions): string {
  const brand = resolveBrand(o);
  return checkSize(
    htmlDoc(`${brand.name} ${title}`, [topBar(crumb, "", brand), ...parts].join("\n"), "server"),
    o,
  );
}

// ---- login, messages ---------------------------------------------------------------------------

/**
 * `GET /login?code=`: a page with one POST form carrying the code. It consumes nothing and shows no
 * data (SPEC-003 section 3.5). The code must be well formed; anything else gets the sign-in hint.
 */
export function renderLoginPage(code: string, o: RenderOptions): string {
  if (typeof code !== "string" || !RE_CODE.test(code))
    return renderMessagePage("signin-required", o);
  return shell(
    "sign in",
    "/ sign in",
    [
      `<div class="wrap"><h2>Sign in</h2><p>Continue to open a session on this machine. The one-time code is used when you press the button, not when this page loads.</p><form method="post" action="/login"><input type="hidden" name="code" value="${code}"><button type="submit">Continue</button></form></div>`,
    ],
    o,
  );
}

/** A static message page (sign-in hint, 404, errors). It never carries data or echoes input. */
export function renderMessagePage(code: WebMessageCode, o: RenderOptions): string {
  const m = Object.hasOwn(WEB_MESSAGES, code) ? WEB_MESSAGES[code] : WEB_MESSAGES.internal;
  return shell(
    m.heading.toLowerCase(),
    `/ ${escapeHtmlText(m.heading.toLowerCase())}`,
    [
      `<div class="wrap"><h2>${escapeHtmlText(m.heading)}</h2>${m.lines.map((l) => `<p>${escapeHtmlText(l)}</p>`).join("")}</div>`,
    ],
    o,
  );
}

// ---- fleet, agent, runs ------------------------------------------------------------------------

function projectLinks(slugs: readonly string[], current: string, path: "/" | "/runs"): string {
  if (slugs.length < 2) return "";
  const items = slugs
    .filter((s) => RE_SLUG.test(s))
    .map((s) => (s === current ? `<code>${s}</code>` : `<a href="${path}?p=${s}">${s}</a>`));
  return `<div class="wrap">projects: ${items.join(" ")}</div>`;
}

function fleetRow(r: FleetRowView, o: RenderOptions): string {
  return `<tr><td>${idLink("/a/", r.agentId, RE_AGT, 12)} ${esc(r.displayName, o)}</td><td>${statusHtml(r.status, r.error)}</td><td>${esc(iso(r.lastSeenMs), o)}</td><td>${num(r.runCount)}</td><td>${credentialsHtml(r.credentials, o)}</td><td>${esc(r.keyBasis, o)}</td></tr>`;
}

export function renderFleetPage(v: FleetView, o: RenderOptions, w: WebNav): string {
  const slug = RE_SLUG.test(v.project.slug) ? v.project.slug : "project";
  const counts = new Map<RunStatusName, number>();
  for (const r of v.rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const cards = (["active", "idle", "ended", "incomplete"] as const)
    .map(
      (s) =>
        `<div class="card"><div class="cl">${s}</div><div class="cv">${num(counts.get(s) ?? 0)}</div></div>`,
    )
    .join("");
  const sortLinks =
    v.sort === "recent"
      ? `sorted by last seen · <a href="/?sort=name${slug === "default" ? "" : `&amp;p=${slug}`}">sort by name</a>`
      : `sorted by name · <a href="/?sort=recent${slug === "default" ? "" : `&amp;p=${slug}`}">sort by last seen</a>`;
  const body = [
    navBlock(w),
    noticeHtml([
      ...CONTENT_NOTICES,
      `content policy ${v.project.contentPolicy === "inline" ? "inline" : "hash-only"}; status is computed from receipt times and end evidence, not reported by agents`,
    ]),
    `<div class="stats">${cards}</div>`,
    projectLinks(v.projectSlugs, slug, "/"),
    `<div class="wrap"><p class="dim">${num(v.total)} ${v.total === 1 ? "agent" : "agents"}, ${sortLinks}</p></div>`,
    '<div class="wrap scroll"><table><thead><tr><th>Agent</th><th>Status</th><th>Last seen</th><th>Runs</th><th>Credentials</th><th>Key basis</th></tr></thead><tbody>',
    v.rows.length === 0
      ? '<tr><td colspan="6">No agents yet. Point an OTLP/HTTP JSON exporter at this server; see the quickstart guide.</td></tr>'
      : v.rows.map((r) => fleetRow(r, o)).join("\n"),
    "</tbody></table></div>",
  ];
  return shell("fleet", `/ fleet / <code>${slug}</code>`, body, o);
}

const COUNT_KEYS = ["spans", "events", "logs"] as const;

function countsText(c: Readonly<Record<string, number>>): string {
  const parts = COUNT_KEYS.filter((k) => Object.hasOwn(c, k) && (c[k] ?? 0) > 0).map(
    (k) => `${num(c[k] ?? 0)} ${k}`,
  );
  return parts.length === 0 ? "none" : parts.join(", ");
}

function runRow(r: RunRowView, o: RenderOptions): string {
  const kind =
    r.kind === "trace" || r.kind === "session" || r.kind === "import" || r.kind === "logs"
      ? r.kind
      : "unknown";
  return `<tr><td>${idLink("/r/", r.runId, RE_RUN, 16)}</td><td>${kind}</td><td>${idLink("/a/", r.agentId, RE_AGT, 12)} ${esc(r.agentName, o)}</td><td>${statusHtml(r.status, r.error)}</td><td>${esc(iso(r.firstReceivedMs), o)}</td><td>${esc(iso(r.lastReceivedMs), o)}</td><td>${countsText(r.counts)}</td><td>${credentialsHtml(r.credentials, o)}</td></tr>`;
}

const RUN_HEAD =
  "<thead><tr><th>Run</th><th>Kind</th><th>Agent</th><th>Status</th><th>First received</th><th>Last received</th><th>Records</th><th>Credentials</th></tr></thead>";

export function renderAgentPage(v: AgentPageView, o: RenderOptions, w: WebNav): string {
  const a = v.agent;
  const id = RE_AGT.test(a.agentId) ? a.agentId : "agt_invalid";
  const body = [
    navBlock(w),
    noticeHtml(CONTENT_NOTICES),
    multiCredentialNotice(a.credentials),
    `<div class="wrap"><h2>${esc(a.displayName, o)}</h2><dl class="kv"><dt>agent</dt><dd><code>${id}</code></dd><dt>key basis</dt><dd>${esc(a.keyBasis, o)}</dd><dt>status</dt><dd>${statusHtml(a.status, a.error)}</dd><dt>first seen</dt><dd>${esc(iso(a.firstSeenMs), o)}</dd><dt>last seen</dt><dd>${esc(iso(a.lastSeenMs), o)}</dd><dt>runs</dt><dd>${num(a.runCount)}</dd><dt>credentials</dt><dd>${credentialsHtml(a.credentials, o)}</dd></dl></div>`,
    `<div class="wrap scroll"><table>${RUN_HEAD}<tbody>`,
    v.runs.length === 0
      ? '<tr><td colspan="8">No runs.</td></tr>'
      : v.runs.map((r) => runRow(r, o)).join("\n"),
    "</tbody></table></div>",
  ];
  return shell(
    "agent",
    `/ <a href="/">fleet</a> / agent / <code>${id.slice(0, 12)}</code>`,
    body,
    o,
  );
}

export function renderRunsListPage(v: RunsListView, o: RenderOptions, w: WebNav): string {
  const slug = RE_SLUG.test(v.project.slug) ? v.project.slug : "project";
  const body = [
    navBlock(w),
    noticeHtml(CONTENT_NOTICES),
    projectLinks(v.projectSlugs, slug, "/runs"),
    `<div class="wrap"><p class="dim">${num(v.total)} ${v.total === 1 ? "run" : "runs"}, most recent first</p></div>`,
    `<div class="wrap scroll"><table>${RUN_HEAD}<tbody>`,
    v.rows.length === 0
      ? '<tr><td colspan="8">No runs yet.</td></tr>'
      : v.rows.map((r) => runRow(r, o)).join("\n"),
    "</tbody></table></div>",
  ];
  return shell("runs", `/ <a href="/">fleet</a> / runs / <code>${slug}</code>`, body, o);
}

// ---- run header (shared) -----------------------------------------------------------------------

/**
 * The run header with the contributing credentials, the persistent "multiple credentials
 * contributed" notice and, for runs with several sources, the index of the parts.
 */
export function runHeaderHtml(
  h: RunHeader,
  o: RenderOptions,
  w: WebNav,
  parts?: {
    readonly views: readonly SessionView[];
    readonly keys: readonly string[];
    readonly selected: number;
  },
): string {
  const rid = RE_RUN.test(h.runId) ? h.runId : "run_invalid";
  const trace =
    h.traceId !== null && RE_HEX32.test(h.traceId)
      ? `<dt>trace</dt><dd><code>${h.traceId}</code></dd>`
      : "";
  const session = h.sessionKey === null ? "" : `<dt>session</dt><dd>${esc(h.sessionKey, o)}</dd>`;
  const out: string[] = [navBlock(w), noticeHtml(CONTENT_NOTICES)];
  const mc = multiCredentialNotice(h.credentials);
  if (mc !== "") out.push(mc);
  if (parts !== undefined && parts.views.length > 1) {
    out.push(
      noticeHtml([
        `${num(parts.views.length)} sources; ordered by first timestamp; not causally ordered`,
      ]),
    );
  }
  out.push(
    `<div class="wrap"><h2>Run <code>${rid.slice(0, 16)}</code></h2><dl class="kv"><dt>agent</dt><dd>${idLink("/a/", h.agentId, RE_AGT, 12)} ${esc(h.agentName, o)}</dd><dt>kind</dt><dd>${esc(h.kind, o)}</dd><dt>status</dt><dd>${statusHtml(h.status, h.error)}${h.late ? ' <span class="b-warn">late data</span>' : ""}</dd>${trace}${session}<dt>records</dt><dd>${countsText(h.counts)}</dd><dt>first received</dt><dd>${esc(iso(h.firstReceivedMs), o)}</dd><dt>last received</dt><dd>${esc(iso(h.lastReceivedMs), o)}</dd><dt>content policy</dt><dd>${h.contentPolicy === "inline" ? "inline" : "hash-only"}</dd><dt>credentials</dt><dd>${credentialsHtml(h.credentials, o)}</dd></dl></div>`,
  );
  if (parts !== undefined && parts.views.length > 1 && RE_RUN.test(h.runId)) {
    const rows = parts.views.map((v, i) => {
      const k = i + 1;
      const key = parts.keys[i] ?? "";
      const keyHtml = RE_KEY.test(key) ? `<code>${key}</code>` : esc(key.slice(0, 20), o);
      const link =
        k === parts.selected
          ? `<strong>part ${num(k)} (shown)</strong>`
          : `<a href="/r/${h.runId}?part=${num(k)}">part ${num(k)}</a>`;
      return `<tr><td>${link}</td><td>${esc(v.record.provider, o)}</td><td>${esc(v.record.adapter.id, o)}</td><td>${num(v.record.counts.events)}</td><td>${esc(v.record.outcome, o)}</td><td>${esc(v.record.firstEventTime ?? "n/a", o)}</td><td>${keyHtml}</td></tr>`;
    });
    out.push(
      `<div class="wrap scroll"><table><thead><tr><th>Source</th><th>Provider</th><th>Adapter</th><th>Events</th><th>Outcome</th><th>First event</th><th>Credential</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
    );
  } else if (parts !== undefined && parts.views.length === 1) {
    const key = parts.keys[0] ?? "";
    if (key !== "") {
      out.push(
        `<div class="wrap dim">source delivered by ${RE_KEY.test(key) ? `<code>${key}</code>` : esc(key.slice(0, 20), o)}</div>`,
      );
    }
  }
  return out.join("\n");
}

// ---- span run page -----------------------------------------------------------------------------

const MAX_ATTRS_SHOWN = 50;
const MAX_DEPTH = 16;

function textView(t: TextView, o: RenderOptions, inline: boolean): string {
  switch (t.kind) {
    case "text":
      return `${esc(t.value, o)}${t.masked ? ' <span class="tag">best-effort masked</span>' : ""}`;
    case "content": {
      const h = RE_HEX64.test(t.sha256) ? t.sha256.slice(0, 12) : "invalid";
      if (!inline || t.inline === null) {
        return `<span class="dim">content not stored (hash-only): sha256 <code>${h}</code>, ${num(t.byteLength)} bytes</span>`;
      }
      const c = capBytes(maskFree(t.inline, o));
      return `${esc(c.text, o)}${c.cut ? ' <span class="tag">truncated</span>' : ""} <span class="tag">inline, best-effort masked</span>`;
    }
    case "scalar":
      return esc(t.value, o);
    case "omitted":
      return `<span class="dim">[${t.label === "array" || t.label === "map" || t.label === "over-depth" ? t.label : "value"}, ${num(t.size)} items not shown]</span>`;
  }
}

function attrsTable(attrs: readonly AttrView[], o: RenderOptions, inline: boolean): string {
  if (attrs.length === 0) return '<p class="dim">No attributes.</p>';
  const shown = attrs.slice(0, MAX_ATTRS_SHOWN);
  const rows = shown
    .map(
      (a) =>
        `<tr><td>${esc(a.key, o)}${a.keyAltered ? ' <span class="tag">key altered</span>' : ""}</td><td>${textView(a.value, o, inline)}</td></tr>`,
    )
    .join("");
  const more =
    attrs.length > shown.length
      ? `<p class="dim">${num(attrs.length - shown.length)} more attributes not shown.</p>`
      : "";
  return `<table><thead><tr><th>Attribute</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
}

interface Ordered {
  readonly span: SpanRowView;
  readonly depth: number;
  readonly orphan: boolean;
}

/** Depth-first tree order by `parentSpanId`; spans whose parent was not received form their own group. */
function orderSpans(spans: readonly SpanRowView[]): Ordered[] {
  const ids = new Set(spans.map((s) => s.spanId));
  const children = new Map<string, SpanRowView[]>();
  const roots: SpanRowView[] = [];
  const orphans: SpanRowView[] = [];
  for (const s of spans) {
    if (s.parentSpanId === null) roots.push(s);
    else if (!ids.has(s.parentSpanId) || s.parentSpanId === s.spanId) orphans.push(s);
    else {
      const l = children.get(s.parentSpanId);
      if (l === undefined) children.set(s.parentSpanId, [s]);
      else l.push(s);
    }
  }
  const out: Ordered[] = [];
  const seen = new Set<string>();
  const walk = (s: SpanRowView, depth: number, orphan: boolean): void => {
    if (seen.has(`${s.spanId}:${s.keyId}:${s.parentSpanId}`)) return;
    seen.add(`${s.spanId}:${s.keyId}:${s.parentSpanId}`);
    out.push({ span: s, depth: Math.min(depth, MAX_DEPTH), orphan });
    for (const c of children.get(s.spanId) ?? []) walk(c, depth + 1, orphan);
  };
  const byStart = (a: SpanRowView, b: SpanRowView): number => {
    const x = a.startNs ?? 0n;
    const y = b.startNs ?? 0n;
    return x < y ? -1 : x > y ? 1 : a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
  };
  for (const r of [...roots].sort(byStart)) walk(r, 0, false);
  for (const r of [...orphans].sort(byStart)) walk(r, 0, true);
  return out;
}

function spanDuration(s: SpanRowView): string {
  const a = nsToMs(s.startNs);
  const b = nsToMs(s.endNs);
  if (a === null || b === null || b < a) return "n/a";
  return formatDuration(b - a);
}

/** Tab order of the span run page: Commands is the default. */
const SPAN_PAGE_TABS = [
  ["cm", "Commands"],
  ["tl", "Timeline"],
  ["ag", "Agents"],
  ["wf", "Waterfall"],
  ["sp", "Spans"],
] as const;

const SPAN_STATUS = ["unset", "ok", "error"] as const;
const OP_CLASSES = ["llm", "tool", "agent", "handoff", "workflow", "generic"] as const;

/**
 * The span run page: a waterfall (tree by `parentSpanId`, a "parent not received" group), a spans
 * table with the credential that delivered each record, per-span detail blocks, and conflicting
 * records. Durations are computed as end minus start from the sender's own timestamps.
 */
export function renderSpanRunPage(v: SpanRunView, o: RenderOptions, w: WebNav): string {
  const inline = v.run.contentPolicy === "inline";
  const ordered = orderSpans(v.spans);
  let t0 = Number.POSITIVE_INFINITY;
  let t1 = Number.NEGATIVE_INFINITY;
  for (const { span } of ordered) {
    const a = nsToMs(span.startNs);
    const b = nsToMs(span.endNs);
    if (a !== null) {
      t0 = Math.min(t0, a);
      t1 = Math.max(t1, b ?? a);
    }
  }
  const range = Number.isFinite(t0) && t1 > t0 ? t1 - t0 : 1;
  const wf: string[] = [];
  let orphanStarted = false;
  for (const { span, depth, orphan } of ordered) {
    if (orphan && !orphanStarted) {
      orphanStarted = true;
      wf.push('<p class="b-warn">parent not received</p>');
    }
    const a = nsToMs(span.startNs);
    const b = nsToMs(span.endNs);
    const bar =
      a === null
        ? ""
        : (() => {
            const q = quantize(a, b ?? a, Number.isFinite(t0) ? t0 : a, range);
            return `<span class="bar o${num(q.offset)} w${num(Math.max(1, Math.min(BAR_STEPS, q.width)))}${span.statusCode === 2 ? " bad" : ""}"></span>`;
          })();
    wf.push(
      `<div class="wr"><span class="wn i${num(depth)}"><code>${textView(span.name, o, inline)}</code></span><span class="wf">${bar}</span><span class="wd">${spanDuration(span)}</span></div>`,
    );
  }
  const rows = ordered.map(({ span: s }) => {
    const sid = RE_SPAN.test(s.spanId) ? s.spanId : "invalid";
    const parent =
      s.parentSpanId !== null && RE_SPAN.test(s.parentSpanId)
        ? `<code>${s.parentSpanId}</code>`
        : '<span class="dim">none</span>';
    const status = SPAN_STATUS[s.statusCode] ?? "unknown";
    const op = (OP_CLASSES as readonly string[]).includes(s.opClass) ? s.opClass : "generic";
    const key = RE_KEY.test(s.keyId) ? `<code>${s.keyId}</code>` : esc(s.keyId.slice(0, 20), o);
    return `<tr${s.statusCode === 2 ? ' class="bad"' : ""}><td><a href="#s-${sid}"><code>${sid}</code></a></td><td>${parent}</td><td>${op}</td><td>${status}${s.late ? ' <span class="b-warn">late</span>' : ""}</td><td>${esc(iso(nsToMs(s.startNs) ?? -1), o)}</td><td>${spanDuration(s)}</td><td>${key}</td><td>${s.canonical ? "yes" : '<span class="b-warn">no: conflicting records from different credentials</span>'}</td></tr>`;
  });
  const details = ordered.map(({ span: s }) => {
    const sid = RE_SPAN.test(s.spanId) ? s.spanId : "invalid";
    const events = s.events
      .slice(0, 20)
      .map(
        (e) =>
          `<h3>Event ${textView(e.name, o, inline)}</h3>${attrsTable(e.attributes, o, inline)}`,
      );
    return `<details id="s-${sid}"><summary>${textView(s.name, o, inline)} <code>${sid}</code></summary><dl class="kv"><dt>kind</dt><dd>${num(s.kind)}</dd><dt>status message</dt><dd>${s.statusMessage === null ? "none" : textView(s.statusMessage, o, inline)}</dd></dl>${attrsTable(s.attributes, o, inline)}${events.join("")}</details>`;
  });
  const conflictRows = v.conflicts.map((c) => {
    const sid = RE_SPAN.test(c.spanId) ? `<code>${c.spanId}</code>` : "invalid";
    const k = (x: string): string => (RE_KEY.test(x) ? `<code>${x}</code>` : "invalid");
    const rel =
      c.relation === "conflicting"
        ? "conflicting record"
        : c.relation === "identical-other-key"
          ? "identical record, other credential"
          : "identical record, same credential";
    return `<tr><td>${sid}</td><td>${rel}</td><td>${k(c.keyId)}</td><td>${k(c.canonicalKeyId)}</td></tr>`;
  });
  if (v.run.kind === "logs") {
    // A logs run holds OTLP log records only; the event view needs the N1.7 projection.
    return shell(
      "run",
      `/ <a href="/">fleet</a> / <a href="/runs">runs</a> / <code>${(RE_RUN.test(v.run.runId) ? v.run.runId : "run_invalid").slice(0, 16)}</code>`,
      [
        runHeaderHtml(v.run, o, w),
        noticeHtml([
          "this run holds OTLP log records only; log content is not shown here (hash-only), and the event view for Claude Code logs is not available yet",
        ]),
      ],
      o,
    );
  }
  const tabs = renderRunTabs(v, o);
  const tabBar = SPAN_PAGE_TABS.map(
    ([k, name], i) =>
      `<input type="radio" name="tab" id="t-${k}"${i === 0 ? " checked" : ""}><label for="t-${k}">${name}</label>`,
  ).join("");
  const body = [
    runHeaderHtml(v.run, o, w),
    v.truncated
      ? noticeHtml([
          `only the first ${num(v.spans.length)} spans are shown; the run has more, so the Commands, Timeline and Agents tabs cover only these`,
        ])
      : "",
    `<div class="wrap">${tabs.filter}</div>`,
    '<section class="tabs" id="tabs">',
    `<div class="tabbar">${tabBar}</div>`,
    `<div class="panel" id="p-cm"><h2>Commands</h2>${tabs.commands}</div>`,
    `<div class="panel" id="p-tl"><h2>Timeline</h2>${tabs.timeline}</div>`,
    `<div class="panel" id="p-ag"><h2>Agents</h2>${tabs.agents}</div>`,
    `<div class="panel" id="p-wf"><h2>Waterfall</h2><div class="trace">`,
    wf.length === 0 ? '<p class="dim">No spans.</p>' : wf.join("\n"),
    "</div></div>",
    `<div class="panel" id="p-sp"><h2>Spans</h2><div class="scroll"><table><thead><tr><th>Span</th><th>Parent</th><th>Operation</th><th>Status</th><th>Start</th><th>Duration (end minus start)</th><th>Credential</th><th>Canonical</th></tr></thead><tbody>${rows.join("\n")}</tbody></table></div>`,
    `<h3>Span details</h3>${details.join("\n")}`,
    conflictRows.length === 0
      ? ""
      : `<div class="scroll"><h3>Conflicting and repeated records</h3><p class="dim">none of the conflicting records is treated as canonical</p><table><thead><tr><th>Span</th><th>Relation</th><th>Sent by</th><th>Stored canonical from</th></tr></thead><tbody>${conflictRows.join("")}</tbody></table></div>`,
    "</div>",
    "</section>",
  ].filter((x) => x !== "");
  const rid = RE_RUN.test(v.run.runId) ? v.run.runId : "run_invalid";
  return shell(
    "run",
    `/ <a href="/">fleet</a> / <a href="/runs">runs</a> / <code>${rid.slice(0, 16)}</code>`,
    body,
    o,
  );
}
