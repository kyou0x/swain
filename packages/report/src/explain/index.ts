import type { CanonicalEvent, ContentRef, EvtId } from "@swain/core";
import { maskHomeInText } from "../render/common.js";
import type {
  ExplainOptions,
  Explanation,
  Part,
  SectionId,
  SessionView,
  Statement,
  TemplateId,
} from "../types.js";

/**
 * Deterministic, template-based explanation (SPEC-002 section 5). Every statement reads only event
 * fields (plus, where labelled, importer statistics) and cites event IDs. Pure: no clock, no I/O.
 */

const MAX_EVIDENCE = 64;
const MAX_ITEMIZED = 200;
const MAX_NAMES = 5;

const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  overview: "Overview",
  turns: "Turns",
  tools: "Tools",
  files: "Files changed",
  failures: "Failures",
  permissions: "Permissions",
  tokens: "Tokens",
  gaps: "Capture gaps and unknown records",
  limitations: "Limitations",
};
const SECTION_ORDER: readonly SectionId[] = [
  "overview",
  "turns",
  "tools",
  "files",
  "failures",
  "permissions",
  "tokens",
  "gaps",
  "limitations",
];

type Ev<K extends CanonicalEvent["kind"]> = Extract<CanonicalEvent, { kind: K }>;

const text = (v: string): Part => ({ t: "text", v });
const data = (v: string): Part => ({ t: "data", v });
const count = (v: number): Part => ({ t: "count", v });

/** Order by value in UTF-16 code units. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Groups sorted by (count desc, key by UTF-16 code units). */
function sortedGroups<T>(m: ReadonlyMap<string, T[]>): [string, T[]][] {
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0]));
}

function pushTo<T>(m: Map<string, T[]>, key: string, v: T): void {
  const list = m.get(key);
  if (list === undefined) m.set(key, [v]);
  else list.push(v);
}

function codePointExcerpt(s: string, max: number): string {
  const limit = Math.max(0, Math.trunc(max));
  let n = 0;
  let end = 0;
  for (const ch of s) {
    if (n === limit) return `${s.slice(0, end)}...`;
    n++;
    end += ch.length;
  }
  return s;
}

function inlineText(ref: ContentRef | null): string | null {
  if (ref === null || ref.inline === undefined) return null;
  return ref.retention === "hash-only" ? null : ref.inline;
}

class Builder {
  readonly statements: Statement[] = [];
  private readonly section: SectionId;
  private readonly pos: ReadonlyMap<EvtId, number>;
  constructor(section: SectionId, pos: ReadonlyMap<EvtId, number>) {
    this.section = section;
    this.pos = pos;
  }

  add(
    template: TemplateId,
    parts: readonly Part[],
    ids: readonly EvtId[],
    rule?: `interp.${string}`,
  ): void {
    const unique = [...new Set(ids)].filter((i) => this.pos.has(i));
    if (unique.length === 0) return; // an evidence statement without evidence is never emitted
    unique.sort((a, b) => (this.pos.get(a) ?? 0) - (this.pos.get(b) ?? 0));
    const base = {
      id: `${this.section}.${this.statements.length + 1}`,
      template,
      parts,
      evidence: unique.slice(0, MAX_EVIDENCE),
      evidenceTotal: unique.length,
    };
    if (rule === undefined) this.statements.push({ ...base, kind: "evidence" });
    else this.statements.push({ ...base, kind: "interpretation", rule });
  }
}

function joinNames(names: readonly string[]): Part[] {
  const shown = names.slice(0, MAX_NAMES);
  const parts: Part[] = [];
  shown.forEach((n, i) => {
    if (i > 0) parts.push(text(", "));
    parts.push(data(n));
  });
  if (names.length > shown.length) {
    parts.push(text(", and "), count(names.length - shown.length), text(" more"));
  }
  return parts;
}

function allContentRefs(e: CanonicalEvent): ContentRef[] {
  const p = e.payload as unknown as Record<string, unknown>;
  const refs: ContentRef[] = [];
  for (const k of ["prompt", "content", "input", "output", "error", "diff", "reason"]) {
    const v = p[k];
    if (typeof v === "object" && v !== null && "sha256" in v && "retention" in v) {
      refs.push(v as ContentRef);
    }
  }
  return refs;
}

