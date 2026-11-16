import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BAR_STEPS,
  type Brand,
  CSP,
  cardsHtml,
  DEFAULT_BRAND,
  explainSession,
  htmlDoc,
  quantize,
  renderHtmlReport,
  renderRunPage,
  renderUiIndex,
  renderUiSessionPage,
  renderUiTooLargePage,
  resolveBrand,
  topBar,
} from "../src/index.js";
import {
  EXPLAIN_OPTS,
  loadSession,
  PROVIDER_FIXTURES,
  RENDER_OPTS,
  readFixture,
} from "./helpers.js";

const main = (html: string): string =>
  html.slice(html.indexOf("</header>"), html.indexOf("</body>"));

test("renderRunPage with one part equals renderUiSessionPage, document and main section, and the goldens", () => {
  for (const name of PROVIDER_FIXTURES) {
    const view = loadSession(name);
    const ui = renderUiSessionPage(view, explainSession(view, EXPLAIN_OPTS), RENDER_OPTS);
    const run = renderRunPage({ parts: [view] }, EXPLAIN_OPTS, RENDER_OPTS);
    assert.ok(run === ui, `${name}: run page document`);
    assert.ok(main(run) === main(ui), `${name}: main section`);
    assert.ok(run === readFixture(`${name}/ui-session.html`), `${name}: golden`);
  }
});

test("renderRunPage refuses anything but exactly one part", () => {
  const v = loadSession("claude-code");
  const bad = [{ parts: [] }, { parts: [v, v] }, { parts: "x" }, undefined, null] as unknown as {
    parts: [];
  }[];
  for (const b of bad) {
    assert.throws(
      () => renderRunPage(b, EXPLAIN_OPTS, RENDER_OPTS),
      (e: unknown) => e instanceof RangeError,
    );
  }
});

test("an explicit default brand reproduces every golden byte for byte", () => {
  const o = { ...RENDER_OPTS, brand: { name: "Swain", mark: "swain" } as const };
  assert.deepEqual(resolveBrand({}), DEFAULT_BRAND);
  assert.deepEqual(resolveBrand(o), DEFAULT_BRAND);
  for (const name of PROVIDER_FIXTURES) {
    const view = loadSession(name);
    const ex = explainSession(view, EXPLAIN_OPTS);
    assert.ok(renderHtmlReport(view, ex, o) === readFixture(`${name}/report.html`), name);
    assert.ok(renderUiSessionPage(view, ex, o) === readFixture(`${name}/ui-session.html`), name);
  }
  const records = PROVIDER_FIXTURES.map((n) => loadSession(n).record);
  assert.ok(renderUiIndex(records, o) === readFixture("ui-index.html"));
});

test("a custom brand (default is Swain) changes only the title and the word mark, and is escaped", () => {
  const brand: Brand = { name: 'Acme <b>&"', mark: "swain" };
  const o = { ...RENDER_OPTS, brand };
  const view = loadSession("codex-cli");
  const ex = explainSession(view, EXPLAIN_OPTS);
  const base = renderUiSessionPage(view, ex, RENDER_OPTS);
  const html = renderUiSessionPage(view, ex, o);
  assert.ok(html.includes("<title>Acme &lt;b&gt;&amp;"));
  assert.ok(html.includes('<span class="wm">Acme &lt;b&gt;&amp;'));
  assert.ok(!html.includes("Acme <b>"));
  assert.ok(!html.includes("Swain"));
  assert.ok(html.includes(CSP), "CSP and the hashed style are unchanged");
  const restore = html
    .replace(/<title>[^<]*<\/title>/, "<title>Swain session report</title>")
    .replace(/<span class="wm">[^<]*<\/span>/, '<span class="wm">Swain</span>');
  assert.ok(restore === base, "nothing else differs");
  // Index and too-large pages carry the brand too.
  const records = PROVIDER_FIXTURES.map((n) => loadSession(n).record);
  assert.ok(renderUiIndex(records, o).includes("<title>Acme &lt;b&gt;&amp;"));
  const big = renderUiTooLargePage(view.record, o);
  assert.ok(big.includes("<title>Acme &lt;b&gt;&amp;&quot; session too large</title>"));
  assert.ok(!big.includes("Swain"));
});

test("invalid brands are refused at the boundary", () => {
  const view = loadSession("claude-code");
  const ex = explainSession(view, EXPLAIN_OPTS);
  const bad: unknown[] = [
    null,
    "Swain",
    {},
    { name: "", mark: "atm" },
    { name: "x".repeat(65), mark: "atm" },
    { name: "a\nb", mark: "atm" },
    { name: "a‮b", mark: "atm" },
    { name: "a\ud800", mark: "atm" },
    { name: "ok", mark: "other" },
    { name: 5, mark: "atm" },
  ];
  for (const brand of bad) {
    const o = { ...RENDER_OPTS, brand } as unknown as typeof RENDER_OPTS;
    assert.throws(() => renderUiSessionPage(view, ex, o), RangeError);
  }
  assert.deepEqual(resolveBrand({ brand: { name: "x".repeat(64), mark: "swain" } }), {
    name: "x".repeat(64),
    mark: "swain",
  });
});

test("shell parts are exported and consistent with the pages", () => {
  assert.equal(topBar("/ a", "s"), topBar("/ a", "s", DEFAULT_BRAND));
  assert.ok(topBar("/ a", "s").includes('<span class="wm">Swain</span>'));
  assert.ok(topBar("/ a", "s", { name: "N", mark: "swain" }).includes('<span class="wm">N</span>'));
  const doc = htmlDoc("T <x>", "<p>b</p>");
  assert.ok(doc.startsWith("<!doctype html>\n"));
  assert.ok(doc.includes("<title>T &lt;x&gt;</title>"));
  assert.ok(doc.includes(CSP));
  assert.ok(doc.endsWith("</body>\n</html>\n"));
  assert.equal(
    cardsHtml([{ label: "L", value: "1" }]),
    '<div class="stats"><div class="card"><div class="cl">L</div><div class="cv">1</div></div></div>',
  );
  assert.equal(BAR_STEPS, 50);
  assert.deepEqual(quantize(0, 10, 0, 100), { offset: 0, width: 5 });
  assert.deepEqual(quantize(100, 100, 0, 100), { offset: 49, width: 1 });
});
