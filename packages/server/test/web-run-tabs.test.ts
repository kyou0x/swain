/**
 * The trace run page tabs (Commands, Timeline, Agents, Waterfall, Spans): per-row agent
 * attribution through the same-credential walk, the content policy gate, the excerpt cap, hostile
 * strings and the structural allow-list of the response bytes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredSpan, SwainStore } from "@swain/db";
import { agentNameViews } from "../src/webdata.js";
import { type Credential, type Env, http, postJson, startEnv } from "./helpers.js";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const hex = (n: number): string => n.toString(16).padStart(16, "0");
const BASE = 1_700_000_000n;
const sv = (key: string, value: string) => ({ key, value: { stringValue: value } });
const iv = (key: string, n: number) => ({ key, value: { intValue: String(n) } });

interface Sp {
  id: number;
  parent: number | null;
  op: "invoke_agent" | "execute_tool" | "chat";
  /** agent name, tool name or model */
  who: string;
  at: number;
  secs?: number;
  args?: string;
  result?: string;
  input?: string;
  output?: string;
  code?: number;
}

function spanJson(s: Sp) {
  const attrs: object[] = [sv("gen_ai.operation.name", s.op)];
  if (s.op === "invoke_agent") attrs.push(sv("gen_ai.agent.name", s.who));
  if (s.op === "execute_tool") attrs.push(sv("gen_ai.tool.name", s.who));
  if (s.op === "chat") {
    attrs.push(sv("gen_ai.request.model", s.who), iv("gen_ai.usage.input_tokens", 120));
    attrs.push(iv("gen_ai.usage.output_tokens", 30));
  }
  if (s.args !== undefined) attrs.push(sv("gen_ai.tool.call.arguments", s.args));
  if (s.result !== undefined) attrs.push(sv("gen_ai.tool.call.result", s.result));
  if (s.input !== undefined) attrs.push(sv("gen_ai.input.messages", s.input));
  if (s.output !== undefined) attrs.push(sv("gen_ai.output.messages", s.output));
  return {
    traceId: TRACE,
    spanId: hex(s.id),
    ...(s.parent === null ? {} : { parentSpanId: hex(s.parent) }),
    name: `${s.op} ${s.who}`,
    kind: 1,
    startTimeUnixNano: String((BASE + BigInt(s.at)) * 1_000_000_000n),
    endTimeUnixNano: String((BASE + BigInt(s.at + (s.secs ?? 5))) * 1_000_000_000n),
    attributes: attrs,
    status: { code: s.code ?? 1 },
  };
}

async function send(env: Env, key: Credential, service: string, spans: readonly Sp[]) {
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [sv("service.name", service)] },
        scopeSpans: [{ scope: { name: "t" }, spans: spans.map(spanJson) }],
      },
    ],
  });
  const r = await postJson(env.srv.port, "/v1/traces", key, body);
  assert.equal(r.status, 200, r.text);
}

async function runPage(env: Env): Promise<string> {
  const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
  assert.ok(run !== undefined);
  const r = await http(env.srv.port, { method: "GET", path: `/r/${run.runId}`, headers: {} });
  assert.equal(r.status, 200);
  return r.text;
}

const TREE: Sp[] = [
  { id: 1, parent: null, op: "invoke_agent", who: "lead", at: 0, secs: 600 },
  { id: 2, parent: 1, op: "invoke_agent", who: "recon-net", at: 10, secs: 100 },
  { id: 3, parent: 1, op: "invoke_agent", who: "web", at: 120, secs: 400 },
  { id: 4, parent: 3, op: "invoke_agent", who: "web-params", at: 200, secs: 150 },
  {
    id: 10,
    parent: 2,
    op: "execute_tool",
    who: "Bash",
    at: 20,
    args: "nmap -sV 10.0.0.5",
    result: "22/tcp open ssh",
  },
  {
    id: 11,
    parent: 3,
    op: "execute_tool",
    who: "Read",
    at: 130,
    args: "scope.txt",
    result: "in scope",
  },
  {
    id: 12,
    parent: 4,
    op: "execute_tool",
    who: "Bash",
    at: 210,
    args: "sqlmap -u http://t/?id=1",
    result: "injectable",
    code: 2,
  },
  {
    id: 13,
    parent: 3,
    op: "execute_tool",
    who: "Bash",
    at: 400,
    args: "curl -s http://t/",
    result: "ok page",
  },
  {
    id: 14,
    parent: 3,
    op: "chat",
    who: "model-x",
    at: 125,
    input: "what next?",
    output: "try the id param",
  },
];

