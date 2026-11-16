import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSpanRunPage, type SpanRowView, type SpanRunView } from "../src/index.js";
import { RENDER_OPTS } from "./helpers.js";

const AGT = `agt_${"a".repeat(32)}`;
const hex = (n: number): string => n.toString(16).padStart(16, "0");

function tool(i: number): SpanRowView {
  return {
    spanId: hex(i + 1),
    parentSpanId: null,
    name: { kind: "text", value: "execute_tool Bash", masked: false },
    kind: 1,
    startNs: BigInt(1_700_000_000 + i) * 1_000_000_000n,
    endNs: BigInt(1_700_000_001 + i) * 1_000_000_000n,
    statusCode: 1,
    statusMessage: null,
    opClass: "tool",
    keyId: `key_${"b".repeat(16)}`,
    canonical: true,
    late: false,
    attributes: [
      {
        key: "gen_ai.tool.name",
        keyAltered: false,
        value: { kind: "text", value: "Bash", masked: false },
      },
      {
        key: "gen_ai.tool.call.arguments",
        keyAltered: false,
        value: {
          kind: "content",
          sha256: "d".repeat(64),
          byteLength: 2000,
          inline: "a".repeat(2000),
        },
      },
    ],
    events: [],
    agentId: AGT,
    ownerAgentId: null,
    parentOwnerAgentId: null,
  };
}

test("run page tabs degrade to a truncation notice under the byte cap", () => {
  const view: SpanRunView = {
    run: {
      runId: `run_${"c".repeat(32)}`,
      kind: "trace",
      agentId: AGT,
      agentName: "a",
      status: "ended",
      error: false,
      late: false,
      traceId: null,
      sessionKey: null,
      contentPolicy: "inline",
      counts: {},
      credentials: [],
      firstReceivedMs: 0,
      lastReceivedMs: 0,
    },
    spans: Array.from({ length: 100 }, (_, i) => tool(i)),
    conflicts: [],
    truncated: true,
    agents: [{ agentId: AGT, name: "a" }],
  };
  const html = renderSpanRunPage(
    view,
    { ...RENDER_OPTS, maxOutputBytes: 1_000_000 },
    { csrf: null, nowMs: 0 },
  );
  assert.match(html, /Output size cap: showing the first \d+ of 100 rows/);
  assert.match(html, /only the first 100 spans are shown/);
});

function viewOf(spans: SpanRowView[], agents: { agentId: string; name: string }[]): SpanRunView {
  return {
    run: {
      runId: `run_${"c".repeat(32)}`,
      kind: "trace",
      agentId: AGT,
      agentName: "a",
      status: "ended",
      error: false,
      late: false,
      traceId: null,
      sessionKey: null,
      contentPolicy: "hash-only",
      counts: {},
      credentials: [],
      firstReceivedMs: 0,
      lastReceivedMs: 0,
    },
    spans,
    conflicts: [],
    truncated: false,
    agents,
  };
}

const NAV = { csrf: null, nowMs: 0 };

test("a credential without a label shows the first 8 hex digits; a missing name shows the short ID", () => {
  const html = renderSpanRunPage(viewOf([tool(0)], []), RENDER_OPTS, NAV);
  const cm = html.slice(html.indexOf('id="p-cm"'), html.indexOf('id="p-tl"'));
  assert.match(cm, /<td>bbbbbbbb<\/td>/);
  assert.match(cm, /<td>agt_aaaaaaaa<\/td>/);
  assert.ok(!cm.includes("unknown agent"));
});

test("agents beyond index 15 share one labelled bucket", () => {
  const spans: SpanRowView[] = [];
  const agents: { agentId: string; name: string }[] = [];
  for (let i = 0; i < 20; i++) {
    const id = `agt_${i.toString(16).padStart(32, "0")}`;
    spans.push({ ...tool(i), agentId: id });
    agents.push({ agentId: id, name: `n${i}` });
  }
  const html = renderSpanRunPage(viewOf(spans, agents), RENDER_OPTS, NAV);
  assert.match(html, /<label for="a-g-15">15\+ \(others\)<\/label>/);
});

test("Agents panel caps long names at 128 code points", () => {
  const html = renderSpanRunPage(
    viewOf([tool(0)], [{ agentId: AGT, name: "N".repeat(500) }]),
    RENDER_OPTS,
    NAV,
  );
  const ag = html.slice(html.indexOf('id="p-ag"'), html.indexOf('id="p-wf"'));
  assert.ok(ag.includes("N".repeat(128)));
  assert.ok(!ag.includes("N".repeat(129)));
});

test("the Agents panel shares the row budget", () => {
  const spans: SpanRowView[] = [];
  const agents: { agentId: string; name: string }[] = [];
  for (let i = 0; i < 200; i++) {
    const id = `agt_${i.toString(16).padStart(32, "0")}`;
    spans.push({ ...tool(i), agentId: id });
    agents.push({ agentId: id, name: `agent-${i}` });
  }
  const html = renderSpanRunPage(
    viewOf(spans, agents),
    { ...RENDER_OPTS, maxOutputBytes: 600_000 },
    NAV,
  );
  assert.match(html, /Output size cap: showing the first \d+ of 200 rows/);
});
