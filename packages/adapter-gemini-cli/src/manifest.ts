import type {
  AdapterManifest,
  DetectResult,
  FramedRecord,
  JsonValue,
  ProviderCapabilities,
} from "@swain/core";
import { MESSAGE_TYPES } from "./fold.js";
import { boundedId, isArr, isObj, own, ownStr } from "./util.js";

export const ADAPTER_VERSION = "0.1.0";

/**
 * Neither Gemini surface is listed in docs/architecture/capability-matrix.json (only hooks,
 * telemetry and an undocumented `transcript`), so every cell is `unknown` (M12, M-16).
 * What the mapping supports once a maintainer adds the surfaces to the matrix (L-MATRIX):
 * sessionLifecycle partial (header only, no end marker), toolCallInputs available,
 * toolCallOutputs available, llmMetadata partial (model + tokens on gemini messages),
 * filePatches partial, subagents unknown, permissions unknown, failures partial,
 * timestamps available, tokens partial. None of this is fixture-verified.
 */
export const CAPABILITIES: ProviderCapabilities = Object.freeze({
  sessionLifecycle: "unknown",
  toolCallInputs: "unknown",
  toolCallOutputs: "unknown",
  llmMetadata: "unknown",
  filePatches: "unknown",
  subagents: "unknown",
  permissions: "unknown",
  failures: "unknown",
  timestamps: "unknown",
  tokens: "unknown",
});

/** PA-3 allowlist: scalars only, closed vocabularies or integers. */
export const ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  "gemini-cli.message_type",
  "gemini-cli.tool_status",
  "gemini-cli.thought_index",
  "gemini-cli.thought_source",
]);

export function baseManifest(
  id: "gemini-cli.chat-jsonl" | "gemini-cli.chat-json",
  framing: AdapterManifest["framing"],
): AdapterManifest {
  return {
    id,
    adapterVersion: ADAPTER_VERSION,
    provider: "gemini-cli",
    sourceKind: id,
    // Undocumented chat recording files (matrix: `gemini-cli.transcript` is `undocumented`).
    sourceStability: "undocumented",
    captureModes: ["import-file"],
    testedProviderVersions: [],
    capabilities: CAPABILITIES,
    framing,
    experimental: true,
    attributeKeys: ATTRIBUTE_KEYS,
  };
}

const HASH = /^[0-9a-f]{64}$/;

export const NO_MATCH = (reason: string): DetectResult => ({
  verdict: "no-match",
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [reason],
});

/** `sessionId` + 64-hex `projectHash` strings; the discriminator shared by header and envelope. */
export function headerLike(v: JsonValue | undefined): v is { readonly [key: string]: JsonValue } {
  if (!isObj(v)) return false;
  const h = ownStr(v, "projectHash");
  return typeof own(v, "sessionId") === "string" && h !== undefined && HASH.test(h);
}

export function matchResult(v: { readonly [key: string]: JsonValue }): DetectResult {
  return {
    verdict: "match",
    providerVersionSeen: null,
    nativeSessionId: boundedId(own(v, "sessionId")),
    reasons: ["gemini-header"],
  };
}

export function isMessageLike(r: FramedRecord | undefined): boolean {
  if (r === undefined || !r.parse.ok) return false;
  const v = r.parse.value;
  return (
    isObj(v) &&
    typeof own(v, "id") === "string" &&
    (MESSAGE_TYPES as readonly string[]).includes(ownStr(v, "type") ?? "")
  );
}

export function hasArray(v: { readonly [key: string]: JsonValue }, key: string): boolean {
  return isArr(own(v, key));
}
