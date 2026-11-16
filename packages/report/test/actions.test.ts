import assert from "node:assert/strict";
import { test } from "node:test";
import { type CanonicalEvent, makeContentRef } from "@swain/core";
import {
  explainSession,
  maskHomeInText,
  renderHtmlReport,
  renderUiSessionPage,
} from "../src/index.js";
import {
  ACTIONS_MAX_ROWS,
  actionSummary,
  buildActionLog,
  extractInput,
  isShellTool,
  mergeRowsChronologically,
} from "../src/render/actions.js";
import { buildTrace, type TraceStep } from "../src/render/trace.js";
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
const act = (n: number): string => `act_${hex(n)}`;
const tc = (n: number): string => `tc_${hex(n)}`;
const T0 = Date.UTC(2026, 2, 2, 9, 0, 0);
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

interface Opts {
  actor?: number;
  links?: { rel: string; target: string }[];
  sec?: number | null;
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
  e["turnId"] = null;
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
type Ref = ReturnType<typeof makeContentRef>;
const inline = (s: string): Ref => makeContentRef(s, { retention: "inline" });
const hashed = (s: string): Ref => makeContentRef(s, { retention: "hash-only" });
const req = (n: number, name: string, call: number | null, input: Ref | null, o: Opts = {}) =>
  ev(
    n,
    "tool.requested",
    "none",
    {
      toolCallId: call === null ? null : tc(call),
      toolName: name,
      toolNamespace: "builtin",
      input,
    },
    o,
  );
const done = (n: number, call: number | null, target: number | null, out = "out", o: Opts = {}) =>
  ev(
    n,
    "tool.completed",
    "success",
    {
      toolCallId: call === null ? null : tc(call),
      toolName: null,
      output: inline(out),
      exitCode: 0,
    },
    { ...o, links: target === null ? [] : [{ rel: "result-of", target: evt(target) }] },
  );
const started = (n: number, agent: number, type: string | null, o: Opts = {}) =>
  ev(
    n,
    "agent.started",
    "none",
    { agentActorId: act(agent), parentActorId: null, agentType: type, spawnedByToolCallId: null },
    o,
  );
const cmdInput = (c: unknown): Ref => inline(JSON.stringify({ command: c }));

test("shell tool names", () => {
  for (const n of [
    "Bash",
    "bash",
    "exec_command",
    "shell_command",
    "shell",
    "local_shell",
    "run_shell_command",
  ]) {
    assert.ok(isShellTool(n), n);
  }
  for (const n of ["Read", "apply_patch", "write_stdin", "grep", "BASH", "bash_output", "exec"]) {
    assert.ok(!isShellTool(n), n);
  }
});

test("provider fixtures: the shell calls found are exactly the fixture's shell calls", () => {
  const expected: Record<
    string,
    { tools: string[]; commands: (string | null)[]; hidden: (number | null)[] }
  > = {
    "claude-code": {
      tools: ["Bash", "Bash", "Bash"],
      commands: [null, null, null],
      hidden: [11, 11, 10],
    },
    "codex-cli": { tools: ["shell"], commands: ["ls src"], hidden: [null] },
    "gemini-cli": { tools: [], commands: [], hidden: [] },
    opencode: { tools: [], commands: [], hidden: [] },
  };
  for (const name of PROVIDER_FIXTURES) {
    const view = loadSession(name);
    const rows = buildActionLog(view.result.events).rows;
    const reqs = view.result.events.filter((e) => e.kind === "tool.requested").length;
    assert.equal(rows.length, reqs, `${name} one row per request`);
    const cmds = rows.filter((r) => r.isCommand);
    const want = expected[name];
    assert.ok(want !== undefined);
    assert.deepEqual(
      cmds.map((r) => r.toolName),
      want.tools,
      name,
    );
    assert.deepEqual(
      cmds.map((r) => r.command),
      want.commands,
      name,
    );
    assert.deepEqual(
      cmds.map((r) => r.commandHiddenBytes),
      want.hidden,
      name,
    );
    assert.deepEqual(
      rows.map((r) => r.seq),
      rows.map((_, i) => i + 1),
    );
    for (const r of rows) assert.equal(r.agentLabel, "main");
  }
});

test("claude fixture: hash-only command is hidden, statuses and exit codes come from the pairing", () => {
  const rows = buildActionLog(base.result.events).rows;
  const bash = rows.filter((r) => r.toolName === "Bash");
  assert.deepEqual(
    bash.map((r) => r.status),
    ["failed", "ok", "none"],
  );
  assert.deepEqual(
    bash.map((r) => r.exitCode),
    [1, 0, null],
  );
  const first = bash[0];
  assert.ok(first !== undefined);
  assert.equal(actionSummary(first), "command hidden (hash-only, 11 bytes)");
  assert.equal(first.requestId, first.eventIds[0]);
  assert.equal(first.eventIds.length, 2);
  assert.equal(bash[2]?.eventIds.length, 1);
  assert.equal(first.durationMs, 3000);
});

test("command extraction: command and cmd fields, arrays, raw shell text, targets", () => {
  const x = (n: string, i: Ref | null) => extractInput(n, i);
  assert.equal(x("Bash", cmdInput("ls -la")).command, "ls -la");
  assert.equal(x("exec_command", inline('{"cmd":"id"}')).command, "id");
  assert.equal(x("shell", cmdInput(["bash", "-lc", "echo hi"])).command, "bash -lc echo hi");
  assert.equal(x("shell", cmdInput(["a", 1])).command, null);
  assert.equal(x("shell", inline('{"foo":1}')).command, null);
  assert.equal(x("shell", inline("ls src")).command, "ls src");
  assert.equal(x("Read", inline("ls src")).command, null);
  assert.equal(x("bash", inline('{"__proto__":{"command":"x"}}')).command, null);
  assert.equal(x("Bash", hashed("whatever")).hiddenBytes, 8);
  assert.equal(x("Bash", hashed("whatever")).command, null);
  assert.equal(x("Bash", null).hiddenBytes, null);
  assert.equal(x("Read", hashed("whatever")).hiddenBytes, null);
  const t = (o: object) => x("Read", inline(JSON.stringify(o))).target;
  assert.equal(t({ file_path: "/a" }), "/a");
  assert.equal(t({ filePath: "/b" }), "/b");
  assert.equal(t({ path: "/c" }), "/c");
  assert.equal(t({ url: "http://x" }), "http://x");
  assert.equal(t({ pattern: "p" }), "p");
  assert.equal(t({ query: "q" }), "q");
  assert.equal(t({ other: "o" }), null);
  assert.equal(t({ path: 5 }), null);
});

test("non-shell rows show a target or the tool name", () => {
  const rows = buildActionLog([
    req(1, "Read", 1, inline('{"file_path":"/etc/hosts"}')),
    req(2, "Glob", 2, inline('{"x":1}')),
  ]).rows;
  const [a, b] = rows;
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(actionSummary(a), "Read: /etc/hosts");
  assert.equal(actionSummary(b), "Glob");
  assert.ok(rows.every((r) => !r.isCommand));
});

test("excerpts: command 400 and output 200 code points", () => {
  const long = "\u{1f600}".repeat(500);
  const rows = buildActionLog([req(1, "Bash", 1, cmdInput(long)), done(2, 1, 1, long)]).rows;
  const r = rows[0];
  assert.ok(r !== undefined);
  assert.equal(Array.from(actionSummary(r)).length, 403);
  assert.equal(Array.from(r.excerpt ?? "").length, 203);
  assert.equal(Array.from(r.command ?? "").length, 500);
});

test("subagent attribution: label, stable first-appearance index, nesting path", () => {
  const rows = buildActionLog([
    req(1, "Bash", 1, cmdInput("m1")),
    started(2, 2, "researcher"),
    req(3, "Bash", 2, cmdInput("r1"), { actor: 2 }),
    started(4, 3, null, { actor: 2 }),
    req(5, "Bash", 3, cmdInput("n1"), { actor: 3 }),
    done(6, 3, 5, "o", { actor: 3 }),
    started(7, 4, "researcher"),
    req(8, "Bash", 4, cmdInput("r2"), { actor: 4 }),
    req(9, "Bash", 5, cmdInput("m2")),
  ]).rows;
  assert.deepEqual(
    rows.map((r) => r.command),
    ["m1", "r1", "n1", "r2", "m2"],
  );
  assert.deepEqual(
    rows.map((r) => r.agentIndex),
    [0, 1, 2, 3, 0],
  );
  assert.deepEqual(
    rows.map((r) => r.agentLabel),
    [
      "main",
      'subagent "researcher" #1',
      "subagent (untyped) #2",
      'subagent "researcher" #3',
      "main",
    ],
  );
  assert.deepEqual(rows[2]?.agentPath, ['subagent "researcher" #1', "subagent (untyped) #2"]);
  assert.deepEqual(rows[0]?.agentPath, []);
});

test("an orphan result is its own row in event order; results are never duplicated", () => {
  const rows = buildActionLog([
    req(1, "Bash", 1, cmdInput("a")),
    done(2, 9, null, "orphan out"),
    done(3, 1, 1),
    req(4, "Bash", 2, cmdInput("b")),
  ]).rows;
  assert.deepEqual(
    rows.map((r) => r.requestId),
    [evt(1), null, evt(4)],
  );
  assert.equal(rows[1]?.resultId, evt(2));
  assert.equal(rows[1]?.toolName, "(unnamed)");
  assert.equal(rows[1]?.excerpt, "orphan out");
  assert.equal(rows[0]?.resultId, evt(3));
});

test("pairing falls back to toolCallId when there is no link", () => {
  const rows = buildActionLog([req(1, "Bash", 7, cmdInput("a")), done(2, 7, null, "x")]).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "ok");
});