/** Tag and attribute allow-list of the page bytes; hrefs are the server routes only. */
const TAGS = new Set(
  "html head meta title style body header div span a p h1 h2 h3 ul ol li table thead tbody tr th td code dl dt dd details summary form button input label section fieldset legend".split(
    " ",
  ),
);
const ATTRS = new Set(
  "class id href lang charset name content http-equiv colspan type value method action for open checked".split(
    " ",
  ),
);
const HREF_OK =
  /^(\/|\/runs|\/a\/agt_[0-9a-f]{32}|\/r\/run_[0-9a-f]{32}|#s-[0-9a-f]{16}|#s-invalid)$/;

function violations(html: string): string[] {
  const bad: string[] = [];
  const text = html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  for (const m of text.matchAll(/<([^>]*)>/g)) {
    const inner = m[1] ?? "";
    const name = /^\/?([a-zA-Z0-9!]+)/.exec(inner)?.[1]?.toLowerCase() ?? "";
    if (name === "!doctype") continue;
    if (!TAGS.has(name)) bad.push(`tag ${inner.slice(0, 40)}`);
    for (const a of inner.replace(/="[^"]*"/g, "=").matchAll(/\s([a-zA-Z-]+)=?/g)) {
      if (!ATTRS.has(a[1] ?? "")) bad.push(`attr ${a[1]}`);
    }
    for (const h of inner.matchAll(/href="([^"]*)"/g)) {
      if (!HREF_OK.test(h[1] ?? "")) bad.push(`href ${h[1]}`);
    }
  }
  if (/[<]/.test(text.replace(/<[^>]*>/g, ""))) bad.push("raw < in text");
  for (const m of text.matchAll(/<([^>]*)>/g)) {
    if (/^\/?script|\sstyle=|\son[a-z]+=/i.test(m[1] ?? "")) bad.push("script, style or handler");
  }
  return bad;
}

interface CmdRow {
  agent: string;
  cred: string;
  tool: string;
  cmd: string;
  result: string;
  cls: string;
}

/** The Commands panel rows. */
function commandRows(html: string): CmdRow[] {
  const panel =
    /<div class="panel" id="p-cm">([\s\S]*?)<div class="panel" id="p-tl">/.exec(html)?.[1] ?? "";
  return [...panel.matchAll(/<tr class="([^"]*)">((?:<td>[\s\S]*?<\/td>)+)<\/tr>/g)].map((m) => {
    const td = [...(m[2] ?? "").matchAll(/<td>([\s\S]*?)<\/td>/g)].map((x) => x[1] ?? "");
    const cell = (i: number): string =>
      (td[i] ?? "").replace(/^<div class="pc">/, "").replace(/<\/div>$/, "");
    return {
      cls: m[1] ?? "",
      agent: td[2] ?? "",
      cred: td[3] ?? "",
      tool: td[4] ?? "",
      cmd: cell(5),
      result: cell(6),
    };
  });
}

async function withPolicy(inline: boolean): Promise<Env> {
  const env = await startEnv({ agentName: null });
  if (inline) {
    env.store.setProjectPolicy(
      env.scope,
      { contentPolicy: "inline" },
      { type: "owner", id: "local", at: "2026-01-01T00:00:00.000Z" },
    );
  }
  return env;
}

test("Commands: every tool, correct agent per row, filters, inline text", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", TREE);
    const html = await runPage(env);
    const rows = commandRows(html);
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((r) => [r.agent, r.tool]),
      [
        ["recon-net", "Bash"],
        ["web", "Read"],
        ["web-params", "Bash"],
        ["web", "Bash"],
      ],
    );
    assert.match(rows[2]?.cmd ?? "", /sqlmap -u/);
    assert.match(rows[0]?.cmd ?? "", /nmap -sV 10\.0\.0\.5/);
    assert.ok(
      rows[2]?.cls.includes("bad") && rows[2].cls.includes("cmd"),
      "error and shell classes",
    );
    assert.ok(!rows[1]?.cls.includes("cmd"), "Read is not a shell tool");
    assert.match(html, /<td>\d{4}-\d\d-\d\dT[\d:.]+Z <span class="dim">\+00:20<\/span><\/td>/);
    for (const label of ["all", "lead", "recon-net", "web", "web-params"]) {
      assert.match(html, new RegExp(`<label for="a-g-[a-z0-9]+">${label}</label>`));
    }
    assert.match(html, /Only shell commands/);
    assert.match(html, /<input type="radio" name="tab" id="t-cm" checked>/);
    for (const t of ["tl", "ag", "wf", "sp"]) assert.match(html, new RegExp(`id="t-${t}"`));
    assert.deepEqual(violations(html), []);
  } finally {
    await env.done();
  }
});

