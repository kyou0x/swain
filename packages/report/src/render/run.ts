/**
 * Run pages (SPEC-003 N0 and N1.6, ADR-0008 section 1).
 *
 * Without a run header (the static viewer) a run has exactly one part and the document is
 * byte-identical to `renderUiSessionPage` for that part. With a header (server pages) a run has one
 * or more parts: the page adds the header, its credentials, the "multiple credentials contributed"
 * notice and an index of the parts, then the unchanged viewer of the selected part. Parts are never
 * merged into one timeline, so every statement still cites the event IDs of its own part.
 */
import { explainSession } from "../explain/index.js";
import type { ExplainOptions, RenderOptions, RunView } from "../types.js";
import type { WebNav } from "../web-types.js";
import { renderSessionPage, UI_SESSION_NAV } from "./html.js";
import { runHeaderHtml } from "./web.js";

const MAX_PARTS = 1000;
const WEB_NAV = '<a href="/runs">runs</a>';

export function renderRunPage(
  view: RunView,
  ex: ExplainOptions,
  o: RenderOptions,
  w?: WebNav,
): string {
  const parts: unknown = view?.parts;
  if (view?.run === undefined) {
    if (!Array.isArray(parts) || parts.length !== 1) {
      throw new RangeError("renderRunPage supports exactly one part");
    }
    const part = view.parts[0];
    if (part === undefined) throw new RangeError("renderRunPage supports exactly one part");
    return renderSessionPage(part, explainSession(part, ex), o, UI_SESSION_NAV);
  }
  if (w === undefined || !Array.isArray(parts) || parts.length < 1 || parts.length > MAX_PARTS) {
    throw new RangeError("renderRunPage needs one to 1000 parts and the page navigation");
  }
  const selected = view.part ?? 1;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > view.parts.length) {
    throw new RangeError("renderRunPage part is out of range");
  }
  const keys = view.partKeys ?? [];
  if (keys.length !== view.parts.length) {
    throw new RangeError("renderRunPage needs one credential per part");
  }
  const part = view.parts[selected - 1];
  if (part === undefined) throw new RangeError("renderRunPage part is out of range");
  const extra = runHeaderHtml(view.run, o, w, { views: view.parts, keys, selected });
  return renderSessionPage(part, explainSession(part, ex), o, WEB_NAV, { extra });
}
