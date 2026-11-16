// Regenerates the synthetic canonical sessions in this directory:
//   node fixtures/report/generate.mjs   (after `npm run build`)
// Every value is invented. No real session data, paths or identifiers are involved.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, deriveId, REQUIRED_FACETS_BY_KIND, validateEvents } from "../../packages/core/dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash("sha256").update(s).digest("hex");

function session(spec) {
  const sourceId = deriveId("src", [spec.sourceKind, spec.name]);
  const sessionId = deriveId("ses", [spec.provider, spec.name]);
  const actors = {
    agent: deriveId("act", [sessionId, "agent"]),
    user: deriveId("act", [sessionId, "user"]),
    runtime: deriveId("act", [sessionId, "runtime"]),
    subagent: deriveId("act", [sessionId, "subagent"]),
  };
  const events = [];
  const ids = new Map();
  let turn = null;
  const ref = (label, inline) => ({
    sha256: sha(inline ?? label),
    byteLength: new TextEncoder().encode(inline ?? label).length,
    encoding: "utf8",
    retention: inline === undefined ? "hash-only" : "inline",
    ...(inline === undefined ? {} : { inline, redactionCount: 0 }),
  });
  const api = {
    ref,
    tc: (key) => deriveId("tc", [sessionId, key]),
    turn: (key) => {
      turn = key === null ? null : deriveId("trn", [sessionId, key]);
    },
    id: (key) => ids.get(key),
    ev(seq, kind, status, payload, o = {}) {
      const role = o.role ?? "agent";
      const eventId = deriveId("evt", [sourceId, seq, 0]);
      if (o.key) ids.set(o.key, eventId);
      const completeness = {};
      for (const f of REQUIRED_FACETS_BY_KIND[kind]) completeness[f] = { state: "captured" };
      if ((o.links ?? []).length > 0) completeness.causality = { state: "captured" };
      if (o.completeness) Object.assign(completeness, o.completeness);
      events.push({
        schemaVersion: "0.1.0",
        eventId,
        kind,
        provider: spec.provider,
        providerVersion: "0.0.0-synthetic",
        sourceKind: spec.sourceKind,
        sessionId,
        turnId: turn,
        sourceSequence: seq,
        subIndex: 0,
        time: { value: new Date(Date.parse("2026-03-02T09:00:00.000Z") + seq * 1000).toISOString(), origin: "source", status: "valid" },
        actor: { actorId: actors[role], role },
        status,
        payload,
        links: (o.links ?? []).map(([rel, key]) => ({ rel, target: ids.get(key) })),
        provenance: {
          type: "record",
          sourceId,
          line: seq + 1,
          byteOffset: seq * 200,
          byteLength: 180,
          sha256: sha(`${spec.name}:${seq}`),
          pointer: null,
          adapter: { id: spec.sourceKind, version: "0.1.0" },
        },
        completeness,
        attributes: {},
      });
    },
  };
  spec.build(api);
  const v = validateEvents(events);
  if (!v.ok) throw new Error(`${spec.name}: ${JSON.stringify(v.issues.slice(0, 5))}`);
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const gaps = byKind["capture.gap"] ?? 0;
  const unknowns = byKind["source.unknown"] ?? 0;
  const warnings = spec.warnings ?? [];
  const sourceSha = sha(`source:${spec.name}`);
  const result = {
    source: {
      sourceId,
      provider: spec.provider,
      sourceKind: spec.sourceKind,
      sourceStability: spec.stability,
      sha256: sourceSha,
      byteLength: 4096,
      recordCount: events.length + (spec.folded ?? 0),
      blankLineCount: 0,
      displayName: spec.displayName,
    },
    events,
    warnings,
    stats: { records: events.length + (spec.folded ?? 0), blankLines: 0, eventsByKind: byKind, gaps, unknowns, derived: 0, folded: spec.folded ?? 0 },
    outcome: gaps + unknowns > 0 ? "partial" : "complete",
  };
  const record = {
    importId: deriveId("src", [spec.name, "import"]).replace("src_", "imp_"),
    sessionId,
    provider: spec.provider,
    sourceKind: spec.sourceKind,
    adapter: { id: spec.sourceKind, version: "0.1.0", sourceStability: spec.stability, experimental: spec.experimental },
    source: { sha256: sourceSha, byteLength: 4096, container: "plain", displayName: spec.displayName, displayPath: spec.displayPath },
    contentRetention: spec.retention,
    outcome: result.outcome,
    counts: { events: events.length, records: result.stats.records, gaps, unknowns, folded: spec.folded ?? 0, warnings: warnings.length, byKind },
    warningCodes: [...new Set(warnings.map((w) => w.code))],
    firstEventTime: events[0].time.value,
    lastEventTime: events[events.length - 1].time.value,
    importedAt: "2026-03-02T10:00:00.000Z",
  };
  const dir = join(here, spec.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.json"), `${canonicalJson({ record, result })}\n`);
}

const untested = { code: "untested-provider-version", severity: "info", sourceSequence: null, detail: { seen: "0.0.0-synthetic" } };

session({
  name: "claude-code",
  provider: "claude-code",
  sourceKind: "claude-code.transcript-jsonl",
  stability: "undocumented",
  experimental: true,
  retention: "hash-only",
  displayName: "session-a.jsonl",
  displayPath: "~/.claude/projects/demo/session-a.jsonl",
  warnings: [untested, { code: "unknown-record-type", severity: "warn", sourceSequence: 14, detail: { nativeType: "queue-operation" } }],
  build(a) {
    a.ev(0, "session.started", "none", { nativeSessionId: "synthetic-claude-1", trigger: "startup" }, { role: "runtime" });
    a.turn("t1");
    a.ev(1, "turn.started", "none", { prompt: a.ref("fix the failing test in the demo project") }, { role: "user", key: "t1s" });
    a.ev(2, "message.observed", "none", { role: "assistant", channel: "reasoning", content: a.ref("reasoning text 1") }, { completeness: { internalReasoning: { state: "captured" } } });
    a.ev(3, "tool.requested", "none", { toolCallId: a.tc("c1"), toolName: "Read", toolNamespace: "builtin", input: a.ref("read input") }, { key: "r1" });
    a.ev(4, "tool.completed", "success", { toolCallId: a.tc("c1"), toolName: "Read", output: a.ref("read output") }, { links: [["result-of", "r1"]] });
    a.ev(5, "tool.requested", "none", { toolCallId: a.tc("c2"), toolName: "Bash", toolNamespace: "builtin", input: a.ref("run tests 1") }, { key: "b1" });
    a.ev(6, "permission.requested", "none", { toolName: "Bash", toolCallId: a.tc("c2"), input: null });
    a.ev(7, "permission.decided", "none", { decision: "allow", decidedBy: "user", reason: null }, { role: "user" });
    a.ev(8, "tool.failed", "failure", { toolCallId: a.tc("c2"), toolName: "Bash", output: null, exitCode: 1, error: a.ref("test failure output"), errorClass: "error" }, { links: [["result-of", "b1"]] });
    a.ev(9, "tool.requested", "none", { toolCallId: a.tc("c3"), toolName: "Bash", toolNamespace: "builtin", input: a.ref("run tests 2") }, { key: "b2" });
    a.ev(10, "tool.completed", "success", { toolCallId: a.tc("c3"), toolName: "Bash", output: a.ref("tests pass"), exitCode: 0 }, { links: [["result-of", "b2"]] });
    a.ev(11, "tool.requested", "none", { toolCallId: a.tc("c4"), toolName: "Edit", toolNamespace: "builtin", input: a.ref("edit input") }, { key: "e1" });
    a.ev(12, "tool.completed", "success", { toolCallId: a.tc("c4"), toolName: "Edit", output: a.ref("edit output") }, { links: [["result-of", "e1"]], key: "e1r" });
    a.ev(13, "file.changed", "success", { path: "/home/demo/project/src/app.ts", changeKind: "update", diff: null, viaToolCallId: a.tc("c4"), basis: "derived-from-tool-result" });
    a.ev(14, "source.unknown", "none", { nativeType: "queue-operation", topLevelKeys: ["operation", "type"], recordSha256: sha("unknown-1") }, { role: "runtime" });
    a.ev(15, "model.usage", "none", { scope: "message", model: "synthetic-model-a", inputTokens: 1200, outputTokens: 300, cachedInputTokens: 800 }, { completeness: {} });
    a.ev(16, "model.usage", "none", { scope: "message", model: "synthetic-model-a", inputTokens: 1500, outputTokens: 220, costUsdEstimate: 0.0123 });
    a.ev(17, "message.observed", "none", { role: "assistant", channel: "text", content: a.ref("final answer") });
    a.ev(18, "turn.ended", "success", {});
    a.turn("t2");
    a.ev(19, "turn.started", "none", { prompt: a.ref("now run the linter") }, { role: "user" });
    a.ev(20, "tool.requested", "none", { toolCallId: a.tc("c5"), toolName: "Bash", toolNamespace: "builtin", input: a.ref("run linter") }, { key: "b3" });
    a.ev(21, "capture.gap", "none", { reason: "missing-result", detail: "no result record before end of source" }, { role: "runtime", links: [["gap-for", "b3"]] });
    a.ev(22, "turn.ended", "unknown", {});
    a.turn(null);
    a.ev(23, "session.ended", "unknown", { reason: "unknown" }, { role: "runtime" });
  },
});

session({
  name: "codex-cli",
  provider: "codex-cli",
  sourceKind: "codex-cli.rollout-jsonl",
  stability: "internal-unstable",
  experimental: true,
  retention: "inline",
  displayName: "rollout-demo.jsonl",
  displayPath: "~/.codex/sessions/2026/03/02/rollout-demo.jsonl",
  warnings: [untested],
  folded: 2,
  build(a) {
    a.ev(0, "session.started", "none", { nativeSessionId: "synthetic-codex-1", trigger: "startup" }, { role: "runtime" });
    a.turn("t1");
    a.ev(1, "turn.started", "none", { prompt: a.ref("add a --verbose flag", "add a --verbose flag") }, { role: "user" });
    a.ev(2, "message.observed", "none", { role: "assistant", channel: "text", content: a.ref("I will edit the CLI parser.", "I will edit the CLI parser.") });
    a.ev(3, "tool.requested", "none", { toolCallId: a.tc("c1"), toolName: "shell", toolNamespace: "builtin", input: a.ref("ls src", "ls src") }, { key: "s1" });
    a.ev(4, "tool.completed", "success", { toolCallId: a.tc("c1"), toolName: "shell", output: a.ref("cli.ts\nmain.ts\n", "cli.ts\nmain.ts\n"), exitCode: 0, durationMs: 12 }, { links: [["result-of", "s1"]] });
    a.ev(5, "file.changed", "success", { path: "/home/demo/repo/src/cli.ts", changeKind: "update", diff: null, viaToolCallId: null, basis: "provider-reported" });
    a.ev(6, "file.changed", "success", { path: "/home/demo/repo/docs/verbose.md", changeKind: "add", diff: null, viaToolCallId: null, basis: "provider-reported" });
    a.ev(7, "model.usage", "none", { scope: "session", model: "synthetic-model-c", inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
    a.ev(8, "turn.ended", "success", {});
    a.turn("t2");
    a.ev(9, "turn.started", "none", { prompt: a.ref("also update the tests", "also update the tests") }, { role: "user" });
    a.ev(10, "tool.requested", "none", { toolCallId: a.tc("c2"), toolName: "apply_patch", toolNamespace: "builtin", input: a.ref("patch", "*** Begin Patch\n*** End Patch") }, { key: "p1" });
    a.ev(11, "tool.completed", "success", { toolCallId: a.tc("c2"), toolName: "apply_patch", output: a.ref("ok", "ok") }, { links: [["result-of", "p1"]] });
    a.ev(12, "file.changed", "success", { path: "/home/demo/repo/test/cli.test.ts", changeKind: "update", diff: null, viaToolCallId: a.tc("c2"), basis: "derived-from-tool-result" });
    a.ev(13, "model.usage", "none", { scope: "session", model: "synthetic-model-c", inputTokens: 2500, outputTokens: 400, totalTokens: 2900, costUsdEstimate: 0.021 });
    a.ev(14, "turn.ended", "success", {});
    a.turn(null);
    a.ev(15, "session.ended", "success", { reason: "exit" }, { role: "runtime" });
  },
});

session({
  name: "gemini-cli",
  provider: "gemini-cli",
  sourceKind: "gemini-cli.chat-jsonl",
  stability: "undocumented",
  experimental: true,
  retention: "hash-only",
  displayName: "chat-demo.jsonl",
  displayPath: "~/.gemini/tmp/demo/chats/chat-demo.jsonl",
  warnings: [untested, { code: "folded-records", severity: "info", sourceSequence: null, detail: { count: 3 } }],
  folded: 3,
  build(a) {
    a.ev(0, "session.started", "none", { nativeSessionId: "synthetic-gemini-1", trigger: "startup" }, { role: "runtime" });
    a.turn("t1");
    a.ev(1, "turn.started", "none", { prompt: a.ref("search the docs for rate limits") }, { role: "user" });
    a.ev(2, "tool.requested", "none", { toolCallId: a.tc("c1"), toolName: "search_docs", toolNamespace: "mcp", mcpServer: "docs-server", input: a.ref("rate limits") }, { key: "m1" });
    a.ev(3, "permission.requested", "none", { toolName: "search_docs", toolCallId: a.tc("c1"), input: null });
    a.ev(4, "permission.decided", "none", { decision: "deny", decidedBy: "policy", reason: null }, { role: "runtime" });
    a.ev(5, "tool.failed", "denied", { toolCallId: a.tc("c1"), toolName: "search_docs", output: null, error: null, errorClass: "denied" }, { links: [["result-of", "m1"]] });
    a.ev(6, "agent.started", "none", { agentActorId: deriveId("act", ["sub", "gemini"]), parentActorId: null, agentType: "researcher", spawnedByToolCallId: null }, { role: "subagent" });
    a.ev(7, "agent.ended", "interrupted", { agentActorId: deriveId("act", ["sub", "gemini"]) }, { role: "subagent" });
    a.ev(8, "model.usage", "none", { scope: "turn", model: "synthetic-model-g", inputTokens: 400, outputTokens: 50 });
    a.ev(9, "turn.ended", "interrupted", {});
  },
});

session({
  name: "opencode",
  provider: "opencode",
  sourceKind: "opencode.session-export",
  stability: "documented-interface",
  experimental: false,
  retention: "hash-only",
  displayName: "export.json",
  displayPath: "~/exports/export.json",
  warnings: [untested],
  build(a) {
    a.ev(0, "session.started", "none", { nativeSessionId: "synthetic-opencode-1", trigger: "startup" }, { role: "runtime" });
    a.turn("t1");
    a.ev(1, "turn.started", "none", { prompt: a.ref("rename the helper function") }, { role: "user" });
    a.ev(2, "tool.requested", "none", { toolCallId: a.tc("c1"), toolName: "grep", toolNamespace: "builtin", input: a.ref("grep helper") }, { key: "g1" });
    a.ev(3, "tool.completed", "success", { toolCallId: a.tc("c1"), toolName: "grep", output: a.ref("matches") }, { links: [["result-of", "g1"]] });
    a.ev(4, "tool.requested", "none", { toolCallId: a.tc("c2"), toolName: "edit", toolNamespace: "builtin", input: a.ref("edit") }, { key: "ed1" });
    a.ev(5, "tool.completed", "success", { toolCallId: a.tc("c2"), toolName: "edit", output: a.ref("edited") }, { links: [["result-of", "ed1"]] });
    a.ev(6, "file.changed", "success", { path: "/home/demo/app/lib/util.ts", changeKind: "update", diff: null, viaToolCallId: a.tc("c2"), basis: "derived-from-tool-result" });
    a.ev(7, "model.usage", "none", { scope: "turn", model: "synthetic-model-o", inputTokens: 700, outputTokens: 90, costUsdEstimate: 0.004 });
    a.ev(8, "turn.ended", "success", {});
    a.turn("t2");
    a.ev(9, "turn.started", "none", { prompt: a.ref("run the build") }, { role: "user" });
    a.ev(10, "model.usage", "none", { scope: "turn", model: "synthetic-model-o", inputTokens: 300, outputTokens: 20 });
    a.ev(11, "turn.ended", "success", {});
    a.turn(null);
    a.ev(12, "session.ended", "success", { reason: "exit" }, { role: "runtime" });
  },
});