test("hash-only project: no command, result or message text, only hashes", async () => {
  const env = await withPolicy(false);
  try {
    await send(env, env.key, "swarm", TREE);
    const html = await runPage(env);
    for (const secret of [
      "sqlmap",
      "nmap -sV",
      "injectable",
      "22/tcp",
      "try the id param",
      "what next?",
    ]) {
      assert.ok(!html.includes(secret), `${secret} must not appear`);
    }
    const rows = commandRows(html);
    assert.equal(rows.length, 4);
    assert.match(rows[2]?.cmd ?? "", /hash-only <code>[0-9a-f]{12}<\/code>/);
    assert.deepEqual(violations(html), []);
  } finally {
    await env.done();
  }
});

test("Agents and Timeline tabs: counts, tokens, parents, errors, indentation", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", TREE);
    const html = await runPage(env);
    const agents = /id="p-ag">([\s\S]*?)<div class="panel" id="p-wf">/.exec(html)?.[1] ?? "";
    const cells = (name: string): string[] => {
      const row = new RegExp(`<tr><td>${name}</td>([\\s\\S]*?)</tr>`).exec(agents)?.[1] ?? "";
      return [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? "");
    };
    // parent, model, start, end, duration, tools, chats, in, out, errors
    const web = cells("web");
    assert.equal(web[0], "lead");
    assert.equal(web[1], "model-x");
    assert.equal(web[5], "2");
    assert.equal(web[6], "1");
    assert.equal(web[7], "120");
    assert.equal(web[8], "30");
    const wp = cells("web-params");
    assert.equal(wp[0], "web");
    assert.match(wp[9] ?? "", />1</);
    assert.equal(cells("lead")[0], '<span class="dim">none</span>');
    const tl = /id="p-tl">([\s\S]*?)<div class="panel" id="p-ag">/.exec(html)?.[1] ?? "";
    assert.match(tl, /<td>agent start<\/td>/);
    assert.match(tl, /<td>agent end<\/td>/);
    assert.match(tl, /120 &rarr; 30 tokens/);
    assert.match(tl, /in: what next\?/);
    assert.match(tl, /<div class="i2">web-params<\/div>/);
    assert.match(tl, /<div class="i0">lead<\/div>/);
  } finally {
    await env.done();
  }
});

test("cross-key parenting does not change attribution", async () => {
  const env = await withPolicy(true);
  try {
    const keyB = env.newKey({ agentName: null });
    await send(env, env.key, "svc-a", TREE);
    // key B parents a tool span under A's web-params agent span
    await send(env, keyB, "svc-b", [
      { id: 50, parent: 4, op: "execute_tool", who: "Bash", at: 220, args: "id", result: "uid=0" },
    ]);
    const html = await runPage(env);
    const rows = commandRows(html);
    const foreign = rows.find((r) => r.cmd === "<code>id</code>");
    assert.ok(foreign !== undefined);
    assert.equal(foreign.agent, "svc-b", "B's tool stays on B's own agent");
    assert.equal(rows.find((r) => r.cmd.includes("sqlmap"))?.agent, "web-params");
  } finally {
    await env.done();
  }
});

test("hostile strings in arguments, results, agent names and messages are escaped", async () => {
  const env = await withPolicy(true);
  try {
    const evil = "<script>alert(1)</script>";
    await send(env, env.key, "swarm", [
      {
        id: 1,
        parent: null,
        op: "invoke_agent",
        who: `${evil}<img src=x onerror=alert(9)>`,
        at: 0,
      },
      {
        id: 2,
        parent: 1,
        op: "execute_tool",
        who: "Bash",
        at: 1,
        args: `echo ${evil} style="x" onclick=y`,
        result: `"><${evil}`,
      },
      { id: 3, parent: 1, op: "chat", who: "m", at: 2, input: evil, output: evil },
    ]);
    const html = await runPage(env);
    assert.ok(!/<script/i.test(html));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.deepEqual(violations(html), []);
  } finally {
    await env.done();
  }
});

