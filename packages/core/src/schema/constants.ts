/** Canonical event schema v0.1 constants (ADR-0002 r2.1). */

export const SCHEMA_VERSION = "0.1.0";

export const PROVIDERS = ["claude-code", "codex-cli", "gemini-cli", "opencode"] as const;

export const EVENT_KINDS = [
  "session.started",
  "session.ended",
  "turn.started",
  "turn.ended",
  "message.observed",
  "tool.requested",
  "tool.completed",
  "tool.failed",
  "agent.started",
  "agent.ended",
  "file.changed",
  "permission.requested",
  "permission.decided",
  "model.usage",
  "capture.gap",
  "source.unknown",
] as const;

export const EVENT_STATUSES = [
  "none",
  "success",
  "failure",
  "denied",
  "interrupted",
  "unknown",
] as const;

export const KIND_ALLOWED_STATUS = {
  "session.started": ["none"],
  "session.ended": ["success", "failure", "interrupted", "unknown"],
  "turn.started": ["none"],
  "turn.ended": ["success", "failure", "interrupted", "unknown"],
  "message.observed": ["none"],
  "tool.requested": ["none"],
  "tool.completed": ["success", "unknown"],
  "tool.failed": ["failure", "denied", "interrupted", "unknown"],
  "agent.started": ["none"],
  "agent.ended": ["success", "failure", "interrupted", "unknown"],
  "file.changed": ["success", "failure", "unknown"],
  "permission.requested": ["none"],
  "permission.decided": ["none"],
  "model.usage": ["none"],
  "capture.gap": ["none"],
  "source.unknown": ["none"],
} as const;

export const ACTOR_ROLES = ["user", "agent", "subagent", "runtime", "unknown"] as const;

export const FACETS = [
  "content",
  "inputs",
  "outputs",
  "timestamp",
  "actor",
  "model",
  "tokens",
  "causality",
  "internalReasoning",
] as const;

export const COMPLETENESS_STATES = [
  "captured",
  "partial",
  "absent",
  "unavailable",
  "unknown",
] as const;

export const COMPLETENESS_REASONS = [
  "provider-does-not-expose",
  "missing-in-record",
  "exceeded-bounds",
  "malformed-value",
  "correlation-missing",
  "adapter-unsupported",
] as const;

/** Every kind requires `timestamp` and `actor`; see ADR-0002 section 3. */
export const REQUIRED_FACETS_BY_KIND = {
  "session.started": ["timestamp", "actor"],
  "session.ended": ["timestamp", "actor"],
  "turn.started": ["timestamp", "actor"],
  "turn.ended": ["timestamp", "actor"],
  "message.observed": ["timestamp", "actor", "content", "internalReasoning"],
  "tool.requested": ["timestamp", "actor", "inputs", "outputs"],
  "tool.completed": ["timestamp", "actor", "inputs", "outputs"],
  "tool.failed": ["timestamp", "actor", "inputs", "outputs"],
  "agent.started": ["timestamp", "actor"],
  "agent.ended": ["timestamp", "actor"],
  "file.changed": ["timestamp", "actor"],
  "permission.requested": ["timestamp", "actor"],
  "permission.decided": ["timestamp", "actor"],
  "model.usage": ["timestamp", "actor", "model", "tokens"],
  "capture.gap": ["timestamp", "actor"],
  "source.unknown": ["timestamp", "actor"],
} as const;

export const LINK_RELS = [
  "result-of",
  "decides",
  "spawned-by",
  "ends",
  "gap-for",
  "duplicate-of",
] as const;

export const GAP_REASONS = [
  "malformed-record",
  "truncated-final-record",
  "record-too-large",
  "depth-exceeded",
  "invalid-utf8",
  "missing-result",
  "missing-start",
  "bounds-reached",
  "adapter-error",
  "adapter-output-invalid",
] as const;

export const WARNING_CODES = [
  "untested-provider-version",
  "unknown-record-type",
  "unmapped-field",
  "malformed-record",
  "record-too-large",
  "depth-exceeded",
  "invalid-utf8",
  "truncated-final-record",
  "utf8-bom",
  "timestamp-invalid",
  "timestamp-regression",
  "duplicate-native-record",
  "missing-result",
  "orphan-result",
  "bounds-reached",
  "adapter-output-invalid",
  "adapter-error",
  "empty-source",
  "blank-lines",
  "warnings-aggregated",
  "duplicate-json-key",
  "record-array-missing",
  "folded-records",
  "attribute-not-allowed",
] as const;

