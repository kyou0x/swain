/**
 * Maps stored rows to the page view models of `@swain/report`. Everything read from the store is
 * re-validated here: stored JSON is untrusted input (SPEC-003 section 2.3), so every JSON column is
 * parsed defensively and a malformed value becomes a visible "unrenderable" scalar, never markup.
 */
import type {
  AgtId,
  ProjectScope,
  RunId,
  RunSummary,
  StoredSpan,
  StoredSpanConflict,
  SwainStore,
} from "@swain/db";
import { computeRunStatus, DEFAULT_IDLE_WINDOW_MS } from "@swain/model";
import type {
  AgentNameView,
  AttrView,
  CredentialView,
  RunHeader,
  RunRowView,
  RunStatusName,
  SpanConflictView,
  SpanRowView,
  TextView,
} from "@swain/report";

const MAX_SPANS = 1000;
const MAX_JSON_DEPTH_ITEMS = 256;

export type KeyLabels = ReadonlyMap<
  string,
  { readonly label: string; readonly agentName: string | null }
>;

export function keyLabels(store: SwainStore, scope: ProjectScope): KeyLabels {
  const out = new Map<string, { label: string; agentName: string | null }>();
  for (const k of store.listKeys(scope).keys)
    out.set(k.keyId, { label: k.label, agentName: k.agentName });
  return out;
}

export function credentialViews(
  list: readonly { readonly keyId: string; readonly records: number }[],
  labels: KeyLabels,
): CredentialView[] {
  return list.map((c) => {
    const l = labels.get(c.keyId);
    return {
      keyId: c.keyId,
      label: l?.label ?? null,
      agentName: l?.agentName ?? null,
      records: c.records,
    };
  });
}

/** Sum credentials over several runs (an agent's runs), sorted by key ID. */
export function mergeCredentials(
  lists: readonly (readonly { readonly keyId: string; readonly records: number }[])[],
): { keyId: string; records: number }[] {
  const m = new Map<string, number>();
  for (const l of lists) for (const c of l) m.set(c.keyId, (m.get(c.keyId) ?? 0) + c.records);
  return [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([keyId, records]) => ({ keyId, records }));
}

/**
 * Run status (ADR-0005 section 4), computed at read time. For an ended trace run the spans are read
 * (bounded) so that a missing parent makes it `incomplete`; no other run needs them.
 */
export function runStatusOf(
  store: SwainStore,
  scope: ProjectScope,
  run: RunSummary,
  nowMs: number,
): { status: RunStatusName; error: boolean; late: boolean } {
  let missingParents = 0;
  if (run.kind === "trace" && run.endEvidence) {
    const spans = store.runSpans(scope, run.runId, MAX_SPANS).spans;
    const ids = new Set(spans.map((s) => s.spanId));
    missingParents = spans.filter(
      (s) => s.parentSpanId !== null && !ids.has(s.parentSpanId),
    ).length;
  }
  const r = computeRunStatus(
    {
      lastReceivedMs: run.lastReceivedMs,
      endEvidence: run.endEvidence,
      missingParents,
      captureGaps: 0,
      unresolvedReferences: 0,
      errorEvidence: run.flags["error"] === true,
    },
    nowMs,
    DEFAULT_IDLE_WINDOW_MS,
  );
  return { status: r.status, error: r.error, late: r.late || run.flags["late"] === true };
}

