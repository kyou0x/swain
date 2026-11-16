import assert from "node:assert/strict";
import { test } from "node:test";
import { type CanonicalEvent, validateEvents } from "@swain/core";
import {
  type Explanation,
  explainSession,
  type Part,
  type SessionView,
  type Statement,
} from "../src/index.js";
import {
  EXPLAIN_OPTS,
  loadSession,
  PROVIDER_FIXTURES,
  readFixture,
  withEvents,
} from "./helpers.js";

const SAFE_TEXT = /^[A-Za-z0-9 .,;:()'/+=%$#@?-]*$/;
const RULES = new Set(["interp.outcome", "interp.retry", "interp.unfinished"]);

function flat(p: readonly Part[]): string {
  return p.map((x) => (x.t === "count" ? String(x.v) : x.v)).join("");
}
function all(ex: Explanation): Statement[] {
  return ex.sections.flatMap((s) => [...s.statements]);
}

test("fixtures: every session validates with validateEvents", () => {
  for (const name of PROVIDER_FIXTURES) {
    const parsed = JSON.parse(readFixture(`${name}/session.json`)) as {
      result: { events: unknown };
    };
    const r = validateEvents(parsed.result.events);
    assert.equal(r.ok, true, name);
  }
});

test("every statement cites existing events; interpretations carry a closed rule", () => {
  for (const name of PROVIDER_FIXTURES) {
    const view = loadSession(name);
    const ids = new Set(view.result.events.map((e) => e.eventId));
    const ex = explainSession(view, EXPLAIN_OPTS);
    assert.equal(ex.sections.length, 9);
    const seen = new Set<string>();
    for (const s of all(ex)) {
      assert.ok(!seen.has(s.id), `unique id ${s.id}`);
      seen.add(s.id);
      assert.ok(s.evidence.length >= 1 && s.evidence.length <= 64, s.id);
      assert.ok(s.evidenceTotal >= s.evidence.length);
      for (const e of s.evidence) assert.ok(ids.has(e), `${name} ${s.id} cites unknown ${e}`);
      if (s.kind === "interpretation") assert.ok(s.rule !== undefined && RULES.has(s.rule));
      else assert.equal(s.rule, undefined);
      for (const p of s.parts) {
        if (p.t === "text") assert.match(p.v, SAFE_TEXT, `${s.id} static text`);
      }
    }
  }
});

test("evidence is listed in event order", () => {
  const view = loadSession("claude-code");
  const order = new Map(view.result.events.map((e, i) => [e.eventId, i]));
  for (const s of all(explainSession(view, EXPLAIN_OPTS))) {
    const pos = s.evidence.map((e) => order.get(e) ?? -1);
    assert.deepEqual(
      pos,
      [...pos].sort((a, b) => a - b),
    );
  }
});

test("requested is never phrased as ran; a missing result is 'outcome not observed'", () => {
  const view = loadSession("claude-code");
  const ex = explainSession(view, EXPLAIN_OPTS);
  const texts = all(ex).map((s) => flat(s.parts));
  for (const t of texts) {
    assert.doesNotMatch(t, /\b(ran|executed|runs)\b/i);
    assert.doesNotMatch(t, /thinking|chain-of-thought/i);
  }
  const bash = texts.find((t) => t.startsWith("Tool Bash"));
  assert.equal(bash, "Tool Bash: requested 3, completed 1, failed 1, outcome not observed 1.");
  const unfinished = all(ex).find((s) => s.rule === "interp.unfinished");
  assert.ok(unfinished);
  const gap = view.result.events.find((e) => e.kind === "capture.gap");
  assert.ok(gap && unfinished.evidence.includes(gap.eventId), "cites the gap");
});

test("reasoning channel is labelled provider-exposed reasoning text", () => {
  const ex = explainSession(loadSession("claude-code"), EXPLAIN_OPTS);
  const msg = all(ex).find((s) => s.template === "turns.messages");
  assert.ok(msg);
  assert.match(flat(msg.parts), /provider-exposed reasoning text messages/);
});

test("interpretations: outcome from session.ended, else turn.ended; retry", () => {
  const codex = explainSession(loadSession("codex-cli"), EXPLAIN_OPTS);
  const o1 = all(codex).find((s) => s.rule === "interp.outcome");
  assert.match(flat(o1?.parts ?? []), /outcome is success, from the last session\.ended/);
  const gem = explainSession(loadSession("gemini-cli"), EXPLAIN_OPTS);
  const o2 = all(gem).find((s) => s.rule === "interp.outcome");
  assert.match(flat(o2?.parts ?? []), /interrupted, from the last turn\.ended/);
  const claude = explainSession(loadSession("claude-code"), EXPLAIN_OPTS);
  const r = all(claude).find((s) => s.rule === "interp.retry");
  assert.ok(r && r.evidence.length === 2);
});

test("tokens: cumulative session counts use the last value, never a sum (M-18)", () => {
  const ex = explainSession(loadSession("codex-cli"), EXPLAIN_OPTS);
  const t = all(ex).filter((s) => s.template.startsWith("tokens."));
  assert.equal(t.length, 1);
  const text = flat(t[0]?.parts ?? []);
  assert.match(text, /cumulative as reported/);
  assert.match(text, /input tokens 2500, output tokens 400, total tokens 2900/);
  assert.doesNotMatch(text, /3500/);
  assert.equal(t[0]?.evidence.length, 1);
});

test("tokens: turn-scope and message-scope events are summed per model", () => {
  const oc = all(explainSession(loadSession("opencode"), EXPLAIN_OPTS)).find(
    (s) => s.template === "tokens.summed",
  );
  assert.match(
    flat(oc?.parts ?? []),
    /summed from 2 turn-scope usage events, input tokens 1000, output tokens 110/,
  );
  assert.match(flat(oc?.parts ?? []), /provider-side estimate\) USD 0\.004000/);
  const cl = all(explainSession(loadSession("claude-code"), EXPLAIN_OPTS)).find(
    (s) => s.template === "tokens.summed",
  );
  assert.match(flat(cl?.parts ?? []), /message-scope usage events, input tokens 2700/);
});

