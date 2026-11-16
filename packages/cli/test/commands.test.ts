// `swain commands`: synthetic sessions derived from fixtures/report, fake HOME and temp dirs only.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CanonicalEvent, type ImportResult, makeContentRef } from "@swain/core";
import { openStore } from "@swain/store";
import { type CliIo, main } from "../src/main.js";
import { NOW } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));
const FAKE_HOME = "/home/fakeuser";
const ESC = String.fromCodePoint(0x1b);
const BIDI = String.fromCodePoint(0x202e);

function run(argv: readonly string[], home: string | undefined = FAKE_HOME) {
  let out = "";
  let err = "";
  const io: CliIo = {
    stdout: {
      write: (s) => {
        out += s;
      },
    },
    stderr: {
      write: (s) => {
        err += s;
      },
    },
    env: { HOME: home, XDG_DATA_HOME: undefined },
    nowMs: NOW,
  };
  return { code: main(argv, io), out, err };
}

function temp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "atm-cli-cmds-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Doc {
  record: { adapter: never };
  result: ImportResult;
}
const loadDoc = (name: string): Doc =>
  JSON.parse(readFileSync(join(FIXTURES, `report/${name}/session.json`), "utf8")) as Doc;
const inline = (s: string) => makeContentRef(s, { retention: "inline" });

function put(
  storeDir: string,
  doc: Doc,
  events: CanonicalEvent[],
  retention: "inline" | "hash-only",
) {
  const result: ImportResult = { ...doc.result, events };
  const store = openStore(storeDir, { nowMs: NOW, homeDir: null });
  const r = store.put(result, {
    adapter: doc.record.adapter,
    sourcePath: `${FAKE_HOME}/sessions/x.jsonl`,
    container: {
      encoding: "none",
      sha256: result.source.sha256,
      byteLength: result.source.byteLength,
    },
    contentRetention: retention,
    reimport: false,
  });
  return r.record.importId;
}

const COMMANDS_A = ["echo one", `cat ${FAKE_HOME}/.ssh/id_rsa`, "whoami"];

/** Claude fixture with inline commands: shell requests at 09:00:05, 09:00:09 and 09:00:20. */
function seedClaude(storeDir: string, commands: readonly string[] = COMMANDS_A): string {
  const doc = loadDoc("claude-code");
  let i = 0;
  const events = doc.result.events.map((e): CanonicalEvent => {
    if (e.kind === "tool.requested" && e.payload.toolName === "Bash") {
      const input = inline(JSON.stringify({ command: commands[i++] }));
      return { ...e, payload: { ...e.payload, input } };
    }
    return e;
  });
  return put(storeDir, doc, events, "inline");
}

/** Gemini fixture: its denied tool becomes a subagent's `run_shell_command` at 09:00:06.5. */
function seedGemini(storeDir: string, agentType = "recon"): string {
  const doc = loadDoc("gemini-cli");
  const agent = doc.result.events.find((e) => e.kind === "agent.started");
  assert.ok(agent !== undefined && agent.kind === "agent.started");
  const agentId = agent.payload.agentActorId;
  const events = doc.result.events.map((e): CanonicalEvent => {
    if (e.kind === "tool.requested") {
      return {
        ...e,
        actor: { ...e.actor, actorId: agentId },
        time: { ...e.time, value: "2026-03-02T09:00:06.500Z" },
        payload: {
          ...e.payload,
          toolName: "run_shell_command",
          input: inline(JSON.stringify({ command: "curl http://example.invalid/x" })),
        },
      };
    }
    if (e.kind === "tool.failed") return { ...e, actor: { ...e.actor, actorId: agentId } };
    // The subagent is active between its start and end: move them around the tool call.
    if (e.kind === "agent.started") {
      return { ...e, sourceSequence: 1, subIndex: 1, payload: { ...e.payload, agentType } };
    }
    if (e.kind === "agent.ended") return { ...e, sourceSequence: 5, subIndex: 1 };
    return e;
  });
  events.sort((x, y) => x.sourceSequence - y.sourceSequence || x.subIndex - y.subIndex);
  return put(storeDir, doc, events, "inline");
}

