/**
 * Pinned content-key list (ADR-0005 section 6.3), the secret-name rule and the metadata allowlist
 * (section 6.4). Versioned: a change to any list changes `CONTENT_KEYS_VERSION`.
 *
 * Matching is ASCII case-insensitive (a strict superset of the exact spellings in the ADR: a
 * sender cannot dodge a key by changing its case).
 */

export const CONTENT_KEYS_VERSION = "swain.content-keys/1" as const;

export interface ContentKeyFamily {
  readonly family: string;
  /** Exact keys. */
  readonly exact: readonly string[];
  /** Key prefixes (a key that starts with one of them). */
  readonly prefix: readonly string[];
  /** Keys that start with `from` and end with `to`, with at least one character between. */
  readonly between?: readonly { readonly from: string; readonly to: string }[];
}

export const CONTENT_KEY_FAMILIES: readonly ContentKeyFamily[] = [
  {
    family: "genai",
    exact: [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.result",
      "gen_ai.tool.definitions",
      "gen_ai.tool.description",
    ],
    // `gen_ai.prompt*` and `gen_ai.completion*` (legacy).
    prefix: ["gen_ai.prompt", "gen_ai.completion"],
  },
  {
    family: "openinference",
    exact: ["input.value", "output.value", "tool.parameters", "metadata"],
    prefix: [
      "llm.input_messages.",
      "llm.output_messages.",
      "llm.prompts",
      "llm.prompt_template.",
      "llm.tools.",
      "retrieval.documents.",
      "reranker.",
    ],
    between: [{ from: "embedding.", to: ".text" }],
  },
  {
    family: "vercel-ai",
    exact: ["ai.toolCall.args", "ai.toolCall.result"],
    prefix: ["ai.prompt", "ai.response."],
  },
  {
    family: "traceloop",
    exact: ["traceloop.entity.input", "traceloop.entity.output"],
    prefix: [],
  },
  {
    family: "general",
    exact: [
      "exception.message",
      "exception.stacktrace",
      "db.statement",
      "db.query.text",
      "process.command_line",
      "process.command_args",
    ],
    prefix: [],
  },
  {
    family: "claude-code",
    // `prompt`, `tool_input`, `tool_parameters` are in CC-T section 1. The rest are UNVERIFIED
    // guesses for "other attributes that carry user, model or tool text" (ADR-0005 section 6.3);
    // being wrong only hides a metadata string.
    exact: [
      "prompt",
      "tool_input",
      "tool_parameters",
      "tool_response",
      "tool_output",
      "tool_content",
      "response",
      "response_text",
      "raw_api_body",
      "request_body",
      "response_body",
      "last_assistant_message",
    ],
    prefix: [],
  },
  {
    family: "adk-legacy",
    // All of `gcp.vertex.agent.*`; the ID allowlist is empty until a sample confirms spellings.
    exact: [],
    prefix: ["gcp.vertex.agent."],
  },
];

/** Exceptions inside a content family (ADK ID allowlist); empty by design, see ADR-0005 6.3. */
export const CONTENT_KEY_EXCEPTIONS: readonly string[] = [];

/**
 * Claude Code event records (CONSERVATIVE UNTIL A CC FIXTURE confirms attribute names, ADR-0005
 * section 6.3): on every record whose `eventName` or `event.name` starts with `claude_code.` (or is
 * the bare `api_error`), every string, array, map and bytes attribute is content, except the keys
 * below. Numbers and booleans are always kept.
 */
export const CLAUDE_EVENT_PREFIX = "claude_code.";
export const CLAUDE_BARE_EVENT_NAMES: readonly string[] = ["api_error"];
export const CLAUDE_CORRELATION_KEYS: readonly string[] = [
  "session.id",
  "prompt.id",
  "event.sequence",
  "event.name",
  "event.timestamp",
  "user.id",
  "organization.id",
  "user.account_uuid",
  "terminal.type",
  "app.version",
  "model",
  "tool_name",
  "tool_use_id",
  "success",
  "decision",
  "decision_type",
  "source",
  "tool_source",
  "error_type",
  "request_id",
  "status_code",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "duration_ms",
];

/**
 * Keys whose value is an identity or grouping component: the applier records an `identity` part
 * for them, computed from the UNMASKED value (ADR-0005 section 3 note).
 */
export const IDENTITY_KEYS: readonly string[] = [
  "gen_ai.agent.id",
  "gen_ai.agent.name",
  "agent.name",
  "service.name",
  "service.namespace",
  "session.id",
  "gen_ai.conversation.id",
];
const IDENTITY_SET = new Set(IDENTITY_KEYS);
export const isIdentityKey = (key: string): boolean => IDENTITY_SET.has(key);

