/**
 * Span normalizer, N1 subset (ADR-0005 section 7.3). Reads ONLY post-policy attributes:
 * the parameter type has no `name` and no `kind`, so a span cannot be classified by either
 * (OTF section 1). Spans without a recognised detector are `generic`, never dropped.
 *
 * Pin: the conventions are at Development status. `SEMCONV_PIN` is the identifier of the reviewed
 * name set; the upstream commit SHA is recorded by the N3 slice (ADR-0005 section 7.3).
 */
import type { PolicyKeyValue, PolicyValue } from "./policy/types.js";

export const SEMCONV_PIN = "swain.semconv-genai/n1-names-2026-11-16" as const;

export type OperationKind = "llm" | "tool" | "agent" | "workflow" | "handoff" | "generic";
export type OperationSubtype = "embeddings" | "retrieval" | "create_agent" | null;

export interface Detector {
  readonly basis: "gen_ai.operation.name" | "openinference.span.kind" | "none";
  readonly value: string | null;
}

export interface NormalizedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly reasoningTokens: number | null;
  /** input + output, only when both are present. Computed, not reported (OTF section 1). */
  readonly totalTokensComputed: number | null;
}

export interface NormalizedSpan {
  readonly operation: OperationKind;
  readonly subtype: OperationSubtype;
  readonly detector: Detector;
  readonly provider: string | null;
  readonly requestModel: string | null;
  readonly responseModel: string | null;
  readonly usage: NormalizedUsage;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  /** Which attribute key supplied each field, in field order (ADR-0005 section 7.3, `normBasis`). */
  readonly normBasis: readonly { readonly field: string; readonly key: string }[];
}

/** The only part of a span the normalizer may read. */
export interface NormalizerInput {
  readonly attributes: readonly PolicyKeyValue[];
}

const GENAI_OPERATIONS: Readonly<Record<string, readonly [OperationKind, OperationSubtype]>> = {
  chat: ["llm", null],
  generate_content: ["llm", null],
  text_completion: ["llm", null],
  embeddings: ["llm", "embeddings"],
  retrieval: ["llm", "retrieval"],
  invoke_agent: ["agent", null],
  create_agent: ["agent", "create_agent"],
  execute_tool: ["tool", null],
  invoke_workflow: ["workflow", null],
  invoke_runner: ["workflow", null],
  plan: ["workflow", null],
};

const OPENINFERENCE_KINDS: Readonly<Record<string, readonly [OperationKind, OperationSubtype]>> = {
  LLM: ["llm", null],
  AGENT: ["agent", null],
  TOOL: ["tool", null],
  CHAIN: ["workflow", null],
  EMBEDDING: ["llm", "embeddings"],
  RETRIEVER: ["llm", "retrieval"],
};

const PROVIDER_KEYS = ["gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system"];
const REQUEST_MODEL_KEYS = ["gen_ai.request.model", "llm.model_name"];
const RESPONSE_MODEL_KEYS = ["gen_ai.response.model"];
const INPUT_TOKEN_KEYS = [
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.prompt_tokens",
  "llm.token_count.prompt",
];
const OUTPUT_TOKEN_KEYS = [
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.completion_tokens",
  "llm.token_count.completion",
];
const CACHE_READ_KEYS = [
  "gen_ai.usage.cache_read.input_tokens",
  "llm.token_count.prompt_details.cache_read",
];
const CACHE_WRITE_KEYS = [
  "gen_ai.usage.cache_write.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
  "llm.token_count.prompt_details.cache_write",
];
const REASONING_KEYS = [
  "gen_ai.usage.reasoning.output_tokens",
  "llm.token_count.completion_details.reasoning",
];
const TOOL_NAME_KEYS = ["gen_ai.tool.name", "tool.name"];
const TOOL_CALL_ID_KEYS = ["gen_ai.tool.call.id"];

function textValue(v: PolicyValue): string | null {
  return v.kind === "text" && v.value !== "" ? v.value : null;
}

