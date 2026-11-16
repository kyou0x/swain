import assert from "node:assert/strict";
import { test } from "node:test";
import { type CanonicalEvent, makeContentRef } from "@swain/core";
import { explainSession, renderHtmlReport, renderUiSessionPage } from "../src/index.js";
import {
  buildTrace,
  type ToolStep,
  TRACE_MAX_AGENT_DEPTH,
  TRACE_MAX_EVENTS,
  type TraceStep,
} from "../src/render/trace.js";
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
const evt = (n: number): string => `evt_${hex(n)}`;
const trn = (n: number): string => `trn_${hex(n)}`;
const act = (n: number): string => `act_${hex(n)}`;
const tc = (n: number): string => `tc_${hex(n)}`;
const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

interface Opts {
  turn?: number | null;
  actor?: number;
  links?: { rel: string; target: string }[];
  sec?: number | null | undefined;
}
function ev(
  n: number,
  kind: string,
  status: string,
  payload: object,
  o: Opts = {},
): CanonicalEvent {
  const e = JSON.parse(JSON.stringify(tpl)) as Record<string, unknown>;
  e["eventId"] = evt(n);
  e["kind"] = kind;
  e["status"] = status;
  e["payload"] = payload;
  e["sourceSequence"] = n;
  e["subIndex"] = 0;
  e["turnId"] = o.turn === null ? null : trn(o.turn ?? 1);
  e["actor"] = { actorId: act(o.actor ?? 1), role: "agent" };
  e["links"] = o.links ?? [];
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
    o.sec === null
      ? { value: null, origin: "none", status: "missing" }
      : { value: iso(o.sec ?? n), origin: "source", status: "valid" };
  return e as unknown as CanonicalEvent;
}

const hashRef = (s: string) => makeContentRef(s, { retention: "hash-only" });
const inlineRef = (s: string) => makeContentRef(s, { retention: "inline" });
const turnStart = (n: number, turn: number, prompt: string, inline = true, sec?: number | null) =>
  ev(
    n,
    "turn.started",
    "none",
    { prompt: inline ? inlineRef(prompt) : hashRef(prompt) },
    { turn, sec },
  );
const turnEnd = (n: number, turn: number, status = "success", sec?: number | null) =>
  ev(n, "turn.ended", status, {}, { turn, sec });
const req = (n: number, name: string, call: number | null, o: Opts = {}) =>
  ev(
    n,
    "tool.requested",
    "none",
    {
      toolCallId: call === null ? null : tc(call),
      toolName: name,
      toolNamespace: "builtin",
      input: inlineRef(`input-of-${name}`),
    },
    o,
  );
const done = (n: number, call: number | null, target: number | null, o: Opts = {}) =>
  ev(
    n,
    "tool.completed",
    "success",
    {
      toolCallId: call === null ? null : tc(call),
      toolName: null,
      output: inlineRef("output-text"),
      exitCode: 0,
    },
    { ...o, links: target === null ? [] : [{ rel: "result-of", target: evt(target) }] },
  );
const fail = (n: number, call: number | null, target: number | null, o: Opts = {}) =>
  ev(
    n,
    "tool.failed",
    "failure",
    {
      toolCallId: call === null ? null : tc(call),
      toolName: null,
      output: null,
      error: hashRef("boom"),
      errorClass: "error",
    },
    { ...o, links: target === null ? [] : [{ rel: "result-of", target: evt(target) }] },
  );

const view = (evs: CanonicalEvent[]) => withEvents(base, evs);
const htmlOf = (evs: CanonicalEvent[], hashOnly = false) => {
  const v = view(evs);
  const vv = {
    record: {
      ...v.record,
      contentRetention: hashOnly ? "hash-only" : "inline",
    } as typeof v.record,
    result: v.result,
  };
  return renderHtmlReport(vv, explainSession(vv, EXPLAIN_OPTS), RENDER_OPTS);
};
const tools = (steps: readonly TraceStep[]): ToolStep[] =>
  steps.filter((s): s is ToolStep => s.type === "tool");
const model = (evs: CanonicalEvent[]) => buildTrace(view(evs).result.events);