function lines(out: string): string[] {
  return out.split("\n");
}

test("single session: shell commands only, in order, with agent, status, exit", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedClaude(store);
    const r = run(["--store", store, "commands", id]);
    assert.equal(r.code, 0, r.err);
    const rows = lines(r.out).filter((l) => /^\d+ +(\d{4}-|\()/.test(l));
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? "", /^2 +2026-03-02T09:00:05\.000Z +main +failed +1 +echo one$/);
    assert.match(rows[1] ?? "", /ok +0 +cat ~\/\.ssh\/id_rsa$/);
    assert.match(rows[2] ?? "", /no-result +- +whoami$/);
    assert.ok(!r.out.includes("SESSION"));
    assert.ok(!r.out.includes("Read"));
    assert.ok(r.out.includes("shell tools are identified by tool name"));
    assert.ok(!r.out.includes(FAKE_HOME));
    assert.ok(r.out.includes("masking is best-effort"));
  } finally {
    t.done();
  }
});

test("--all adds every tool action with its target or tool name", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedClaude(store);
    const r = run(["--store", store, "commands", id, "--all"]);
    assert.equal(r.code, 0, r.err);
    const rows = lines(r.out).filter((l) => /^\d+ +(\d{4}-|\()/.test(l));
    assert.equal(rows.length, 5);
    assert.match(rows[0] ?? "", /^1 .* Read( |$)/);
    assert.ok(rows.some((l) => /Edit$/.test(l)));
  } finally {
    t.done();
  }
});

test("several sessions merge chronologically with a session column and short-prefix ids", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const a = seedClaude(store);
    const b = seedGemini(store);
    const r = run(["--store", store, "commands", a.slice(0, 10), b.slice(0, 10)]);
    assert.equal(r.code, 0, r.err);
    assert.ok(lines(r.out)[0]?.includes("SESSION"));
    const rows = lines(r.out).filter((l) => /^\d+ +(\d{4}-|\()/.test(l));
    assert.deepEqual(
      rows.map((l) => l.replace(/ +/g, " ")),
      [
        `2 2026-03-02T09:00:05.000Z ${a.slice(0, 16)} main failed 1 echo one`,
        `1 2026-03-02T09:00:06.500Z ${b.slice(0, 16)} subagent "recon" #1 denied - curl http://example.invalid/x`,
        `3 2026-03-02T09:00:09.000Z ${a.slice(0, 16)} main ok 0 cat ~/.ssh/id_rsa`,
        `5 2026-03-02T09:00:20.000Z ${a.slice(0, 16)} main no-result - whoami`,
      ],
    );
    // The same session named twice (full id and prefix) is listed once.
    const dup = run(["--store", store, "commands", a, a.slice(0, 12)]);
    assert.equal(lines(dup.out).filter((l) => /^\d+ +(\d{4}-|\()/.test(l)).length, 3);
    assert.ok(!lines(dup.out)[0]?.includes("SESSION"));
  } finally {
    t.done();
  }
});

test("rows without a valid time follow the timed rows in per-session order", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const doc = loadDoc("claude-code");
    let i = 0;
    const events = doc.result.events.map((e): CanonicalEvent => {
      if (e.kind === "tool.requested" && e.payload.toolName === "Bash") {
        const n = i++;
        const input = inline(JSON.stringify({ command: `c${n}` }));
        const time =
          n === 0 ? { value: null, origin: "none" as const, status: "missing" as const } : e.time;
        return { ...e, time, payload: { ...e.payload, input } };
      }
      return e;
    });
    const id = put(store, doc, events, "inline");
    const g = seedGemini(store);
    const r = run(["--store", store, "commands", id, g]);
    assert.equal(r.code, 0, r.err);
    const cmds = lines(r.out)
      .filter((l) => /^\d+ +(\d{4}-|\()/.test(l))
      .map((l) => l.split(/ +/).pop());
    assert.deepEqual(cmds, ["http://example.invalid/x", "c1", "c2", "c0"]);
  } finally {
    t.done();
  }
});