export function explainSession(view: SessionView, opts: ExplainOptions): Explanation {
  const { record, result } = view;
  const events: readonly CanonicalEvent[] = result.events
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) => a.e.sourceSequence - b.e.sourceSequence || a.e.subIndex - b.e.subIndex || a.i - b.i,
    )
    .map((x) => x.e);
  const pos = new Map<EvtId, number>();
  events.forEach((e, i) => {
    pos.set(e.eventId, i);
  });
  const byId = new Map<EvtId, CanonicalEvent>(events.map((e) => [e.eventId, e]));
  const kind = <K extends CanonicalEvent["kind"]>(k: K): Ev<K>[] =>
    events.filter((e): e is Ev<K> => e.kind === k);

  const first = events[0];
  const last = events[events.length - 1];

  // Tool correlation: results by the `result-of` link, gaps by the `gap-for` link.
  const requested = kind("tool.requested");
  const results: (Ev<"tool.completed"> | Ev<"tool.failed">)[] = events.filter(
    (e): e is Ev<"tool.completed"> | Ev<"tool.failed"> =>
      e.kind === "tool.completed" || e.kind === "tool.failed",
  );
  const resultsOf = new Map<EvtId, (Ev<"tool.completed"> | Ev<"tool.failed">)[]>();
  const gapsFor = new Map<EvtId, Ev<"capture.gap">[]>();
  const linkedResult = new Set<EvtId>();
  const requestedName = (id: EvtId): string | null => {
    const r = byId.get(id);
    return r?.kind === "tool.requested" ? r.payload.toolName : null;
  };
  for (const r of results) {
    for (const l of r.links) {
      if (l.rel !== "result-of" || requestedName(l.target) === null) continue;
      const list = resultsOf.get(l.target) ?? [];
      list.push(r);
      resultsOf.set(l.target, list);
      linkedResult.add(r.eventId);
    }
  }
  for (const g of kind("capture.gap")) {
    for (const l of g.links) {
      if (l.rel !== "gap-for" || requestedName(l.target) === null) continue;
      const list = gapsFor.get(l.target) ?? [];
      list.push(g);
      gapsFor.set(l.target, list);
    }
  }
  const resultName = (r: Ev<"tool.completed"> | Ev<"tool.failed">): string | null => {
    if (r.payload.toolName !== null) return r.payload.toolName;
    for (const l of r.links) {
      if (l.rel === "result-of") {
        const n = requestedName(l.target);
        if (n !== null) return n;
      }
    }
    return null;
  };

  const sections = new Map<SectionId, Builder>();
  const sec = (id: SectionId): Builder => {
    const b = new Builder(id, pos);
    sections.set(id, b);
    return b;
  };

  // ---- overview ----
  {
    const b = sec("overview");
    const turnsStarted = kind("turn.started");
    if (first !== undefined && last !== undefined) {
      b.add(
        "overview.source",
        [
          text("Provider "),
          data(record.provider),
          text(", source kind "),
          data(record.sourceKind),
          text(", source stability "),
          data(record.adapter.sourceStability),
          text(", adapter "),
          data(`${record.adapter.id}@${record.adapter.version}`),
          text(", import outcome "),
          data(record.outcome),
          text("."),
        ],
        [first.eventId],
      );
      b.add(
        "overview.counts",
        [
          text("The import holds "),
          count(events.length),
          text(" events, including "),
          count(turnsStarted.length),
          text(" turn.started events."),
        ],
        [first.eventId, last.eventId],
      );
      const timed = events.filter((e) => e.time.status === "valid" && e.time.value !== null);
      const t0 = timed[0];
      const t1 = timed[timed.length - 1];
      if (t0 !== undefined && t1 !== undefined) {
        b.add(
          "overview.span",
          [
            text("First valid event time "),
            data(t0.time.value ?? ""),
            text(", last valid event time "),
            data(t1.time.value ?? ""),
            text("."),
          ],
          [t0.eventId, t1.eventId],
        );
      }
    }
    const ends = kind("session.ended");
    const lastEnd = ends[ends.length - 1];
    if (lastEnd !== undefined) {
      b.add(
        "overview.outcome",
        [
          text("the session outcome is "),
          data(lastEnd.status),
          text(", from the last session.ended event"),
        ],
        [lastEnd.eventId],
        "interp.outcome",
      );
    } else {
      const turnEnds = kind("turn.ended");
      const lastTurnEnd = turnEnds[turnEnds.length - 1];
      if (lastTurnEnd !== undefined) {
        b.add(
          "overview.outcome",
          [
            text("no session.ended event exists; the outcome is "),
            data(lastTurnEnd.status),
            text(", from the last turn.ended event"),
          ],
          [lastTurnEnd.eventId],
          "interp.outcome",
        );
      }
    }
  }

  // ---- turns ----
  {
    const b = sec("turns");
    const buckets = new Map<string, CanonicalEvent[]>();
    for (const e of events) if (e.turnId !== null) pushTo(buckets, e.turnId, e);
    const order = [...buckets.values()];
    order.slice(0, MAX_ITEMIZED).forEach((evs, idx) => {
      const n = idx + 1;
      const started = evs.find((e): e is Ev<"turn.started"> => e.kind === "turn.started");
      const ended = [...evs].reverse().find((e): e is Ev<"turn.ended"> => e.kind === "turn.ended");
      const parts: Part[] = [text("Turn "), count(n), text(": ")];
      if (started !== undefined) {
        parts.push(text("started"));
        if (started.time.status === "valid" && started.time.value !== null) {
          parts.push(text(" at "), data(started.time.value));
        }
      } else parts.push(text("no turn.started event observed"));
      parts.push(text("; "));
      if (ended !== undefined) parts.push(text("ended with status "), data(ended.status));
      else parts.push(text("no turn.ended event observed"));
      parts.push(text("."));
      const ids: EvtId[] = [];
      if (started !== undefined) ids.push(started.eventId);
      if (ended !== undefined) ids.push(ended.eventId);
      const firstEv = evs[0];
      if (ids.length === 0 && firstEv !== undefined) ids.push(firstEv.eventId);
      b.add("turns.turn", parts, ids);

      if (opts.includeContentExcerpts && started !== undefined) {
        const prompt = inlineText(started.payload.prompt);
        if (prompt !== null) {
          b.add(
            "turns.prompt",
            [
              text("Turn "),
              count(n),
              text(" prompt excerpt (inline content): "),
              data(
                codePointExcerpt(
                  (opts.homeDirs ?? []).reduce<string>((t, h) => maskHomeInText(t, h), prompt),
                  opts.excerptChars,
                ),
              ),
            ],
            [started.eventId],
          );
        }
      }

      const msgs = evs.filter((e): e is Ev<"message.observed"> => e.kind === "message.observed");
      if (msgs.length > 0) {
        const groups = new Map<string, Ev<"message.observed">[]>();
        for (const m of msgs) {
          const label =
            m.payload.channel === "reasoning"
              ? "provider-exposed reasoning text messages"
              : m.payload.channel === "notification"
                ? `${m.payload.role} notification messages`
                : `${m.payload.role} text messages`;
          pushTo(groups, label, m);
        }
        const mp: Part[] = [text("Turn "), count(n), text(" messages: ")];
        sortedGroups(groups).forEach(([label, list], i) => {
          if (i > 0) mp.push(text(", "));
          mp.push(count(list.length), text(` ${label}`));
        });
        mp.push(text("."));
        b.add(
          "turns.messages",
          mp,
          msgs.map((m) => m.eventId),
        );
      }
    });
    if (order.length > MAX_ITEMIZED) {
      const rest = order.slice(MAX_ITEMIZED);
      const ids = rest.flatMap((evs) => (evs[0] === undefined ? [] : [evs[0].eventId]));
      b.add("turns.omitted", [count(rest.length), text(" further turns are not itemized.")], ids);
    }
  }

  // ---- tools ----
  {
    const b = sec("tools");
    type Group = { ids: EvtId[]; req: number; ok: number; failed: number; unobserved: number };
    const groups = new Map<string, Group>();
    const grp = (name: string): Group => {
      let g = groups.get(name);
      if (g === undefined) {
        g = { ids: [], req: 0, ok: 0, failed: 0, unobserved: 0 };
        groups.set(name, g);
      }
      return g;
    };
    const unfinished: Ev<"tool.requested">[] = [];
    for (const r of requested) {
      const g = grp(r.payload.toolName);
      g.req++;
      g.ids.push(r.eventId);
      const rs = resultsOf.get(r.eventId) ?? [];
      if (rs.length === 0) {
        g.unobserved++;
        unfinished.push(r);
        for (const gap of gapsFor.get(r.eventId) ?? []) g.ids.push(gap.eventId);
      }
    }
    for (const r of results) {
      const g = grp(resultName(r) ?? "(unnamed)");
      if (r.kind === "tool.completed") g.ok++;
      else g.failed++;
      g.ids.push(r.eventId);
    }
    if (requested.length > 0) {
      b.add(
        "tools.summary",
        [
          count(requested.length),
          text(" tool requests were recorded across "),
          count(new Set(requested.map((r) => r.payload.toolName)).size),
          text(" distinct tools. A request records an attempt, not an observed execution."),
        ],
        requested.map((r) => r.eventId),
      );
    }
    const sorted = [...groups.entries()].sort(
      (a, c) => c[1].ids.length - a[1].ids.length || cmp(a[0], c[0]),
    );
    for (const [name, g] of sorted) {
      b.add(
        "tools.group",
        [
          text("Tool "),
          data(name),
          text(": requested "),
          count(g.req),
          text(", completed "),
          count(g.ok),
          text(", failed "),
          count(g.failed),
          text(", outcome not observed "),
          count(g.unobserved),
          text("."),
        ],
        g.ids,
      );
    }
    if (unfinished.length > 0) {
      const gapIds = unfinished.flatMap((r) =>
        (gapsFor.get(r.eventId) ?? []).map((g) => g.eventId),
      );
      b.add(
        "tools.unfinished",
        [
          count(unfinished.length),
          text(
            " tool requests have no observed result at the end of the source; the source may have ended before they completed",
          ),
        ],
        [...unfinished.map((r) => r.eventId), ...gapIds],
        "interp.unfinished",
      );
    }
  }

  // ---- files ----
  {
    const b = sec("files");
    const changes = kind("file.changed");
    if (changes.length > 0) {
      b.add(
        "files.summary",
        [
          count(changes.length),
          text(" file.changed events across "),
          count(new Set(changes.map((c) => c.payload.path)).size),
          text(" distinct paths."),
        ],
        changes.map((c) => c.eventId),
      );
    }
    for (const c of changes.slice(0, MAX_ITEMIZED)) {
      b.add(
        "files.change",
        [
          text("File "),
          data(c.payload.path),
          text(": change kind "),
          data(c.payload.changeKind),
          text(", status "),
          data(c.status),
          text(
            c.payload.basis === "derived-from-tool-result"
              ? ", derived from tool result."
              : ", reported by the provider.",
          ),
        ],
        [c.eventId],
      );
    }
    if (changes.length > MAX_ITEMIZED) {
      b.add(
        "files.omitted",
        [count(changes.length - MAX_ITEMIZED), text(" further file changes are not itemized.")],
        changes.slice(MAX_ITEMIZED).map((c) => c.eventId),
      );
    }
  }

  // ---- failures ----
  {
    const b = sec("failures");
    const failed = kind("tool.failed");
    const byClass = new Map<string, Ev<"tool.failed">[]>();
    for (const f of failed) pushTo(byClass, f.payload.errorClass, f);
    for (const [cls, list] of sortedGroups(byClass)) {
      const names = [...new Set(list.map((f) => resultName(f) ?? "(unnamed)"))].sort(cmp);
      b.add(
        "failures.tool",
        [
          count(list.length),
          text(" tool.failed events with error class "),
          data(cls),
          text(" (tools: "),
          ...joinNames(names),
          text(")."),
        ],
        list.map((f) => f.eventId),
      );
    }
    const endedBad = new Map<string, CanonicalEvent[]>();
    for (const e of events) {
      if (
        (e.kind === "session.ended" || e.kind === "turn.ended" || e.kind === "agent.ended") &&
        (e.status === "failure" || e.status === "interrupted")
      ) {
        pushTo(endedBad, `${e.kind}\u0000${e.status}`, e);
      }
    }
    for (const [key, list] of sortedGroups(endedBad)) {
      const [k = "", s = ""] = key.split("\u0000");
      b.add(
        "failures.ended",
        [count(list.length), text(` ${k} events with status `), data(s), text(".")],
        list.map((e) => e.eventId),
      );
    }
    // interp.retry: a failed tool followed, within the same turn, by a success of the same tool.
    const retry = new Map<string, EvtId[]>();
    // One pass: successes per (turn, tool name) in event order (positions ascend).
    const successes = new Map<string, { at: number; ev: Ev<"tool.completed"> }[]>();
    for (const r of results) {
      if (r.kind !== "tool.completed" || r.status !== "success" || r.turnId === null) continue;
      const n = resultName(r);
      if (n === null) continue;
      const key = `${r.turnId}\u0000${n}`;
      const list = successes.get(key) ?? [];
      list.push({ at: pos.get(r.eventId) ?? 0, ev: r });
      successes.set(key, list);
    }
    for (const f of failed) {
      const name = resultName(f);
      if (name === null || f.turnId === null) continue;
      const fp = pos.get(f.eventId) ?? 0;
      const list = successes.get(`${f.turnId}\u0000${name}`);
      if (list === undefined) continue;
      // First success strictly after the failure (binary search).
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((list[mid]?.at ?? 0) > fp) hi = mid;
        else lo = mid + 1;
      }
      const success = list[lo]?.ev;
      if (success !== undefined) {
        const ids = retry.get(name) ?? [];
        ids.push(f.eventId, success.eventId);
        retry.set(name, ids);
      }
    }
    for (const [name, ids] of [...retry.entries()].sort(
      (a, c) => c[1].length - a[1].length || cmp(a[0], c[0]),
    )) {
      b.add(
        "failures.retry",
        [
          text("tool "),
          data(name),
          text(" failed and was followed, in the same turn, by a successful "),
          data(name),
          text(" result, which may be a retry"),
        ],
        ids,
        "interp.retry",
      );
    }
  }

  // ---- permissions ----
  {
    const b = sec("permissions");
    const reqs = kind("permission.requested");
    if (reqs.length > 0) {
      const names = [...new Set(reqs.map((r) => r.payload.toolName ?? "(unnamed)"))].sort(cmp);
      b.add(
        "permissions.requested",
        [
          count(reqs.length),
          text(" permission requests were recorded (tools: "),
          ...joinNames(names),
          text("). A request is not a decision."),
        ],
        reqs.map((r) => r.eventId),
      );
    }
    const groups = new Map<string, Ev<"permission.decided">[]>();
    for (const d of kind("permission.decided")) {
      pushTo(groups, `${d.payload.decision}\u0000${d.payload.decidedBy}`, d);
    }
    for (const [key, list] of sortedGroups(groups)) {
      const [decision = "", by = ""] = key.split("\u0000");
      b.add(
        "permissions.decided",
        [
          count(list.length),
          text(" permission decisions: "),
          data(decision),
          text(", decided by "),
          data(by),
          text("."),
        ],
        list.map((d) => d.eventId),
      );
    }
  }

  // ---- tokens (SPEC-002 section 5.2) ----
  {
    const b = sec("tokens");
    const usage = kind("model.usage");
    const sessionScope = usage.filter((u) => u.payload.scope === "session");
    const scoped =
      sessionScope.length > 0 ? sessionScope : usage.filter((u) => u.payload.scope === "turn");
    const chosen = scoped.length > 0 ? scoped : usage.filter((u) => u.payload.scope === "message");
    const cumulative = sessionScope.length > 0;
    const scopeName = cumulative ? "session" : (chosen[0]?.payload.scope ?? "message");
    const byModel = new Map<string, Ev<"model.usage">[]>();
    for (const u of chosen) pushTo(byModel, u.payload.model ?? "(unspecified model)", u);
    const fields = [
      ["inputTokens", "input"],
      ["outputTokens", "output"],
      ["cachedInputTokens", "cached input"],
      ["cacheWriteInputTokens", "cache write input"],
      ["reasoningOutputTokens", "reasoning output"],
      ["totalTokens", "total"],
    ] as const;
    for (const [model, list] of sortedGroups(byModel)) {
      const use = cumulative ? list.slice(-1) : list;
      const parts: Part[] = [text("Model "), data(model), text(": ")];
      parts.push(
        text(
          cumulative
            ? "cumulative as reported (last session-scope usage event, not summed), "
            : `summed from ${use.length} ${scopeName}-scope usage events, `,
        ),
      );
      const items: Part[][] = [];
      for (const [key, label] of fields) {
        let total = 0;
        let seen = false;
        for (const u of use) {
          const v = u.payload[key];
          if (v !== undefined) {
            total += v;
            seen = true;
          }
        }
        if (seen) items.push([text(`${label} tokens `), count(total)]);
      }
      let cost = 0;
      let costSeen = false;
      for (const u of use) {
        if (u.payload.costUsdEstimate !== undefined) {
          cost += u.payload.costUsdEstimate;
          costSeen = true;
        }
      }
      if (costSeen) items.push([text("cost (provider-side estimate) USD "), data(cost.toFixed(6))]);
      if (items.length === 0) items.push([text("no token counts reported")]);
      items.forEach((it, i) => {
        if (i > 0) parts.push(text(", "));
        parts.push(...it);
      });
      parts.push(text("."));
      b.add(
        cumulative ? "tokens.cumulative" : "tokens.summed",
        parts,
        use.map((u) => u.eventId),
      );
    }
  }

  // ---- gaps ----
  {
    const b = sec("gaps");
    const gaps = new Map<string, Ev<"capture.gap">[]>();
    for (const g of kind("capture.gap")) pushTo(gaps, g.payload.reason, g);
    for (const [reason, list] of sortedGroups(gaps)) {
      b.add(
        "gaps.gap",
        [count(list.length), text(" capture gaps with reason "), data(reason), text(".")],
        list.map((g) => g.eventId),
      );
    }
    const unknown = kind("source.unknown");
    if (unknown.length > 0) {
      const types = new Map<string, Ev<"source.unknown">[]>();
      for (const u of unknown) pushTo(types, u.payload.nativeType ?? "(no native type)", u);
      const names = sortedGroups(types).map(([n]) => n);
      b.add(
        "gaps.unknown",
        [
          count(unknown.length),
          text(" records were not recognized and kept as source.unknown (native types: "),
          ...joinNames(names),
          text(")."),
        ],
        unknown.map((u) => u.eventId),
      );
    }
    if (result.stats.folded > 0 && first !== undefined) {
      b.add(
        "gaps.folded",
        [
          text("Import statistics, not an event, report "),
          count(result.stats.folded),
          text(" source records folded without an event of their own."),
        ],
        [first.eventId],
      );
    }
  }

  // ---- limitations ----
  {
    const b = sec("limitations");
    if (first !== undefined) {
      b.add(
        "limitations.stability",
        [
          text("Source stability is "),
          data(record.adapter.sourceStability),
          text(
            record.adapter.experimental
              ? ". The adapter is labelled experimental."
              : ". The adapter is not labelled experimental.",
          ),
          text(
            record.adapter.sourceStability === "undocumented"
              ? " The source format is undocumented and may change without notice."
              : "",
          ),
        ],
        [first.eventId],
      );
    }
    const hashOnly = events.filter((e) =>
      allContentRefs(e).some((r) => r.retention === "hash-only"),
    );
    if (hashOnly.length > 0) {
      b.add(
        "limitations.retention",
        [
          count(hashOnly.length),
          text(
            " events carry hash-only content; the text is not stored and only its hash and size are known.",
          ),
        ],
        hashOnly.map((e) => e.eventId),
      );
    }
    const incomplete = new Map<string, CanonicalEvent[]>();
    for (const e of events) {
      for (const [facet, c] of Object.entries(e.completeness)) {
        if (c.state === "unknown" || c.state === "unavailable") {
          pushTo(incomplete, `${facet}\u0000${c.state}`, e);
        }
      }
    }
    for (const [key, list] of sortedGroups(incomplete)) {
      const [facet = "", state = ""] = key.split("\u0000");
      b.add(
        "limitations.completeness",
        [
          count(list.length),
          text(" events report facet "),
          data(facet),
          text(" as "),
          data(state),
          text("."),
        ],
        list.map((e) => e.eventId),
      );
    }
    const warn = new Map<string, number>();
    for (const w of result.warnings) warn.set(w.code, (warn.get(w.code) ?? 0) + 1);
    if (warn.size > 0 && first !== undefined) {
      const items = [...warn.entries()].sort((a, c) => c[1] - a[1] || cmp(a[0], c[0]));
      const parts: Part[] = [text("Import warnings, not events: ")];
      items.forEach(([code, n], i) => {
        if (i > 0) parts.push(text(", "));
        parts.push(data(code), text(" x"), count(n));
      });
      parts.push(text("."));
      b.add("limitations.warnings", parts, [first.eventId]);
    }
  }

  return {
    format: "atm.explanation/0.1",
    importId: record.importId,
    sessionId: record.sessionId,
    sections: SECTION_ORDER.map((id) => ({
      id,
      title: SECTION_TITLES[id],
      statements: sections.get(id)?.statements ?? [],
    })),
  };
}