test("excerpts are capped at 2 KiB and say so", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", [
      { id: 1, parent: null, op: "invoke_agent", who: "a", at: 0 },
      {
        id: 2,
        parent: 1,
        op: "execute_tool",
        who: "Bash",
        at: 1,
        args: `echo ${"x".repeat(5000)}`,
      },
    ]);
    const html = await runPage(env);
    const cmd = commandRows(html)[0]?.cmd ?? "";
    assert.match(cmd, /<span class="tag">truncated<\/span>/);
    assert.ok(cmd.length < 2048 + 200, `cell is ${cmd.length} long`);
    // the Spans tab keeps the raw attribute table as before (bounded by maxInlineBytes); the new
    // tabs never carry more than the cap
    const upto = html.slice(0, html.indexOf('id="p-wf"'));
    assert.ok(!upto.includes("x".repeat(2100)));
  } finally {
    await env.done();
  }
});

test("credential column: label, and a key claiming another's names is visible", async () => {
  const env = await withPolicy(true);
  try {
    const keyB = env.newKey({ agentName: null });
    await send(env, env.key, "svc", TREE);
    // key B claims A's service name and an agent name of A, and runs commands under it
    await send(env, keyB, "svc", [
      { id: 60, parent: null, op: "invoke_agent", who: "web", at: 300 },
      {
        id: 61,
        parent: 60,
        op: "execute_tool",
        who: "Bash",
        at: 301,
        args: "whoami",
        result: "root",
      },
      { id: 62, parent: null, op: "execute_tool", who: "Bash", at: 302, args: "id -u" },
    ]);
    const html = await runPage(env);
    const rows = commandRows(html);
    const sq = rows.find((r) => r.cmd.includes("sqlmap"));
    assert.equal(sq?.cred, "test-1");
    for (const needle of ["whoami", "id -u"]) {
      const row = rows.find((r) => r.cmd.includes(needle));
      assert.ok(row !== undefined, needle);
      assert.match(row.cred, /^test-2/, "B's own credential is shown");
    }
    const claimed = rows.find((r) => r.cmd.includes("whoami"));
    assert.match(claimed?.cred ?? "", /from another credential/);
    // filter labels are distinguishable
    const filter = /<fieldset class="agf">([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? "";
    const labels = [...filter.matchAll(/<label for="[^"]+">([^<]*)<\/label>/g)].map((m) => m[1]);
    assert.equal(new Set(labels).size, labels.length, `labels are unique: ${labels.join(" | ")}`);
    assert.match(html, /<th>Credential<\/th>/);
    assert.match(html, /multiple credentials contributed/);
  } finally {
    await env.done();
  }
});

test("two agents with the same name get the short agent ID in every label", async () => {
  const env = await withPolicy(true);
  try {
    const keyB = env.newKey({ agentName: null });
    await send(env, env.key, "svc-a", [
      { id: 1, parent: null, op: "invoke_agent", who: "dup", at: 0 },
    ]);
    await send(env, keyB, "svc-b", [
      { id: 2, parent: null, op: "invoke_agent", who: "dup", at: 1 },
      { id: 3, parent: 2, op: "execute_tool", who: "Bash", at: 2, args: "x" },
    ]);
    const html = await runPage(env);
    const filter = /<fieldset class="agf">([\s\S]*?)<\/fieldset>/.exec(html)?.[1] ?? "";
    const labels = [...filter.matchAll(/<label for="[^"]+">([^<]*)<\/label>/g)].map((m) => m[1]);
    assert.equal(new Set(labels).size, labels.length, labels.join(" | "));
  } finally {
    await env.done();
  }
});

test("newlines render as real line breaks, other controls stay neutralized", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", [
      { id: 1, parent: null, op: "invoke_agent", who: "a", at: 0 },
      {
        id: 2,
        parent: 1,
        op: "execute_tool",
        who: "Bash",
        at: 1,
        args: "ls",
        result: "line1\nline2\r\nline3\tx\u0001y‮z",
      },
    ]);
    const html = await runPage(env);
    const r = commandRows(html)[0]?.result ?? "";
    assert.equal(r, "line1\nline2\nline3\tx\\u{1}y\\u{202E}z");
    assert.match(html, /\.pc\{white-space:pre-wrap/);
  } finally {
    await env.done();
  }
});

test("status reads ok for unset and ok, error for error; the Spans tab keeps the raw value", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", [
      { id: 1, parent: null, op: "invoke_agent", who: "a", at: 0, code: 0 },
      { id: 2, parent: 1, op: "execute_tool", who: "Bash", at: 1, args: "ls", code: 0 },
      { id: 3, parent: 1, op: "execute_tool", who: "Bash", at: 2, args: "ls", code: 2 },
    ]);
    const html = await runPage(env);
    const upto = html.slice(0, html.indexOf('id="p-wf"'));
    assert.ok(!upto.includes("unset"));
    assert.match(upto, /<span class="b-ok">ok<\/span>/);
    assert.match(upto, /<span class="b-bad">error<\/span>/);
    assert.match(html.slice(html.indexOf('id="p-sp"')), /unset/);
  } finally {
    await env.done();
  }
});

