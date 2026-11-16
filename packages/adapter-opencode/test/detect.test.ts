import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionExport } from "../src/index.js";
import { detect, frameDocument, frameJsonl, readFixture } from "./helpers.js";

const info = { id: "ses_1", slug: "s", version: "1.19.5", time: { created: 1, updated: 2 } };
const userEl = { info: { id: "msg_1", role: "user", time: { created: 1 } }, parts: [] };
const d = (doc: unknown) => detect(sessionExport, frameDocument(JSON.stringify(doc)));

test("matches the synthetic export and reads session id and version", () => {
  const r = detect(
    sessionExport,
    frameDocument(readFixture("opencode/synthetic-mvp/export-golden.json")),
  );
  assert.equal(r.verdict, "match");
  assert.equal(r.nativeSessionId, "ses_fake01");
  assert.equal(r.providerVersionSeen, "1.19.5");
  assert.deepEqual(r.reasons, ["opencode-export"]);
});

test("matches empty, sanitized and minimal exports", () => {
  for (const f of ["export-empty.json", "export-sanitized.json"]) {
    assert.equal(
      detect(sessionExport, frameDocument(readFixture(`opencode/synthetic-mvp/${f}`))).verdict,
      "match",
      f,
    );
  }
  assert.equal(d({ info, messages: [userEl] }).verdict, "match");
  // Missing /messages leaves the same envelope as an empty array: still the same surface.
  assert.equal(d({ info }).verdict, "match");
});

test("a version string outside printable ASCII is not reported", () => {
  assert.equal(
    d({ info: { ...info, version: "1.0 beta" }, messages: [] }).providerVersionSeen,
    null,
  );
  assert.equal(d({ info: { ...info, version: 7 }, messages: [] }).providerVersionSeen, null);
});

test("rejects other shapes: not info, not ses id, no time, non-array messages, bad elements", () => {
  const no = [
    {},
    [],
    "x",
    { info: "x" },
    { info: { ...info, id: "abc" } },
    { info: { ...info, id: 7 } },
    { info: { id: "ses_1" } },
    { info, messages: "x" },
    { info, messages: { a: 1 } },
    { info, messages: [{ info: { role: "system" }, parts: [] }] },
    { info, messages: [{ info: { role: "user" } }] },
    { info, messages: [5] },
    { info, sessionId: "s", projectHash: "0".repeat(64), messages: [] },
  ];
  for (const doc of no) assert.equal(d(doc).verdict, "no-match", JSON.stringify(doc));
  assert.equal(detect(sessionExport, []).verdict, "no-match");
  assert.equal(detect(sessionExport, frameDocument("{broken")).verdict, "no-match");
});

test("no collision with Gemini, Claude or Codex shaped input", () => {
  const gemini = readFixture("gemini-cli/synthetic-mvp/session-legacy.json");
  assert.equal(detect(sessionExport, frameDocument(gemini)).verdict, "no-match");
  const geminiJsonl = readFixture("gemini-cli/synthetic-mvp/session-golden.jsonl");
  assert.equal(detect(sessionExport, frameDocument(geminiJsonl)).verdict, "no-match");
  const lines = `${JSON.stringify({ type: "user", sessionId: "s", message: {} })}\n`;
  assert.equal(detect(sessionExport, frameJsonl(lines)).verdict, "no-match");
  assert.equal(detect(sessionExport, frameDocument(lines)).verdict, "no-match");
  assert.equal(
    detect(sessionExport, frameDocument(JSON.stringify({ type: "thread.started", thread_id: "t" })))
      .verdict,
    "no-match",
  );
});

test("reasons are static codes", () => {
  for (const doc of [{}, { info: "x" }, { info: { ...info, id: "x" } }, { info, messages: 1 }]) {
    for (const r of d(doc).reasons) assert.match(r, /^[a-z-]+$/);
  }
});
