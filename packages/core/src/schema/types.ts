import type { AdapterWarning } from "../adapter/contract.js";
import type {
  ACTOR_ROLES,
  CAPTURE_MODES,
  CHANGE_KINDS,
  COMPLETENESS_REASONS,
  COMPLETENESS_STATES,
  CONTENT_ENCODINGS,
  CONTENT_RETENTIONS,
  EVENT_KINDS,
  FACETS,
  FILE_CHANGE_BASES,
  GAP_REASONS,
  IMPORT_OUTCOMES,
  LINK_RELS,
  MESSAGE_CHANNELS,
  MESSAGE_ROLES,
  PERMISSION_DECIDERS,
  PERMISSION_DECISIONS,
  PROVIDERS,
  SESSION_END_REASONS,
  SESSION_TRIGGERS,
  SOURCE_STABILITIES,
  TOOL_ERROR_CLASSES,
  TOOL_NAMESPACES,
  USAGE_SCOPES,
} from "./constants.js";

export type Provider = (typeof PROVIDERS)[number];
export type EventKind = (typeof EVENT_KINDS)[number];
export type ActorRole = (typeof ACTOR_ROLES)[number];
export type Facet = (typeof FACETS)[number];
export type CompletenessState = (typeof COMPLETENESS_STATES)[number];
export type CompletenessReason = (typeof COMPLETENESS_REASONS)[number];
export type LinkRel = (typeof LINK_RELS)[number];
export type GapReason = (typeof GAP_REASONS)[number];
export type SourceStability = (typeof SOURCE_STABILITIES)[number];
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type Hex64 = string;
export type EvtId = `evt_${string}`;
export type SesId = `ses_${string}`;
export type TrnId = `trn_${string}`;
export type ActId = `act_${string}`;
export type SrcId = `src_${string}`;
export type TcId = `tc_${string}`;

export interface EventTime {
  value: string | null;
  origin: "source" | "none";
  status: "valid" | "missing" | "invalid";
}

export interface Actor {
  actorId: ActId;
  role: ActorRole;
}

export interface FacetCompleteness {
  state: CompletenessState;
  reason?: CompletenessReason;
}
export type Completeness = Partial<Record<Facet, FacetCompleteness>>;

export interface Link {
  rel: LinkRel;
  target: EvtId;
}

export type AttributeValue = string | number | boolean | null;
export type Attributes = Record<string, AttributeValue>;

export interface AdapterRef {
  id: string;
  version: string;
}

export interface RecordProvenance {
  type: "record";
  sourceId: SrcId;
  line: number;
  byteOffset: number;
  byteLength: number;
  sha256: Hex64;
  pointer: string | null;
  adapter: AdapterRef;
}

export interface DerivedProvenance {
  type: "derived";
  sourceId: SrcId;
  rule: string;
  basisEventIds: EvtId[];
  adapter: AdapterRef;
}

export type Provenance = RecordProvenance | DerivedProvenance;

/**
 * A type alias, not an interface: object literal types are assignable to the `JsonValue` index
 * signature, so adapters can put a `ContentRef` into a draft payload without a cast.
 */
export type ContentRef = {
  sha256: Hex64;
  byteLength: number;
  encoding: (typeof CONTENT_ENCODINGS)[number];
  retention: (typeof CONTENT_RETENTIONS)[number];
  inline?: string;
  redactionCount?: number;
};

