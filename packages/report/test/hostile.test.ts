import assert from "node:assert/strict";
import { test } from "node:test";
import { type CanonicalEvent, makeContentRef } from "@swain/core";
import {
  explainSession,
  renderHtmlReport,
  renderJsonExport,
  renderMarkdown,
  renderUiIndex,
  renderUiSessionPage,
  type SessionView,
} from "../src/index.js";
import { EXPLAIN_OPTS, htmlViolations, loadSession, RENDER_OPTS, withEvents } from "./helpers.js";

const cp = (n: number): string => String.fromCodePoint(n);
const ESC = cp(0x1b);
const BEL = cp(0x07);

const HOSTILE: readonly string[] = [
  "</script><script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  `"><svg onload=alert(1)>`,
  "javascript:alert(1)",
  "[x](javascript:alert(1))",
  "a|b|c\n| --- |",
  "`tick` ``` fence",
  `sep${cp(0x2028)}line${cp(0x2029)}para`,
  `bidi${cp(0x202e)}evil${cp(0x2066)}iso`,
  `${ESC}]8;;http://evil.example/${BEL}link${ESC}[2J${ESC}[31mred`,
  `tag${cp(0xe0041)}${cp(0xe0067)}char${cp(0x115f)}${cp(0x3164)}`,
  "&lt;b&gt;already &amp; escaped",
  "line1\r\nline2\nline3",
  "../../etc/passwd",
  `{{7*7}} $${"{"}process.env.HOME} $(id) <!-- c -->`,
];

function mutate(view: SessionView, h: string): SessionView {
  const events = view.result.events.map((e): CanonicalEvent => {
    switch (e.kind) {
      case "tool.requested":
        return { ...e, payload: { ...e.payload, toolName: h, mcpServer: h } };
      case "tool.completed":
        return { ...e, payload: { ...e.payload, toolName: h } };
      case "tool.failed":
        return { ...e, payload: { ...e.payload, toolName: h } };
      case "file.changed":
        return { ...e, payload: { ...e.payload, path: `/home/demo/${h}` } };
      case "capture.gap":
        return { ...e, payload: { ...e.payload, detail: h } };
      case "source.unknown":
        return { ...e, payload: { ...e.payload, nativeType: h } };
      case "agent.started":
        return { ...e, payload: { ...e.payload, agentType: h } };
      case "model.usage":
        return { ...e, payload: { ...e.payload, model: h } };
      case "permission.requested":
        return { ...e, payload: { ...e.payload, toolName: h } };
      case "turn.started": {
        const p = e.payload.prompt;
        return p === null
          ? e
          : { ...e, payload: { prompt: makeContentRef(h, { retention: "inline" }) } };
      }
      case "message.observed":
        return {
          ...e,
          payload: {
            ...e.payload,
            content: makeContentRef(h, { retention: "inline" }),
          },
        };
      default:
        return e;
    }
  });
  const v = withEvents(view, events);
  return {
    record: {
      ...v.record,
      source: { ...v.record.source, displayPath: `/home/demo/${h}`, displayName: h },
    },
    result: {
      ...v.result,
      warnings: v.result.warnings.map((w) => ({ ...w, detail: { ...w.detail, extra: h } })),
    },
  };
}

function assertNoRawHostileBytes(out: string, label: string): void {
  for (const bad of [
    ESC,
    BEL,
    cp(0x202e),
    cp(0x2066),
    cp(0x2028),
    cp(0x2029),
    cp(0xe0041),
    cp(0x115f),
    cp(0x3164),
  ]) {
    assert.ok(!out.includes(bad), `${label}: raw U+${bad.codePointAt(0)?.toString(16)}`);
  }
}

