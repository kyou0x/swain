import assert from "node:assert/strict";
import { test } from "node:test";
import { chatJson } from "../src/json.js";
import { chatJsonl } from "../src/jsonl.js";
import { detect, frameDocument, frameJsonl, readFixture } from "./helpers.js";

const PH = "0".repeat(64);
const header = { sessionId: "s-1", projectHash: PH, startTime: "2026-11-15T10:30:00.000Z" };
const msg = { id: "m1", timestamp: "2026-11-15T10:30:05.000Z", type: "user", content: "hi" };
const lines = (...o: unknown[]): string => `${o.map((x) => JSON.stringify(x)).join("\n")}\n`;

test("chat-jsonl matches the synthetic golden session, chat-json does not", () => {
  const recs = frameJsonl(readFixture("gemini-cli/synthetic-mvp/session-golden.jsonl"));
  const d = detect(chatJsonl, recs);
  assert.equal(d.verdict, "match");
  assert.equal(d.nativeSessionId, "a1b2c3d4-0000-4000-8000-000000000001");
  assert.equal(d.providerVersionSeen, null);
  // The core frames per adapter: as a document, a multi-line JSONL file is malformed.
  const asDoc = frameDocument(readFixture("gemini-cli/synthetic-mvp/session-golden.jsonl"));
  assert.equal(detect(chatJson, asDoc).verdict, "no-match");
});

test("chat-json matches the legacy document, chat-jsonl does not (even when compacted to one line)", () => {
  const bytes = readFixture("gemini-cli/synthetic-mvp/session-legacy.json");
  const doc = frameDocument(bytes);
  assert.equal(detect(chatJson, doc).verdict, "match");
  // Pretty-printed: not JSONL at all.
  assert.equal(detect(chatJsonl, frameJsonl(bytes)).verdict, "no-match");
  // Compact single line: valid under both framings, still exactly one match.
  const compact = JSON.stringify(JSON.parse(new TextDecoder().decode(bytes)));
  assert.equal(detect(chatJsonl, frameJsonl(compact)).verdict, "no-match");
  assert.equal(detect(chatJson, frameDocument(compact)).verdict, "match");
});

test("a header-only JSONL file is claimed by chat-jsonl only", () => {
  const bytes = readFixture("gemini-cli/synthetic-mvp/session-header-only.jsonl");
  assert.equal(detect(chatJsonl, frameJsonl(bytes)).verdict, "match");
  assert.equal(detect(chatJson, frameDocument(bytes)).verdict, "no-match");
});

test("no collision with Claude, Codex or OpenCode shaped input", () => {
  const claude = lines({ type: "user", sessionId: "s", uuid: "u", message: { role: "user" } });
  const codex = lines({ type: "thread.started", thread_id: "t" });
  const codexRollout = lines({ timestamp: "x", type: "session_meta", payload: { id: "i" } });
  const opencode = JSON.stringify({ info: { id: "ses_1", time: { created: 1 } }, messages: [] });
  for (const text of [claude, codex, codexRollout]) {
    assert.equal(detect(chatJsonl, frameJsonl(text)).verdict, "no-match");
    assert.equal(detect(chatJson, frameDocument(text)).verdict, "no-match");
  }
  assert.equal(detect(chatJsonl, frameJsonl(opencode)).verdict, "no-match");
  assert.equal(detect(chatJson, frameDocument(opencode)).verdict, "no-match");
});

test("header must carry a string sessionId and a 64-hex projectHash", () => {
  const bad = [
    { sessionId: 7, projectHash: PH },
    { sessionId: "s", projectHash: "abc" },
    { sessionId: "s", projectHash: PH.toUpperCase().replaceAll("0", "A") },
    { sessionId: "s" },
    { projectHash: PH },
    [],
    "x",
    null,
  ];
  for (const h of bad) {
    assert.equal(
      detect(chatJsonl, frameJsonl(lines(h, msg))).verdict,
      "no-match",
      JSON.stringify(h),
    );
  }
});

test("the header must come first, and must not be a message or metadata record", () => {
  assert.equal(detect(chatJsonl, frameJsonl(lines(msg, header))).verdict, "no-match");
  assert.equal(detect(chatJsonl, frameJsonl(lines({ ...header, id: "m0" }))).verdict, "no-match");
  assert.equal(detect(chatJsonl, frameJsonl(lines({ ...header, $set: {} }))).verdict, "no-match");
  assert.equal(detect(chatJsonl, frameJsonl("{not json}\n")).verdict, "no-match");
  assert.equal(detect(chatJsonl, []).verdict, "no-match");
  assert.equal(detect(chatJson, []).verdict, "no-match");
});

test("chat-json needs message-shaped elements and an array /messages", () => {
  const withMsgs = JSON.stringify({ ...header, messages: [msg] });
  assert.equal(detect(chatJson, frameDocument(withMsgs)).verdict, "match");
  assert.equal(
    detect(chatJson, frameDocument(JSON.stringify({ ...header, messages: [] }))).verdict,
    "no-match",
  );
  assert.equal(detect(chatJson, frameDocument(JSON.stringify({ ...header }))).verdict, "no-match");
  assert.equal(
    detect(chatJson, frameDocument(JSON.stringify({ ...header, messages: "x" }))).verdict,
    "no-match",
  );
  assert.equal(
    detect(
      chatJson,
      frameDocument(JSON.stringify({ ...header, messages: [{ id: "a", type: "alien" }] })),
    ).verdict,
    "no-match",
  );
  assert.equal(detect(chatJson, frameDocument("{broken")).verdict, "no-match");
});

test("detect results carry only static reason codes and a bounded session id", () => {
  const long = "x".repeat(300);
  const d = detect(chatJsonl, frameJsonl(lines({ ...header, sessionId: long })));
  assert.equal(d.verdict, "match");
  assert.equal(d.nativeSessionId, null);
  for (const r of [
    detect(chatJsonl, frameJsonl(lines({ sessionId: "<script>", projectHash: "z" }))),
    d,
  ]) {
    for (const reason of r.reasons) assert.match(reason, /^[a-z-]+$/);
  }
});
