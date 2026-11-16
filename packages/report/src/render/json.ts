import { type CanonicalEvent, canonicalJson } from "@swain/core";
import type { Explanation, Part, RenderOptions, SessionView } from "../types.js";
import { checkSize, maskedData, notices, renderedEvents } from "./common.js";

/** Replace lone surrogates anywhere in plain data so that `canonicalJson` cannot reject it. */
function wellFormed(v: unknown): unknown {
  if (typeof v === "string") return v.toWellFormed();
  if (Array.isArray(v)) return v.map(wellFormed);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k.toWellFormed()] = wellFormed(x);
    return out;
  }
  return v;
}

/** Mask each RFC 6901 segment: unescape, `maskHome`, re-escape. */
function maskPointer(pointer: string, o: RenderOptions): string {
  return pointer
    .split("/")
    .map((seg, i) => {
      if (i === 0) return seg;
      const raw = seg.replaceAll("~1", "/").replaceAll("~0", "~");
      return maskedData(raw, o).replaceAll("~", "~0").replaceAll("/", "~1");
    })
    .join("/");
}

/** Home-mask the path-like fields of one event (file path, `*.cwd` attributes, provenance pointer). */
export function maskEvent(e: CanonicalEvent, o: RenderOptions): CanonicalEvent {
  let out: CanonicalEvent = e;
  if (out.kind === "file.changed") {
    out = { ...out, payload: { ...out.payload, path: maskedData(out.payload.path, o) } };
  }
  if (Object.keys(out.attributes).some((k) => k.endsWith(".cwd"))) {
    const attributes: CanonicalEvent["attributes"] = {};
    for (const [k, v] of Object.entries(out.attributes)) {
      attributes[k] = k.endsWith(".cwd") && typeof v === "string" ? maskedData(v, o) : v;
    }
    out = { ...out, attributes };
  }
  if (out.provenance.type === "record" && out.provenance.pointer !== null) {
    out = {
      ...out,
      provenance: { ...out.provenance, pointer: maskPointer(out.provenance.pointer, o) },
    };
  }
  return out;
}

/** Home-mask explanation data parts. */
export function maskParts(parts: readonly Part[], o: RenderOptions): Part[] {
  return parts.map((p) => (p.t === "data" ? { t: "data", v: maskedData(p.v, o) } : p));
}

/**
 * Canonical JSON export (`atm.export/0.1`) plus a trailing newline. File paths, `*.cwd` attributes, provenance pointers and explanation data
 * parts are home-masked; truncation, when it happens, is stated in `notice.truncation`.
 */
export function renderJsonExport(view: SessionView, ex: Explanation, o: RenderOptions): string {
  const { shown, total } = renderedEvents(view, o);
  const actors = new Map<string, { actorId: string; role: string }>();
  for (const e of view.result.events)
    actors.set(e.actor.actorId, { actorId: e.actor.actorId, role: e.actor.role });
  const doc = {
    format: "atm.export/0.1",
    notice: {
      lines: [...notices(view)],
      truncation: shown.length < total ? { shown: shown.length, total } : null,
    },
    record: {
      ...view.record,
      source: { ...view.record.source, displayPath: maskedData(view.record.source.displayPath, o) },
    },
    source: view.result.source,
    actors: [...actors.values()].sort((a, b) =>
      a.actorId < b.actorId ? -1 : a.actorId > b.actorId ? 1 : 0,
    ),
    events: shown.map((e) => maskEvent(e, o)),
    warnings: view.result.warnings,
    stats: view.result.stats,
    explanation: {
      ...ex,
      sections: ex.sections.map((s) => ({
        ...s,
        statements: s.statements.map((st) => ({ ...st, parts: maskParts(st.parts, o) })),
      })),
    },
  };
  return checkSize(`${canonicalJson(wellFormed(doc))}\n`, o);
}