test("rows without a valid time keep order and merge after timed rows", () => {
  const a = buildActionLog([
    req(1, "Bash", 1, cmdInput("a1"), { sec: null }),
    req(2, "Bash", 2, cmdInput("a2"), { sec: 50 }),
  ]).rows;
  const b = buildActionLog([
    req(1, "Bash", 1, cmdInput("b1"), { sec: 10 }),
    req(2, "Bash", 2, cmdInput("b2"), { sec: null }),
  ]).rows;
  const items = [...a.map((row) => ({ row, order: 0 })), ...b.map((row) => ({ row, order: 1 }))];
  const merged = mergeRowsChronologically(items).map((x) => x.row.command);
  assert.deepEqual(merged, ["b1", "a2", "a1", "b2"]);
  assert.equal(a[0]?.time, null);
  assert.equal(a[0]?.timeText, "(missing)");
});

const htmlOf = (evs: CanonicalEvent[], ui = false) => {
  const v = withEvents(base, evs);
  const ex = explainSession(v, EXPLAIN_OPTS);
  return ui ? renderUiSessionPage(v, ex, RENDER_OPTS) : renderHtmlReport(v, ex, RENDER_OPTS);
};
const section = (h: string): string =>
  h.slice(h.indexOf("<h2>Commands and actions</h2>"), h.indexOf("<h2>Timeline</h2>"));

