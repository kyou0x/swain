import type {
  AdapterRegistration,
  DetectResult,
  FramedRecord,
  ParseContext,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import { ClaudeParser, TRANSCRIPT_ATTRIBUTE_KEYS } from "./parser.js";
import { bound, get, getStr, isObj, versionOrNull } from "./util.js";

const NO = (reason: string): DetectResult => ({
  verdict: "no-match",
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [reason],
});

/**
 * COMMUNITY raw-line shape (FORMAT-claude B.3). A match needs a camelCase message line
 * (`uuid` + `sessionId`) or a `summary` line with `leafUuid`. snake_case stream keys, a
 * `payload` envelope or a dotted type veto it.
 */
export function detectTranscript(sample: readonly FramedRecord[]): DetectResult {
  let strong = false;
  let version: string | null = null;
  let sid: string | null = null;
  let parsed = 0;
  for (const rec of sample) {
    if (!rec.parse.ok) continue;
    const v = rec.parse.value;
    // stray non-object lines are tolerated; they never count as evidence
    if (!isObj(v)) continue;
    parsed++;
    if (
      Object.hasOwn(v, "session_id") ||
      Object.hasOwn(v, "parent_tool_use_id") ||
      Object.hasOwn(v, "claude_code_version") ||
      Object.hasOwn(v, "payload")
    ) {
      return NO("foreign-shape");
    }
    const type = getStr(v, "type");
    if (type === undefined) continue;
    if (type.includes(".")) return NO("foreign-shape");
    const sessionId = getStr(v, "sessionId");
    if (
      (type === "user" || type === "assistant") &&
      sessionId !== undefined &&
      typeof get(v, "uuid") === "string"
    ) {
      strong = true;
      sid = sid ?? bound(sessionId);
      version = version ?? versionOrNull(get(v, "version"));
    } else if (
      type === "summary" &&
      typeof get(v, "leafUuid") === "string" &&
      typeof get(v, "summary") === "string"
    ) {
      strong = true;
    }
  }
  if (parsed === 0) return NO("no-parseable-record");
  if (!strong) return NO("no-transcript-signal");
  return {
    verdict: "match",
    providerVersionSeen: version,
    nativeSessionId: sid,
    reasons: ["transcript-shape"],
  };
}

/**
 * EXPERIMENTAL: the on-disk transcript is documented as internal and changing. The matrix lists
 * `claude-code.transcript-jsonl` only under `timestamps` (value `unknown`), so every cell is
 * `unknown`. Would claim after L-MATRIX: toolCallInputs, toolCallOutputs, llmMetadata, tokens,
 * subagents `partial`; sessionLifecycle stays `unknown` (no session start or end records).
 */
export const transcriptAdapter: SourceAdapter = {
  manifest: {
    id: "claude-code.transcript-jsonl",
    adapterVersion: "0.1.0",
    provider: "claude-code",
    sourceKind: "claude-code.transcript-jsonl",
    sourceStability: "internal-unstable",
    captureModes: ["import-file"],
    testedProviderVersions: [],
    capabilities: {
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
    },
    framing: { kind: "jsonl" },
    experimental: true,
    attributeKeys: TRANSCRIPT_ATTRIBUTE_KEYS,
  },
  detect: detectTranscript,
  createParser(ctx: ParseContext): RecordParser {
    return new ClaudeParser("transcript", ctx);
  },
};

export const transcriptRegistration: AdapterRegistration = {
  adapter: transcriptAdapter,
  discovery: {
    roots: [{ base: "home", segments: [".claude", "projects"] }],
    fileNamePattern: "^[0-9a-fA-F-]{36}\\.jsonl$",
  },
};
