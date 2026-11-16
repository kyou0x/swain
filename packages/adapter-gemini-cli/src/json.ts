import type {
  AdapterRegistration,
  DetectResult,
  FramedRecord,
  ParseContext,
  RecordParser,
  SourceAdapter,
} from "@swain/core";
import { GeminiFold } from "./fold.js";
import { baseManifest, headerLike, isMessageLike, matchResult, NO_MATCH } from "./manifest.js";
import { own } from "./util.js";

/**
 * `gemini-cli.chat-json`: the legacy single `ConversationRecord` document. Record 0 is the
 * envelope (the document without `/messages`), records 1..N are the message elements.
 * Detect needs the envelope header shape and at least one message-shaped element, which keeps
 * a header-only JSONL file (one line, valid as a document too) with `gemini-cli.chat-jsonl`.
 * Consequence: a legacy document with an empty `messages` array is not matched.
 */
export const chatJson: SourceAdapter = {
  manifest: baseManifest("gemini-cli.chat-json", {
    kind: "json-document",
    recordArrays: ["/messages"],
  }),
  detect(sample: readonly FramedRecord[]): DetectResult {
    const env = sample[0];
    if (env === undefined) return NO_MATCH("empty-sample");
    if (!env.parse.ok) return NO_MATCH("envelope-unparsed");
    const v = env.parse.value;
    if (!headerLike(v)) return NO_MATCH("no-header");
    // `messages` still present means it was not an array (the core removes declared arrays).
    if (own(v, "messages") !== undefined) return NO_MATCH("messages-not-array");
    if (!isMessageLike(sample[1])) return NO_MATCH("no-message-element");
    return matchResult(v);
  },
  createParser(ctx: ParseContext): RecordParser {
    const fold = new GeminiFold(ctx, true);
    return {
      push: (record) => fold.pushLegacy(record),
      end: () => fold.end(),
    };
  },
};

export const chatJsonRegistration: AdapterRegistration = {
  adapter: chatJson,
  discovery: {
    roots: [{ base: "home", segments: [".gemini", "tmp"] }],
    fileNamePattern: "^session-[A-Za-z0-9_.-]+\\.json$",
  },
};