test("every provider fixture renders a clean section between Trace and Timeline", () => {
  for (const name of PROVIDER_FIXTURES) {
    const v = loadSession(name);
    for (const html of [
      renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS),
      renderUiSessionPage(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS),
    ]) {
      assert.deepEqual(htmlViolations(html), [], name);
      const t = html.indexOf("<h2>Trace</h2>");
      const a = html.indexOf("<h2>Commands and actions</h2>");
      const l = html.indexOf("<h2>Timeline</h2>");
      assert.ok(t < a && a < l, name);
      assert.ok(html.slice(a, l).includes("Only shell commands"));
      assert.ok(html.slice(a, l).includes("shell tools identified by tool name"));
    }
  }
  const claude = section(renderHtmlReport(base, explainSession(base, EXPLAIN_OPTS), RENDER_OPTS));
  assert.ok(claude.includes("command hidden (hash-only, 11 bytes)"));
  assert.ok(claude.includes('class="cmd ag0"'));
});

test("filter classes and ids come only from the fixed set; agents beyond 15 share ag15", () => {
  const evs: CanonicalEvent[] = [];
  let n = 1;
  evs.push(req(n++, "Bash", 1, cmdInput("m")));
  for (let a = 2; a <= 20; a++) {
    evs.push(started(n++, a, `<b>${a}</b>`));
    evs.push(req(n++, "Read", a, inline('{"path":"/x"}'), { actor: a }));
  }
  const html = htmlOf(evs);
  const sec = section(html);
  const classes = new Set([...sec.matchAll(/<tr class="([^"]*)"/g)].map((m) => m[1] ?? ""));
  const allowed = new Set(["cmd ag0", ...Array.from({ length: 16 }, (_, k) => `ag${k}`)]);
  for (const c of classes) assert.ok(allowed.has(c), c);
  assert.ok(classes.has("ag15"));
  const ids = [...sec.matchAll(/ id="(a-[a-z]-[a-z0-9]+)"/g)].map((m) => m[1] ?? "");
  for (const i of ids) assert.match(i, /^a-(s-(all|cmd)|g-(all|[0-9]|1[0-5]))$/);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(sec.includes(">15+</label>"));
  assert.ok(sec.includes("subagent &quot;&lt;b&gt;2&lt;/b&gt;&quot; #1"));
  assert.ok(!sec.includes("<b>"));
  assert.deepEqual(htmlViolations(html), []);
});

test("the stylesheet is static: selectors for all 16 agents, constant CSP", () => {
  const styleOf = (h: string) => /<style>([\s\S]*?)<\/style>/.exec(h)?.[1] ?? "";
  const cspOf = (h: string) => /content="(default-src[^"]*)"/.exec(h)?.[1];
  const h1 = htmlOf([req(1, "Bash", 1, cmdInput("a"))]);
  const h2 = htmlOf([req(1, "Read", 1, inline('{"path":"/q"}')), started(2, 2, "x")]);
  assert.equal(styleOf(h1), styleOf(h2));
  assert.equal(cspOf(h1), cspOf(h2));
  const css = styleOf(h1);
  assert.ok(css.includes("body:has(#a-s-cmd:checked) .acts tbody tr:not(.cmd){display:none}"));
  for (let k = 0; k <= 15; k++) {
    assert.ok(
      css.includes(`body:has(#a-g-${k}:checked) .acts tbody tr:not(.ag${k}){display:none}`),
    );
  }
  assert.ok(!css.includes("ag16"));
});

