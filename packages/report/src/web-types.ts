/**
 * View models of the server-rendered Swain pages (SPEC-003 N1.6, ADR-0008). The server maps stored
 * rows to these shapes; the renderers escape every string, validate every ID and never see a store.
 * Everything here is data, never markup.
 */

export type RunStatusName = "active" | "idle" | "ended" | "incomplete";

/** One credential (ingest key) that delivered records, with the label and pin the administrator set. */
export interface CredentialView {
  readonly keyId: string;
  readonly label: string | null;
  readonly agentName: string | null;
  readonly records: number;
}

/** What every server page needs besides its own data. */
export interface WebNav {
  /** The logout form token (`hex64`), or null when no form is shown. */
  readonly csrf: string | null;
  /** Server clock, shown as "as of". */
  readonly nowMs: number;
}

export interface FleetRowView {
  readonly agentId: string;
  readonly displayName: string;
  readonly keyBasis: string;
  readonly status: RunStatusName;
  readonly error: boolean;
  readonly lastSeenMs: number;
  readonly runCount: number;
  readonly credentials: readonly CredentialView[];
}

export interface ProjectView {
  readonly slug: string;
  readonly name: string;
  readonly contentPolicy: string;
}

export interface FleetView {
  readonly project: ProjectView;
  readonly projectSlugs: readonly string[];
  readonly sort: "recent" | "name";
  readonly rows: readonly FleetRowView[];
  readonly total: number;
}

export interface RunRowView {
  readonly runId: string;
  readonly kind: "trace" | "session" | "import" | "logs";
  readonly agentId: string;
  readonly agentName: string;
  readonly status: RunStatusName;
  readonly error: boolean;
  readonly firstReceivedMs: number;
  readonly lastReceivedMs: number;
  /** Closed keys: `spans`, `events`, `logs`. */
  readonly counts: Readonly<Record<string, number>>;
  readonly credentials: readonly CredentialView[];
}

export interface AgentPageView {
  readonly project: ProjectView;
  readonly agent: FleetRowView & { readonly firstSeenMs: number };
  readonly runs: readonly RunRowView[];
}

export interface RunsListView {
  readonly project: ProjectView;
  readonly projectSlugs: readonly string[];
  readonly rows: readonly RunRowView[];
  readonly total: number;
}

/** The header shared by event-backed and span-backed run pages (ADR-0008 section 2). */
export interface RunHeader {
  readonly runId: string;
  readonly kind: "trace" | "session" | "import" | "logs";
  readonly agentId: string;
  readonly agentName: string;
  readonly status: RunStatusName;
  readonly error: boolean;
  readonly late: boolean;
  readonly traceId: string | null;
  readonly sessionKey: string | null;
  readonly contentPolicy: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly credentials: readonly CredentialView[];
  readonly firstReceivedMs: number;
  readonly lastReceivedMs: number;
}

/** A stored string or content reference, flattened for display. Never carries markup. */
export type TextView =
  | { readonly kind: "text"; readonly value: string; readonly masked: boolean }
  | {
      readonly kind: "content";
      readonly sha256: string;
      readonly byteLength: number;
      readonly inline: string | null;
    }
  | { readonly kind: "scalar"; readonly value: string }
  | {
      readonly kind: "omitted";
      readonly label: "array" | "map" | "over-depth";
      readonly size: number;
    };

export interface AttrView {
  readonly key: string;
  readonly keyAltered: boolean;
  readonly value: TextView;
}

export interface SpanEventView {
  readonly name: TextView;
  readonly timeNs: bigint | null;
  readonly attributes: readonly AttrView[];
}

export interface SpanRowView {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: TextView;
  readonly kind: number;
  readonly startNs: bigint | null;
  readonly endNs: bigint | null;
  readonly statusCode: number;
  readonly statusMessage: TextView | null;
  readonly opClass: string;
  readonly keyId: string;
  readonly canonical: boolean;
  readonly late: boolean;
  readonly attributes: readonly AttrView[];
  readonly events: readonly SpanEventView[];
  /** The span's own agent (`agt_` ID). Optional: views built without ownership show "unknown agent". */
  readonly agentId?: string;
  /**
   * The agent of the nearest enclosing `agent`-class span, found by the server through trusted
   * same-credential spans only; null when there is none. Computed by the server, never here.
   */
  readonly ownerAgentId?: string | null;
  /** For an agent span: the owner of its parent span under the same rule (the parent agent). */
  readonly parentOwnerAgentId?: string | null;
}

export interface AgentNameView {
  readonly agentId: string;
  readonly name: string;
}

export interface SpanConflictView {
  readonly spanId: string;
  readonly keyId: string;
  readonly canonicalKeyId: string;
  readonly relation: "identical-same-key" | "identical-other-key" | "conflicting";
}

export interface SpanRunView {
  readonly run: RunHeader;
  readonly spans: readonly SpanRowView[];
  readonly conflicts: readonly SpanConflictView[];
  readonly truncated: boolean;
  /** Names for the agent IDs in `spans`. */
  readonly agents?: readonly AgentNameView[];
}

/** Static page messages (never echo input). */
export type WebMessageCode =
  | "signin-required"
  | "not-found"
  | "csrf"
  | "bad-request"
  | "method-not-allowed"
  | "rate-limited"
  | "busy"
  | "internal"
  | "misdirected"
  | "too-large";
