export const PACKAGE_NAME = "@swain/report";

export { escapeHtmlText, escapeMarkdownText, neutralizeL1 } from "./escape.js";
export { explainSession } from "./explain/index.js";
export {
  ACTIONS_MAX_ROWS,
  type ActionLog,
  type ActionRow,
  AGENT_PATH_SEP,
  actionSummary,
  agentPathText,
  buildActionLog,
  isShellTool,
  mergeRowsChronologically,
  SHELL_TOOL_NAMES,
  STATUS_TEXT,
} from "./render/actions.js";
export { maskHomeInText, sortEvents } from "./render/common.js";
export {
  renderHtmlReport,
  renderUiIndex,
  renderUiSessionPage,
  renderUiTooLargePage,
} from "./render/html.js";
export { maskEvent, maskParts, renderJsonExport } from "./render/json.js";
export { renderMarkdown } from "./render/markdown.js";
export { renderRunPage } from "./render/run.js";
export {
  BAR_STEPS,
  CSP,
  cardsHtml,
  DEFAULT_BRAND,
  htmlDoc,
  quantize,
  resolveBrand,
  SERVER_CSP,
  topBar,
} from "./render/shell.js";
export type { Card } from "./render/stream.js";
export {
  renderAgentPage,
  renderFleetPage,
  renderLoginPage,
  renderMessagePage,
  renderRunsListPage,
  renderSpanRunPage,
  WEB_MESSAGES,
} from "./render/web.js";
export type {
  Brand,
  ExplainOptions,
  Explanation,
  ImportRecord,
  Part,
  RenderOptions,
  RunView,
  SectionId,
  SessionView,
  Statement,
  TemplateId,
  UiFile,
} from "./types.js";
export { OutputTooLarge, TEMPLATE_IDS } from "./types.js";
export type {
  AgentNameView,
  AgentPageView,
  AttrView,
  CredentialView,
  FleetRowView,
  FleetView,
  ProjectView,
  RunHeader,
  RunRowView,
  RunStatusName,
  RunsListView,
  SpanConflictView,
  SpanEventView,
  SpanRowView,
  SpanRunView,
  TextView,
  WebMessageCode,
  WebNav,
} from "./web-types.js";
