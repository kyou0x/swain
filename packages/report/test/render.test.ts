import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalEvent } from "@swain/core";
import {
  explainSession,
  OutputTooLarge,
  renderHtmlReport,
  renderJsonExport,
  renderMarkdown,
  renderUiIndex,
  renderUiSessionPage,
} from "../src/index.js";
import {
  EXPLAIN_OPTS,
  htmlViolations,
  loadSession,
  PROVIDER_FIXTURES,
  RENDER_OPTS,
  readFixture,
  sha256Base64,
  withEvents,
} from "./helpers.js";

const M10 = "hashes allow confirmation of guessed content; do not share exports";

function render(name: string) {
  const view = loadSession(name);
  const ex = explainSession(view, EXPLAIN_OPTS);
  return {
    view,
    ex,
    md: renderMarkdown(view, ex, RENDER_OPTS),
    html: renderHtmlReport(view, ex, RENDER_OPTS),
    json: renderJsonExport(view, ex, RENDER_OPTS),
    ui: renderUiSessionPage(view, ex, RENDER_OPTS),
  };
}

test("golden outputs are byte-equal and re-render is byte-identical", () => {
  for (const name of PROVIDER_FIXTURES) {
    const a = render(name);
    const b = render(name);
    assert.equal(a.md, b.md);
    assert.equal(a.html, b.html);
    assert.equal(a.json, b.json);
    assert.equal(a.ui, b.ui);
    assert.ok(a.md === readFixture(`${name}/report.md`), `${name} report.md golden`);
    assert.ok(a.html === readFixture(`${name}/report.html`), `${name} report.html golden`);
    assert.ok(a.json === readFixture(`${name}/export.json`), `${name} export.json golden`);
    assert.ok(a.ui === readFixture(`${name}/ui-session.html`), `${name} ui-session.html golden`);
  }
  const records = PROVIDER_FIXTURES.map((n) => loadSession(n).record);
  assert.ok(
    renderUiIndex(records, RENDER_OPTS) === readFixture("ui-index.html"),
    "ui-index golden",
  );
});

test("every output carries the M10 wording and the experimental / undocumented labels", () => {
  for (const name of PROVIDER_FIXTURES) {
    const r = render(name);
    const exp = r.view.record.adapter.experimental;
    const stab = r.view.record.adapter.sourceStability;
    for (const out of [r.md, r.html, r.ui]) {
      assert.ok(out.includes(M10), `${name} M10`);
      assert.ok(out.includes(exp ? "EXPERIMENTAL" : "experimental label: no"));
      if (stab === "undocumented") assert.ok(out.includes("UNDOCUMENTED SOURCE"));
      if (stab === "internal-unstable") assert.ok(out.includes("INTERNAL UNSTABLE SOURCE"));
      assert.ok(out.includes("untested provider version"));
    }
    assert.ok(r.json.includes(M10));
    assert.ok(r.json.includes(exp ? "EXPERIMENTAL" : "experimental label: no"));
  }
  const codex = render("codex-cli");
  assert.ok(codex.md.includes("inline content was masked best-effort; masking is not a guarantee"));
  assert.ok(
    codex.html.includes("inline content was masked best-effort; masking is not a guarantee"),
  );
  assert.ok(codex.md.includes("content policy inline"));
  const claude = render("claude-code");
  assert.ok(!claude.md.includes("inline content was masked"));
  assert.ok(claude.md.includes("content policy hash-only"));
  const idx = renderUiIndex([claude.view.record], RENDER_OPTS);
  assert.ok(idx.includes(M10));
});

test("HTML: exact CSP, style hash matches, no script, no style attribute, no external URL", () => {
  for (const name of PROVIDER_FIXTURES) {
    const r = render(name);
    const records = [r.view.record];
    for (const html of [r.html, r.ui, renderUiIndex(records, RENDER_OPTS)]) {
      assert.equal((html.match(/<script/gi) ?? []).length, 0);
      assert.doesNotMatch(html, /\sstyle=/i);
      assert.doesNotMatch(
        html,
        /(href|src)="(?!#evt_|#turn-|#tabs"|\.\.\/index\.html|sessions\/imp_)/,
      );
      assert.doesNotMatch(html, /https?:|\/\/|url\(|@import/i);
      assert.ok(
        html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'),
      );
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
      assert.equal(styles.length, 1);
      const b64 = sha256Base64(styles[0]?.[1] ?? "");
      const csp = `default-src 'none'; style-src 'sha256-${b64}'; img-src 'none'; base-uri 'none'; form-action 'none'`;
      assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
      assert.deepEqual(htmlViolations(html), []);
    }
  }
});

