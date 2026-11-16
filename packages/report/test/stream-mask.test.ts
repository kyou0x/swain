import assert from "node:assert/strict";
import { test } from "node:test";
import { type CanonicalEvent, makeContentRef } from "@swain/core";
import {
  explainSession,
  type RenderOptions,
  renderHtmlReport,
  renderMarkdown,
  renderUiSessionPage,
} from "../src/index.js";
import { RAW_MAX_CHARS } from "../src/render/stream.js";
import { EXPLAIN_OPTS, htmlViolations, loadSession, RENDER_OPTS, withEvents } from "./helpers.js";

const base = loadSession("claude-code");
const tpl = base.result.events[3] as CanonicalEvent;
const hex = (n: number): string => n.toString(16).padStart(32, "0");
const OPTS: RenderOptions = { ...RENDER_OPTS, homeDir: "/home/demo", realHomeDir: "/real/home/z" };
const HOMES = ["/home/demo", "/real/home/z"] as const;

function turn(text: string): CanonicalEvent {
  const e = JSON.parse(JSON.stringify(tpl)) as Record<string, unknown>;
  e["eventId"] = `evt_${hex(1)}`;
  e["kind"] = "turn.started";
  e["status"] = "none";
  e["payload"] = { prompt: makeContentRef(text, { retention: "inline" }) };
  e["sourceSequence"] = 1;
  e["subIndex"] = 0;
  e["turnId"] = `trn_${hex(1)}`;
  e["actor"] = { actorId: `act_${hex(1)}`, role: "user" };
  e["links"] = [];
  e["completeness"] = Object.fromEntries(
    [
      "content",
      "inputs",
      "outputs",
      "timestamp",
      "actor",
      "model",
      "tokens",
      "causality",
      "internalReasoning",
    ].map((f) => [f, { state: "captured" }]),
  );
  e["time"] = { value: "2026-03-02T09:00:00.000Z", origin: "source", status: "valid" };
  return e as unknown as CanonicalEvent;
}

function pageOf(text: string, ui = false): string {
  const v = withEvents(base, [turn(text)]);
  const ex = explainSession(v, EXPLAIN_OPTS);
  return ui ? renderUiSessionPage(v, ex, OPTS) : renderHtmlReport(v, ex, OPTS);
}

/** No home spelling, and no fragment of one that is long enough to recognise, in the output. */
function assertNoHomeBytes(page: string, why: string): void {
  for (const h of HOMES) {
    for (let n = 5; n <= h.length; n++) {
      // Fragments after the "~" or at the very end of a cut.
      assert.ok(!page.includes(h.slice(0, n)), `${why}: leaked ${JSON.stringify(h.slice(0, n))}`);
    }
  }
}

test("S-1: masking happens before the 120 and 240 code point cuts of the stream", () => {
  for (const home of HOMES) {
    const path = `${home}/secret`;
    for (const cutAt of [120, 240]) {
      // Sweep the path across the cut: ending exactly at it, straddling it, starting after it.
      for (let pad = cutAt - path.length - 3; pad <= cutAt + 3; pad++) {
        const text = `${"y".repeat(pad)}${path}tail`;
        const page = pageOf(text);
        assertNoHomeBytes(page, `cut ${cutAt} pad ${pad} ${home}`);
      }
    }
  }
});

test("S-1: a path ending exactly at the cut keeps its mask; the cut is marked with ...", () => {
  // Masked text is "y"*N + "~/secret" + "tail": cut inside it, the visible prefix is intact.
  const long = `${"y".repeat(300)}/home/demo/secret`;
  const page = pageOf(long);
  assert.ok(page.includes(`${"y".repeat(240)}...`), "row summary cut at 240 with ...");
  assert.ok(page.includes(`${"y".repeat(120)}...`), "turn header cut at 120 with ...");
  const short = `${"y".repeat(100)}/real/home/z/secret end`;
  const p2 = pageOf(short);
  assert.ok(p2.includes(`${"y".repeat(100)}~/secret end`), "short text is masked, not cut");
});

