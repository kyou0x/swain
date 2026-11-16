import type {
  AdapterRegistration,
  DetectResult,
  FramedRecord,
  ParseContext,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import { ClaudeParser, STREAM_ATTRIBUTE_KEYS } from "./parser.js";
import { bound, get, getStr, isObj, versionOrNull } from "./util.js";

const NO = (reason: string): DetectResult => ({
  verdict: "no-match",
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [reason],
});

const STREAM_TYPES = new Set(["system", "assistant", "user", "result", "stream_event"]);

/**
 * Conservative detection: a documented stream-json shape needs snake_case `session_id`
 * evidence on init, result, or a message line carrying `parent_tool_use_id`. Any camelCase
 * transcript key, any Codex-style `payload` envelope or dotted exec type vetoes the match.
 */
export function detectStreamJson(sample: readonly FramedRecord[]): DetectResult {
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
      Object.hasOwn(v, "sessionId") ||
      Object.hasOwn(v, "parentUuid") ||
      Object.hasOwn(v, "isSidechain") ||
      Object.hasOwn(v, "leafUuid") ||
      Object.hasOwn(v, "payload")
    ) {
      return NO("foreign-shape");
    }
    const type = getStr(v, "type");
    if (type?.includes(".")) return NO("foreign-shape");
    if (type === undefined || !STREAM_TYPES.has(type)) continue;
    const sessionId = getStr(v, "session_id");
    if (type === "system") {
      if (
        getStr(v, "subtype") === "init" &&
        sessionId !== undefined &&
        typeof get(v, "claude_code_version") === "string"
      ) {
        strong = true;
        version = version ?? versionOrNull(get(v, "claude_code_version"));
        sid = sid ?? bound(sessionId);
      }
    } else if (type === "result") {
      if (
        sessionId !== undefined &&
        typeof get(v, "subtype") === "string" &&
        (Object.hasOwn(v, "num_turns") || Object.hasOwn(v, "duration_ms"))
      ) {
        strong = true;
        sid = sid ?? bound(sessionId);
      }
    } else if (type === "assistant" || type === "user") {
      if (
        sessionId !== undefined &&
        Object.hasOwn(v, "parent_tool_use_id") &&
        isObj(get(v, "message"))
      ) {
        strong = true;
        sid = sid ?? bound(sessionId);
      }
    }
  }
  if (parsed === 0) return NO("no-parseable-record");
  if (!strong) return NO("no-stream-json-signal");
  return {
    verdict: "match",
    providerVersionSeen: version,
    nativeSessionId: sid,
    reasons: ["stream-json-shape"],
  };
}

/**
 * Capabilities are conservative: no cell exceeds capability-matrix.json for this surface.
 * Cells whose matrix `surfaces` list omits `claude-code.stream-json` are `unknown` (M-16).
 * Would claim after L-MATRIX uplift (shapes are in FORMAT-claude A.8/A.9, API-sourced):
 * toolCallInputs, toolCallOutputs, filePatches `partial`.
 */
export const streamJsonAdapter: SourceAdapter = {
  manifest: {
    id: "claude-code.stream-json",
    adapterVersion: "0.1.0",
    provider: "claude-code",
    sourceKind: "claude-code.stream-json",
    sourceStability: "documented-interface",
    captureModes: ["import-file"],
    testedProviderVersions: [],
    capabilities: {
      sessionLifecycle: "partial",
      toolCallInputs: "unknown",
      toolCallOutputs: "unknown",
      llmMetadata: "partial",
      filePatches: "unknown",
      subagents: "partial",
      permissions: "partial",
      failures: "partial",
      timestamps: "unknown",
      tokens: "partial",
    },
    framing: { kind: "jsonl" },
    experimental: false,
    attributeKeys: STREAM_ATTRIBUTE_KEYS,
  },
  detect: detectStreamJson,
  createParser(ctx: ParseContext): RecordParser {
    return new ClaudeParser("stream", ctx);
  },
};

export const streamJsonRegistration: AdapterRegistration = {
  adapter: streamJsonAdapter,
  discovery: { roots: [], fileNamePattern: "^.+\\.(?:jsonl|ndjson)$" },
};