test("pairing by result-of link and by toolCallId fallback", () => {
  const m = model([
    turnStart(1, 1, "go"),
    req(2, "Read", 1),
    done(3, 1, 2),
    req(4, "Bash", 2),
    done(5, 2, null), // no link: falls back to the equal toolCallId
    turnEnd(6, 1),
  ]);
  const [a, b] = tools(m.groups[0]?.steps ?? []);
  assert.equal(a?.status, "ok");
  assert.equal(a?.result?.eventId, evt(3));
  assert.equal(b?.status, "ok");
  assert.equal(b?.result?.eventId, evt(5));
  assert.equal(m.groups[0]?.steps.length, 2, "paired results do not appear as steps");
});

test("link beats a wrong toolCallId; a result is claimed once", () => {
  const m = model([
    turnStart(1, 1, "go"),
    req(2, "A", 1),
    req(3, "B", 2),
    done(4, 1, 3), // linked to B though its call id says A
    done(5, 1, null),
  ]);
  const [a, b] = tools(m.groups[0]?.steps ?? []);
  assert.equal(b?.result?.eventId, evt(4));
  assert.equal(a?.result?.eventId, evt(5));
});

test("orphan result and tool with no result", () => {
  const evs = [turnStart(1, 1, "go"), req(2, "Lonely", 1), fail(3, 9, null), turnEnd(4, 1)];
  const m = model(evs);
  const [lonely, orphan] = tools(m.groups[0]?.steps ?? []);
  assert.equal(lonely?.status, "none");
  assert.equal(orphan?.request, null);
  assert.equal(orphan?.status, "failed");
  const html = htmlOf(evs);
  assert.ok(html.includes("no result recorded"));
  assert.ok(html.includes("result without request"));
  assert.ok(html.includes("failed (error)"));
});

test("subagent spans nest events by actor", () => {
  const started = ev(2, "agent.started", "none", {
    agentActorId: act(7),
    parentActorId: act(1),
    agentType: "explorer",
    spawnedByToolCallId: null,
  });
  const ended = ev(5, "agent.ended", "success", { agentActorId: act(7) });
  const evs = [
    turnStart(1, 1, "go"),
    started,
    req(3, "Inner", 1, { actor: 7 }),
    done(4, 1, 3, { actor: 7 }),
    ended,
    req(6, "Outer", 2),
  ];
  const steps = model(evs).groups[0]?.steps ?? [];
  assert.equal(steps.length, 2);
  const agent = steps[0];
  assert.equal(agent?.type, "agent");
  if (agent?.type === "agent") {
    assert.equal(tools(agent.steps)[0]?.toolName, "Inner");
    assert.equal(agent.ended?.eventId, evt(5));
  }
  assert.equal(tools(steps)[0]?.toolName, "Outer");
  assert.match(htmlOf(evs), /<ol class="trace sub">/);
});

test("permission and file changes attach to the tool span", () => {
  const pr = ev(3, "permission.requested", "none", {
    toolName: "Bash",
    toolCallId: tc(1),
    input: null,
  });
  const pd = ev(
    4,
    "permission.decided",
    "none",
    { decision: "allow", decidedBy: "user", reason: null },
    { links: [{ rel: "decides", target: evt(3) }] },
  );
  const fc = ev(6, "file.changed", "success", {
    path: "/home/demo/a.txt",
    changeKind: "update",
    diff: null,
    viaToolCallId: tc(1),
    basis: "derived-from-tool-result",
  });
  const evs = [turnStart(1, 1, "go"), req(2, "Bash", 1), pr, pd, done(5, 1, 2), fc, turnEnd(7, 1)];
  const g = model(evs).groups[0];
  assert.equal(g?.steps.length, 1);
  const t = tools(g?.steps ?? [])[0];
  assert.equal(t?.permissions.length, 1);
  assert.equal(t?.permissions[0]?.decisions[0]?.payload.decision, "allow");
  assert.equal(t?.files.length, 1);
  assert.equal(g?.filesChanged, 1);
  const html = htmlOf(evs);
  assert.ok(html.includes("decision allow by user"));
  assert.ok(!html.includes("/home/demo"));
});