test("S-1: masking happens before the 4096 cuts of a content value and of the raw block", () => {
  for (const home of HOMES) {
    const path = `${home}/secret`;
    // A coarse sweep first, then every offset around the raw block's cut.
    for (let pad = 3000; pad <= 4100; pad += 3) {
      const text = `${"y".repeat(pad)}${path}tail`;
      assertNoHomeBytes(pageOf(text), `4096 pad ${pad} ${home}`);
    }
  }
});

test("S-1: the raw block and the detail value are cut after masking and report the dropped size", () => {
  const text = `${"y".repeat(4090)}/home/demo/secret and more text after the path`;
  const page = pageOf(text, true);
  assert.ok(!page.includes("/home/demo"));
  assert.match(page, /<span class="trunc">\d+ more characters truncated<\/span>/);
  assert.deepEqual(htmlViolations(page), []);
  assert.ok(RAW_MAX_CHARS === 4096);
});

test("I-2: the best-effort masking notice is shown on every session page with raw blocks", () => {
  const hashOnly = renderHtmlReport(base, explainSession(base, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(hashOnly.includes("inline content was masked best-effort; masking is not a guarantee"));
});

test("I-4: a hash-only content reference never carries inline text into the raw block", () => {
  const e = turn("x");
  (e as unknown as { payload: { prompt: object } }).payload.prompt = {
    sha256: "0".repeat(64),
    byteLength: 6,
    encoding: "utf8",
    retention: "hash-only",
    inline: "SECRET-TEXT",
  };
  const v = { record: base.record, result: { ...base.result, events: [e] } };
  const page = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(!page.includes("SECRET-TEXT"));
  assert.ok(page.includes("&quot;retention&quot;: &quot;hash-only&quot;"));
});

test("S-2: the detail budget stops detail blocks early and says so; rows remain", () => {
  const events: CanonicalEvent[] = [];
  for (let i = 0; i < 200; i++) {
    const e = turn(`prompt ${i}`);
    const r = e as unknown as { eventId: string; sourceSequence: number; turnId: string };
    r.eventId = `evt_${hex(i + 1)}`;
    r.sourceSequence = i + 1;
    r.turnId = `trn_${hex(1)}`;
    events.push(e);
  }
  const v = { record: base.record, result: { ...base.result, events } };
  const small = { ...RENDER_OPTS, maxOutputBytes: 1_200_000 }; // budget: a quarter of it
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), small);
  const items = (html.match(/<div class="item /g) ?? []).length;
  const details = (html.match(/<div class="d">/g) ?? []).length;
  assert.equal(items, 200);
  assert.ok(details > 0 && details < items, `${details} of ${items}`);
  assert.ok(
    html.includes(`Detail blocks and raw events are omitted for the last ${items - details} rows`),
  );
  assert.deepEqual(htmlViolations(html), []);
  const full = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(!full.includes("Detail blocks and raw events are omitted"));
});

test("S-3 and UX: wording, jump link to one fixed anchor, cards scope note", () => {
  const html = renderHtmlReport(base, explainSession(base, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(html.includes('<div class="cl">Failed / denied / interrupted</div>'));
  assert.ok(html.includes("tool requests"));
  assert.ok(!html.includes("operations"));
  assert.ok(html.includes('<a href="#tabs">Waterfall &middot; Commands'));
  assert.equal((html.match(/ id="tabs"/g) ?? []).length, 1);
  assert.ok(!html.includes("Cards are computed over"));
  const capped = renderHtmlReport(base, explainSession(base, EXPLAIN_OPTS), {
    ...RENDER_OPTS,
    maxRenderedEvents: 5,
  });
  assert.ok(capped.includes("Cards are computed over the first 5 of 24 events."));
});

test("F-1: the Markdown report masks home paths in free text before its 512 code point cut", () => {
  for (const h of HOMES) {
    for (let pad = 490; pad <= 520; pad++) {
      const v = withEvents(base, [turn(`${"a".repeat(pad)}${h}/secret`)]);
      const md = renderMarkdown(v, explainSession(v, { ...EXPLAIN_OPTS, homeDirs: HOMES }), OPTS);
      assertNoHomeBytes(md.replace(/\\/g, ""), `md pad ${pad}`);
    }
  }
  const v = withEvents(base, [turn("cat /home/demo/.ssh/config")]);
  const md = renderMarkdown(v, explainSession(v, EXPLAIN_OPTS), OPTS);
  assert.ok(!md.includes("home/demo"));
});
