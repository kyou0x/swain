import { type CanonicalEvent, type ContentRef, maskHome } from "@swain/core";
import type { Part, RenderOptions, SessionView } from "../types.js";
import { OutputTooLarge } from "../types.js";

/** Static notice strings. They use only the safe character set, so Markdown emits them verbatim. */
export const NOTICE_M10 = "hashes allow confirmation of guessed content; do not share exports";
export const NOTICE_MASKED = "inline content was masked best-effort; masking is not a guarantee";
export const NOTICE_HASH_ONLY =
  "content policy hash-only: event content is not stored, only hashes and sizes are shown";
export const NOTICE_INLINE = "content policy inline: retained content is shown where present";
export const NOTICE_EXPERIMENTAL =
  "EXPERIMENTAL: this adapter reads a source format that is experimental";
export const NOTICE_NOT_EXPERIMENTAL = "experimental label: no";
export const NOTICE_UNDOCUMENTED =
  "UNDOCUMENTED SOURCE: the provider does not document this format and it may change without notice";
export const NOTICE_INTERNAL =
  "INTERNAL UNSTABLE SOURCE: the provider treats this format as internal and it may change";
export const NOTICE_DOCUMENTED = "documented source interface";
export const NOTICE_UNTESTED =
  "untested provider version: this provider version is not in the adapter's tested list";

export const INLINE_EXCERPT_CHARS = 512;

export const RE_EVT = /^evt_[0-9a-f]{32}$/;
export const RE_IMP = /^imp_[0-9a-f]{32}$/;
/** Static template text is limited to characters that never need Markdown escaping. */
export const RE_MD_SAFE_TEXT = /^[A-Za-z0-9 .,;:()'/+=%$#@?-]*$/;

export const text = (v: string): Part => ({ t: "text", v });
export const data = (v: string): Part => ({ t: "data", v });
export const count = (v: number): Part => ({ t: "count", v });

/** Events in (sourceSequence, subIndex) order; stable for equal keys. */
export function sortEvents(events: readonly CanonicalEvent[]): readonly CanonicalEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) => a.e.sourceSequence - b.e.sourceSequence || a.e.subIndex - b.e.subIndex || a.i - b.i,
    )
    .map((x) => x.e);
}

export function orderedEvents(view: SessionView): readonly CanonicalEvent[] {
  return sortEvents(view.result.events);
}

export function inlineRefs(e: CanonicalEvent): ContentRef[] {
  const p = e.payload as unknown as Record<string, unknown>;
  const out: ContentRef[] = [];
  for (const k of ["prompt", "content", "input", "output", "error", "diff", "reason"]) {
    const v = p[k];
    if (typeof v === "object" && v !== null && "retention" in v && "sha256" in v) {
      out.push(v as ContentRef);
    }
  }
  return out;
}

export function hasInlineContent(view: SessionView): boolean {
  if (view.record.contentRetention === "inline") return true;
  return view.result.events.some((e) => inlineRefs(e).some((r) => r.inline !== undefined));
}

export function hasUntestedVersion(view: SessionView): boolean {
  return (
    view.record.warningCodes.includes("untested-provider-version") ||
    view.result.warnings.some((w) => w.code === "untested-provider-version")
  );
}

/** The notices that every output carries, in fixed order. */
export function notices(view: SessionView): readonly string[] {
  const { record } = view;
  const out: string[] = [NOTICE_M10];
  out.push(record.contentRetention === "hash-only" ? NOTICE_HASH_ONLY : NOTICE_INLINE);
  if (hasInlineContent(view)) out.push(NOTICE_MASKED);
  out.push(record.adapter.experimental ? NOTICE_EXPERIMENTAL : NOTICE_NOT_EXPERIMENTAL);
  out.push(
    record.adapter.sourceStability === "undocumented"
      ? NOTICE_UNDOCUMENTED
      : record.adapter.sourceStability === "internal-unstable"
        ? NOTICE_INTERNAL
        : NOTICE_DOCUMENTED,
  );
  if (hasUntestedVersion(view)) out.push(NOTICE_UNTESTED);
  return out;
}

export function truncateCodePoints(s: string, max: number): string {
  let n = 0;
  let end = 0;
  for (const ch of s) {
    if (n === max) return `${s.slice(0, end)}...`;
    n++;
    end += ch.length;
  }
  return s;
}