test("unlinked permission decision pairs with the open request; unattached ones stay steps", () => {
  const pr = ev(2, "permission.requested", "none", {
    toolName: "X",
    toolCallId: null,
    input: null,
  });
  const pd = ev(3, "permission.decided", "none", {
    decision: "deny",
    decidedBy: "user",
    reason: null,
  });
  const steps = model([turnStart(1, 1, "go"), pr, pd]).groups[0]?.steps ?? [];
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.type, "permission");
  if (steps[0]?.type === "permission") {
    assert.equal(steps[0].entry.decisions.length, 1);
    assert.deepEqual(steps[0].entry.inferred, [evt(3)]);
  }
  assert.ok(
    htmlOf([turnStart(1, 1, "go"), pr, pd]).includes("paired by turn order (no decides link)"),
  );
});

test("a linked permission decision is not labelled as inferred", () => {
  const pr = ev(2, "permission.requested", "none", {
    toolName: "X",
    toolCallId: null,
    input: null,
  });
  const pd = ev(
    3,
    "permission.decided",
    "none",
    { decision: "allow", decidedBy: "user", reason: null },
    { links: [{ rel: "decides", target: evt(2) }] },
  );
  const steps = model([turnStart(1, 1, "go"), pr, pd]).groups[0]?.steps ?? [];
  if (steps[0]?.type === "permission") assert.deepEqual(steps[0].entry.inferred, []);
  assert.ok(!htmlOf([turnStart(1, 1, "go"), pr, pd]).includes("paired by turn order"));
});

test("unknown-status completions are not counted as succeeded", () => {
  const unk = done(3, 1, 2);
  (unk as { status: string }).status = "unknown";
  const evs = [turnStart(1, 1, "go"), req(2, "Q", 1), unk];
  const row = model(evs).usage[0];
  assert.equal(row?.succeeded, 0);
  assert.equal(row?.completedUnknown, 1);
  assert.ok(htmlOf(evs).includes("<td>Q</td><td>1</td><td>0</td><td>1</td><td>0</td><td>0</td>"));
});

test("hostile deep subagent chain is capped and still renders", () => {
  const evs: CanonicalEvent[] = [turnStart(1, 1, "go")];
  const N = 4990;
  for (let i = 0; i < N; i++) {
    evs.push(
      ev(
        2 + i,
        "agent.started",
        "none",
        {
          agentActorId: act(i + 2),
          parentActorId: act(i + 1),
          agentType: "a",
          spawnedByToolCallId: null,
        },
        { actor: i + 1 },
      ),
    );
  }
  evs.push(req(N + 2, "Deep", 1, { actor: N + 1 }));
  const m = model(evs);
  assert.equal(m.nestingCapped, true);
  let depth = 0;
  let steps: readonly TraceStep[] = m.groups[0]?.steps ?? [];
  for (;;) {
    const withKids = steps.find((s) => s.type === "agent" && s.steps.length > 0);
    if (withKids?.type !== "agent") break;
    depth++;
    assert.ok(withKids.depth <= TRACE_MAX_AGENT_DEPTH);
    steps = withKids.steps;
  }
  assert.equal(depth, TRACE_MAX_AGENT_DEPTH);
  assert.equal(tools(steps)[0]?.toolName, "Deep");
  const v = { record: base.record, result: { ...base.result, events: evs } };
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  assert.ok(html.includes("Subagent nesting is deeper than 16 levels"));
  assert.ok((html.match(/<ol class="trace sub">/g) ?? []).length <= N);
});

test("timeline truncation below the trace cap still shows the pairing notice", () => {
  const evs = [turnStart(1, 1, "go"), req(2, "A", 1), req(3, "B", 2), done(4, 1, 2)];
  const v = view(evs);
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), {
    ...RENDER_OPTS,
    maxRenderedEvents: 3,
  });
  assert.ok(html.includes("Trace truncated: showing the first 3 of 4 events."));
  assert.ok(html.includes("no result recorded"));
});

