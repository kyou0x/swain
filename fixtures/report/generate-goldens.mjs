// Regenerates the golden outputs next to each session.json (after `npm run build`):
//   node fixtures/report/generate-goldens.mjs
// Review every diff: the goldens are the expected bytes of the renderers.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  explainSession,
  renderHtmlReport,
  renderJsonExport,
  renderMarkdown,
  renderUiIndex,
  renderUiSessionPage,
} from "../../packages/report/dist/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const names = ["claude-code", "codex-cli", "gemini-cli", "opencode"];
const o = { homeDir: "/home/demo", maxOutputBytes: 268_435_456, maxRenderedEvents: 10_000 };
const x = { includeContentExcerpts: true, excerptChars: 160 };
const records = [];
for (const n of names) {
  const view = JSON.parse(readFileSync(join(here, n, "session.json"), "utf8"));
  const ex = explainSession(view, x);
  writeFileSync(join(here, n, "report.md"), renderMarkdown(view, ex, o));
  writeFileSync(join(here, n, "report.html"), renderHtmlReport(view, ex, o));
  writeFileSync(join(here, n, "export.json"), renderJsonExport(view, ex, o));
  writeFileSync(join(here, n, "ui-session.html"), renderUiSessionPage(view, ex, o));
  records.push(view.record);
}
writeFileSync(join(here, "ui-index.html"), renderUiIndex(records, o));