/** Text-to-text masking applied BEFORE any cut, so a cut can never expose part of a home path. */
export type Mask = (s: string) => string;
const identity: Mask = (s) => s;

export function contentPart(
  label: string,
  ref: ContentRef | null,
  lead = " ",
  max = INLINE_EXCERPT_CHARS,
  mask: Mask = identity,
): Part[] {
  if (ref === null) return [];
  if (ref.inline !== undefined && ref.retention !== "hash-only") {
    return [
      text(`${lead}${label} (${ref.retention}): `),
      data(truncateCodePoints(mask(ref.inline), max)),
    ];
  }
  return [text(`${lead}${label} hash-only, `), count(ref.byteLength), text(" bytes")];
}

/** Kind-specific timeline detail. Everything untrusted is a `data` part. */
export function describe(e: CanonicalEvent, mask: Mask = identity): Part[] {
  switch (e.kind) {
    case "session.started":
      return [text("trigger "), data(e.payload.trigger)];
    case "session.ended":
      return [text("reason "), data(e.payload.reason)];
    case "turn.started":
      return contentPart("prompt", e.payload.prompt, "", INLINE_EXCERPT_CHARS, mask);
    case "turn.ended":
      return [];
    case "message.observed":
      return [
        text(
          e.payload.channel === "reasoning"
            ? "provider-exposed reasoning text, role "
            : `${e.payload.channel} message, role `,
        ),
        data(e.payload.role),
        ...contentPart("content", e.payload.content, " ", INLINE_EXCERPT_CHARS, mask),
      ];
    case "tool.requested":
      return [
        text("requested tool "),
        data(e.payload.toolName),
        text(" ("),
        data(e.payload.toolNamespace),
        text(")"),
        ...(e.payload.mcpServer === undefined ? [] : [text(" server "), data(e.payload.mcpServer)]),
        ...contentPart("input", e.payload.input, " ", INLINE_EXCERPT_CHARS, mask),
      ];
    case "tool.completed":
      return [
        text("tool "),
        data(e.payload.toolName ?? "(unnamed)"),
        text(" completed"),
        ...(e.payload.exitCode === undefined
          ? []
          : [text(", exit code "), count(e.payload.exitCode)]),
        ...contentPart("output", e.payload.output, " ", INLINE_EXCERPT_CHARS, mask),
      ];
    case "tool.failed":
      return [
        text("tool "),
        data(e.payload.toolName ?? "(unnamed)"),
        text(" failed, error class "),
        data(e.payload.errorClass),
        ...(e.payload.exitCode === undefined
          ? []
          : [text(", exit code "), count(e.payload.exitCode)]),
        ...contentPart("error", e.payload.error, " ", INLINE_EXCERPT_CHARS, mask),
      ];
    case "agent.started":
      return [text("agent type "), data(e.payload.agentType ?? "(none)")];
    case "agent.ended":
      return [];
    case "file.changed":
      return [
        text("file "),
        data(e.payload.path),
        text(", change kind "),
        data(e.payload.changeKind),
        text(
          e.payload.basis === "derived-from-tool-result"
            ? ", derived from tool result"
            : ", reported by the provider",
        ),
      ];
    case "permission.requested":
      return [
        text("permission requested for "),
        data(e.payload.toolName ?? "(unnamed)"),
        ...contentPart("input", e.payload.input, " ", INLINE_EXCERPT_CHARS, mask),
      ];
    case "permission.decided":
      return [
        text("decision "),
        data(e.payload.decision),
        text(" by "),
        data(e.payload.decidedBy),
        ...contentPart("reason", e.payload.reason, " ", INLINE_EXCERPT_CHARS, mask),
      ];
    case "model.usage":
      return [
        text("usage scope "),
        data(e.payload.scope),
        text(", model "),
        data(e.payload.model ?? "(unspecified)"),
        ...(e.payload.totalTokens === undefined
          ? []
          : [text(", total tokens "), count(e.payload.totalTokens)]),
      ];
    case "capture.gap":
      return [text("gap "), data(e.payload.reason), text(": "), data(e.payload.detail)];
    case "source.unknown":
      return [text("unrecognized record, native type "), data(e.payload.nativeType ?? "(none)")];
  }
}

