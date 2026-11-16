import type {
  AdapterManifest,
  AdapterRegistration,
  DetectResult,
  FramedRecord,
  ParseContext,
  ProviderCapabilities,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import { OpenCodeParser, sessionVersion } from "./parser.js";
import { boundedId, isArr, isObj, own, ownStr } from "./util.js";

export const ADAPTER_VERSION = "0.1.0";

/**
 * docs/architecture/capability-matrix.json lists `opencode.session-export`, but none of its cells
 * names that surface, so every cell is `unknown` (M12, M-16). Not fixture-verified, but the
 * mapping would support, once a maintainer adds the surface to the cells (L-MATRIX):
 * sessionLifecycle partial (info only, no end marker), toolCallInputs available,
 * toolCallOutputs available, llmMetadata partial, filePatches partial (patch parts, write/edit
 * results), subagents partial (subtask parts), permissions unknown, failures partial,
 * timestamps available (epoch ms), tokens available (step-finish and session totals).
 */
const CAPABILITIES: ProviderCapabilities = Object.freeze({
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

/** PA-3 allowlist: scalars only; strings come from closed vocabularies, except `opencode.cwd`. */
export const ATTRIBUTE_KEYS: readonly string[] = Object.freeze([
  "opencode.part_type",
  "opencode.tool_status",
  "opencode.synthetic",
  "opencode.ignored",
  "opencode.retry_attempt",
  "opencode.compaction_auto",
  "opencode.finish_reason",
  "opencode.error_name",
  "opencode.cwd",
]);

const manifest: AdapterManifest = {
  id: "opencode.session-export",
  adapterVersion: ADAPTER_VERSION,
  provider: "opencode",
  sourceKind: "opencode.session-export",
  // The matrix records the export command as documented; the JSON schema itself is not.
  sourceStability: "documented-interface",
  captureModes: ["import-file"],
  testedProviderVersions: [],
  capabilities: CAPABILITIES,
  framing: { kind: "json-document", recordArrays: ["/messages"] },
  experimental: true,
  attributeKeys: ATTRIBUTE_KEYS,
};

const no = (reason: string): DetectResult => ({
  verdict: "no-match",
  providerVersionSeen: null,
  nativeSessionId: null,
  reasons: [reason],
});

/**
 * Conservative detect: envelope `{info}` with `info.id` starting `ses` and an `info.time`
 * object, no Gemini-style `sessionId`/`projectHash`, and every sampled element shaped
 * `{info:{role: user|assistant}, parts: []}`.
 */
export const sessionExport: SourceAdapter = {
  manifest,
  detect(sample: readonly FramedRecord[]): DetectResult {
    const env = sample[0];
    if (env === undefined) return no("empty-sample");
    if (!env.parse.ok) return no("envelope-unparsed");
    const v = env.parse.value;
    if (!isObj(v)) return no("envelope-not-object");
    const info = own(v, "info");
    if (!isObj(info)) return no("no-info");
    if (own(v, "sessionId") !== undefined || own(v, "projectHash") !== undefined) {
      return no("gemini-shape");
    }
    if (own(v, "messages") !== undefined) return no("messages-not-array");
    const id = ownStr(info, "id");
    if (id === undefined || !id.startsWith("ses") || !isObj(own(info, "time"))) {
      return no("no-session-info");
    }
    for (let i = 1; i < sample.length; i++) {
      const r = sample[i];
      if (r === undefined || !r.parse.ok) continue;
      const e = r.parse.value;
      const mi = isObj(e) ? own(e, "info") : undefined;
      const role = isObj(mi) ? ownStr(mi, "role") : undefined;
      if (!isObj(e) || (role !== "user" && role !== "assistant") || !isArr(own(e, "parts"))) {
        return no("element-shape");
      }
    }
    return {
      verdict: "match",
      providerVersionSeen: sessionVersion(info),
      nativeSessionId: boundedId(own(info, "id")),
      reasons: ["opencode-export"],
    };
  },
  createParser(ctx: ParseContext): RecordParser {
    return new OpenCodeParser(ctx);
  },
};

export const registrations: readonly AdapterRegistration[] = [
  {
    adapter: sessionExport,
    discovery: {
      // `opencode export` writes to stdout; users save it under any name. UNKNOWN where exports
      // live, so this root and pattern are a best guess. Detect, not the name, decides.
      roots: [{ base: "xdg-data", segments: ["opencode"] }],
      fileNamePattern: "^[A-Za-z0-9._-]*(opencode|session|export)[A-Za-z0-9._-]*\\.json$",
    },
  },
];