test("failed, denied and interrupted rows use the bad badge", () => {
  const fail = (n: number, call: number, target: number, status: string) =>
    ev(
      n,
      "tool.failed",
      status,
      {
        toolCallId: tc(call),
        toolName: null,
        output: null,
        error: hashed("e"),
        errorClass: "error",
      },
      { links: [{ rel: "result-of", target: evt(target) }] },
    );
  const sec = section(
    htmlOf([
      req(1, "Bash", 1, cmdInput("a")),
      fail(2, 1, 1, "failure"),
      req(3, "Bash", 2, cmdInput("b")),
      fail(4, 2, 3, "denied"),
      req(5, "Bash", 3, cmdInput("c")),
      fail(6, 3, 5, "interrupted"),
    ]),
  );
  assert.equal((sec.match(/class="b-bad"/g) ?? []).length, 3);
  assert.ok(sec.includes("output hidden (hash-only, 1 bytes)"));
});

test("the action log is capped with a static notice", () => {
  const evs: CanonicalEvent[] = [];
  for (let i = 0; i < ACTIONS_MAX_ROWS + 20; i++) {
    evs.push(req(i + 1, "Bash", i + 1, cmdInput(`c${i}`)));
  }
  const v = { record: base.record, result: { ...base.result, events: evs } };
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), RENDER_OPTS);
  const sec = section(html);
  assert.ok(
    sec.includes(
      `Action log truncated: showing the first ${ACTIONS_MAX_ROWS} of ${ACTIONS_MAX_ROWS + 20} actions.`,
    ),
  );
  assert.equal((sec.match(/<tr class=/g) ?? []).length, ACTIONS_MAX_ROWS);
});

test("maxRenderedEvents bounds the examined events and says so", () => {
  const evs: CanonicalEvent[] = [];
  for (let i = 0; i < 30; i++) evs.push(req(i + 1, "Bash", i + 1, cmdInput(`c${i}`)));
  const v = { record: base.record, result: { ...base.result, events: evs } };
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), {
    ...RENDER_OPTS,
    maxRenderedEvents: 10,
  });
  const sec = section(html);
  assert.ok(sec.includes("Events truncated: the first 10 of 30 events were examined."));
  assert.equal((sec.match(/<tr class=/g) ?? []).length, 10);
});