test("Spans tab follows the current content policy: hash-only shows no stored inline text", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", TREE);
    assert.ok((await runPage(env)).includes("sqlmap -u"), "baseline: inline policy shows it");
    env.store.setProjectPolicy(
      env.scope,
      { contentPolicy: "hash-only" },
      { type: "owner", id: "local", at: "2026-01-01T00:00:00.000Z" },
    );
    const html = await runPage(env);
    assert.ok(!html.includes("sqlmap"), "no stored text anywhere once the policy is hash-only");
    assert.ok(!html.includes("try the id param"));
    assert.match(html, /content not stored \(hash-only\)/);
  } finally {
    await env.done();
  }
});

test("Spans tab caps inline text at 2 KiB", async () => {
  const env = await withPolicy(true);
  try {
    await send(env, env.key, "swarm", [
      { id: 1, parent: null, op: "invoke_agent", who: "a", at: 0 },
      { id: 2, parent: 1, op: "execute_tool", who: "Bash", at: 1, args: "y".repeat(5000) },
    ]);
    const html = await runPage(env);
    assert.ok(!html.includes("y".repeat(2100)));
    assert.match(html.slice(html.indexOf('id="p-sp"')), /truncated/);
  } finally {
    await env.done();
  }
});

test("a run too large to render gets the notice page, not a 500", async () => {
  const env = await startEnv({ agentName: null, maxPageBytes: 65536 });
  try {
    env.store.setProjectPolicy(
      env.scope,
      { contentPolicy: "inline" },
      { type: "owner", id: "local", at: "2026-01-01T00:00:00.000Z" },
    );
    const many: Sp[] = [{ id: 1, parent: null, op: "invoke_agent", who: "a", at: 0 }];
    for (let i = 0; i < 60; i++) {
      many.push({
        id: 2 + i,
        parent: 1,
        op: "execute_tool",
        who: "Bash",
        at: 1 + i,
        args: "z".repeat(2000),
      });
    }
    await send(env, env.key, "swarm", many);
    const run = env.store.runs(env.scope, { limit: 1, offset: 0 }).rows[0];
    assert.ok(run !== undefined);
    const r = await http(env.srv.port, { method: "GET", path: `/r/${run.runId}`, headers: {} });
    assert.equal(r.status, 200);
    assert.match(r.text, /Run too large to render/);
    assert.ok(!r.text.includes("zzzzzzzz"));
  } finally {
    await env.done();
  }
});

test("name cap: owner agent IDs are named before plain span agent IDs", () => {
  const agt = (n: number): string => `agt_${n.toString(16).padStart(32, "0")}`;
  const mk = (id: string, op: string, i: number): Record<string, unknown> => ({
    spanId: hex(i + 1),
    parentSpanId: null,
    agentId: id,
    opClass: op,
    statusCode: 1,
    keyId: "k",
    canonical: true,
  });
  const spans: Record<string, unknown>[] = [];
  for (let i = 0; i < 300; i++) spans.push(mk(agt(i), "tool", i));
  const owner = agt(9999);
  spans.push(mk(owner, "agent", 300));
  const store = {
    agent: (_s: unknown, id: string) => ({ agent: { displayName: `n-${id.slice(-4)}` } }),
  };
  const out = agentNameViews(
    store as unknown as SwainStore,
    {} as never,
    spans as unknown as StoredSpan[],
  );
  assert.equal(out.length, 256);
  assert.ok(
    out.some((a) => a.agentId === owner),
    "the owner is named despite the cap",
  );
});
