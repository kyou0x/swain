import assert from "node:assert/strict";
import { test } from "node:test";
import { type CanonicalEvent, makeContentRef } from "@swain/core";
import {
  explainSession,
  renderHtmlReport,
  renderUiIndex,
  renderUiSessionPage,
} from "../src/index.js";
import { buildActionLog } from "../src/render/actions.js";
import {
  MINIMAP_MAX_TICKS,
  MINIMAP_STEPS,
  RAW_MAX_CHARS,
  STREAM_MAX_EVENTS,
} from "../src/render/stream.js";
import { buildStyle } from "../src/render/theme.js";
import { buildTrace } from "../src/render/trace.js";
import {
  EXPLAIN_OPTS,
  htmlViolations,
  loadSession,
  PROVIDER_FIXTURES,
  RENDER_OPTS,
  withEvents,
} from "./helpers.js";

const base = loadSession("claude-code");
const tpl = base.result.events[3] as CanonicalEvent;
const hex = (n: number): string => n.toString(16).padStart(32, "0");
const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);

function ev(
  n: number,
  kind: string,
  status: string,
  payload: object,
  sec: number | null = n,
): CanonicalEvent {
  const e = JSON.parse(JSON.stringify(tpl)) as Record<string, unknown>;
  e["eventId"] = `evt_${hex(n)}`;
  e["kind"] = kind;
  e["status"] = status;
  e["payload"] = payload;
  e["sourceSequence"] = n;
  e["subIndex"] = 0;
  e["turnId"] = `trn_${hex(1)}`;
  e["actor"] = { actorId: `act_${hex(1)}`, role: "agent" };
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
  e["time"] =
    sec === null
      ? { value: null, origin: "none", status: "missing" }
      : { value: new Date(T0 + sec * 1000).toISOString(), origin: "source", status: "valid" };
  return e as unknown as CanonicalEvent;
}
const inline = (s: string) => makeContentRef(s, { retention: "inline" });
const req = (n: number, name: string, call: number, input: string, sec: number | null = n) =>
  ev(
    n,
    "tool.requested",
    "none",
    {
      toolCallId: `tc_${hex(call)}`,
      toolName: name,
      toolNamespace: "builtin",
      input: inline(input),
    },
    sec,
  );
const done = (n: number, call: number, target: number, ok = true, sec: number | null = n) => {
  const e = ev(
    n,
    ok ? "tool.completed" : "tool.failed",
    ok ? "success" : "failure",
    ok
      ? { toolCallId: `tc_${hex(call)}`, toolName: null, output: inline("out"), exitCode: 0 }
      : {
          toolCallId: `tc_${hex(call)}`,
          toolName: null,
          output: null,
          error: inline("boom"),
          errorClass: "error",
        },
    sec,
  );
  (e as unknown as { links: unknown[] }).links = [
    { rel: "result-of", target: `evt_${hex(target)}` },
  ];
  return e;
};

const pages = (evs: CanonicalEvent[]) => {
  const v = withEvents(base, evs);
  const ex = explainSession(v, EXPLAIN_OPTS);
  return {
    html: renderHtmlReport(v, ex, RENDER_OPTS),
    ui: renderUiSessionPage(v, ex, RENDER_OPTS),
  };
};

const bodyOf = (html: string): string => html.replace(/<style>[\s\S]*?<\/style>/, "");
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