// Payloads (ADR-0002 section 9).
export interface SessionStartedPayload {
  nativeSessionId: string | null;
  trigger: (typeof SESSION_TRIGGERS)[number];
}
export interface SessionEndedPayload {
  reason: (typeof SESSION_END_REASONS)[number];
}
export interface TurnStartedPayload {
  prompt: ContentRef | null;
}
export type TurnEndedPayload = Record<string, never>;
export interface MessageObservedPayload {
  role: (typeof MESSAGE_ROLES)[number];
  channel: (typeof MESSAGE_CHANNELS)[number];
  content: ContentRef;
}
export interface ToolRequestedPayload {
  toolCallId: TcId | null;
  toolName: string;
  toolNamespace: (typeof TOOL_NAMESPACES)[number];
  mcpServer?: string;
  input: ContentRef | null;
}
export interface ToolCompletedPayload {
  toolCallId: TcId | null;
  toolName: string | null;
  output: ContentRef | null;
  exitCode?: number;
  durationMs?: number;
}
export interface ToolFailedPayload extends ToolCompletedPayload {
  error: ContentRef | null;
  errorClass: (typeof TOOL_ERROR_CLASSES)[number];
}
export interface AgentStartedPayload {
  agentActorId: ActId;
  parentActorId: ActId | null;
  agentType: string | null;
  spawnedByToolCallId: TcId | null;
}
export interface AgentEndedPayload {
  agentActorId: ActId;
}
export interface FileChangedPayload {
  path: string;
  changeKind: (typeof CHANGE_KINDS)[number];
  diff: ContentRef | null;
  viaToolCallId: TcId | null;
  basis: (typeof FILE_CHANGE_BASES)[number];
}
export interface PermissionRequestedPayload {
  toolName: string | null;
  toolCallId: TcId | null;
  input: ContentRef | null;
}
export interface PermissionDecidedPayload {
  decision: (typeof PERMISSION_DECISIONS)[number];
  decidedBy: (typeof PERMISSION_DECIDERS)[number];
  reason: ContentRef | null;
}
export interface ModelUsagePayload {
  scope: (typeof USAGE_SCOPES)[number];
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  costUsdEstimate?: number;
}
export interface CaptureGapPayload {
  reason: GapReason;
  detail: string;
  fromSequence?: number;
  toSequence?: number;
}
export interface SourceUnknownPayload {
  nativeType: string | null;
  topLevelKeys: string[];
  recordSha256: Hex64;
}

export interface EnvelopeBase {
  schemaVersion: string;
  eventId: EvtId;
  provider: Provider;
  providerVersion: string | null;
  sourceKind: string;
  sessionId: SesId;
  turnId: TrnId | null;
  sourceSequence: number;
  subIndex: number;
  time: EventTime;
  actor: Actor;
  links: Link[];
  provenance: Provenance;
  completeness: Completeness;
  attributes: Attributes;
}

interface Ev<K extends EventKind, S extends string, P> extends EnvelopeBase {
  kind: K;
  status: S;
  payload: P;
}

type EndStatus = "success" | "failure" | "interrupted" | "unknown";

/** Discriminated union on `kind`; `status` is constrained per kind (ADR-0002 section 3). */
export type CanonicalEvent =
  | Ev<"session.started", "none", SessionStartedPayload>
  | Ev<"session.ended", EndStatus, SessionEndedPayload>
  | Ev<"turn.started", "none", TurnStartedPayload>
  | Ev<"turn.ended", EndStatus, TurnEndedPayload>
  | Ev<"message.observed", "none", MessageObservedPayload>
  | Ev<"tool.requested", "none", ToolRequestedPayload>
  | Ev<"tool.completed", "success" | "unknown", ToolCompletedPayload>
  | Ev<"tool.failed", "failure" | "denied" | "interrupted" | "unknown", ToolFailedPayload>
  | Ev<"agent.started", "none", AgentStartedPayload>
  | Ev<"agent.ended", EndStatus, AgentEndedPayload>
  | Ev<"file.changed", "success" | "failure" | "unknown", FileChangedPayload>
  | Ev<"permission.requested", "none", PermissionRequestedPayload>
  | Ev<"permission.decided", "none", PermissionDecidedPayload>
  | Ev<"model.usage", "none", ModelUsagePayload>
  | Ev<"capture.gap", "none", CaptureGapPayload>
  | Ev<"source.unknown", "none", SourceUnknownPayload>;

export interface SourceDescriptor {
  sourceId: SrcId;
  provider: Provider;
  sourceKind: string;
  sourceStability: SourceStability;
  sha256: Hex64;
  byteLength: number;
  recordCount: number;
  blankLineCount: number;
  displayName: string;
}

export interface ImportStats {
  records: number;
  blankLines: number;
  eventsByKind: Partial<Record<EventKind, number>>;
  gaps: number;
  unknowns: number;
  derived: number;
  /** Records accounted for by a `RecordDisposition` rather than an event. */
  folded: number;
}

export interface ImportResult {
  source: SourceDescriptor;
  events: CanonicalEvent[];
  warnings: AdapterWarning[];
  stats: ImportStats;
  outcome: (typeof IMPORT_OUTCOMES)[number];
}