test("30k events: the model builds in linear time", () => {
  const evs: CanonicalEvent[] = [started(1, 2, "researcher")];
  for (let i = 0; i < 15_000; i++) {
    const actor = 1 + (i % 2);
    evs.push(
      req(10 + 2 * i, i % 2 === 0 ? "Bash" : "Read", i + 1, cmdInput(`c${i}`), {
        actor,
        sec: i % 3000,
      }),
    );
    evs.push(done(11 + 2 * i, i + 1, 10 + 2 * i, "o", { actor, sec: (i % 3000) + 1 }));
  }
  assert.equal(evs.length, 30_001);
  const t0 = performance.now();
  const log = buildActionLog(evs);
  const ms = performance.now() - t0;
  assert.equal(log.rows.length, 15_000);
  assert.ok(ms < 3000, `took ${ms}ms`);
  assert.equal(log.rows.filter((r) => r.isCommand).length, 7500);
  assert.equal(log.rows[1]?.agentIndex, 1);
});

test("an agent that emits its own start is nested under payload.parentActorId", () => {
  const own = (n: number, agent: number, parent: number, type: string) =>
    ev(
      n,
      "agent.started",
      "none",
      {
        agentActorId: act(agent),
        parentActorId: act(parent),
        agentType: type,
        spawnedByToolCallId: null,
      },
      { actor: agent },
    );
  const rows = buildActionLog([
    req(1, "Bash", 1, cmdInput("m")),
    own(2, 2, 1, "a"),
    own(3, 3, 2, "b"),
    req(4, "Bash", 2, cmdInput("x"), { actor: 3 }),
  ]).rows;
  assert.deepEqual(rows[1]?.agentPath, ['subagent "a" #1', 'subagent "b" #2']);
  assert.equal(rows[1]?.agentIndex, 2);
});

test("maskHomeInText masks whole path prefixes anywhere in a command", () => {
  const m = (s: string) => maskHomeInText(s, "/home/demo/");
  assert.equal(m("cat /home/demo/.ssh/id; ls /home/demo"), "cat ~/.ssh/id; ls ~");
  assert.equal(m("x=/home/demo/a /home/demo2/b /mnt/home/demo/c"), "x=~/a /home/demo2/b /mnt~/c");
  assert.equal(maskHomeInText("/home/demo/x", null), "/home/demo/x");
  assert.equal(maskHomeInText("/x", "/"), "/x");
});

const HOME = "/home/u";

test("F1: masking happens before the cut; no part of the home path survives at 400 or 200", () => {
  const cases = [
    "x".repeat(393) + "/home/u/secret",
    "x".repeat(400 - HOME.length) + HOME + "/more",
    "x".repeat(397) + "/home/u/secret",
    "x".repeat(399) + HOME,
  ];
  for (const c of cases) {
    const rows = buildActionLog(
      [req(1, "Bash", 1, cmdInput(c)), done(2, 1, 1, c.slice(0, 190) + HOME + "/q")],
      [HOME],
    ).rows;
    const r = rows[0];
    assert.ok(r !== undefined);
    for (const text of [actionSummary(r), r.command ?? "", r.excerpt ?? ""]) {
      assert.ok(!text.includes("/h"), text.slice(-30));
      assert.ok(!text.includes("home"), text.slice(-30));
    }
    assert.ok((r.command ?? "").includes("~"));
  }
  // The 200 code point output cut, home path ending exactly at it and straddling it.
  for (const n of [200 - 1 - HOME.length + 1, 197, 198, 199]) {
    const out = "y".repeat(n) + HOME + "/tail";
    const r = buildActionLog([req(1, "Bash", 1, cmdInput("a")), done(2, 1, 1, out)], [HOME])
      .rows[0];
    assert.ok(r !== undefined);
    assert.ok(!(r.excerpt ?? "").includes("/h"));
    assert.ok(!(r.excerpt ?? "").includes("home"));
  }
  // Targets too.
  const t = buildActionLog(
    [req(1, "Read", 1, inline(JSON.stringify({ path: "z".repeat(393) + "/home/u/s" })))],
    [HOME],
  ).rows[0];
  assert.ok(t !== undefined && !actionSummary(t).includes("/h"));
});

test("F1: HTML masks before the cut, for homeDir and a different realHomeDir", () => {
  const c = "x".repeat(393) + "/home/demo/secret";
  const c2 = "x".repeat(396) + "/real/home/z";
  const evs = [req(1, "Bash", 1, cmdInput(c)), req(2, "Bash", 2, cmdInput(c2))];
  const v = withEvents(base, evs);
  const html = renderHtmlReport(v, explainSession(v, EXPLAIN_OPTS), {
    ...RENDER_OPTS,
    realHomeDir: "/real/home",
  });
  const sec = section(html);
  assert.ok(!sec.includes("/home"), "no home fragment");
  assert.ok(!sec.includes("/ho"));
  assert.ok(sec.includes("~/secre"));
});