test("HTML: dark only with a print sheet, and evidence links resolve to stream anchors", () => {
  const r = render("claude-code");
  assert.match(r.html, /color-scheme:dark/);
  assert.doesNotMatch(r.html, /prefers-color-scheme/);
  assert.match(r.html, /@media print/);
  const hrefs = [...r.html.matchAll(/href="#(evt_[0-9a-f]{32})"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 20);
  // One id per event: on the stream row (or on the anchor of a result folded into its request row).
  for (const id of hrefs) {
    assert.equal(r.html.split(` id="${id}"`).length - 1, 1, `anchor ${id}`);
    assert.ok(r.ui.includes(` id="${id}"`), `ui anchor ${id}`);
  }
  assert.ok(r.ui.includes('<a href="../index.html">'));
  assert.ok(!r.html.includes("../index.html"));
});

test("Markdown: event IDs are code spans, no link syntax, header facts present", () => {
  const r = render("codex-cli");
  const bare = r.md.replace(/\\[\s\S]/g, "").replace(/`(evt_[0-9a-f]{32}|interp\.[a-z]+)`/g, "");
  assert.doesNotMatch(bare, /[[\]<`!]/);
  assert.ok(r.md.includes("Interpretation: the session outcome is success"));
  assert.ok(r.md.includes("| Seq | Event | Kind |"));
  assert.ok(r.md.endsWith("\n"));
});

test("home directory is masked on every display surface; the raw path is absent", () => {
  for (const name of PROVIDER_FIXTURES) {
    const r = render(name);
    for (const out of [r.md, r.html, r.ui, r.json]) assert.ok(!out.includes("/home/demo"), name);
  }
  assert.ok(render("codex-cli").html.includes("~/repo/src/cli.ts"));
});

test("JSON export: canonical, newline-terminated, spec shape", () => {
  const r = render("gemini-cli");
  assert.ok(r.json.endsWith("}\n"));
  assert.ok(!r.json.slice(0, -1).includes("\n"));
  const doc = JSON.parse(r.json) as Record<string, unknown>;
  assert.deepEqual(Object.keys(doc), [
    "actors",
    "events",
    "explanation",
    "format",
    "notice",
    "record",
    "source",
    "stats",
    "warnings",
  ]);
  assert.equal(doc["format"], "atm.export/0.1");
  assert.equal((doc["events"] as unknown[]).length, r.view.result.events.length);
  assert.equal((doc["explanation"] as { format: string }).format, "atm.explanation/0.1");
});

test("maxRenderedEvents truncates with a notice that cites the count", () => {
  const view = loadSession("claude-code");
  const ex = explainSession(view, EXPLAIN_OPTS);
  const o = { ...RENDER_OPTS, maxRenderedEvents: 3 };
  const md = renderMarkdown(view, ex, o);
  assert.ok(md.includes("Timeline truncated: showing the first 3 of 24 events."));
  assert.equal((md.match(/^\| \d+\.\d+ \|/gm) ?? []).length, 3);
  const html = renderHtmlReport(view, ex, o);
  assert.ok(html.includes("Timeline truncated: showing the first 3 of 24 events."));
  assert.equal((html.match(/<div class="item /g) ?? []).length, 3);
  assert.equal((html.match(/<div class="d">/g) ?? []).length, 3);
  assert.deepEqual(htmlViolations(html), []);
  const doc = JSON.parse(renderJsonExport(view, ex, o)) as {
    notice: { truncation: { shown: number; total: number } };
    events: unknown[];
  };
  assert.deepEqual(doc.notice.truncation, { shown: 3, total: 24 });
  assert.equal(doc.events.length, 3);
});

test("exceeding maxOutputBytes throws OutputTooLarge and returns nothing", () => {
  const view = loadSession("opencode");
  const ex = explainSession(view, EXPLAIN_OPTS);
  const o = { ...RENDER_OPTS, maxOutputBytes: 500 };
  for (const f of [renderMarkdown, renderHtmlReport, renderJsonExport, renderUiSessionPage]) {
    assert.throws(() => f(view, ex, o), OutputTooLarge);
  }
  assert.throws(() => renderUiIndex([view.record], o), OutputTooLarge);
  const exact = renderMarkdown(view, ex, RENDER_OPTS);
  const size = new TextEncoder().encode(exact).length;
  assert.equal(renderMarkdown(view, ex, { ...RENDER_OPTS, maxOutputBytes: size }), exact);
  assert.throws(
    () => renderMarkdown(view, ex, { ...RENDER_OPTS, maxOutputBytes: size - 1 }),
    OutputTooLarge,
  );
});

test("UI index: sorted rows, CSS-only filters for provider and outcome, relative links only", () => {
  const records = PROVIDER_FIXTURES.map((n) => loadSession(n).record);
  const html = renderUiIndex([...records].reverse(), RENDER_OPTS);
  assert.deepEqual(htmlViolations(html), []);
  assert.ok(html.includes('<input type="radio" name="fp" id="f-p-codex-cli">'));
  assert.ok(html.includes('<input type="radio" name="fo" id="f-o-partial">'));
  assert.ok(
    html.includes(
      'body:has(#f-p-codex-cli:checked) tr[data-provider]:not([data-provider="codex-cli"]){display:none}',
    ),
  );
  assert.ok(
    html.includes(
      'body:has(#f-o-partial:checked) tr[data-outcome]:not([data-outcome="partial"]){display:none}',
    ),
  );
  const rows = [...html.matchAll(/<tr data-provider="([a-z-]+)" data-outcome="([a-z]+)">/g)];
  assert.equal(rows.length, 4);
  for (const r of records) assert.ok(html.includes(`href="sessions/${r.importId}.html"`));
  assert.ok(html.includes(">experimental, undocumented<"));
  const again = renderUiIndex(records, RENDER_OPTS);
  assert.equal(renderUiIndex([...records].reverse(), RENDER_OPTS), again, "order independent");
  assert.ok(renderUiIndex([], RENDER_OPTS).includes("No sessions imported yet."));
});

test("G3-3: JSON export masks *.cwd attributes and provenance pointer segments", () => {
  const view = loadSession("codex-cli");
  const events = view.result.events.map((e, i) => {
    const c = JSON.parse(JSON.stringify(e)) as {
      attributes: Record<string, string>;
      provenance: { pointer: string | null };
    };
    if (i === 0) c.attributes["codex.cwd"] = "/home/demo/repo";
    if (i === 1) c.attributes["other.note"] = "/home/demo/keep";
    if (i === 2) c.provenance.pointer = "/payload/changes/~1home~1demo~1repo~1a~0b.ts/kind";
    return c as unknown as CanonicalEvent;
  });
  const v = withEvents(view, events);
  const ex = explainSession(v, EXPLAIN_OPTS);
  const out = renderJsonExport(v, ex, RENDER_OPTS);
  const doc = JSON.parse(out) as {
    events: {
      attributes: Record<string, string>;
      provenance: { pointer: string | null };
    }[];
  };
  assert.equal(doc.events[0]?.attributes["codex.cwd"], "~/repo");
  assert.equal(doc.events[1]?.attributes["other.note"], "/home/demo/keep");
  assert.equal(doc.events[2]?.provenance.pointer, "/payload/changes/~0~1repo~1a~0b.ts/kind");
  // Markdown never renders attributes or pointers. The HTML raw event block does, home-masked.
  const md = renderMarkdown(v, ex, RENDER_OPTS);
  assert.ok(!md.includes("~1home~1demo"));
  assert.ok(!md.includes("codex.cwd"));
  const html = renderHtmlReport(v, ex, RENDER_OPTS);
  assert.ok(!html.includes("~1home~1demo"));
  assert.ok(!html.includes("/home/demo"));
  assert.ok(html.includes("&quot;codex.cwd&quot;: &quot;~/repo&quot;"));
  assert.ok(html.includes("/payload/changes/~0~1repo~1a~0b.ts/kind"));
});