test("inline prompt excerpts are opt-in and truncated by code points", () => {
  const view = loadSession("codex-cli");
  const on = explainSession(view, { includeContentExcerpts: true, excerptChars: 5 });
  assert.ok(all(on).some((s) => flat(s.parts).endsWith("add a...")));
  const off = explainSession(view, { includeContentExcerpts: false, excerptChars: 160 });
  assert.ok(!all(off).some((s) => s.template === "turns.prompt"));
  const hashOnly = explainSession(loadSession("claude-code"), EXPLAIN_OPTS);
  assert.ok(!all(hashOnly).some((s) => s.template === "turns.prompt"));
});

test("files: provider-reported and derived-from-tool-result are phrased differently", () => {
  const ex = explainSession(loadSession("codex-cli"), EXPLAIN_OPTS);
  const f = all(ex)
    .filter((s) => s.template === "files.change")
    .map((s) => flat(s.parts));
  assert.equal(f.length, 3);
  assert.ok(f[0]?.endsWith("reported by the provider."));
  assert.ok(f[2]?.endsWith("derived from tool result."));
});

test("explanation is deterministic and an empty session yields no evidence statements", () => {
  const view = loadSession("opencode");
  assert.deepEqual(explainSession(view, EXPLAIN_OPTS), explainSession(view, EXPLAIN_OPTS));
  const empty = explainSession(withEvents(view, []), EXPLAIN_OPTS);
  assert.equal(all(empty).length, 0);
});

