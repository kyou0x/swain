import { escapeHtmlText } from "../escape.js";
import type { Part, RenderOptions } from "../types.js";
import { maskFree, RE_EVT } from "./common.js";

/**
 * Untrusted text for an HTML text context: every whole-path occurrence of either home directory
 * becomes `~` (also inside free text such as commands and excerpts), then the usual mask, entity
 * escaping and L1. Never use for attribute values.
 */
export function esc(s: string, o: RenderOptions): string {
  return escapeHtmlText(maskFree(s, o));
}

export function partsHtml(parts: readonly Part[], o: RenderOptions): string {
  let out = "";
  for (const p of parts) {
    if (p.t === "count") out += String(Math.trunc(p.v));
    else out += esc(p.v, o); // static text is escaped too, which is a no-op for the safe set
  }
  return out;
}

/** Numbers from records are re-coerced so that a malformed value can never carry markup. */
export function num(v: number): string {
  return Number.isFinite(v) ? String(Math.trunc(v)) : "0";
}

export function evtLink(id: string, anchors: ReadonlySet<string>): string {
  // Anchors and hrefs come only from regex-validated IDs that exist in the timeline.
  if (RE_EVT.test(id) && anchors.has(id)) return `<a href="#${id}"><code>${id}</code></a>`;
  if (RE_EVT.test(id)) return `<code>${id}</code>`;
  return escapeHtmlText(id);
}