test("F2: a path glued to a one-letter option is masked", () => {
  assert.equal(maskHomeInText("gcc -I/home/u/inc -L/home/u/lib", "/home/u"), "gcc -I~/inc -L~/lib");
  assert.equal(maskHomeInText("echo a-I/home/u/inc", "/home/u"), "echo a-I~/inc");
});

test("F5: attribution only between start and end, and never of the main actor", () => {
  const rows = buildActionLog([
    req(1, "Bash", 1, cmdInput("main1")),
    req(2, "Bash", 2, cmdInput("before"), { actor: 2 }),
    started(3, 2, "main"),
    req(4, "Bash", 3, cmdInput("during"), { actor: 2 }),
    ev(5, "agent.ended", "success", { agentActorId: act(2) }),
    req(6, "Bash", 4, cmdInput("after"), { actor: 2 }),
    // A start that names the main actor (the first event's actor) is ignored.
    started(7, 1, "evil", { actor: 2 }),
    req(8, "Bash", 5, cmdInput("main2")),
  ]).rows;
  assert.deepEqual(
    rows.map((r) => [r.command, r.agentLabel]),
    [
      ["main1", "main"],
      ["before", "main"],
      ["during", 'subagent "main" #1'],
      ["after", "main"],
      ["main2", "main"],
    ],
  );
  assert.notEqual(rows[2]?.agentLabel, "main");
});

test("F5: a user actor is never claimed, and type text cannot fake nesting", () => {
  const user = ev(
    2,
    "message.observed",
    "none",
    { role: "user", channel: "text", content: inline("hi") },
    { actor: 9 },
  );
  (user as { actor: { role: string } }).actor.role = "user";
  const rows = buildActionLog([
    req(1, "Bash", 1, cmdInput("m")),
    user,
    started(3, 9, "x"),
    req(4, "Bash", 2, cmdInput("u"), { actor: 9 }),
    started(5, 2, "a > b \u203a c"),
    req(6, "Bash", 3, cmdInput("s"), { actor: 2 }),
  ]).rows;
  assert.equal(rows[1]?.agentLabel, "main");
  const s = rows[2];
  assert.equal(s?.agentPath.length, 1);
  assert.ok(s?.agentLabel.startsWith('subagent "a > b'));
  assert.equal(s?.agentLabel.endsWith('" #1'), true);
});

test("F5: trace does not relabel the main actor either", () => {
  const trace = buildTrace([
    req(1, "Bash", 1, cmdInput("m1")),
    started(2, 1, "evil", { actor: 2 }),
    req(3, "Bash", 2, cmdInput("m2")),
  ]);
  const top = trace.groups.flatMap((g) => g.steps);
  const nested = (st: readonly TraceStep[]): number =>
    st
      .filter((x) => x.type === "agent")
      .reduce((n, x) => n + (x.type === "agent" ? x.steps.length : 0), 0);
  assert.equal(nested(top), 0);
  assert.equal(top.filter((x) => x.type === "tool").length, 2);
});

test("UX: Agent and Task rows show subagent_type and description", () => {
  const rows = buildActionLog([
    req(
      1,
      "Agent",
      1,
      inline(JSON.stringify({ subagent_type: "recon", description: "Recon", prompt: "p" })),
    ),
    req(2, "Task", 2, inline(JSON.stringify({ description: "only desc" }))),
    req(3, "Agent", 3, inline(JSON.stringify({ prompt: "x" }))),
  ]).rows;
  assert.deepEqual(
    rows.map((r) => actionSummary(r)),
    ["Agent: recon - Recon", "Task: only desc", "Agent"],
  );
});

test("empty command differs from a command that was not recorded", () => {
  const rows = buildActionLog([
    req(1, "Bash", 1, cmdInput("")),
    req(2, "Bash", 2, inline(JSON.stringify({ command: 5 }))),
    req(3, "shell", 3, inline("")),
  ]).rows;
  assert.deepEqual(
    rows.map((r) => actionSummary(r)),
    ["(empty command)", "Bash (command not recorded)", "(empty command)"],
  );
});