// Payload enums (ADR-0002 section 9).
export const SESSION_TRIGGERS = [
  "startup",
  "resume",
  "clear",
  "compact",
  "fork",
  "unknown",
] as const;
export const SESSION_END_REASONS = [
  "exit",
  "clear",
  "logout",
  "prompt-input-exit",
  "resume",
  "other",
  "unknown",
] as const;
export const MESSAGE_ROLES = ["user", "assistant", "system"] as const;
export const MESSAGE_CHANNELS = ["text", "reasoning", "notification"] as const;
export const TOOL_NAMESPACES = ["builtin", "mcp", "unknown"] as const;
export const TOOL_ERROR_CLASSES = [
  "error",
  "declined",
  "denied",
  "interrupted",
  "timeout",
  "unknown",
] as const;
export const CHANGE_KINDS = ["add", "delete", "update", "unknown"] as const;
export const FILE_CHANGE_BASES = ["provider-reported", "derived-from-tool-result"] as const;
export const PERMISSION_DECISIONS = ["allow", "deny", "ask", "unknown"] as const;
export const PERMISSION_DECIDERS = ["user", "policy", "auto-mode", "unknown"] as const;
export const USAGE_SCOPES = ["message", "turn", "session"] as const;
export const CONTENT_ENCODINGS = ["utf8", "jcs-json"] as const;
export const CONTENT_RETENTIONS = ["hash-only", "inline", "inline-truncated"] as const;
export const TIME_ORIGINS = ["source", "none"] as const;
export const TIME_STATUSES = ["valid", "missing", "invalid"] as const;
export const SOURCE_STABILITIES = [
  "documented-interface",
  "internal-unstable",
  "undocumented",
] as const;
export const CAPTURE_MODES = ["import-file", "stream-events", "live-hook"] as const;
export const IMPORT_OUTCOMES = ["complete", "partial", "failed"] as const;

export type StringRule = "rfc6901" | "no-nul" | "display-name";

export interface StringBound {
  /** Maximum (or exact, see `exact`) UTF-8 byte length. */
  readonly bytes: number;
  readonly exact: boolean;
  /** Regular expression source, or null when the row defines no pattern. */
  readonly pattern: string | null;
  readonly rule: StringRule | null;
}

const b = (
  bytes: number,
  exact: boolean,
  pattern: string | null,
  rule: StringRule | null = null,
): StringBound => ({ bytes, exact, pattern, rule });

const SLUG_PAIR = "^[a-z0-9-]+\\.[a-z0-9-]+$";

/** Mirrors the ADR-0002 section 1a table. Every string field has a row. */
export const STRING_BOUNDS = {
  schemaVersion: b(16, false, "^0\\.1\\.[0-9]{1,6}$"),
  evtId: b(36, true, "^evt_[0-9a-f]{32}$"),
  sesId: b(36, true, "^ses_[0-9a-f]{32}$"),
  trnId: b(36, true, "^trn_[0-9a-f]{32}$"),
  actId: b(36, true, "^act_[0-9a-f]{32}$"),
  srcId: b(36, true, "^src_[0-9a-f]{32}$"),
  tcId: b(35, true, "^tc_[0-9a-f]{32}$"),
  sha256: b(64, true, "^[0-9a-f]{64}$"),
  providerVersion: b(64, false, "^[!-~]{1,64}$"),
  sourceKind: b(64, false, SLUG_PAIR),
  surfaceId: b(64, false, SLUG_PAIR),
  adapterId: b(64, false, "^[a-z0-9-]+(\\.[a-z0-9-]+)+$"),
  adapterVersion: b(32, false, "^[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}(-[0-9A-Za-z.-]{1,16})?$"),
  rule: b(64, false, "^[a-z0-9-]+(\\.[a-z0-9-]+)+$"),
  pointer: b(512, false, null, "rfc6901"),
  timeValue: b(24, true, "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"),
  attributeKey: b(96, false, "^[a-z0-9-]+\\.[A-Za-z0-9_.-]{1,64}$"),
  attributeString: b(256, false, null),
  bounded256: b(256, false, null),
  bounded512: b(512, false, null),
  filePath: b(4096, false, null, "no-nul"),
  inlineContent: b(1_048_576, false, null),
  displayName: b(255, false, null, "display-name"),
  warningDetailKey: b(32, false, "^[a-zA-Z][a-zA-Z0-9]{0,31}$"),
  warningDetailString: b(256, false, null),
  issuePath: b(512, false, null, "rfc6901"),
} as const satisfies Record<string, StringBound>;

export type StringBoundName = keyof typeof STRING_BOUNDS;

/** Other structural limits (ADR-0002 section 1 and SPEC-001 section 4). */
export const LIMITS = {
  maxLinks: 16,
  maxAttributes: 32,
  maxTopLevelKeys: 32,
  maxBasisEventIds: 64,
  maxSubIndex: 1023,
  maxObjectKeys: 64,
  maxArrayLength: 64,
  maxDepth: 32,
  maxIssues: 100,
  maxEvents: 2_000_000,
  maxIssuePathSegmentCodePoints: 64,
  maxIssuePathBytes: 512,
} as const;