test("prompts: inline excerpt, hash-only size, reimport notice, user message fallback", () => {
  const inline = htmlOf([turnStart(1, 1, "please fix the bug"), turnEnd(2, 1)], false);
  assert.ok(inline.includes("prompt (inline): please fix the bug"));
  assert.ok(!inline.includes("swain import --include-content --reimport"));

  const hashed = htmlOf([turnStart(1, 1, "secret prompt text", false), turnEnd(2, 1)], true);
  assert.ok(hashed.includes("prompt hash-only, 18 bytes"));
  assert.ok(!hashed.includes("secret prompt text"));
  assert.ok(hashed.includes("swain import --include-content --reimport &lt;path&gt;"));

  const userMsg = ev(2, "message.observed", "none", {
    role: "user",
    channel: "text",
    content: hashRef("hello"),
  });
  const fallback = model([ev(1, "turn.started", "none", { prompt: null }), userMsg]);
  assert.equal(fallback.groups[0]?.prompts.length, 1);
  assert.equal(fallback.groups[0]?.prompts[0]?.viaMessage, true);
  const withBoth = model([turnStart(1, 1, "real"), userMsg]);
  assert.equal(withBoth.groups[0]?.prompts.length, 1, "turn prompt wins over user messages");
  assert.equal(withBoth.groups[0]?.prompts[0]?.viaMessage, false);
});

test("reasoning messages are labelled as provider-exposed", () => {
  const html = htmlOf([
    turnStart(1, 1, "go"),
    ev(2, "message.observed", "none", {
      role: "assistant",
      channel: "reasoning",
      content: hashRef("r"),
    }),
  ]);
  assert.ok(html.includes("provider-exposed reasoning, role assistant"));
});

test("tool usage table: counts and order", () => {
  const evs = [
    turnStart(1, 1, "go"),
    req(2, "Zed", 1),
    done(3, 1, 2),
    req(4, "Alpha", 2),
    fail(5, 2, 4),
    req(6, "Alpha", 3),
    req(7, "Alpha", 4),
    done(8, 4, 7),
    req(9, "Beta", 5),
  ];
  assert.deepEqual(
    model(evs).usage.map((r) => [r.toolName, r.calls, r.succeeded, r.failed, r.noResult]),
    [
      ["Alpha", 3, 1, 1, 1],
      ["Beta", 1, 0, 0, 1],
      ["Zed", 1, 1, 0, 0],
    ],
  );
  assert.ok(
    htmlOf(evs).includes(
      "<th>Tool</th><th>Requests</th><th>Succeeded</th><th>Completed, status unknown</th><th>Failed</th><th>No result recorded</th>",
    ),
  );
});

test("events with a null turnId go into the session group", () => {
  const html = htmlOf([
    ev(1, "capture.gap", "none", { reason: "missing-result", detail: "d" }, { turn: null }),
  ]);
  assert.ok(html.includes("Session (outside turns)"));
  assert.ok(html.includes('id="turn-0"'));
  const m = model([turnStart(1, 1, "a"), req(2, "T", 1, { turn: null }), turnStart(3, 2, "b")]);
  assert.deepEqual(
    m.groups.map((g) => g.index),
    [1, 2, 0],
  );
});

test("turn summary: counts, status and duration from valid timestamps only", () => {
  const m = model([
    turnStart(1, 1, "go", true, 0),
    req(2, "A", 1, { sec: 1 }),
    fail(3, 1, 2, { sec: 4 }),
    ev(
      4,
      "message.observed",
      "none",
      { role: "assistant", channel: "text", content: hashRef("m") },
      { sec: 5 },
    ),
    turnEnd(5, 1, "failure", 10),
  ]);
  const g = m.groups[0];
  assert.equal(g?.durationMs, 10_000);
  assert.equal(g?.toolCalls, 1);
  assert.equal(g?.failedTools, 1);
  assert.equal(g?.messages, 1);
  assert.equal(g?.endStatus, "failure");
  assert.equal(tools(g?.steps ?? [])[0]?.durationMs, 3000);

  const none = model([turnStart(1, 1, "go", true, null), turnEnd(2, 1, "success", null)]);
  assert.equal(none.groups[0]?.durationMs, null);
  assert.equal(none.groups[0]?.startTime, null);
});

