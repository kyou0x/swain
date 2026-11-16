import assert from "node:assert/strict";
import { test } from "node:test";
import type { DraftEvent } from "@swain/core";
import { sha256Hex } from "@swain/core";
import { sessionExport } from "../src/index.js";
import {
  accounting,
  attributeProblems,
  frameDocument,
  ofKind,
  type Run,
  run,
  shaOf,
  validated,
} from "./helpers.js";

const T0 = 1_790_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const info = {
  id: "ses_1",
  version: "1.19.5",
  directory: "/home/u/p",
  time: { created: T0, updated: T0 + 5 },
};
const user = (id: string, parts: unknown[], extra = {}) => ({
  info: { id, role: "user", time: { created: T0 + 1 }, ...extra },
  parts,
});
const asst = (id: string, parts: unknown[], extra: Record<string, unknown> = {}) => ({
  info: {
    id,
    role: "assistant",
    time: { created: T0 + 10, completed: T0 + 20 },
    modelID: "mod",
    providerID: "prov",
    ...extra,
  },
  parts,
});
const text = (t: string, extra = {}) => ({ type: "text", text: t, ...extra });
const tool = (callID: string, name: string, state: unknown) => ({
  type: "tool",
  callID,
  tool: name,
  state,
});

function go(doc: unknown, o: Parameters<typeof run>[2] = {}): Run {
  const recs = frameDocument(JSON.stringify(doc, null, 2));
  const r = run(sessionExport, recs, o);
  assert.deepEqual(accounting(recs, r), []);
  assert.deepEqual(attributeProblems(sessionExport, r), []);
  validated(sessionExport, recs, r, "ses_1");
  return r;
}

const by = (r: Run, k: string): DraftEvent[] => ofKind(r, k);

test("epoch milliseconds are normalized through the core to UTC ISO times", () => {
  const r = go({ info, messages: [user("m1", [text("hi")])] });
  const start = by(r, "session.started")[0];
  assert.equal(start?.time.value, iso(T0));
  assert.equal(start?.time.origin, "source");
  assert.equal(by(r, "turn.started")[0]?.time.value, iso(T0 + 1));
  // Out-of-range or mistyped times are invalid, never guessed.
  const bad = go({
    info,
    messages: [
      user("m1", [text("hi")], { time: { created: -5 } }),
      { ...user("m2", [text("x")]), info: { id: "m2", role: "user", time: { created: "soon" } } },
    ],
  });
  const times = by(bad, "turn.started").map((d) => d.time);
  assert.deepEqual(
    times.map((t) => t.status),
    ["invalid", "invalid"],
  );
  assert.deepEqual(
    times.map((t) => t.value),
    [null, null],
  );
  const missing = go({ info: { ...info, time: {} }, messages: [] });
  assert.equal(by(missing, "session.started")[0]?.time.status, "missing");
});

test("session.started carries the session id; cwd is the only path attribute", () => {
  const r = go({ info, messages: [] });
  const s = by(r, "session.started")[0];
  assert.deepEqual(s?.payload, { nativeSessionId: "ses_1", trigger: "unknown" });
  assert.deepEqual(s?.attributes, { "opencode.cwd": "/home/u/p" });
  const long = go({ info: { ...info, directory: `/${"d".repeat(300)}` }, messages: [] });
  assert.deepEqual(by(long, "session.started")[0]?.attributes, {});
});

test("session totals map to a session-scope model.usage (cumulative as reported)", () => {
  const r = go({
    info: {
      ...info,
      cost: 0.5,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } },
      model: { id: "m1", providerID: "p" },
    },
    messages: [],
  });
  assert.deepEqual(by(r, "model.usage")[0]?.payload, {
    scope: "session",
    model: "m1",
    inputTokens: 10,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    cachedInputTokens: 3,
    cacheWriteInputTokens: 4,
    costUsdEstimate: 0.5,
  });
});

test("user message: turn.started with the joined non-synthetic text prompt", () => {
  const r = go({
    info,
    messages: [
      user("m1", [
        text("one"),
        text("ctx", { synthetic: true }),
        text("two"),
        text("hidden", { ignored: true }),
      ]),
    ],
  });
  const t = by(r, "turn.started")[0];
  assert.equal(t?.actor.role, "user");
  assert.equal(shaOf(t?.payload["prompt"]), sha256Hex(new TextEncoder().encode("one\ntwo")));
  assert.equal(t?.pointer, "/parts/0");
  assert.equal(by(r, "message.observed").length, 0);
  const none = go({ info, messages: [user("m2", [])] });
  assert.equal(by(none, "turn.started")[0]?.payload["prompt"], null);
});