test("--json: machine rows, masked, schema-stable", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const a = seedClaude(store);
    const b = seedGemini(store);
    const r = run(["--store", store, "commands", a, b, "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(FAKE_HOME));
    const j = JSON.parse(r.out) as {
      format: string;
      all: boolean;
      sessions: string[];
      rows: {
        session: string;
        seq: number;
        command: string | null;
        agent: { index: number; label: string };
        status: string;
        exitCode: number | null;
        eventIds: string[];
      }[];
    };
    assert.equal(j.format, "atm.commands/0.1");
    assert.equal(j.all, false);
    assert.deepEqual(j.sessions, [a, b]);
    assert.deepEqual(
      j.rows.map((x) => x.command),
      ["echo one", "curl http://example.invalid/x", "cat ~/.ssh/id_rsa", "whoami"],
    );
    assert.equal(j.rows[1]?.agent.label, 'subagent "recon" #1');
    assert.equal(j.rows[1]?.session, b);
    assert.equal(j.rows[0]?.exitCode, 1);
    assert.ok(j.rows.every((x) => x.eventIds.every((e) => /^evt_[0-9a-f]{32}$/.test(e))));
    const all = JSON.parse(run(["--store", store, "commands", a, "--all", "--json"]).out) as {
      rows: unknown[];
    };
    assert.equal(all.rows.length, 5);
  } finally {
    t.done();
  }
});

test("hash-only import: command hidden with its size, and a re-import hint", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const doc = loadDoc("claude-code");
    const id = put(store, doc, doc.result.events, "hash-only");
    const r = run(["--store", store, "commands", id]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes("command hidden (hash-only, 11 bytes)"));
    assert.ok(r.out.includes("re-import with --include-content"));
    const j = JSON.parse(run(["--store", store, "commands", id, "--json"]).out) as {
      rows: { command: string | null; commandHiddenBytes: number | null }[];
    };
    assert.deepEqual(
      j.rows.map((x) => [x.command, x.commandHiddenBytes]),
      [
        [null, 11],
        [null, 11],
        [null, 10],
      ],
    );
  } finally {
    t.done();
  }
});

test("a session without shell commands says so and points at --all", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const doc = loadDoc("opencode");
    const id = put(store, doc, doc.result.events, "hash-only");
    const r = run(["--store", store, "commands", id]);
    assert.equal(r.code, 0);
    assert.ok(r.out.startsWith("No shell commands found"));
    assert.ok(r.out.includes("--all"));
    assert.equal(JSON.parse(run(["--store", store, "commands", id, "--json"]).out).rows.length, 0);
  } finally {
    t.done();
  }
});

test("unknown id exits 6; missing id and bad flags exit 2", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedClaude(store);
    const nf = run(["--store", store, "commands", id, "imp_ffffffffffff"]);
    assert.equal(nf.code, 6);
    assert.equal(nf.out, "");
    assert.ok(nf.err.startsWith("swain: no import matches 'imp_ffffffffffff'"));
    assert.equal(run(["--store", store, "commands"]).code, 2);
    assert.equal(run(["--store", store, "commands", id, "--limit", "3"]).code, 2);
    assert.ok(run(["--help"]).out.includes("commands <id...>"));
  } finally {
    t.done();
  }
});

test("hostile commands, agent types and ids stay inert on the terminal", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const hostile = [
      `${ESC}]8;;http://evil.example/\u0007link${ESC}[2J${ESC}[31mred`,
      `line1\nFAKE 9 2026-03-02T00:00:00.000Z main ok 0 injected`,
      `a${BIDI}b\r\nc`,
      `<script>alert(1)</script> ${FAKE_HOME}/x`,
    ];
    const a = seedClaude(store, [hostile[0] ?? "", hostile[1] ?? "", hostile[3] ?? ""]);
    const b = seedGemini(store, `${ESC}[31m${BIDI}agent\r\nINJECT ${hostile[2] ?? ""}`);
    for (const args of [
      ["commands", a, b],
      ["commands", a, b, "--all"],
      ["commands", a, b, "--json"],
    ]) {
      const r = run(["--store", store, ...args]);
      assert.equal(r.code, 0, r.err);
      for (const bad of [ESC, BIDI, "\r", "\u0007"])
        assert.ok(!r.out.includes(bad), args.join(" "));
      if (!args.includes("--json")) {
        assert.ok(
          !lines(r.out).some((l) => l.startsWith("FAKE")),
          "a newline in a command must not start a new line",
        );
        assert.ok(!r.out.includes(FAKE_HOME));
        assert.ok(r.out.includes("\\u001B"));
      } else {
        assert.equal(lines(r.out).length, 2, "single JSON line");
        assert.ok(!r.out.includes(FAKE_HOME));
        assert.equal(JSON.parse(r.out).rows.length, 4);
      }
    }
  } finally {
    t.done();
  }
});