test("every stream row has a detail block, and every href lands on exactly one id", () => {
  for (const name of PROVIDER_FIXTURES) {
    const v = loadSession(name);
    const ex = explainSession(v, EXPLAIN_OPTS);
    const folded = buildActionLog(v.result.events).rows.filter(
      (r) => r.requestId !== null && r.resultId !== null,
    ).length;
    for (const html of [
      renderHtmlReport(v, ex, RENDER_OPTS),
      renderUiSessionPage(v, ex, RENDER_OPTS),
    ]) {
      const items = count(html, /<div class="item /g);
      assert.equal(items, v.result.events.length - folded, `${name} rows`);
      assert.equal(count(html, /<div class="d">/g), items, `${name} details`);
      assert.equal(count(html, /<dl class="kv">/g), items + 1, `${name} kv grids plus facts`);
      assert.equal(count(html, /RAW EVENT/g), items + folded, `${name} raw blocks`);
      const ids = new Set([...html.matchAll(/ id="(evt_[0-9a-f]{32})"/g)].map((m) => m[1]));
      assert.equal(ids.size, v.result.events.length, `${name} one id per event`);
      assert.equal(count(html, / id="evt_/g), ids.size, `${name} ids are unique`);
      for (const m of html.matchAll(/href="#(evt_[0-9a-f]{32})"/g)) {
        assert.ok(ids.has(m[1]), `${name} dangling ${m[1]}`);
      }
      for (const m of html.matchAll(/href="#(turn-[0-9]+)"/g)) {
        assert.equal(count(html, new RegExp(` id="${m[1]}"`, "g")), 1, `${name} ${m[1]}`);
      }
      assert.ok(html.includes("Event stream"));
      assert.deepEqual(htmlViolations(html), [], name);
    }
  }
});

test("every class in the markup is defined by the static stylesheet", () => {
  const style = buildStyle();
  const defined = new Set([...style.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const records = PROVIDER_FIXTURES.map((n) => loadSession(n).record);
  const outs = PROVIDER_FIXTURES.flatMap((n) => {
    const v = loadSession(n);
    const ex = explainSession(v, EXPLAIN_OPTS);
    return [renderHtmlReport(v, ex, RENDER_OPTS), renderUiSessionPage(v, ex, RENDER_OPTS)];
  });
  outs.push(renderUiIndex(records, RENDER_OPTS));
  const used = new Set<string>();
  for (const html of outs) {
    for (const m of bodyOf(html).matchAll(/ class="([^"]*)"/g)) {
      for (const c of (m[1] ?? "").split(" ")) if (c !== "") used.add(c);
    }
  }
  assert.deepEqual(
    [...used].filter((c) => !defined.has(c)),
    [],
  );
  // Minimap classes come from the fixed range.
  for (const c of used) {
    const m = /^x(\d+)$/.exec(c);
    if (m !== null) assert.ok(Number(m[1]) < MINIMAP_STEPS);
  }
  assert.ok([...used].some((c) => /^x\d+$/.test(c)));
});

test("the stylesheet is one static string shared by every page", () => {
  const cspOf = (h: string) => /content="(default-src[^"]*)"/.exec(h)?.[1];
  const a = pages([ev(1, "turn.started", "none", { prompt: inline("a") })]);
  const b = pages([
    ev(1, "turn.started", "none", { prompt: inline("<b>b</b>") }),
    req(2, "T", 1, "x"),
  ]);
  const idx = renderUiIndex([base.record], RENDER_OPTS);
  assert.equal(cspOf(a.html), cspOf(b.ui));
  assert.equal(cspOf(a.html), cspOf(idx));
  assert.equal(buildStyle(), buildStyle());
  assert.doesNotMatch(buildStyle(), /url\(|@import|https?:|\/\//);
});

test("stat cards come from the trace model", () => {
  for (const name of PROVIDER_FIXTURES) {
    const v = loadSession(name);
    const t = buildTrace(v.result.events);
    const calls = t.usage.reduce((n, r) => n + r.calls, 0);
    const none = t.usage.reduce((n, r) => n + r.noResult, 0);
    const failed = t.groups.reduce((n, g) => n + g.failedTools, 0);
    const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
    const card = (label: string): string | undefined =>
      new RegExp(`<div class="cl">${label}</div><div class="cv">([^<]*)</div>`).exec(html)?.[1];
    assert.equal(card("Tool requests"), String(calls), name);
    assert.equal(card("No result"), String(none), name);
    assert.equal(card("Failed / denied / interrupted"), String(failed), name);
    assert.equal(
      html.includes('<div class="card bad"><div class="cl">Failed / denied / interrupted'),
      failed > 0,
    );
  }
});

test("raw event: escaped, home-masked, stored content only, cut with a marker", () => {
  const hostile = '</code><img src=x onerror=alert(1)> /home/demo/secret.txt "q"';
  const long = "x".repeat(RAW_MAX_CHARS * 2);
  const { html, ui } = pages([
    ev(1, "turn.started", "none", { prompt: inline(hostile) }),
    req(2, "Bash", 1, JSON.stringify({ command: "cat /home/demo/a.txt" })),
    done(3, 1, 2),
    ev(4, "message.observed", "none", {
      role: "assistant",
      channel: "text",
      content: inline(long),
    }),
  ]);
  for (const page of [html, ui]) {
    assert.deepEqual(htmlViolations(page), []);
    assert.doesNotMatch(page, /<img/i);
    assert.ok(!page.includes("/home/demo"), /.{80}\/home\/demo.{20}/.exec(page)?.[0]);
    assert.ok(page.includes("&lt;/code&gt;&lt;img src=x onerror=alert(1)&gt; ~/secret.txt"));
    assert.ok(page.includes("cat ~/a.txt"));
    assert.ok(page.includes("&quot;kind&quot;: &quot;turn.started&quot;"));
    // The long message is cut inside its raw block and the cut is marked.
    const raw =
      /<div class="raw"><code>((?:<span class="rl">[^<]*<\/span>)*)<\/code>(<span class="trunc">(\d+) more characters truncated<\/span>)?/g;
    const blocks = [...page.matchAll(raw)];
    assert.equal(blocks.length, 4);
    const cutBlocks = blocks.filter((b) => b[2] !== undefined);
    assert.equal(cutBlocks.length, 1);
    // 8192 "x" went in; the block holds the first 4096 code points of the pretty-printed JSON.
    const xs = (cutBlocks[0]?.[1] ?? "").match(/x/g) ?? [];
    assert.ok(xs.length > 3000 && xs.length <= RAW_MAX_CHARS, `x count ${xs.length}`);
    assert.ok(Number(cutBlocks[0]?.[3]) > 4000, "the marker counts the dropped characters");
    // One block-level span per line: the indentation is real, not a literal \\n.
    assert.ok(page.includes('<span class="rl">  &quot;actor&quot;: {</span>'));
    assert.ok(!/<div class="raw"><code>[^<]*\\n/.test(page));
  }
});

test("hash-only content stays hash-only in the stream, details and raw blocks", () => {
  const v = loadSession("claude-code");
  const html = renderUiSessionPage(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(!html.includes("&quot;inline&quot;"));
  assert.ok(html.includes("hash-only, "));
  assert.ok(html.includes("sha256 "));
});

test("minimap: ticks quantized to x0..x199, failures full height, cap and sampling note", () => {
  const small = pages([
    ev(1, "turn.started", "none", { prompt: inline("go") }),
    req(2, "Bash", 1, "{}"),
    done(3, 1, 2, false),
    req(4, "Read", 2, "{}"),
    done(5, 2, 4),
  ]);
  const ticks = [
    ...small.html.matchAll(/<a class="t (x\d+) (k-[a-z]+)( bad)?" href="#(evt_[0-9a-f]{32})">/g),
  ];
  assert.equal(ticks.length, 5);
  // The failed result is folded into its request row; both of its events are red ticks.
  assert.equal(ticks.filter((t) => t[3] !== undefined).length, 2);
  assert.ok(!small.html.includes("Sampled:"));
  assert.equal(ticks[0]?.[1], "x0");
  assert.equal(ticks[4]?.[1], `x${MINIMAP_STEPS - 1}`);

  // Without a valid time range, ticks follow event order.
  const untimed = pages([
    ev(1, "turn.started", "none", { prompt: inline("go") }, null),
    req(2, "Bash", 1, "{}", null),
    done(3, 1, 2, true, null),
  ]);
  const xs = [...untimed.html.matchAll(/<a class="t x(\d+) /g)].map((m) => Number(m[1]));
  assert.deepEqual(xs, [0, 66, 133]);

  const evs: CanonicalEvent[] = [];
  for (let i = 0; i < 3000; i++) {
    evs.push(ev(i + 1, "model.usage", "none", { scope: "turn", model: "m" }));
  }
  evs[1500] = ev(1501, "tool.failed", "failure", {
    toolCallId: null,
    toolName: "F",
    output: null,
    error: null,
    errorClass: "error",
  });
  const big = pages(evs);
  const bigTicks = [...big.html.matchAll(/<a class="t x\d+ k-[a-z]+( bad)?" href=/g)];
  assert.equal(bigTicks.length, MINIMAP_MAX_TICKS);
  assert.ok(
    bigTicks.some((t) => t[1] !== undefined),
    "the failure survives sampling",
  );
  assert.ok(big.html.includes("Sampled: 2000 of 3000 events"));
});

test("30k events: stream capped with a notice, minimap capped, render stays fast", () => {
  const evs: CanonicalEvent[] = [ev(1, "turn.started", "none", { prompt: inline("go") }, 0)];
  for (let i = 0; i < 15_000; i++) {
    evs.push(req(10 + 2 * i, `T${i % 50}`, i + 1, "{}", i % 3000));
    evs.push(done(11 + 2 * i, i + 1, 10 + 2 * i, i % 7 !== 0, (i % 3000) + 1));
  }
  const v = { record: base.record, result: { ...base.result, events: evs } };
  const t0 = performance.now();
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms}ms`);
  assert.ok(
    html.includes(`Event stream and details cover the first ${STREAM_MAX_EVENTS} of 30001 events`),
  );
  assert.ok(count(html, /<div class="item /g) <= STREAM_MAX_EVENTS);
  // The running byte budget stops detail blocks (1/4 of the cap, at most 8 MiB) and says so.
  assert.ok(count(html, /<div class="d">/g) < count(html, /<div class="item /g));
  assert.ok(html.includes("Detail blocks and raw events are omitted for the last"));
  assert.ok(html.includes("Cards are computed over the first 5000 of 30001 events."));
  assert.ok(count(html, /<a class="t /g) <= MINIMAP_MAX_TICKS);
  assert.deepEqual(htmlViolations(html), []);
});

test("index: stat cards and columns come from the record only", () => {
  const records = PROVIDER_FIXTURES.map((n) => loadSession(n).record);
  const html = renderUiIndex(records, RENDER_OPTS);
  for (const label of [
    "Sessions",
    "Providers",
    "Events",
    "Failed / denied / interrupted",
    "Imports with gaps",
  ]) {
    assert.ok(html.includes(`<div class="cl">${label}</div>`), label);
  }
  for (const col of [
    "Provider",
    "Import",
    "First time",
    "Duration",
    "Tool requests",
    "Failed / denied / interrupted",
    "Gaps",
    "Source",
  ]) {
    assert.ok(html.includes(`<th>${col}</th>`), col);
  }
  const events = records.reduce((n, r) => n + r.counts.events, 0);
  assert.ok(html.includes(`<div class="cl">Events</div><div class="cv">${events}</div>`));
  assert.ok(html.includes("<code>imp_"));
});
