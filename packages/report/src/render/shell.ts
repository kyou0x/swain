/**
 * The shared page shell (SPEC-003 N0, ADR-0008 section 1): doctype, CSP, the single hashed style
 * block, the top bar and the brand. Moved out of `html.ts`; the default brand is Swain and the goldens pin
 * its bytes.
 */
import { createHash } from "node:crypto";
import { escapeHtmlText } from "../escape.js";
import type { Brand, RenderOptions } from "../types.js";
import { buildStyle } from "./theme.js";

export { cardsHtml } from "./stream.js";
export { BAR_STEPS, quantize } from "./trace.js";

export const DEFAULT_BRAND: Brand = Object.freeze({ name: "Swain", mark: "swain" });

const BRAND_NAME_MAX = 64;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control and bidi characters is the purpose
const BRAND_UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

/** Validates `o.brand` at the boundary; an absent brand is the default. Throws `RangeError`. */
export function resolveBrand(o: Pick<RenderOptions, "brand">): Brand {
  const b: unknown = o.brand;
  if (b === undefined) return DEFAULT_BRAND;
  if (typeof b !== "object" || b === null) throw new RangeError("invalid brand");
  const { name, mark } = b as { name?: unknown; mark?: unknown };
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > BRAND_NAME_MAX ||
    !name.isWellFormed() ||
    BRAND_UNSAFE.test(name) ||
    (mark !== "atm" && mark !== "swain")
  ) {
    throw new RangeError("invalid brand");
  }
  return { name, mark };
}

const STYLE = buildStyle();
const STYLE_HASH = createHash("sha256").update(STYLE).digest("base64");
export const CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'none'; base-uri 'none'; form-action 'none'`;
/**
 * The CSP of server pages (ADR-0007 section 5): the same hashed style, plus `form-action 'self'`
 * for the login and logout forms and `frame-ancestors 'none'`. The server sends this exact string
 * as the header and the page carries it as the meta tag. Static exports keep `CSP`.
 */
export const SERVER_CSP = `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

/**
 * The shared document shell: doctype, CSP, the single hashed style block. `title` is escaped.
 * `mode` picks the CSP: `static` (exports, the default) or `server` (pages with forms).
 */
export function htmlDoc(title: string, body: string, mode: "static" | "server" = "static"): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${mode === "server" ? SERVER_CSP : CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtmlText(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * The brand mark, built from CSS only: two dots joined by two curves. Both marks share the
 * geometry until the slice that changes the stylesheet (and with it the CSP hash).
 */
const LOGO =
  '<span class="logo"><span class="lc lc1"></span><span class="lc lc2"></span><span class="ld ld1"></span><span class="ld ld2"></span></span>';

/** `crumb` and `stats` are trusted markup built by the callers; the brand name is escaped here. */
export function topBar(crumb: string, stats: string, brand: Brand = DEFAULT_BRAND): string {
  return `<header class="top"><div class="brand">${LOGO}<span class="wm">${escapeHtmlText(brand.name)}</span><span class="crumb">${crumb}</span></div><div class="ts">${stats}</div></header>`;
}