/** Claude fixture with explicit shell commands and outputs (in order of the three Bash calls). */
function seedCustom(
  storeDir: string,
  commands: readonly string[],
  output: string,
  times?: readonly string[],
): string {
  const doc = loadDoc("claude-code");
  let i = 0;
  const events = doc.result.events.map((e): CanonicalEvent => {
    if (e.kind === "tool.requested" && e.payload.toolName === "Bash") {
      const n = i++;
      const input = inline(JSON.stringify({ command: commands[n] }));
      const t = times?.[n];
      const time = t === undefined ? e.time : { ...e.time, value: t };
      return { ...e, time, payload: { ...e.payload, input } };
    }
    if (e.kind === "tool.completed") {
      return { ...e, payload: { ...e.payload, output: inline(output) } };
    }
    if (e.kind === "tool.failed") {
      return { ...e, payload: { ...e.payload, error: inline(output) } };
    }
    return e;
  });
  return put(storeDir, doc, events, "inline");
}

test("F1: home path is masked before the cut (table and JSON), at and inside the cut", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const exact = "x".repeat(400 - FAKE_HOME.length) + FAKE_HOME + "/more";
    const inside = "x".repeat(396) + FAKE_HOME + "/more";
    const longOut = "y".repeat(190) + FAKE_HOME + "/q";
    const id = seedCustom(store, [exact, inside, `${"z".repeat(393)}${FAKE_HOME}/secret`], longOut);
    const table = run(["--store", store, "commands", id]);
    assert.equal(table.code, 0, table.err);
    assert.ok(!table.out.includes("/h"), "no home fragment in the table");
    assert.ok(!table.out.includes("/home"));
    assert.ok(table.out.includes("~"));
    const json = run(["--store", store, "commands", id, "--json"]);
    assert.ok(!json.out.includes("/h"), "no home fragment in the JSON");
    assert.ok(!json.out.includes("/home"));
    const j = JSON.parse(json.out) as { rows: { command: string; excerpt: string | null }[] };
    assert.equal(j.rows[0]?.command, `${"x".repeat(400 - FAKE_HOME.length)}~/more`);
    assert.ok(j.rows.every((r) => !(r.excerpt ?? "").includes("/h")));
  } finally {
    t.done();
  }
});

test("F4: JSON command cap after masking, notice, statusLabel, truncated; text wording", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedCustom(store, ["a".repeat(9000), "b", "c"], "o");
    const r = run(["--store", store, "commands", id, "--json"]);
    const j = JSON.parse(r.out) as {
      truncated: number;
      notice: string;
      ordering: string;
      rows: {
        command: string;
        commandTruncated: boolean;
        status: string;
        statusLabel: string;
      }[];
    };
    assert.equal(j.rows[0]?.command.length, 8192);
    assert.equal(j.rows[0]?.commandTruncated, true);
    assert.equal(j.rows[1]?.commandTruncated, false);
    assert.equal(j.truncated, 0);
    assert.equal(j.rows[2]?.status, "none");
    assert.equal(j.rows[2]?.statusLabel, "no result recorded");
    assert.ok(j.notice.includes("secrets"));
    assert.ok(j.notice.includes("heuristic"));
    assert.ok(j.notice.includes("MCP"));
    const text = run(["--store", store, "commands", id]);
    assert.ok(text.out.includes("requested"));
    assert.ok(text.out.includes("no-result"));
    assert.ok(
      run(["--help"]).out.includes(
        "Tool commands each agent requested, with results where recorded",
      ),
    );
  } finally {
    t.done();
  }
});