export function provenanceText(e: CanonicalEvent): string {
  const p = e.provenance;
  if (p.type === "record") {
    return `line ${p.line}, offset ${p.byteOffset}, sha256 ${p.sha256.slice(0, 12)}`;
  }
  return `derived by ${p.rule}`;
}

export function eventTimeText(e: CanonicalEvent): string {
  return e.time.status === "valid" && e.time.value !== null ? e.time.value : `(${e.time.status})`;
}

/** Both home directories masked inside free text (not only a whole path). Escaping is the caller's. */
export function maskFree(v: string, o: RenderOptions): string {
  return maskedData(maskHomeInText(maskHomeInText(v, o.homeDir), o.realHomeDir ?? null), o);
}

/** Display form of a data value: home-masked. Escaping is applied by the caller. */
export function maskedData(v: string, o: RenderOptions): string {
  const once = maskHome(v, o.homeDir);
  return once === v ? maskHome(v, o.realHomeDir ?? null) : once;
}

const PATH_CHAR = /[A-Za-z0-9_.-]/;

/**
 * Home masking inside free text (a command line): every occurrence of the home directory that is a
 * whole path prefix becomes `~`. `maskHome` only handles a string that is itself a path.
 */
export function maskHomeInText(text: string, homeDir: string | null): string {
  if (homeDir === null || !homeDir.startsWith("/")) return text;
  let home = homeDir;
  while (home.length > 1 && home.endsWith("/")) home = home.slice(0, -1);
  if (home === "/" || home.length < 2) return text;
  let out = "";
  let i = 0;
  for (;;) {
    const at = text.indexOf(home, i);
    if (at < 0) break;
    const after = text[at + home.length] ?? "";
    // No check on the preceding character: `x/home/u` and `-I/home/u/inc` must mask too. Over-masking
    // only mangles display; under-masking leaks. A longer name (`/home/u2`) is another path.
    out += text.slice(i, at);
    out += !PATH_CHAR.test(after) ? "~" : home;
    i = at + home.length;
  }
  return out + text.slice(i);
}

export function checkSize(out: string, o: RenderOptions): string {
  if (new TextEncoder().encode(out).length > o.maxOutputBytes) throw new OutputTooLarge();
  return out;
}

export interface Facts {
  readonly label: string;
  readonly value: string;
}

/** Header facts, label static and value untrusted. */
export function headerFacts(view: SessionView, o: RenderOptions): readonly Facts[] {
  const { record, result } = view;
  const times =
    record.firstEventTime === null && record.lastEventTime === null
      ? "(none)"
      : `${record.firstEventTime ?? "(none)"} to ${record.lastEventTime ?? "(none)"}`;
  return [
    { label: "Import ID", value: record.importId },
    { label: "Session ID", value: record.sessionId },
    { label: "Provider", value: record.provider },
    { label: "Source kind", value: record.sourceKind },
    { label: "Source stability", value: record.adapter.sourceStability },
    { label: "Experimental", value: record.adapter.experimental ? "yes" : "no" },
    { label: "Adapter", value: `${record.adapter.id}@${record.adapter.version}` },
    { label: "Source", value: maskedData(record.source.displayPath, o) },
    { label: "Source SHA-256", value: record.source.sha256 },
    { label: "Source size (bytes)", value: String(record.source.byteLength) },
    { label: "Content retention", value: record.contentRetention },
    { label: "Import outcome", value: record.outcome },
    { label: "Events", value: String(result.events.length) },
    { label: "Event time range", value: times },
  ];
}

/** Gap and unknown-record events, in event order. */
export function gapEvents(events: readonly CanonicalEvent[]): readonly CanonicalEvent[] {
  return events.filter((e) => e.kind === "capture.gap" || e.kind === "source.unknown");
}

export function warningDetail(d: Readonly<Record<string, string | number>>): string {
  return Object.keys(d)
    .sort()
    .map((k) => `${k}=${String(d[k])}`)
    .join(", ");
}

export function renderedEvents(
  view: SessionView,
  o: RenderOptions,
): { readonly shown: readonly CanonicalEvent[]; readonly total: number } {
  const all = orderedEvents(view);
  const max = Math.max(0, Math.trunc(o.maxRenderedEvents));
  return { shown: all.length > max ? all.slice(0, max) : all, total: all.length };
}
