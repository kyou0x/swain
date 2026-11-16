export const PACKAGE_NAME = "@swain/model";

export type { AgentEvidence, AgentIdentity, AgentKeyBasis } from "./agent.js";
export {
  AGENT_KEY_BASES,
  AGENT_KEY_FORMATS,
  containsSwainKey,
  deriveAgentIdentity,
  isAgentIdentity,
  isAgentKeyFormat,
  normalizeKeyValue,
} from "./agent.js";
export type {
  AssertedEdge,
  EdgeEndpoint,
  EdgeEvidence,
  ParentEdgeResult,
  RunSessionFact,
  SpanFact,
} from "./edges.js";
export { deriveParentOfEdges, deriveSameSessionEdges } from "./edges.js";
export type { IdentityValue } from "./identity.js";
export {
  identityOfAdr0002,
  identityOfAttribute,
  isIdentityValue,
} from "./identity.js";
export type { SwainIdType } from "./ids.js";
export { deriveSwainId, SWAIN_ID_TYPES } from "./ids.js";
export type {
  InputAnyValue,
  InputKeyValue,
  InputLogRecord,
  InputSpan,
  PolicyInputLogs,
  PolicyInputTraces,
} from "./input.js";
export type {
  Detector,
  NormalizedSpan,
  NormalizedUsage,
  NormalizerInput,
  OperationKind,
  OperationSubtype,
} from "./normalize.js";
export { normalizeSpan, SEMCONV_PIN } from "./normalize.js";
export type { ContentPolicyInput } from "./policy/apply.js";
export {
  applyContentPolicy,
  MAX_KEPT_STRING_BYTES,
  METADATA_CAP_BYTES,
  resolvePolicy,
} from "./policy/apply.js";
export {
  CONTENT_KEY_FAMILIES,
  CONTENT_KEYS_VERSION,
  contentKeyFamily,
  isUsageKey,
  METADATA_ALLOWLIST,
  matchesSecretName,
  NORMALIZER_KEYS,
} from "./policy/content-keys.js";
export {
  POLICY_APPLIED_FORMAT,
  policyAppliedLogJson,
  policyAppliedSpanJson,
} from "./policy/serialize.js";
export { applyUrlRule, neutralizeText } from "./policy/text.js";
export type {
  EffectivePolicy,
  PolicyAppliedLog,
  PolicyAppliedLogs,
  PolicyAppliedSpan,
  PolicyAppliedTraces,
  PolicyContent,
  PolicyKeptText,
  PolicyKeyValue,
  PolicyOverDepth,
  PolicyResource,
  PolicyScope,
  PolicyText,
  PolicyValue,
  PolicyWarning,
} from "./policy/types.js";
export { isPolicyApplied } from "./policy/types.js";
export type { LogRunInput, RunKind, RunRef, SessionKeyBasis } from "./run.js";
export {
  ADR_SESSION_ID,
  deriveSessionId,
  IMPORT_ID,
  importRun,
  isRunRef,
  logsRun,
  runForLogRecord,
  SESSION_KEY,
  sessionRun,
  traceRun,
  utcDay,
} from "./run.js";
export type { RunEvidence, RunStatus, RunStatusResult, SpanStatusFact } from "./status.js";
export { computeRunStatus, DEFAULT_IDLE_WINDOW_MS, traceRunEvidence } from "./status.js";