test("F4: more than 64 distinct sessions is a usage error; duplicates collapse", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedClaude(store);
    const many = Array.from({ length: 65 }, (_, i) => `imp_${i.toString(16).padStart(12, "0")}`);
    const r = run(["--store", store, "commands", ...many]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("at most 64 sessions"));
    assert.equal(r.out, "");
    const dup = run(["--store", store, "commands", ...Array.from({ length: 100 }, () => id)]);
    assert.equal(dup.code, 0, dup.err);
  } finally {
    t.done();
  }
});

test("F4: rows are capped at 20000 with a notice and a truncated count", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const doc = loadDoc("claude-code");
    const template = doc.result.events.find(
      (e) => e.kind === "tool.requested" && e.payload.toolName === "Bash",
    );
    assert.ok(template !== undefined && template.kind === "tool.requested");
    const events: CanonicalEvent[] = doc.result.events.filter((e) => e.sourceSequence < 3);
    const total = 20_005;
    for (let i = 0; i < total; i++) {
      const n = 100 + i;
      events.push({
        ...template,
        eventId: `evt_${n.toString(16).padStart(32, "0")}` as never,
        sourceSequence: n,
        subIndex: 0,
        time: { ...template.time, value: "2026-03-02T09:00:05.000Z" },
        links: [],
        provenance: { ...template.provenance },
        payload: { ...template.payload, toolCallId: null, input: inline('{"command":"id"}') },
      });
    }
    const id = put(store, doc, events, "inline");
    const text = run(["--store", store, "commands", id]);
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out.split("\n").filter((l) => /^\d+ +\d{4}-/.test(l)).length, 20_000);
    assert.ok(text.out.includes("Output truncated: showing the first 20000 of 20005 rows."));
    const json = JSON.parse(run(["--store", store, "commands", id, "--json"]).out) as {
      truncated: number;
      rows: unknown[];
    };
    assert.equal(json.truncated, 5);
    assert.equal(json.rows.length, 20_000);
  } finally {
    t.done();
  }
});

test("F7: one session keeps source order; several print the ordering line", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const id = seedCustom(store, ["first", "second", "third"], "o", [
      "2026-03-02T09:00:05.000Z",
      "2026-03-02T09:00:09.000Z",
      "2026-03-02T09:00:20.000Z",
    ]);
    const one = run(["--store", store, "commands", id]);
    assert.ok(!one.out.includes("ordered by timestamp"));
    const g = seedGemini(store);
    const two = run(["--store", store, "commands", id, g]);
    assert.ok(
      two.out.includes(
        "ordered by timestamp across sessions; rows without a valid time are listed last; SEQ is per-session source order",
      ),
    );
  } finally {
    t.done();
  }
});

test("F7: a single session is not re-sorted by time", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const doc = loadDoc("claude-code");
    let i = 0;
    const events = doc.result.events.map((e): CanonicalEvent => {
      if (e.kind === "tool.requested" && e.payload.toolName === "Bash") {
        const n = i++;
        const input = inline(JSON.stringify({ command: `c${n}` }));
        // c1 is stamped later than c2: time order would swap them.
        const value = n === 1 ? "2026-03-02T09:00:19.000Z" : e.time.value;
        return { ...e, time: { ...e.time, value }, payload: { ...e.payload, input } };
      }
      return e;
    });
    const id = put(store, doc, events, "inline");
    const r = run(["--store", store, "commands", id]);
    assert.equal(r.code, 0, r.err);
    const cmds = r.out
      .split("\n")
      .filter((l) => /^\d+ +\d{4}-/.test(l))
      .map((l) => l.split(/ +/).pop());
    assert.deepEqual(cmds, ["c0", "c1", "c2"]);
  } finally {
    t.done();
  }
});

test("F5: a call outside the subagent's start and end is attributed to main in the CLI", () => {
  const t = temp();
  try {
    const store = join(t.dir, "store");
    const g = seedGemini(store);
    const rows = JSON.parse(run(["--store", store, "commands", g, "--json"]).out).rows as {
      agent: { label: string };
    }[];
    assert.equal(rows[0]?.agent.label, 'subagent "recon" #1');
  } finally {
    t.done();
  }
});