function pickCounts(c: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of ["spans", "events", "logs"]) {
    const v = c[k];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

export function runRowView(
  store: SwainStore,
  scope: ProjectScope,
  run: RunSummary,
  agentName: string,
  labels: KeyLabels,
  nowMs: number,
): RunRowView {
  const st = runStatusOf(store, scope, run, nowMs);
  return {
    runId: run.runId,
    kind: run.kind,
    agentId: run.primaryAgentId,
    agentName,
    status: st.status,
    error: st.error,
    firstReceivedMs: run.firstReceivedMs,
    lastReceivedMs: run.lastReceivedMs,
    counts: pickCounts(run.counts),
    credentials: credentialViews(run.credentials, labels),
  };
}

export function runHeaderView(
  store: SwainStore,
  scope: ProjectScope,
  run: RunSummary,
  agentName: string,
  contentPolicy: string,
  labels: KeyLabels,
  nowMs: number,
): RunHeader {
  const st = runStatusOf(store, scope, run, nowMs);
  return {
    runId: run.runId,
    kind: run.kind,
    agentId: run.primaryAgentId,
    agentName,
    status: st.status,
    error: st.error,
    late: st.late,
    traceId: run.traceId,
    sessionKey: run.sessionKey ?? run.adrSessionId,
    contentPolicy,
    counts: pickCounts(run.counts),
    credentials: credentialViews(run.credentials, labels),
    firstReceivedMs: run.firstReceivedMs,
    lastReceivedMs: run.lastReceivedMs,
  };
}

// ---- stored JSON to display values ---------------------------------------------------------------

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

const UNRENDERABLE: TextView = { kind: "scalar", value: "[unrenderable value]" };

/** A `PolicyValue` or `PolicyText` as stored by `@swain/db` (`swain.policy-applied/1`). */
export function textViewOf(v: unknown): TextView {
  const o = rec(v);
  if (o === null) return UNRENDERABLE;
  switch (o["kind"]) {
    case "text":
      return typeof o["value"] === "string"
        ? { kind: "text", value: o["value"], masked: o["bestEffortMasked"] === true }
        : UNRENDERABLE;
    case "content": {
      const ref = rec(o["ref"]);
      if (
        ref === null ||
        typeof ref["sha256"] !== "string" ||
        typeof ref["byteLength"] !== "number" ||
        !Number.isSafeInteger(ref["byteLength"])
      ) {
        return UNRENDERABLE;
      }
      return {
        kind: "content",
        sha256: ref["sha256"],
        byteLength: ref["byteLength"],
        inline: typeof ref["inline"] === "string" ? ref["inline"] : null,
      };
    }
    case "bool":
      return { kind: "scalar", value: o["value"] === true ? "true" : "false" };
    case "int":
      return typeof o["value"] === "string" && /^-?[0-9]{1,20}$/.test(o["value"])
        ? { kind: "scalar", value: o["value"] }
        : UNRENDERABLE;
    case "double":
      return typeof o["value"] === "number" || typeof o["value"] === "string"
        ? { kind: "scalar", value: String(o["value"]).slice(0, 32) }
        : UNRENDERABLE;
    case "array":
      return {
        kind: "omitted",
        label: "array",
        size: Array.isArray(o["values"]) ? o["values"].length : 0,
      };
    case "kvlist":
      return {
        kind: "omitted",
        label: "map",
        size: Array.isArray(o["values"]) ? o["values"].length : 0,
      };
    case "over-depth":
      return { kind: "omitted", label: "over-depth", size: 0 };
    default:
      return UNRENDERABLE;
  }
}

/** A name stored as `PolicyText` JSON. */
export function nameView(json: string): TextView {
  return textViewOf(parse(json));
}

function attrViews(json: string): AttrView[] {
  const v = parse(json);
  if (!Array.isArray(v)) return [];
  const out: AttrView[] = [];
  for (const item of v.slice(0, MAX_JSON_DEPTH_ITEMS)) {
    const o = rec(item);
    if (o === null || typeof o["key"] !== "string") continue;
    out.push({
      key: o["key"],
      keyAltered: o["keyAltered"] === true,
      value: textViewOf(o["value"]),
    });
  }
  return out;
}

function nsOf(v: unknown): bigint | null {
  if (typeof v !== "string" || !/^[0-9]{1,20}$/.test(v)) return null;
  const n = BigInt(v);
  return n === 0n ? null : n;
}

function eventViews(json: string): SpanRowView["events"] {
  const v = parse(json);
  if (!Array.isArray(v)) return [];
  const out: { name: TextView; timeNs: bigint | null; attributes: AttrView[] }[] = [];
  for (const item of v.slice(0, 20)) {
    const o = rec(item);
    if (o === null) continue;
    out.push({
      name: textViewOf(o["name"]),
      timeNs: nsOf(o["timeUnixNano"]),
      attributes: attrViews(JSON.stringify(o["attributes"] ?? [])),
    });
  }
  return out;
}

function statusMessageView(json: string | null): TextView | null {
  if (json === null) return null;
  const t = textViewOf(parse(json));
  return t.kind === "text" && t.value === "" ? null : t;
}

export function spanRowView(s: StoredSpan): SpanRowView {
  return {
    spanId: s.spanId,
    parentSpanId: s.parentSpanId,
    name: nameView(s.nameJson),
    kind: s.kind,
    startNs: s.startNs,
    endNs: s.endNs,
    statusCode: s.statusCode,
    statusMessage: statusMessageView(s.statusMessageJson),
    opClass: s.opClass,
    keyId: s.keyId,
    canonical: s.canonical,
    late: s.late,
    attributes: attrViews(s.attributesJson),
    events: eventViews(s.eventsJson),
  };
}

/**
 * Span views with the ownership of `spanOwners` attached: `agentId` (the span's own agent),
 * `ownerAgentId` (the same-credential enclosing agent) and `parentOwnerAgentId`.
 */
export function spanRowViews(spans: readonly StoredSpan[]): SpanRowView[] {
  const walk = spanOwners(spans);
  return spans.map((s) => ({
    ...spanRowView(s),
    agentId: s.agentId,
    ownerAgentId: walk.owner(s),
    parentOwnerAgentId: walk.parentOwner(s),
  }));
}

const MAX_AGENT_NAMES = 256;

/**
 * Display names of the agents the spans refer to. Bounded: owner IDs (the agents that rows are
 * attributed to) are collected before plain span agent IDs, so the cap drops the least useful
 * names first. An agent without a name here renders as its short ID.
 */
export function agentNameViews(
  store: SwainStore,
  scope: ProjectScope,
  spans: readonly StoredSpan[],
): AgentNameView[] {
  const ids = new Set<string>();
  const add = (id: string | null): void => {
    if (id !== null && ids.size < MAX_AGENT_NAMES) ids.add(id);
  };
  const walk = spanOwners(spans);
  for (const s of spans) {
    add(walk.owner(s));
    add(walk.parentOwner(s));
  }
  for (const s of spans) add(s.agentId);
  const out: AgentNameView[] = [];
  for (const id of ids) {
    const a = store.agent(scope, id as AgtId);
    if (a !== null) out.push({ agentId: id, name: a.agent.displayName });
  }
  return out;
}

export function conflictView(c: StoredSpanConflict): SpanConflictView {
  return {
    spanId: c.spanId,
    keyId: c.keyId,
    canonicalKeyId: c.canonicalKeyId,
    relation: c.relation,
  };
}

export function agentNameOf(store: SwainStore, scope: ProjectScope, id: AgtId): string {
  return store.agent(scope, id)?.agent.displayName ?? "unknown agent";
}

export function runIdOf(v: string): RunId | null {
  return /^run_[0-9a-f]{32}$/.test(v) ? (v as RunId) : null;
}

/**
 * The same-credential ownership walk shared by error attribution and the run page tabs. A span is a
 * trusted node only when it is canonical and its `spanId` is unique in the run. `owner` is the agent
 * of the nearest `agent`-class ancestor-or-self reached through trusted nodes of the SAME credential
 * (`keyId`); `parentOwner` is the owner of the span's parent under the same rule (null when the
 * parent is missing, untrusted or from another credential). Untrusted spans have no owner.
 * The owner of each span is memoized (path compression), so the cost is O(n) per run.
 */
export interface SpanOwners {
  readonly trusted: (sp: ErrorSpanInput) => boolean;
  readonly owner: (sp: ErrorSpanInput) => string | null;
  readonly parentOwner: (sp: ErrorSpanInput) => string | null;
}

export function spanOwners(spans: readonly ErrorSpanInput[]): SpanOwners {
  const seen = new Map<string, number>();
  for (const sp of spans) seen.set(sp.spanId, (seen.get(sp.spanId) ?? 0) + 1);
  const byId = new Map<string, ErrorSpanInput>();
  for (const sp of spans) if (sp.canonical && seen.get(sp.spanId) === 1) byId.set(sp.spanId, sp);
  const trusted = (sp: ErrorSpanInput): boolean => sp.canonical && seen.get(sp.spanId) === 1;
  const sameKeyParent = (sp: ErrorSpanInput): ErrorSpanInput | undefined => {
    const parent = sp.parentSpanId === null ? undefined : byId.get(sp.parentSpanId);
    return parent !== undefined && parent.keyId === sp.keyId ? parent : undefined;
  };
  /** spanId -> the agent of the nearest agent-class ancestor-or-self in the same-key chain, or null */
  const memo = new Map<string, string | null>();
  const ownerOf = (start: ErrorSpanInput): string | null => {
    const path: ErrorSpanInput[] = [];
    const onPath = new Set<string>();
    let cur: ErrorSpanInput | undefined = start;
    let found: string | null = null;
    while (cur !== undefined) {
      const m = memo.get(cur.spanId);
      if (m !== undefined) {
        found = m;
        break;
      }
      if (onPath.has(cur.spanId)) break; // a cycle: no owner
      onPath.add(cur.spanId);
      path.push(cur);
      if (cur.opClass === "agent") {
        found = cur.agentId;
        break;
      }
      cur = sameKeyParent(cur);
    }
    for (const n of path) memo.set(n.spanId, found);
    return found;
  };
  return {
    trusted,
    // the walk starts at the span itself only when it is a trusted node of the tree
    owner: (sp) => (trusted(sp) ? ownerOf(sp) : null),
    parentOwner: (sp) => {
      if (!trusted(sp)) return null;
      const p = sameKeyParent(sp);
      return p === undefined ? null : ownerOf(p);
    },
  };
}

/**
 * The agents an ERROR span (status code 2) is charged to, within one trace run.
 *
 * - The span's OWN agent is always charged, so an agent can never clear its own error.
 * - The nearest enclosing `agent`-class span is charged too, by the `spanOwners` walk: a key
 *   boundary, a non-canonical span, a duplicated `spanId` or a missing parent stops it, so a sender
 *   cannot move its errors onto, or clear them from, another credential's agent.
 * - No propagation across an agent boundary: a sub-agent's error does not mark its parent.
 */
export interface ErrorSpanInput {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly agentId: string;
  readonly opClass: string;
  readonly statusCode: number;
  readonly keyId: string;
  readonly canonical: boolean;
}

export function errorAgents(spans: readonly ErrorSpanInput[]): Set<string> {
  const walk = spanOwners(spans);
  const out = new Set<string>();
  for (const sp of spans) {
    if (sp.statusCode !== 2) continue;
    out.add(sp.agentId);
    const owner = walk.owner(sp);
    if (owner !== null) out.add(owner);
  }
  return out;
}