const lower = (s: string): string => s.toLowerCase();

const EXACT = new Map<string, string>();
const PREFIX: { readonly p: string; readonly family: string }[] = [];
const BETWEEN: { readonly from: string; readonly to: string; readonly family: string }[] = [];
for (const f of CONTENT_KEY_FAMILIES) {
  for (const k of f.exact) EXACT.set(lower(k), f.family);
  for (const p of f.prefix) PREFIX.push({ p: lower(p), family: f.family });
  for (const b of f.between ?? []) {
    BETWEEN.push({ from: lower(b.from), to: lower(b.to), family: f.family });
  }
}
const EXCEPTIONS = new Set(CONTENT_KEY_EXCEPTIONS.map(lower));

/** The family of a content key (ADR-0005 section 6.3), or `null`. */
export function contentKeyFamily(key: string): string | null {
  const k = lower(key);
  if (EXCEPTIONS.has(k)) return null;
  const e = EXACT.get(k);
  if (e !== undefined) return e;
  for (const { p, family } of PREFIX) if (k.startsWith(p)) return family;
  for (const { from, to, family } of BETWEEN) {
    if (k.length > from.length + to.length && k.startsWith(from) && k.endsWith(to)) return family;
  }
  return null;
}

const SECRET_NAME_RE =
  /(authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|signature)/i;

/** The secret-name rule (ADR-0005 section 6.4), before the usage-key exemption. */
export function matchesSecretName(key: string): boolean {
  if (SECRET_NAME_RE.test(key)) return true;
  const k = lower(key);
  if (k.startsWith("http.request.header.") || k.startsWith("http.response.header.")) return true;
  return k.startsWith("rpc.") && k.includes(".metadata.");
}

/** Pinned numeric usage keys (ADR-0005 section 6.2): `*.usage.*tokens`, `llm.token_count.*`, ... */
export function isUsageKey(key: string): boolean {
  const k = lower(key);
  if (k === "gen_ai.request.max_tokens") return true;
  if (k.startsWith("llm.token_count.")) return true;
  const at = k.indexOf(".usage.");
  return at > 0 && k.endsWith("tokens");
}

/**
 * Keys the normalizer reads. They are compared before redaction (ADR-0005 section 6.2), so a
 * pinned key is never rewritten by the masker, and they are always on the metadata allowlist.
 */
export const NORMALIZER_KEYS: readonly string[] = [
  "gen_ai.operation.name",
  "openinference.span.kind",
  "gen_ai.provider.name",
  "gen_ai.system",
  "llm.provider",
  "llm.system",
  "gen_ai.request.model",
  "llm.model_name",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
  "gen_ai.usage.cache_read.input_tokens",
  "llm.token_count.prompt_details.cache_read",
  "gen_ai.usage.cache_write.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
  "llm.token_count.prompt_details.cache_write",
  "gen_ai.usage.reasoning.output_tokens",
  "llm.token_count.completion_details.reasoning",
  "gen_ai.tool.name",
  "tool.name",
  "gen_ai.tool.call.id",
  "gen_ai.agent.id",
  "gen_ai.agent.name",
  "agent.name",
  "session.id",
  "gen_ai.conversation.id",
  "service.name",
  "service.namespace",
  "gen_ai.transfer.target.name",
  "gen_ai.transfer.mode",
];

/** Pinned metadata allowlist for `metadataPolicy: "allowlist"` (ADR-0005 section 6.2). */
export const METADATA_ALLOWLIST: readonly string[] = [
  ...NORMALIZER_KEYS,
  "service.version",
  "service.instance.id",
  "telemetry.sdk.name",
  "telemetry.sdk.language",
  "telemetry.sdk.version",
  "error.type",
  "exception.type",
  "http.request.method",
  "http.response.status_code",
  "http.route",
  "rpc.system",
  "rpc.method",
  "server.port",
  "url.scheme",
  "event.name",
  "event.sequence",
  "prompt.id",
  "user.id",
  "organization.id",
  "gen_ai.response.finish_reasons",
  "gen_ai.response.id",
  "gen_ai.request.max_tokens",
  "gen_ai.request.temperature",
  "gen_ai.output.type",
];

const NORMALIZER_SET = new Set(NORMALIZER_KEYS);
const ALLOW_SET = new Set(METADATA_ALLOWLIST);
export const isNormalizerKey = (key: string): boolean => NORMALIZER_SET.has(key);
export const isAllowlistedKey = (key: string): boolean => ALLOW_SET.has(key);