function tokenValue(v: PolicyValue): number | null {
  if (v.kind === "int") {
    if (v.value < 0n || v.value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(v.value);
  }
  if (v.kind === "double") {
    return Number.isSafeInteger(v.value) && v.value >= 0 ? v.value : null;
  }
  // A usage key with a digit-only string stays metadata under the policy (ADR-0005 section 6.2).
  if (v.kind === "text" && /^[0-9]{1,15}$/.test(v.value)) return Number(v.value);
  return null;
}

class Lookup {
  readonly basis: { field: string; key: string }[] = [];
  private readonly attrs: readonly PolicyKeyValue[];
  constructor(attrs: readonly PolicyKeyValue[]) {
    this.attrs = attrs;
  }

  /** The first usable value under the alias list, in precedence order (current names first). */
  pick<T>(field: string, keys: readonly string[], read: (v: PolicyValue) => T | null): T | null {
    for (const key of keys) {
      const kv = this.attrs.find((a) => a.key === key);
      if (kv === undefined) continue;
      const v = read(kv.value);
      if (v !== null) {
        this.basis.push({ field, key });
        return v;
      }
    }
    return null;
  }

  text(key: string): string | null {
    const kv = this.attrs.find((a) => a.key === key);
    return kv === undefined ? null : textValue(kv.value);
  }

  hasPrefix(prefix: string): boolean {
    return this.attrs.some((a) => a.key.startsWith(prefix));
  }
}

/** Classify and extract. Detector precedence: `gen_ai.operation.name`, then `openinference.span.kind`. */
export function normalizeSpan(span: NormalizerInput): NormalizedSpan {
  const look = new Lookup(span.attributes);

  let operation: OperationKind = "generic";
  let subtype: OperationSubtype = null;
  let detector: Detector = { basis: "none", value: null };
  const op = look.text("gen_ai.operation.name");
  const oi = look.text("openinference.span.kind");
  const byGenAi = op === null ? undefined : GENAI_OPERATIONS[op];
  const byOi = oi === null ? undefined : OPENINFERENCE_KINDS[oi];
  if (op !== null && byGenAi !== undefined && Object.hasOwn(GENAI_OPERATIONS, op)) {
    [operation, subtype] = byGenAi;
    detector = { basis: "gen_ai.operation.name", value: op };
    // `gen_ai.transfer.*` on a tool call is explicit handoff evidence (ADR-0005 section 7.3).
    if (operation === "tool" && look.hasPrefix("gen_ai.transfer.")) operation = "handoff";
  } else if (oi !== null && byOi !== undefined && Object.hasOwn(OPENINFERENCE_KINDS, oi)) {
    [operation, subtype] = byOi;
    detector = { basis: "openinference.span.kind", value: oi };
  }

  const provider = look.pick("provider", PROVIDER_KEYS, textValue);
  const requestModel = look.pick("requestModel", REQUEST_MODEL_KEYS, textValue);
  const responseModel = look.pick("responseModel", RESPONSE_MODEL_KEYS, textValue);
  const inputTokens = look.pick("inputTokens", INPUT_TOKEN_KEYS, tokenValue);
  const outputTokens = look.pick("outputTokens", OUTPUT_TOKEN_KEYS, tokenValue);
  const cacheReadTokens = look.pick("cacheReadTokens", CACHE_READ_KEYS, tokenValue);
  const cacheWriteTokens = look.pick("cacheWriteTokens", CACHE_WRITE_KEYS, tokenValue);
  const reasoningTokens = look.pick("reasoningTokens", REASONING_KEYS, tokenValue);
  const toolName = look.pick("toolName", TOOL_NAME_KEYS, textValue);
  const toolCallId = look.pick("toolCallId", TOOL_CALL_ID_KEYS, textValue);

  return {
    operation,
    subtype,
    detector,
    provider,
    requestModel,
    responseModel,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokensComputed:
        inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    },
    toolName,
    toolCallId,
    normBasis: look.basis,
  };
}
