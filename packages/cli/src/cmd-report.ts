/** Rendering commands: report and ui. Output files are written only through `@swain/store`. */
import {
  explainSession,
  type ImportRecord,
  OutputTooLarge,
  type RenderOptions,
  renderHtmlReport,
  renderJsonExport,
  renderMarkdown,
  renderUiIndex,
  renderUiSessionPage,
  renderUiTooLargePage,
  type SessionView,
  type UiFile,
} from "@swain/report";
import { OutputRefused, writeOutputDir, writeOutputFile } from "@swain/store";
import {
  type Ctx,
  EXIT,
  flagOn,
  flagValue,
  openStoreFor,
  renderOptionsFor,
  resolveRecord,
  usageError,
} from "./context.js";
import { esc, escapeJsonText, formatBytes } from "./text.js";

const EXCERPT_CHARS = 160;

function renderOptions(ctx: Ctx): RenderOptions {
  return renderOptionsFor(ctx.homeDir, ctx.realHomeDir);
}

const explainOptions = (r: ImportRecord, o: RenderOptions) => ({
  includeContentExcerpts: r.contentRetention === "inline",
  excerptChars: EXCERPT_CHARS,
  homeDirs: [o.homeDir, o.realHomeDir ?? null],
});

const FORMATS = ["md", "html", "json"] as const;
type Format = (typeof FORMATS)[number];

export function runReport(ctx: Ctx): number {
  const format = flagValue(ctx, "--format");
  if (format === undefined || !(FORMATS as readonly string[]).includes(format)) {
    return usageError(ctx, "report needs --format md|html|json");
  }
  const out = flagValue(ctx, "--out");
  if (out === undefined && format === "html") {
    return usageError(
      ctx,
      "--format html requires --out FILE (HTML is not written to the terminal)",
    );
  }
  if (out !== undefined && out === "") return usageError(ctx, "--out needs a file path");
  if (out === undefined && flagOn(ctx, "--force")) {
    return usageError(ctx, "--force only applies together with --out");
  }
  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;
  const record = resolveRecord(ctx, store, ctx.inv.positionals[0] ?? "");
  if (record === null) return EXIT.notFound;
  const view: SessionView = { record, result: store.load(record.importId) };
  const o = renderOptions(ctx);
  const ex = explainSession(view, explainOptions(record, o));
  const f = format as Format;
  const data =
    f === "md"
      ? renderMarkdown(view, ex, o)
      : f === "html"
        ? renderHtmlReport(view, ex, o)
        : renderJsonExport(view, ex, o);
  if (out === undefined) {
    ctx.out(f === "json" ? escapeJsonText(data) : data);
    return EXIT.ok;
  }
  writeOutputFile(out, data, { force: flagOn(ctx, "--force"), maxBytes: o.maxOutputBytes });
  ctx.out(
    `Wrote ${f} report (${formatBytes(new TextEncoder().encode(data).length)}) to ${esc(out)}\n`,
  );
  return EXIT.ok;
}

/** `file://` URL with every byte outside the unreserved set percent-encoded. */
function fileUrl(absoluteDir: string): string {
  const path = absoluteDir.toWellFormed().split("/").map(encodeURIComponent).join("/");
  return `file://${path}/index.html`;
}

/**
 * Accumulates rendered pages with a running byte total. Throws `OutputRefused("too-large")` as soon
 * as the total exceeds `maxBytes`, so callers can stop rendering instead of holding everything.
 */
export function uiFileKeeper(maxBytes: number): (name: UiFile["name"], data: string) => UiFile {
  const encoder = new TextEncoder();
  let total = 0;
  return (name, data) => {
    total += encoder.encode(data).length;
    if (total > maxBytes) throw new OutputRefused("too-large");
    return { name, data };
  };
}

/**
 * One session page of the UI. An oversized session (OutputTooLarge, or a RangeError from a string
 * that is too long) must not abort the whole UI: it gets a small static stub instead.
 */
export function uiSessionPage(
  record: ImportRecord,
  load: () => SessionView["result"],
  o: RenderOptions,
  onStub?: () => void,
): string {
  try {
    const view: SessionView = { record, result: load() };
    return renderUiSessionPage(view, explainSession(view, explainOptions(record, o)), o);
  } catch (e) {
    const tooLong = e instanceof RangeError && /Invalid string length/.test(e.message);
    if (!(e instanceof OutputTooLarge) && !tooLong) throw e;
    onStub?.();
    return renderUiTooLargePage(record, o);
  }
}

export function runUi(ctx: Ctx): number {
  const outFlag = flagValue(ctx, "--out");
  if (outFlag !== undefined && outFlag === "")
    return usageError(ctx, "--out needs a directory path");
  const store = openStoreFor(ctx);
  if (store === null) return EXIT.usage;
  const o = renderOptions(ctx);
  const records = store.list();
  const keep = uiFileKeeper(o.maxOutputBytes);
  const files: UiFile[] = [keep("index.html", renderUiIndex(records, o))];
  let stubbed = 0;
  for (const r of records) {
    const page = uiSessionPage(
      r,
      () => store.load(r.importId),
      o,
      () => {
        stubbed++;
      },
    );
    files.push(keep(`sessions/${r.importId}.html`, page));
  }
  let dir: string;
  if (outFlag === undefined) {
    store.init();
    dir = writeOutputDir(`${store.root}/ui`, files, { force: true, maxBytes: o.maxOutputBytes });
  } else {
    dir = writeOutputDir(outFlag, files, {
      force: flagOn(ctx, "--force"),
      maxBytes: o.maxOutputBytes,
    });
  }
  ctx.out(
    `Generated a static UI for ${records.length} ${records.length === 1 ? "import" : "imports"} (no server, no JavaScript).\n`,
  );
  if (stubbed > 0) {
    ctx.err(
      `swain: ${stubbed} session ${stubbed === 1 ? "page was" : "pages were"} too large and replaced by a stub; use 'swain report' or 'swain commands' for ${stubbed === 1 ? "it" : "them"}\n`,
    );
  }
  ctx.out(`Open in a browser: ${fileUrl(dir)}\n`);
  return EXIT.ok;
}