test("waterfall classes come only from the fixed set and the stylesheet defines them", () => {
  const html = htmlOf([
    turnStart(1, 1, "go", true, 0),
    req(2, "A", 1, { sec: 0 }),
    done(3, 1, 2, { sec: 5 }),
    req(4, "B", 2, { sec: 7 }),
    done(5, 2, 4, { sec: 100 }),
    turnEnd(6, 1, "success", 100),
  ]);
  const bars = [...html.matchAll(/<span class="bar (o\d+) (w\d+)"><\/span>/g)];
  assert.equal(bars.length, 2);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  for (const [, o, w] of bars) {
    const oi = Number(o?.slice(1));
    const wi = Number(w?.slice(1));
    assert.ok(oi >= 0 && oi <= 50 && wi >= 1 && wi <= 50 && oi + wi <= 50);
    assert.ok(style.includes(`.${o}{left:`));
    assert.ok(style.includes(`.${w}{width:`));
  }
  assert.ok(!/style="/.test(html));
  const noTime = htmlOf([turnStart(1, 1, "go", true, null), req(2, "A", 1, { sec: null })]);
  assert.ok(!noTime.includes('class="bar'));
});

test("stylesheet stays static: the CSP hash is independent of the data", () => {
  const cspOf = (h: string) => /content="(default-src[^"]*)"/.exec(h)?.[1];
  assert.equal(
    cspOf(htmlOf([turnStart(1, 1, "a")])),
    cspOf(htmlOf([turnStart(1, 1, "b"), req(2, "T", 1)])),
  );
});

test("usage events are shown per event, never summed", () => {
  const u = (n: number, t: number) =>
    ev(n, "model.usage", "none", { scope: "message", model: "m", totalTokens: t });
  const html = htmlOf([turnStart(1, 1, "go"), u(2, 100), u(3, 250)]);
  const trace = html.slice(html.indexOf("<h2>Trace</h2>"), html.indexOf("<h2>Timeline</h2>"));
  assert.ok(trace.includes("total tokens 100"));
  assert.ok(trace.includes("total tokens 250"));
  assert.ok(!trace.includes("total tokens 350"));
});

test("gap and unknown events are warning steps with timeline links", () => {
  const html = htmlOf([
    turnStart(1, 1, "go"),
    ev(2, "capture.gap", "none", { reason: "missing-result", detail: "missing part" }),
    ev(3, "source.unknown", "none", {
      nativeType: "weird",
      topLevelKeys: [],
      recordSha256: "0".repeat(64),
    }),
  ]);
  assert.ok(html.includes("capture gap missing-result: missing part"));
  assert.ok(html.includes("unrecognized record, native type weird"));
  assert.ok(html.includes(`<a href="#${evt(2)}">`));
});

test("every provider fixture renders a clean Trace section in both page kinds", () => {
  for (const name of PROVIDER_FIXTURES) {
    const v = loadSession(name);
    const ex = explainSession(v, EXPLAIN_OPTS);
    for (const page of [
      renderHtmlReport(v, ex, RENDER_OPTS),
      renderUiSessionPage(v, ex, RENDER_OPTS),
    ]) {
      const iExpl = page.indexOf("<h2>Explanation</h2>");
      const iTrace = page.indexOf("<h2>Trace</h2>");
      const iTime = page.indexOf("<h2>Timeline</h2>");
      assert.ok(iExpl < iTrace && iTrace < iTime, `${name} order`);
      assert.deepEqual(htmlViolations(page), [], name);
      assert.ok(page.includes("<h3>Tool usage</h3>"));
      assert.ok(page.includes("<h3>What you asked</h3>"));
      assert.ok(/<details class="turn" id="turn-1" open>/.test(page), name);
      assert.ok(!/style="/.test(page));
      assert.ok(!/\son[a-z]+=/i.test(page));
    }
  }
});

test("large sessions: trace is capped with a notice and renders quickly", () => {
  const evs: CanonicalEvent[] = [turnStart(1, 1, "go", true, 0)];
  for (let i = 0; i < 15_000; i++) {
    evs.push(req(10 + 2 * i, `T${i % 50}`, i + 1, { sec: i % 3000 }));
    evs.push(done(11 + 2 * i, i + 1, 10 + 2 * i, { sec: (i % 3000) + 1 }));
  }
  // Unvalidated on purpose: validating 30k events is not what is under test.
  const v = { record: base.record, result: { ...base.result, events: evs } };
  assert.equal(v.result.events.length, 30_001);
  const t0 = performance.now();
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `took ${ms}ms`);
  assert.ok(html.includes("Trace truncated: showing the first 5000 of 30001 events."));
  assert.equal(TRACE_MAX_EVENTS, 5000);
  assert.deepEqual(htmlViolations(html), []);
  const tb = performance.now();
  const full = buildTrace(v.result.events);
  assert.ok(performance.now() - tb < 3000);
  assert.equal(
    full.usage.reduce((n, r) => n + r.calls, 0),
    15_000,
  );
});
