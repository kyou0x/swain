/**
 * Asserted relationship edges, N1 only (ADR-0005 section 9): `parent-of` and `same-session`.
 * No inference rules exist in N1 to N3; every edge here is `asserted` and cites L1 evidence with
 * the ingest key that delivered it. `crossCredential` is true when more than one key contributed
 * to the edge (both endpoints and the asserting record), so one key holder cannot forge
 * relationships onto another key's agents unnoticed.
 */
import { AtmError } from "@swain/core";
import { type IdentityValue, requireIdentity } from "./identity.js";
import { deriveSwainId } from "./ids.js";

export interface EdgeEvidence {
  readonly layer: "L1";
  readonly ref: string;
  readonly keyId: string;
}

export interface EdgeEndpoint {
  readonly type: "span" | "run";
  readonly id: string;
}

export interface AssertedEdge {
  readonly edgeId: string;
  readonly kind: "parent-of" | "same-session";
  readonly from: EdgeEndpoint;
  readonly to: EdgeEndpoint;
  readonly basis: string;
  readonly evidence: readonly EdgeEvidence[];
  readonly keyIds: readonly string[];
  readonly crossCredential: boolean;
  readonly confidence: "asserted";
}

/** What the model needs from one stored span record. `ref` locates it in L1 (batch + path). */
export interface SpanFact {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly keyId: string;
  readonly ref: string;
}

export interface RunSessionFact {
  readonly runId: string;
  readonly sessionBasis: "session.id" | "gen_ai.conversation.id" | "adr0002.sessionId";
  /** From `identityOfAttribute` / `identityOfAdr0002`; post-mask text cannot be passed. */
  readonly session: IdentityValue;
  readonly keyId: string;
  readonly ref: string;
}

const MAX_EVIDENCE = 64;
const PROJECT_ID = /^prj_[0-9a-f]{32}$/;

function projectOf(p: string): string {
  if (typeof p !== "string" || !PROJECT_ID.test(p)) throw new AtmError("invalid-id-component");
  return p;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function evidenceList(facts: readonly { ref: string; keyId: string }[]): EdgeEvidence[] {
  const seen = new Set<string>();
  const out: EdgeEvidence[] = [];
  const sorted = [...facts].sort((a, b) => cmp(a.ref, b.ref) || cmp(a.keyId, b.keyId));
  for (const f of sorted) {
    const k = `${f.keyId}\u0000${f.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ layer: "L1", ref: f.ref, keyId: f.keyId });
    if (out.length === MAX_EVIDENCE) break;
  }
  return out;
}

function keyIdsOf(facts: readonly { keyId: string }[]): string[] {
  return [...new Set(facts.map((f) => f.keyId))].sort(cmp);
}

export interface ParentEdgeResult {
  readonly edges: readonly AssertedEdge[];
  /** Spans whose `parentSpanId` has no record yet ("parent not received"); no edge is invented. */
  readonly missingParents: readonly { readonly traceId: string; readonly spanId: string }[];
}

/**
 * `parent-of` (parent span to child span, same trace; basis `otlp.parentSpanId`). Conflicting
 * records for one span ID (from different keys or not) are all kept as evidence, so a conflict
 * across keys sets `crossCredential`.
 */
export function deriveParentOfEdges(
  projectId: string,
  facts: readonly SpanFact[],
): ParentEdgeResult {
  const prj = projectOf(projectId);
  const bySpan = new Map<string, SpanFact[]>();
  for (const f of facts) {
    const k = `${f.traceId}/${f.spanId}`;
    const list = bySpan.get(k);
    if (list === undefined) bySpan.set(k, [f]);
    else list.push(f);
  }
  const edges = new Map<string, AssertedEdge>();
  const missing = new Map<string, { traceId: string; spanId: string }>();
  for (const [childKey, childFacts] of [...bySpan].sort((a, b) => cmp(a[0], b[0]))) {
    const first = childFacts[0];
    if (first === undefined) continue;
    const parents = new Set(
      childFacts.map((c) => c.parentSpanId).filter((p): p is string => p !== null),
    );
    for (const parentSpanId of [...parents].sort(cmp)) {
      if (parentSpanId === first.spanId) continue;
      const parentKey = `${first.traceId}/${parentSpanId}`;
      const parentFacts = bySpan.get(parentKey);
      if (parentFacts === undefined) {
        missing.set(childKey, { traceId: first.traceId, spanId: first.spanId });
        continue;
      }
      // The asserting records are the children that name this parent.
      const asserting = childFacts.filter((c) => c.parentSpanId === parentSpanId);
      const all = [...asserting, ...parentFacts, ...childFacts];
      const evidence = evidenceList(all);
      const keyIds = keyIdsOf(all);
      const firstRef = evidenceList(asserting)[0]?.ref ?? first.ref;
      const edgeId = deriveSwainId("edg", [
        prj,
        "parent-of",
        parentKey,
        childKey,
        "otlp.parentSpanId",
        firstRef,
      ]);
      edges.set(edgeId, {
        edgeId,
        kind: "parent-of",
        from: { type: "span", id: parentKey },
        to: { type: "span", id: childKey },
        basis: "otlp.parentSpanId",
        evidence,
        keyIds,
        crossCredential: keyIds.length > 1,
        confidence: "asserted",
      });
    }
  }
  return {
    edges: [...edges.values()].sort((a, b) => cmp(a.edgeId, b.edgeId)),
    missingParents: [...missing.values()],
  };
}

/**
 * `same-session` (run to run; grouping, never causal). Runs sharing a `(basis, value)` are linked
 * in a chain over their sorted run IDs, so `n` runs give `n - 1` edges with a stable result.
 */
export function deriveSameSessionEdges(
  projectId: string,
  facts: readonly RunSessionFact[],
): readonly AssertedEdge[] {
  const prj = projectOf(projectId);
  const groups = new Map<string, Map<string, RunSessionFact[]>>();
  for (const f of facts) {
    const gk = `${f.sessionBasis}\u0000${requireIdentity(f.session).part}`;
    let runs = groups.get(gk);
    if (runs === undefined) {
      runs = new Map();
      groups.set(gk, runs);
    }
    const list = runs.get(f.runId);
    if (list === undefined) runs.set(f.runId, [f]);
    else list.push(f);
  }
  const edges: AssertedEdge[] = [];
  for (const [gk, runs] of [...groups].sort((a, b) => cmp(a[0], b[0]))) {
    const basis = gk.slice(0, gk.indexOf("\u0000"));
    const ids = [...runs.keys()].sort(cmp);
    for (let i = 0; i + 1 < ids.length; i++) {
      const a = ids[i];
      const b = ids[i + 1];
      if (a === undefined || b === undefined) continue;
      const all = [...(runs.get(a) ?? []), ...(runs.get(b) ?? [])];
      const evidence = evidenceList(all);
      const keyIds = keyIdsOf(all);
      const edgeId = deriveSwainId("edg", [
        prj,
        "same-session",
        a,
        b,
        `attr:${basis}`,
        evidence[0]?.ref ?? "none",
      ]);
      edges.push({
        edgeId,
        kind: "same-session",
        from: { type: "run", id: a },
        to: { type: "run", id: b },
        basis: basis === "adr0002.sessionId" ? basis : `attr:${basis}`,
        evidence,
        keyIds,
        crossCredential: keyIds.length > 1,
        confidence: "asserted",
      });
    }
  }
  return edges.sort((a, b) => cmp(a.edgeId, b.edgeId));
}