test("assistant text and reasoning map to message.observed; reasoning is provider-exposed text only", () => {
  const r = go({
    info,
    messages: [
      asst("a1", [
        { type: "reasoning", text: "think", time: { start: T0 + 11, end: T0 + 12 } },
        text("say", { time: { start: T0 + 13 } }),
        text("plain"),
      ]),
    ],
  });
  const obs = by(r, "message.observed");
  assert.deepEqual(
    obs.map((d) => d.payload["channel"]),
    ["reasoning", "text", "text"],
  );
  assert.equal(obs[0]?.completeness.internalReasoning?.state, "unavailable");
  assert.equal(obs[0]?.time.value, iso(T0 + 11));
  // A part without a time of its own borrows the message time and says so.
  assert.equal(obs[2]?.time.value, iso(T0 + 10));
  assert.equal(obs[2]?.completeness.timestamp?.state, "partial");
  assert.equal(obs[1]?.completeness.timestamp?.state, "captured");
});

test("tool parts: pending/running are requests only; completed and error carry results", () => {
  const r = go({
    info,
    messages: [
      asst("a1", [
        tool("c1", "bash", { status: "pending", input: {}, raw: "{" }),
        tool("c2", "bash", {
          status: "running",
          input: { command: "x" },
          time: { start: T0 + 30 },
        }),
        tool("c3", "bash", {
          status: "completed",
          input: { command: "ls" },
          output: "out",
          title: "ls",
          metadata: { exit: 3 },
          time: { start: T0 + 40, end: T0 + 45 },
        }),
        tool("c4", "read", {
          status: "error",
          input: { filePath: "/x" },
          error: "nope",
          time: { start: T0 + 50, end: T0 + 51 },
        }),
        tool("c5", "mcp_server_tool", { status: "weird" }),
      ]),
    ],
  });
  assert.deepEqual(
    by(r, "tool.requested").map((d) => d.attributes["opencode.tool_status"]),
    ["pending", "running", "completed", "error", "other"],
  );
  assert.deepEqual(
    by(r, "tool.requested").map((d) => d.payload["toolNamespace"]),
    ["builtin", "builtin", "builtin", "builtin", "unknown"],
  );
  const done = by(r, "tool.completed");
  assert.equal(done.length, 1);
  assert.equal(done[0]?.status, "success");
  assert.equal(done[0]?.payload["exitCode"], 3);
  assert.equal(done[0]?.payload["durationMs"], 5);
  assert.deepEqual(done[0]?.correlation?.refs, [{ rel: "result-of", key: "c3" }]);
  assert.equal(done[0]?.time.value, iso(T0 + 45));
  const failed = by(r, "tool.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.status, "failure");
  assert.equal(failed[0]?.payload["errorClass"], "error");
  assert.equal(failed[0]?.payload["output"], null);
  // Requests with anchors are never marked as having run.
  assert.equal(by(r, "tool.requested")[0]?.correlation?.anchor, "c1");
});

test("exit code is read only from bash metadata and only when an integer", () => {
  const mk = (name: string, exit: unknown) =>
    go({
      info,
      messages: [
        asst("a", [
          tool("c", name, {
            status: "completed",
            input: {},
            output: "o",
            metadata: { exit },
            time: { start: 1, end: 2 },
          }),
        ]),
      ],
    });
  assert.equal(by(mk("bash", 0), "tool.completed")[0]?.payload["exitCode"], 0);
  assert.ok(!Object.hasOwn(by(mk("bash", null), "tool.completed")[0]?.payload ?? {}, "exitCode"));
  assert.ok(!Object.hasOwn(by(mk("bash", 1.5), "tool.completed")[0]?.payload ?? {}, "exitCode"));
  assert.ok(!Object.hasOwn(by(mk("read", 2), "tool.completed")[0]?.payload ?? {}, "exitCode"));
});

test("file.changed: only completed write/edit; a patch part for the same path wins; patch parts are provider-reported", () => {
  const edit = tool("e1", "edit", {
    status: "completed",
    input: { filePath: "/p/a.txt" },
    output: "ok",
    metadata: { filediff: { file: "/p/a.txt", patch: "@@" }, diff: "d" },
    time: { start: 1, end: 2 },
  });
  const write = tool("w1", "write", {
    status: "completed",
    input: { filePath: "/p/new.txt" },
    output: "ok",
    metadata: { exists: false },
    time: { start: 1, end: 2 },
  });
  const overwrite = tool("w2", "write", {
    status: "completed",
    input: { filePath: "/p/old.txt" },
    output: "ok",
    metadata: { exists: true },
    time: { start: 1, end: 2 },
  });
  const failedEdit = tool("e2", "edit", {
    status: "error",
    input: { filePath: "/p/b.txt" },
    error: "x",
    time: { start: 1, end: 2 },
  });
  const running = tool("w3", "write", { status: "running", input: { filePath: "/p/c.txt" } });
  const pending = tool("w4", "write", {
    status: "pending",
    input: { filePath: "/p/d.txt" },
    raw: "",
  });
  const read = tool("r1", "read", {
    status: "completed",
    input: { filePath: "/p/e.txt" },
    output: "o",
    time: { start: 1, end: 2 },
  });
  const r = go({
    info,
    messages: [asst("a", [edit, write, overwrite, failedEdit, running, pending, read])],
  });
  assert.deepEqual(
    by(r, "file.changed").map((d) => [
      d.payload["path"],
      d.payload["changeKind"],
      d.payload["basis"],
    ]),
    [
      ["/p/a.txt", "update", "derived-from-tool-result"],
      ["/p/new.txt", "add", "derived-from-tool-result"],
      ["/p/old.txt", "update", "derived-from-tool-result"],
    ],
  );
  assert.equal(
    shaOf(by(r, "file.changed")[0]?.payload["diff"]),
    sha256Hex(new TextEncoder().encode("@@")),
  );
  const withPatch = go({
    info,
    messages: [asst("a", [edit, { type: "patch", hash: "h", files: ["/p/a.txt", "/p/z.txt"] }])],
  });
  assert.deepEqual(
    by(withPatch, "file.changed").map((d) => [
      d.payload["path"],
      d.payload["basis"],
      d.payload["viaToolCallId"],
    ]),
    [
      ["/p/a.txt", "provider-reported", null],
      ["/p/z.txt", "provider-reported", null],
    ],
  );
});

test("step-finish maps to message-scope usage; the assistant total is not double counted", () => {
  const tokens = { total: 9, input: 5, output: 3, reasoning: 1, cache: { read: 2, write: 1 } };
  const withStep = go({
    info,
    messages: [
      asst(
        "a",
        [{ type: "step-start" }, { type: "step-finish", reason: "stop", cost: 0.25, tokens }],
        { cost: 0.25, tokens },
      ),
    ],
  });
  const u = by(withStep, "model.usage").filter((d) => d.payload["scope"] === "message");
  assert.equal(u.length, 1);
  assert.deepEqual(u[0]?.payload, {
    scope: "message",
    model: "mod",
    inputTokens: 5,
    outputTokens: 3,
    reasoningOutputTokens: 1,
    totalTokens: 9,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    costUsdEstimate: 0.25,
  });
  assert.equal(u[0]?.attributes["opencode.finish_reason"], "stop");
  assert.equal(u[0]?.pointer, "/parts/1");
  const noStep = go({ info, messages: [asst("a", [text("x")], { cost: 0.1, tokens })] });
  const u2 = by(noStep, "model.usage");
  assert.equal(u2.length, 1);
  assert.equal(u2[0]?.pointer, "/info/tokens");
});

test("subtask becomes agent.started (a delegation record); an @agent part is flagged, not mapped", () => {
  const r = go({
    info,
    messages: [
      user("u", [
        text("go"),
        { id: "prt_s", type: "subtask", prompt: "p", description: "d", agent: "reviewer" },
        { id: "prt_a", type: "agent", name: "reviewer" },
      ]),
    ],
  });
  const a = by(r, "agent.started");
  assert.equal(a.length, 1);
  assert.deepEqual(a[0]?.payload, {
    agentActorId: "native:prt_s",
    parentActorId: "root",
    agentType: "reviewer",
    spawnedByToolCallId: null,
  });
  assert.equal(a[0]?.actor.role, "subagent");
  assert.ok(r.warnings.some((w) => w.detail["fieldCode"] === "oc.agent-part"));
});

test("retry and compaction are runtime notifications; message error too", () => {
  const r = go({
    info,
    messages: [
      asst(
        "a",
        [
          {
            type: "retry",
            attempt: 2,
            error: { name: "APIError", data: { message: "m" } },
            time: { created: T0 + 77 },
          },
          { type: "compaction", auto: true },
        ],
        { error: { name: "MessageAbortedError", data: { message: "x" } } },
      ),
    ],
  });
  const n = by(r, "message.observed");
  assert.equal(n.length, 3);
  for (const d of n) {
    assert.equal(d.payload["role"], "system");
    assert.equal(d.payload["channel"], "notification");
    assert.equal(d.actor.role, "runtime");
  }
  assert.equal(n[0]?.attributes["opencode.retry_attempt"], 2);
  assert.equal(n[0]?.time.value, iso(T0 + 77));
  assert.equal(n[1]?.attributes["opencode.compaction_auto"], true);
  assert.equal(n[2]?.attributes["opencode.error_name"], "MessageAbortedError");
});

test("file, snapshot and step-start parts are not mapped; file/snapshot/agent are flagged", () => {
  const r = go({
    info,
    messages: [
      asst("a", [
        { type: "file", url: "file:///x", mime: "t" },
        { type: "snapshot", snapshot: "s" },
        { type: "step-start" },
        text("t"),
      ]),
    ],
  });
  assert.deepEqual(
    r.drafts.map((d) => d.draft.kind),
    ["session.started", "message.observed"],
  );
  const codes = r.warnings
    .filter((w) => w.code === "unmapped-field")
    .map((w) => w.detail["fieldCode"]);
  assert.ok(codes.includes("oc.file-part") && codes.includes("oc.snapshot-part"));
});

test("unknown part type, unknown role and malformed shapes become source.unknown", () => {
  const r = go({
    info,
    messages: [
      asst("a", [{ type: "future" }, 5, null, { id: "x" }]),
      { info: { id: "m", role: "system", time: { created: 1 } }, parts: [] },
      { info: { id: "n", role: "user", time: { created: 1 } } },
      "bare",
    ],
  });
  assert.equal(by(r, "source.unknown").length, 4 + 3);
  assert.equal(r.warnings.filter((w) => w.code === "unknown-record-type").length, 7);
});

test("an assistant message with no parts and no totals is a metadata disposition into the envelope", () => {
  const recs = frameDocument(JSON.stringify({ info, messages: [asst("a", [])] }));
  const r = run(sessionExport, recs);
  assert.deepEqual(r.dispositions, [{ sourceSequence: 1, kind: "metadata", into: 0 }]);
  assert.deepEqual(accounting(recs, r), []);
});

test("sanitized exports keep the shape: redacted inputs are hashed as objects, not parsed", () => {
  const r = go({
    info,
    messages: [
      asst("a", [
        tool("c", "bash", {
          status: "completed",
          input: { redacted: "tool-input:prt_1" },
          output: "[redacted:tool-output:prt_1]",
          title: "t",
          metadata: {},
          time: { start: 1, end: 2 },
        }),
      ]),
    ],
  });
  assert.equal(by(r, "tool.requested")[0]?.payload["toolName"], "bash");
  assert.equal(by(r, "tool.completed").length, 1);
});

test("content is hash-only by default and inline only on request", () => {
  const doc = {
    info,
    messages: [
      user("u", [text("secret prompt")]),
      asst("a", [
        text("secret answer"),
        tool("c", "bash", {
          status: "completed",
          input: { command: "secret cmd" },
          output: "secret out",
          title: "t",
          metadata: {},
          time: { start: 1, end: 2 },
        }),
      ]),
    ],
  };
  const h = JSON.stringify(go(doc).drafts.map((d) => d.draft));
  assert.ok(!h.includes("secret") && !h.includes('"inline"'));
  const inline = go(doc, { retention: "inline" });
  const prompt = by(inline, "turn.started")[0]?.payload["prompt"] as { inline?: string };
  assert.equal(prompt.inline, "secret prompt");
  const out = by(inline, "tool.completed")[0]?.payload["output"] as { inline?: string };
  assert.equal(out.inline, "secret out");
  const input = by(inline, "tool.requested")[0]?.payload["input"] as {
    inline?: string;
    encoding: string;
  };
  assert.equal(input.encoding, "jcs-json");
  assert.equal(input.inline, '{"command":"secret cmd"}');
});

test("providerVersion passes through; drafts are capped per record", () => {
  const r = go({ info, messages: [user("u", [text("x")])] }, { version: "1.19.5" });
  assert.ok(r.drafts.every((d) => d.draft.providerVersion === "1.19.5"));
  const many = Array.from({ length: 30 }, (_, i) =>
    tool(`c${i}`, "bash", { status: "pending", input: {}, raw: "" }),
  );
  const capped = go({ info, messages: [asst("a", many)] }, { bounds: { maxDraftsPerRecord: 4 } });
  assert.equal(capped.drafts.filter((d) => d.order === 1).length, 4);
  assert.ok(capped.warnings.some((w) => w.code === "bounds-reached"));
});

test("unmapped session and message fields are counted under static codes", () => {
  const r = go({
    info: { ...info, share: { url: "u" }, title: "t" },
    messages: [user("u", [text("x")], { system: "s" })],
  });
  const codes = r.warnings.map((w) => w.detail["fieldCode"]);
  assert.ok(codes.includes("oc.session-info-fields"));
  assert.ok(codes.includes("oc.message-fields"));
});