test("hostile strings in tool names, paths, gaps, agents, models, inline content stay inert", () => {
  for (const base of ["claude-code", "codex-cli", "gemini-cli"]) {
    for (const h of HOSTILE) {
      const view = mutate(loadSession(base), h);
      const ex = explainSession(view, EXPLAIN_OPTS);
      const md = renderMarkdown(view, ex, RENDER_OPTS);
      const html = renderHtmlReport(view, ex, RENDER_OPTS);
      const ui = renderUiSessionPage(view, ex, RENDER_OPTS);
      const idx = renderUiIndex([view.record], RENDER_OPTS);
      const json = renderJsonExport(view, ex, RENDER_OPTS);
      const label = `${base} ${JSON.stringify(h).slice(0, 30)}`;

      for (const [name, page] of [
        ["html", html],
        ["ui", ui],
        ["index", idx],
      ] as const) {
        assert.equal((page.match(/<script/gi) ?? []).length, 0, `${label} ${name} script`);
        assert.doesNotMatch(
          page,
          /<(img|svg|iframe|object|embed|link|base|form)\b/i,
          `${label} ${name}`,
        );
        assert.deepEqual(htmlViolations(page), [], `${label} ${name}`);
        assertNoRawHostileBytes(page, `${label} ${name}`);
        if (name !== "index") {
          const trace = page.slice(
            page.indexOf("<h2>Trace</h2>"),
            page.indexOf("<h2>Timeline</h2>"),
          );
          assert.ok(trace.startsWith("<h2>Trace</h2>"), `${label} ${name} trace section`);
          assert.doesNotMatch(trace, /<[^>]*\s(style|on[a-z]+)=/i, `${label} ${name} trace attrs`);
          assert.doesNotMatch(
            trace,
            /href="(?!#(evt_[0-9a-f]{32}|turn-[0-9]+)")/,
            `${label} ${name}`,
          );
          // The stream, the detail blocks and the raw JSON are inert too.
          const stream = page.slice(page.indexOf('<main class="stream">'), page.indexOf("</main>"));
          assert.ok(stream.startsWith('<main class="stream">'), `${label} ${name} stream`);
          assert.ok(stream.includes('<div class="raw"><code>'), `${label} ${name} raw`);
          assert.doesNotMatch(
            stream,
            /<[^>]*\s(style|on[a-z]+)=/i,
            `${label} ${name} stream attrs`,
          );
          assert.doesNotMatch(
            stream,
            /href="(?!#(evt_[0-9a-f]{32}|turn-[0-9]+|tabs)")/,
            `${label} ${name} stream href`,
          );
          assert.doesNotMatch(
            stream,
            / (class|id)="[^"]*[^a-z0-9_ "-][^"]*"/,
            `${label} ${name} stream class and id values`,
          );
          assert.equal(
            (stream.match(/<div class="item /g) ?? []).length,
            (stream.match(/<div class="d">/g) ?? []).length,
            `${label} ${name} detail per row`,
          );
        }
        assert.ok(page.includes("default-src 'none'"));
        assert.ok(!page.includes("/home/demo"));
      }

      // Markdown: after removing backslash escapes no link or HTML syntax is left.
      assertNoRawHostileBytes(md, `${label} md`);
      const bare = md.replace(/\\[\s\S]/g, "").replace(/`(evt_[0-9a-f]{32}|interp\.[a-z]+)`/g, "");
      assert.doesNotMatch(bare, /[[\]<`!]/, `${label} md syntax`);
      assert.doesNotMatch(md, /(^|[^\\])\]\(/m, `${label} md link`);
      for (const line of md.split("\n")) {
        if (!line.startsWith("| ") || line.startsWith("| Seq")) continue;
        assert.equal(line.replace(/\\[\s\S]/g, "").split("|").length - 1, 9, `${label} md row`);
      }
      assert.ok(!md.includes("/home/demo"));
      assert.equal(
        md.split("\n").filter((l) => l.startsWith("| ")).length,
        view.result.events.length + 1,
      );

      // JSON stays parseable and carries no raw control bytes.
      assert.ok(!json.includes(ESC) && !json.includes(BEL), `${label} json`);
      JSON.parse(json);
      assert.ok(!json.includes("/home/demo"));
    }
  }
});

test("hostile text is visible, not dropped: it appears escaped in the HTML", () => {
  const view = mutate(loadSession("claude-code"), "<img src=x onerror=alert(1)>");
  const html = renderHtmlReport(view, explainSession(view, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("hostile record and index fields are escaped", () => {
  const view = mutate(loadSession("opencode"), "<script>alert(1)</script>");
  const record = {
    ...view.record,
    provider: "x<script>" as never,
    outcome: '"><b>' as never,
    importId: "imp_<script>" as never,
    sourceKind: "<i>k</i>",
  };
  const idx = renderUiIndex([record], RENDER_OPTS);
  assert.equal((idx.match(/<script/gi) ?? []).length, 0);
  assert.deepEqual(htmlViolations(idx), []);
  assert.doesNotMatch(idx, /href="sessions\/imp_</);
  assert.ok(!idx.includes("<tr data-"), "unknown provider and outcome yield no attribute");
});

test("hash-only content never produces an inline excerpt in any format", () => {
  const view = loadSession("claude-code");
  const ex = explainSession(view, EXPLAIN_OPTS);
  const outs = [
    renderMarkdown(view, ex, RENDER_OPTS),
    renderHtmlReport(view, ex, RENDER_OPTS),
    renderJsonExport(view, ex, RENDER_OPTS),
  ];
  for (const o of outs) {
    assert.ok(!/\(inline/.test(o));
    assert.ok(!o.includes('"inline"'));
  }
  assert.ok(outs[0]?.includes("hash-only, 40 bytes"));
});

function actionsSection(html: string): string {
  return html.slice(
    html.indexOf("<h2>Commands and actions</h2>"),
    html.indexOf("<h2>Timeline</h2>"),
  );
}

test("hostile commands and output stay inert in Commands and actions", () => {
  for (const h of HOSTILE) {
    const view = loadSession("claude-code");
    const events = view.result.events.map((e): CanonicalEvent => {
      if (e.kind === "tool.requested" && e.payload.toolName === "Bash") {
        const input = makeContentRef(JSON.stringify({ command: `${h} /home/demo/secret` }), {
          retention: "inline",
        });
        return { ...e, payload: { ...e.payload, input } };
      }
      if (e.kind === "tool.completed") {
        const output = makeContentRef(h, { retention: "inline" });
        return { ...e, payload: { ...e.payload, output } };
      }
      if (e.kind === "tool.failed") {
        const error = makeContentRef(h, { retention: "inline" });
        return { ...e, payload: { ...e.payload, error } };
      }
      return e;
    });
    const v = withEvents(view, events);
    const ex = explainSession(v, EXPLAIN_OPTS);
    const label = JSON.stringify(h).slice(0, 30);
    for (const html of [
      renderHtmlReport(v, ex, RENDER_OPTS),
      renderUiSessionPage(v, ex, RENDER_OPTS),
    ]) {
      assert.deepEqual(htmlViolations(html), [], label);
      assertNoRawHostileBytes(html, label);
      const sec = actionsSection(html);
      assert.ok(sec.startsWith("<h2>Commands and actions</h2>"), label);
      assert.doesNotMatch(sec, /<(script|img|svg|iframe)/i, label);
      assert.doesNotMatch(sec, /<[^>]*\s(style|on[a-z]+)=/i, label);
      assert.ok(!sec.includes("/home/demo"), label);
      assert.ok(sec.includes("~/secret"), label);
    }
  }
});

test("hostile subagent type is escaped in the agent filter labels", () => {
  for (const h of HOSTILE) {
    const view = mutate(loadSession("gemini-cli"), h);
    const html = renderHtmlReport(view, explainSession(view, EXPLAIN_OPTS), RENDER_OPTS);
    assert.deepEqual(htmlViolations(html), []);
    assertNoRawHostileBytes(actionsSection(html), "agent filter");
    assert.match(actionsSection(html), /id="a-g-all"/);
  }
});
