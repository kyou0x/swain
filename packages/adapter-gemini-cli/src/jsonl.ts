import type {
  AdapterRegistration,
  DetectResult,
  FramedRecord,
  ParseContext,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import { GeminiFold } from "./fold.js";
import { baseManifest, hasArray, headerLike, matchResult, NO_MATCH } from "./manifest.js";
import { own } from "./util.js";

/**
 * `gemini-cli.chat-jsonl`: append-only JSONL, header first, folded at `end()`.
 * Conservative detect: first record must be a header (`sessionId` + 64-hex `projectHash`) with
 * no `messages` array and no message `id`; a compact one-line legacy document is left to
 * `gemini-cli.chat-json`.
 */
export const chatJsonl: SourceAdapter = {
  manifest: baseManifest("gemini-cli.chat-jsonl", { kind: "jsonl" }),
  detect(sample: readonly FramedRecord[]): DetectResult {
    const first = sample[0];
    if (first === undefined) return NO_MATCH("empty-sample");
    if (!first.parse.ok) return NO_MATCH("first-record-unparsed");
    const v = first.parse.value;
    if (!headerLike(v)) return NO_MATCH("no-header");
    if (hasArray(v, "messages")) return NO_MATCH("legacy-document-shape");
    if (own(v, "id") !== undefined || own(v, "$set") !== undefined) return NO_MATCH("not-a-header");
    return matchResult(v);
  },
  createParser(ctx: ParseContext): RecordParser {
    const fold = new GeminiFold(ctx, false);
    return {
      push: (record) => fold.pushJsonl(record),
      end: () => fold.end(),
    };
  },
};

export const chatJsonlRegistration: AdapterRegistration = {
  adapter: chatJsonl,
  discovery: {
    // `~/.gemini/tmp/<slug|64-hex>/chats/session-*.jsonl`; subagents: `chats/<parent>/<id>.jsonl`.
    roots: [{ base: "home", segments: [".gemini", "tmp"] }],
    fileNamePattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*\\.jsonl$",
  },
};
