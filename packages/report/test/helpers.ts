import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type CanonicalEvent, validateEvents } from "@swain/core";
import type { ExplainOptions, ImportRecord, RenderOptions, SessionView } from "../src/index.js";

export const PROVIDER_FIXTURES = ["claude-code", "codex-cli", "gemini-cli", "opencode"] as const;

export const RENDER_OPTS: RenderOptions = {
  homeDir: "/home/demo",
  maxOutputBytes: 268_435_456,
  maxRenderedEvents: 10_000,
};
export const EXPLAIN_OPTS: ExplainOptions = { includeContentExcerpts: true, excerptChars: 160 };

const FIXTURE_DIR = new URL("../../../../fixtures/report/", import.meta.url);

export function readFixture(rel: string): string {
  return readFileSync(new URL(rel, FIXTURE_DIR), "utf8");
}

export function loadSession(name: string): SessionView {
  const parsed: unknown = JSON.parse(readFixture(`${name}/session.json`));
  const v = parsed as { record: ImportRecord; result: SessionView["result"] };
  const checked = validateEvents(v.result.events);
  if (!checked.ok) throw new Error("fixture events are invalid");
  return { record: v.record, result: { ...v.result, events: checked.events } };
}

/** Replace the events of a view; the new set must still validate. */
export function withEvents(view: SessionView, events: readonly CanonicalEvent[]): SessionView {
  const checked = validateEvents(JSON.parse(JSON.stringify(events)));
  if (!checked.ok)
    throw new Error(`mutated events are invalid: ${JSON.stringify(checked.issues[0])}`);
  return { record: view.record, result: { ...view.result, events: checked.events } };
}

export function sha256Base64(s: string): string {
  return createHash("sha256").update(s).digest("base64");
}

const ALLOWED_TAGS = new Set([
  "html",
  "head",
  "meta",
  "title",
  "style",
  "body",
  "h1",
  "h2",
  "h3",
  "p",
  "ul",
  "li",
  "span",
  "a",
  "code",
  "dl",
  "dt",
  "dd",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "input",
  "label",
  "fieldset",
  "legend",
  "details",
  "summary",
  "ol",
  "header",
  "main",
  "aside",
  "section",
]);
const ALLOWED_ATTRS = new Set([
  "lang",
  "charset",
  "http-equiv",
  "content",
  "name",
  "class",
  "id",
  "href",
  "data-provider",
  "data-outcome",
  "colspan",
  "type",
  "for",
  "checked",
  "open",
]);
const HREF_OK =
  /^(#evt_[0-9a-f]{32}|#turn-[0-9]{1,6}|#tabs|\.\.\/index\.html|sessions\/imp_[0-9a-f]{32}\.html)$/;

/** Structural HTML check on real output bytes: returns a list of violations (empty when clean). */
export function htmlViolations(html: string): string[] {
  const bad: string[] = [];
  const noStyle = html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  const tagRe = /<([^>]*)>/g;
  let m: RegExpExecArray | null = tagRe.exec(noStyle);
  while (m !== null) {
    const inner = m[1] ?? "";
    const name = /^\/?([a-zA-Z0-9!]+)/.exec(inner)?.[1]?.toLowerCase() ?? "";
    if (name === "!doctype") {
      m = tagRe.exec(noStyle);
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) bad.push(`tag ${inner.slice(0, 40)}`);
    const rest = inner.replace(/^\/?[a-zA-Z0-9]+/, "");
    const attrRe = /\s+([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let consumed = 0;
    let a: RegExpExecArray | null = attrRe.exec(rest);
    while (a !== null) {
      consumed += a[0].length;
      const an = a[1] ?? "";
      const av = a[2] ?? "";
      if (!ALLOWED_ATTRS.has(an)) bad.push(`attr ${an}`);
      if (an === "href" && !HREF_OK.test(av)) bad.push(`href ${av.slice(0, 40)}`);
      if (an === "class" && /[^a-z0-9 _-]/.test(av)) bad.push("attr value class");
      if (
        (an === "id" || an === "data-provider" || an === "data-outcome") &&
        /[^a-z0-9_-]/.test(av)
      ) {
        bad.push(`attr value ${an}`);
      }
      a = attrRe.exec(rest);
    }
    if (consumed !== rest.replace(/\s+$/, "").length && rest.trim() !== "")
      bad.push(`junk in tag ${inner.slice(0, 40)}`);
    m = tagRe.exec(noStyle);
  }
  const text = noStyle.replace(/<[^>]*>/g, "");
  if (/[<]/.test(text)) bad.push("raw < in text");
  return bad;
}