test("property: removing a cited event changes or removes the statement", () => {
  for (const name of PROVIDER_FIXTURES) {
    const view = loadSession(name);
    const base = explainSession(view, EXPLAIN_OPTS);
    const strip = (s: Statement) => JSON.stringify({ ...s, id: "" });
    for (const s of all(base)) {
      const victim = s.evidence[0];
      const events = view.result.events.filter((e) => e.eventId !== victim);
      // Links to the removed event would dangle; drop them as the pipeline would.
      const cleaned = events.map((e) => ({
        ...e,
        links: e.links.filter((l) => l.target !== victim),
      }));
      const after = new Set(
        all(explainSession(withEvents(view, cleaned), EXPLAIN_OPTS)).map(strip),
      );
      assert.ok(!after.has(strip(s)), `${name} ${s.id} unchanged after removing its evidence`);
    }
  }
});

test("G3-1: interp.retry scales linearly in failures x results", () => {
  const base = loadSession("claude-code");
  const tpl = base.result.events.find((e) => e.kind === "tool.failed");
  const okTpl = base.result.events.find((e) => e.kind === "tool.completed");
  assert.ok(tpl && okTpl);
  const mk = (src: CanonicalEvent, i: number, name: string, ok: boolean): CanonicalEvent => {
    const e = JSON.parse(JSON.stringify(src)) as CanonicalEvent;
    const m = e as unknown as {
      eventId: string;
      sourceSequence: number;
      subIndex: number;
      turnId: string;
      links: unknown[];
      status: string;
      payload: { toolName: string };
    };
    m.eventId = `evt_${i.toString(16).padStart(32, "0")}`;
    m.sourceSequence = 100_000 + i;
    m.subIndex = 0;
    m.turnId = "turn_x";
    m.links = [];
    m.status = ok ? "success" : "failure";
    m.payload.toolName = name;
    return e;
  };
  const run = (n: number, matching: boolean) => {
    const evs: CanonicalEvent[] = [];
    for (let i = 0; i < n; i++) evs.push(mk(tpl, i, "a", false));
    for (let i = 0; i < n; i++) evs.push(mk(okTpl, n + i, matching ? "a" : "b", true));
    const view = { record: base.record, result: { ...base.result, events: evs } };
    const t0 = performance.now();
    const ex = explainSession(view as SessionView, EXPLAIN_OPTS);
    return { ms: performance.now() - t0, ex };
  };
  // no matching successes: the old code scanned all n results per failure (n^2)
  const big = run(30_000, false);
  assert.ok(big.ms < 3000, `took ${big.ms}ms`);
  assert.equal(all(big.ex).filter((s) => s.rule === "interp.retry").length, 0);
  const small = run(50, true);
  const r = all(small.ex).find((s) => s.rule === "interp.retry");
  assert.ok(r);
  assert.equal(r.evidenceTotal, 51); // 50 failures + the first success after them
});

test("explain masks home paths in prompt excerpts before cutting them", async () => {
  const { makeContentRef } = await import("@swain/core");
  const { loadSession, withEvents } = await import("./helpers.js");
  const base = loadSession("claude-code");
  const homes = ["/home/someuser", "/data/realhome"];
  for (const home of homes) {
    for (let pad = 140; pad <= 165; pad++) {
      const prompt = `${"a".repeat(pad)}${home}/secret`;
      const events = base.result.events.map((e) =>
        e.kind === "turn.started"
          ? { ...e, payload: { prompt: makeContentRef(prompt, { retention: "inline" }) } }
          : e,
      );
      const v = withEvents(base, events);
      const ex = explainSession(v, {
        includeContentExcerpts: true,
        excerptChars: 160,
        homeDirs: ["/home/someuser", "/data/realhome"],
      });
      const out = JSON.stringify(ex);
      const name = home.split("/").pop() ?? "";
      for (let k = 5; k <= name.length; k++) {
        assert.ok(!out.includes(`/${name.slice(0, k)}`), `pad ${pad} leaks ${name.slice(0, k)}`);
      }
    }
  }
});
